import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SELF_PACE_TOOL_DENY } from '../web/agent-scaffold.js'
import { resolveProfilePlaceholders } from '../web/profiles.js'

// Permission-rule FORM invariants for the shipped security profiles.
//
// Measured 2026-09-15 (kanban 85cf51c5, 11 controlled runs against throwaway
// `claude -p` instances, every claim re-verified on the filesystem): a deny rule
// only takes effect if its path is written in a form the harness actually
// matches. The forms are NOT interchangeable:
//
//   Read(/home/laci/x/**)   -> NOT enforced (not even for the Read tool itself)
//   Read(//home/laci/x/**)  -> enforced
//   Read(~/x/**)            -> enforced
//   Read(**/filename)       -> enforced
//   Read(**/dirname/**)     -> NOT enforced
//
// The profiles interpolate ${HOME} (src/web/profiles.ts), so a rule written as
// `Read(${HOME}/.ssh/**)` renders to the single-leading-slash form -- the one
// form that does nothing. That is how the .ssh / .aws / .gnupg denies became
// paper rules in all three live agents. Writing `/${HOME}/...` renders the
// double-slash form, which is enforced.
//
// This file guards the FORM, not the policy: which paths we deny stays a
// product decision, but a deny we ship must be one the harness honours.

const PROFILE_DIR = join(process.cwd(), 'templates', 'profiles')

function profileFiles(): string[] {
  return readdirSync(PROFILE_DIR).filter(f => f.endsWith('.json') && !f.includes('.bak-'))
}

function rulesOf(file: string, key: 'allow' | 'deny'): string[] {
  const parsed = JSON.parse(readFileSync(join(PROFILE_DIR, file), 'utf-8')) as
    { filesystem?: { allow?: string[]; deny?: string[] } }
  return parsed.filesystem?.[key] ?? []
}

// A path-targeting rule: Read/Write/Edit with a path argument (not Bash(...), not a bare tool name).
const PATH_RULE = /^(Read|Write|Edit)\((.+)\)$/

// Judge the RENDERED path, the way the harness sees it after ${...} interpolation
// (src/web/profiles.ts) -- `${HOME}/x` renders to `/home/.../x` (one slash, inert)
// while `/${HOME}/x` renders to `//home/.../x` (two slashes, enforced).
function render(path: string): string {
  return path
    .replace(/\$\{HOME\}/g, '/home/testuser')
    .replace(/\$\{(AGENT_DIR|WORKDIR)\}/g, '/home/testuser/agents/test')
}

function isUnenforcedAbsolute(path: string): boolean {
  const r = render(path)
  return r.startsWith('/') && !r.startsWith('//')
}

describe('security profiles: deny rules use an enforced path form', () => {
  it('no deny rule is written in the single-leading-slash absolute form', () => {
    const offenders: string[] = []
    for (const file of profileFiles()) {
      for (const rule of rulesOf(file, 'deny')) {
        const m = PATH_RULE.exec(rule)
        if (!m) continue // Bash(...) / bare tool names are matched differently
        if (isUnenforcedAbsolute(m[2])) offenders.push(`${file}: ${rule}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every profile that denies a credential directory does so in an enforced form', () => {
    // The intent behind these rules predates the measurement; what changed is that
    // we now know which spelling actually blocks.
    for (const file of profileFiles()) {
      const deny = rulesOf(file, 'deny')
      for (const dir of ['.ssh', '.aws', '.gnupg']) {
        const hit = deny.find(r => r.includes(`${dir}/`))
        if (!hit) continue // profile does not claim to protect it -- nothing to assert
        expect(hit, `${file} -> ${hit}`).toMatch(/^Read\((\/\$\{HOME\}|~)\//)
      }
    }
  })
})

describe('self-pace deny list covers the fan-out tooling', () => {
  it('denies the Workflow tool to sub-agents', () => {
    // Workflow spawns dozens of subagents from one call. The self-pace doctrine
    // (a sub-agent is input-driven, it does not hand itself work) covers the
    // scheduling tools; fan-out belongs in the same list. Measured gap 2026-09-15.
    expect(SELF_PACE_TOOL_DENY).toContain('Workflow')
  })

  it('still denies the original self-scheduling tools', () => {
    for (const t of ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) {
      expect(SELF_PACE_TOOL_DENY).toContain(t)
    }
  })
})

describe('git push is denied to every non-developer profile', () => {
  it('the marketer profile denies git push', () => {
    // Measured 2026-09-15: researcher denied it, marketer did not, so Sophie could
    // push to any branch she could reach. A marketer has no publishing path to git.
    expect(rulesOf('marketer.json', 'deny')).toContain('Bash(git push:*)')
  })
})

describe('profile placeholders: the install path is not baked in', () => {
  it('renders ${PROJECT_ROOT} to the install directory', () => {
    // The shared dashboard/docs grants used to spell out /home/laci/projects/marveen,
    // which is one machine's truth (template-identity-hygiene.test.ts caught it).
    // The placeholder must render byte-identically to that literal on this install,
    // so de-hardcoding costs no access.
    const ctx = { HOME: '/home/testuser', AGENT_DIR: '/home/testuser/agents/test', PROJECT_ROOT: '/opt/marveen' }
    expect(resolveProfilePlaceholders('Read(${PROJECT_ROOT}/**)', ctx)).toBe('Read(/opt/marveen/**)')
    expect(resolveProfilePlaceholders('Bash(bash ${PROJECT_ROOT}/scripts/dash:*)', ctx))
      .toBe('Bash(bash /opt/marveen/scripts/dash:*)')
  })

  it('defaults PROJECT_ROOT to the running install when the caller omits it', () => {
    // Two call sites resolve profiles (agent-scaffold + the /security route). The
    // default keeps them in sync: neither can silently ship an unresolved literal.
    const out = resolveProfilePlaceholders('Read(${PROJECT_ROOT}/**)', {
      HOME: '/home/testuser', AGENT_DIR: '/home/testuser/agents/test',
    })
    expect(out).not.toContain('${PROJECT_ROOT}')
    expect(out).toMatch(/^Read\(\/.+\/\*\*\)$/)
  })

  it('leaves no unresolved placeholder in any shipped profile rule', () => {
    const ctx = { HOME: '/home/testuser', AGENT_DIR: '/home/testuser/agents/test', PROJECT_ROOT: '/opt/marveen' }
    for (const file of profileFiles()) {
      for (const key of ['allow', 'deny'] as const) {
        for (const rule of rulesOf(file, key)) {
          expect(resolveProfilePlaceholders(rule, ctx), `${file}: ${rule}`).not.toMatch(/\$\{[A-Z_]+\}/)
        }
      }
    }
  })
})
