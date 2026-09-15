#!/usr/bin/env python3
"""Napi al-agens tevekenyseg-atnezes a tool_call_log alapjan.

Miert letezik (2026-09-15, kanban 85cf51c5): a jogosultsag-felmeres kimutatta, hogy
az al-agensek hatara ma nagyreszt viselkedesi, nem technikai -- a deny szabalyokat
egy interpreter vagy egy glob megkeruli. Amig ez igy van, a MEGELOZES mellett
kell egy DETEKCIO is: ha megis tortent valami, utolag latszodjon.

A PostToolUse `tool-log-capture.py` mar ma is rogziti minden al-agens minden
eszkozhivasat a tool_call_log tablaba. Ez a script azt a naplot nezi at, es csak
azt emeli ki, ami nem fer bele a napi munkaba. Nem blokkol semmit, csak lat.

Hasznalat:
    python3 scripts/subagent-audit.py [--hours 24] [--json]

Kimenet: emberi olvasasra szant osszefoglalo, vagy --json eseten gepi feldolgozasra.
Ha nincs talalat, a kimenet ures (a hivo heartbeat ilyenkor csendben marad).
"""
import argparse
import json
import os
import re
import sqlite3
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, 'store', 'claudeclaw.db')

# A fo-agens sajat naploja nem ide tartozik: o nem al-agens, ra nem vonatkoznak
# a governance-kapuk, es a sajat muveleteit amugy is jelenti.
MAIN_AGENT = 'marween'

# Sajat, szentesitett utvonalak: ezek NEM talalatok.
# A dashboard-token olvasasa a localhost API-hivasok resze, ezt naponta tucatszor teszik.
SANCTIONED = [
    re.compile(r'\$\(cat\s+\S*store/\.dashboard-token\)'),
    re.compile(r'scripts/dash\b'),
    # ZAJSZURES az elso eles futas utan (2026-09-15 20:40, 26 talalat / 0 incidens).
    # A .env.testing es a .env.example KONVENCIO szerint nem titok-hordozo: az elobbi a
    # teszt-DB beallitasa, az utobbi a bemasolando minta. A CSUPASZ .env-et tovabbra is
    # jelezzuk, mert az a valodi titok-fajl.
    re.compile(r'\.env\.(testing|example)\b'),
]

# Egy `rm`, aminek MINDEN celpontja /tmp ala mutat, sajat takaritas, nem rombolas.
# Ha akar egy celpont kilog onnan, a szabaly tovabbra is jelez.
_RM_RE = re.compile(r'\brm\s+(-[a-zA-Z]+\s+)*(?P<targets>[^;&|\n]+)')


def is_tmp_only_rm(text):
    m = _RM_RE.search(text)
    if not m:
        return False
    targets = [t for t in m.group('targets').split() if not t.startswith('-')]
    return bool(targets) and all(t.startswith('/tmp/') for t in targets)

# Localhost es a sajat tailscale dashboard-cim: ezek nem "kulso" halozat.
LOCAL_HOSTS = re.compile(r'https?://(localhost|127\.0\.0\.1|100\.83\.33\.14)(:\d+)?', re.I)

RULES = [
    # (kulcs, emberi cimke, regex a parancsra/utvonalra)
    ('hitelesito-adat', 'hitelesito adat eleresenek kiserlete',
     re.compile(r'(\.ssh/|\.aws/|\.gnupg/|\.dashboard-token|(^|[^A-Za-z0-9_.-])\.env($|[^A-Za-z0-9]))')),
    ('kulso-halozat', 'kulso halozati hivas parancssorbol',
     re.compile(r'\b(curl|wget)\b')),
    ('romboló', 'torlo vagy felulcsapo muvelet',
     re.compile(r'(\brm\s+-[a-z]*[rf]|os\.remove|os\.unlink|shutil\.rmtree|\bDROP\s+TABLE\b|\btruncate\b|git\s+push\s+(-f|--force))', re.I)),
    ('ongondoskodas', 'onutemezes vagy mas munkamenet piszkalasa',
     re.compile(r'(tmux\s+(send-keys|paste-buffer|run-shell)|crontab|\bat\s+now\b|scheduled_tasks\.json)')),
]

# Melyik agens hova irhat sajatkent. Ezen kivuli IRAS talalat.
# (Olvasast nem szurunk utvonalra: a kozos tudastar olvasasa ma mar engedelyezett.)
# A sajat session-scratchpad ES a flotta kozos memoria-konyvtara NEM "sajat teruleten
# kivul": az elso a harness altal kijelolt ideiglenes hely (a path-ban ott az agens neve),
# a masodik a kozos emlekezet, ahova irni a dolguk. Az elso eles futason ez a ketto adta a
# 26 talalatbol 21-et -- pontosan az a napi zaj, ami elolne az igazi jelzest.
# FIGYELEM: a kozos memoria-konyvtar (~/.claude/projects/*/memory/) SZANDEKOSAN NINCS itt.
# Elso korben felvettem, aztan visszavettem: a subagent-audit-detection.test.ts "fires on a
# write outside the agent own area" esete kifejezetten azt dokumentalja, hogy a memoria-iras
# "benign, but must be visible". Megosztott eroforras, ahol az agensek egymasra irhatnak (volt
# is mar majdnem-utkozes), es naponta ot sor nem az a zaj, ami elolne a jelzest -- a tizenhat
# scratchpad-sor volt az. Mielott egy jelzest kivennel, nezd meg, mit orzott (88. eset).
_OWN_PATH_RE = [
    re.compile(r'^/tmp/claude-\d+/[^/]*agents-(?P<agent>[a-z0-9_-]+)/[^/]+/scratchpad/'),
]


def is_own_path(agent, path):
    for rx in _OWN_PATH_RE:
        m = rx.match(path)
        if not m:
            continue
        named = m.groupdict().get('agent')
        if named is None or named == agent:
            return True
    return False


def own_write_areas(agent):
    return [
        f'/home/laci/projects/marveen/agents/{agent}/',
        '/home/laci/projects/marveen/docs/',
        f'/home/laci/projects/workflowTTK-{agent}/',
        f'/home/laci/projects/gyartaskiszolgalas-{agent}/',
        f'/home/laci/projects/kriptoSZJA-{agent}/',
        f'/home/laci/projects/marveen-{agent}/',
    ]

WRITE_TOOLS = ('Write', 'Edit', 'NotebookEdit')


def is_sanctioned(text):
    return any(p.search(text) for p in SANCTIONED)


def external_network(text):
    """curl/wget hivas, aminek a celja NEM a sajat localhost API."""
    if not re.search(r'\b(curl|wget)\b', text):
        return False
    urls = re.findall(r'https?://[^\s\'"]+', text)
    if not urls:
        return False   # cel nelkuli curl (pl. --help) nem talalat
    return any(not LOCAL_HOSTS.match(u) for u in urls)


def audit(hours):
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "SELECT agent_id, tool_name, input_summary, success, created_at "
        "FROM tool_call_log "
        "WHERE created_at > strftime('%s','now', ?) AND agent_id IS NOT NULL AND agent_id <> ? "
        "ORDER BY created_at",
        (f'-{hours} hours', MAIN_AGENT),
    ).fetchall()

    findings = []
    for r in rows:
        text = str(r['input_summary'] or '')
        if not text:
            continue
        agent = r['agent_id']
        hits = []

        if not is_sanctioned(text):
            for key, label, pat in RULES:
                if key == 'kulso-halozat':
                    if external_network(text):
                        hits.append(label)
                elif key == 'romboló' and is_tmp_only_rm(text):
                    continue
                elif pat.search(text):
                    hits.append(label)

        if r['tool_name'] in WRITE_TOOLS:
            path = text.strip()
            if (path.startswith('/')
                    and not any(path.startswith(a) for a in own_write_areas(agent))
                    and not is_own_path(agent, path)):
                hits.append('iras a sajat teruleten kivul')

        if hits:
            findings.append({
                'agent': agent,
                'tool': r['tool_name'],
                'at': r['created_at'],
                'why': hits,
                'what': text[:220],
            })
    return findings, len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hours', type=int, default=24)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    findings, total = audit(args.hours)

    if args.json:
        print(json.dumps({'findings': findings, 'scanned': total, 'hours': args.hours},
                         ensure_ascii=False, indent=2))
        return 0

    if not findings:
        return 0   # ures kimenet: a hivo heartbeat csendben marad

    import datetime
    print(f"AL-AGENS ATNEZES -- utolso {args.hours} ora, {total} eszkozhivas atnezve, "
          f"{len(findings)} kiemelt sor")
    by_agent = {}
    for f in findings:
        by_agent.setdefault(f['agent'], []).append(f)
    for agent, items in sorted(by_agent.items()):
        print(f"\n[{agent}] {len(items)} talalat")
        for f in items:
            ts = datetime.datetime.fromtimestamp(f['at']).strftime('%m-%d %H:%M')
            print(f"  {ts} {f['tool']:6s} {', '.join(f['why'])}")
            print(f"           {f['what']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
