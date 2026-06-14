import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, RESPAWN_ENABLED } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane, restartAgentProcess } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { resumeMarveenSession, hardRestartMarveenChannels, lastMainRespawnAt } from './channel-monitor.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { detectReauthNeeded } from './reauth-detect.js'
import { loginSequence, literalKeyArgs, specialKeyArgs } from './tmux-keys.js'

// Autonomous re-auth healer (Adam stability-fix #1, scoped 2026-06-03;
// restart-first tier added 2026-06-13).
//
// The watchdog only restarts MISSING sessions; the reauth badge only surfaces
// the dead-token state in the dashboard. Neither acts on a session that is
// ALIVE but whose OAuth token is dead (401) -- it silently stops working.
//
// Two failure modes hide behind the same 401:
//   1. REFRESHABLE -- the 8h access token lapsed but the refresh token is still
//      valid. A fresh `claude` process re-mints the access token silently on
//      start, so a plain session RESTART heals it with zero human action. This
//      is the COMMON case (Laci's 2026-06-12 outage: a fleet restart the next
//      day at 12:44 brought the main agent back, no browser step needed).
//   2. FULLY EXPIRED -- the refresh token itself is dead. No restart helps; the
//      /login flow needs a human browser authorize step (cf. issue #248).
//
// So the loop is now: autonomous DETECTION -> one SOFT RESTART (heals case 1
// silently) -> for the MAIN agent, if still dead past a boot grace, one HARD
// RESTART (a fresh respawn that reliably re-mints) -> if STILL dead, LOUD
// escalation to the owner via notify.sh (plugin-independent Bot API, so it
// reaches the owner even when the channel plugin is also wedged) for the manual
// browser /login.
//
// Why the extra hard-restart tier (added 2026-06-14): the MAIN soft restart is a
// `--continue` respawn (resumeMarveenSession). On 2026-06-14 it fired exactly as
// designed at 19:50 but did NOT re-mint the expired access token -- the fresh
// `--continue` process resumes the conversation without making the startup API
// call that triggers Claude Code's lazy token refresh, so the token stayed dead
// and it escalated at 19:56. A full fleet restart (a FRESH process, no
// --continue) healed it. So when the conversation-preserving restart fails to
// heal, we now escalate to a fresh respawn (hardRestartMarveenChannels) BEFORE
// paging the owner -- the same action that actually worked that night. The cost
// is losing the live --continue conversation, but it only triggers when the soft
// restart already failed, and the deterministic conversation ledger restores
// recent context anyway. A working agent beats a dead one.
//
// Restart actions: sub-agents via restartAgentProcess (stop+start -- ALREADY a
// fresh process, so they skip the hard-restart tier: a second identical restart
// would not heal); the MAIN always-on channels session via resumeMarveenSession
// (soft, --continue) then hardRestartMarveenChannels (fresh, no --continue).
// Each tier is ONE-SHOT per dead-spell (restartedAtMs / hardRestartedAtMs latch),
// so a genuinely-expired refresh token can never drive a respawn loop: it
// restarts at most twice (soft, then hard), then only escalates.
//
// Sub-agents additionally get a best-effort /login send-keys alongside the
// escalation. Production-host only (RESPAWN_ENABLED), like the other recovery
// loops.

const TMUX = resolveFromPath('tmux')
const NOTIFY_SCRIPT = join(PROJECT_ROOT, 'scripts', 'notify.sh')

const PROBE_INTERVAL_MS = 3 * 60 * 1000 // 3 min
const INITIAL_DELAY_MS = 90_000         // after boot-grace, offset from other watchers
const RESTART_THRESHOLD = 2             // ~one probe interval of confirmed dead before the one-shot restart (debounces a blip)
const RESTART_GRACE_MS = 5 * 60 * 1000  // after a restart, let the fresh process boot + re-mint before judging it still-dead
const ESCALATION_COOLDOWN_MS = 30 * 60 * 1000 // 1 alert / agent / 30 min (re-alerts if still dead)

export interface ReauthHealerState {
  consecutiveDead: number
  lastActionAtMs: number | null
  restartedAtMs: number | null      // when the one-shot SOFT restart fired this spell (null = not yet)
  hardRestartedAtMs: number | null  // when the one-shot HARD restart fired this spell (main only; null = not yet)
}

export interface ReauthHealerInput {
  isDeadToken: boolean
  sessionAlive: boolean
  isMain: boolean
  prev: ReauthHealerState
  nowMs: number
}

export interface ReauthHealerThresholds {
  restartThreshold: number
  restartGraceMs: number
  cooldownMs: number
}

export interface ReauthHealerDecision {
  restart: boolean      // one-shot SOFT restart (sub-agent stop+start; main --continue respawn)
  hardRestart: boolean  // one-shot HARD restart (main only: fresh respawn, no --continue -- re-mints reliably)
  sendKeys: boolean     // best-effort autonomous /login (sub-agents only, after restart failed)
  escalate: boolean     // notify.sh alert to the owner (after every restart failed)
  next: ReauthHealerState
}

export const NO_REAUTH_STATE: ReauthHealerState = { consecutiveDead: 0, lastActionAtMs: null, restartedAtMs: null, hardRestartedAtMs: null }

/**
 * Pure decision for the healer. A clean probe (token healed, or session gone)
 * resets the spell. A confirmed dead-token-but-alive session goes through up to
 * three tiers:
 *   1. SOFT restart -- after `restartThreshold` consecutive dead probes
 *      (debounces a blip). Sub-agent stop+start, or the main `--continue`
 *      respawn. Heals the common refreshable-token case.
 *   2. HARD restart (MAIN only) -- if still dead `restartGraceMs` after the soft
 *      restart, a fresh respawn (no --continue) that reliably re-mints. Skipped
 *      for sub-agents, whose Tier-1 restart was ALREADY a fresh process.
 *   3. Escalate -- if still dead `restartGraceMs` after the last applicable
 *      restart, page the owner for a manual /login, re-firing at most once per
 *      `cooldownMs`. Sub-agents also get a best-effort /login send-keys here.
 * Each restart latches (`restartedAtMs` / `hardRestartedAtMs`), so a genuinely-
 * expired refresh token restarts at most twice per spell and can never loop.
 * send-keys never fires for the main agent.
 */
export function decideReauthAction(input: ReauthHealerInput, t: ReauthHealerThresholds): ReauthHealerDecision {
  const { isDeadToken, sessionAlive, isMain, prev, nowMs } = input

  // Clean / not-applicable: end the spell, allow a fresh heal next time.
  if (!isDeadToken || !sessionAlive) {
    return { restart: false, hardRestart: false, sendKeys: false, escalate: false, next: NO_REAUTH_STATE }
  }

  const consecutiveDead = prev.consecutiveDead + 1
  const noop = (next: ReauthHealerState): ReauthHealerDecision =>
    ({ restart: false, hardRestart: false, sendKeys: false, escalate: false, next })

  // Tier 1 -- one-shot SOFT restart. After `restartThreshold` consecutive dead
  // probes (debounces a transient blip), restart ONCE. restartedAtMs latches so
  // we never loop.
  if (prev.restartedAtMs == null) {
    if (consecutiveDead < t.restartThreshold) {
      return noop({ consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: null, hardRestartedAtMs: null })
    }
    return {
      restart: true, hardRestart: false, sendKeys: false, escalate: false,
      next: { consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: nowMs, hardRestartedAtMs: null },
    }
  }

  // Post-soft-restart grace -- the fresh process needs time to boot and make its
  // first authenticated call. A dead reading inside the window is likely stale
  // boot output, so do not judge it yet.
  if (nowMs - prev.restartedAtMs < t.restartGraceMs) {
    return noop({ consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: prev.restartedAtMs, hardRestartedAtMs: prev.hardRestartedAtMs })
  }

  // Tier 2 (MAIN only) -- the soft `--continue` restart did not re-mint the token
  // past the grace. Do ONE fresh respawn (no --continue), which reliably re-mints
  // (cf. the 2026-06-14 outage: only a fresh process healed it). hardRestartedAtMs
  // latches so we never loop. Sub-agents skip this: their Tier-1 was already a
  // fresh stop+start, so a second identical restart cannot heal -- straight to
  // Tier 3.
  if (isMain && prev.hardRestartedAtMs == null) {
    return {
      restart: false, hardRestart: true, sendKeys: false, escalate: false,
      next: { consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: prev.restartedAtMs, hardRestartedAtMs: nowMs },
    }
  }

  // Post-hard-restart grace (MAIN) -- same boot-grace reasoning for the fresh
  // respawn.
  if (isMain && prev.hardRestartedAtMs != null && nowMs - prev.hardRestartedAtMs < t.restartGraceMs) {
    return noop({ consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: prev.restartedAtMs, hardRestartedAtMs: prev.hardRestartedAtMs })
  }

  // Tier 3 -- still dead after every restart we can do: the refresh token itself
  // is dead (fully-expired). Escalate to the owner for a manual browser /login,
  // and (sub-agents only) fire a best-effort /login into the session. Rate-limited.
  const cooldownElapsed = prev.lastActionAtMs == null || (nowMs - prev.lastActionAtMs) >= t.cooldownMs
  return {
    restart: false, hardRestart: false,
    sendKeys: cooldownElapsed && !isMain,
    escalate: cooldownElapsed,
    next: {
      consecutiveDead,
      lastActionAtMs: cooldownElapsed ? nowMs : prev.lastActionAtMs,
      restartedAtMs: prev.restartedAtMs,
      hardRestartedAtMs: prev.hardRestartedAtMs,
    },
  }
}

const watchState = new Map<string, ReauthHealerState>()

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// Fire-and-forget best-effort /login into a sub-agent session. Reuses the same
// scripted sequence as the dashboard button (loginSequence('start')).
async function sendBestEffortLogin(session: string): Promise<void> {
  for (const step of loginSequence('start')) {
    const args = step.kind === 'literal' ? literalKeyArgs(session, step.text) : specialKeyArgs(session, step.key)
    if (args) {
      await new Promise<void>((resolve) => {
        execFile(TMUX, args, { timeout: 5000 }, () => resolve())
      })
    }
    if (step.delayMs > 0) await sleep(step.delayMs)
  }
}

function escalate(label: string, reason: string, consecutiveDead: number): void {
  // Dynamic duration: consecutiveDead probes at PROBE_INTERVAL_MS each. On a
  // re-alert (after the 30min cooldown, still dead) this grows past the initial
  // ~9min, so a hardcoded value would lie -- compute it from the probe count.
  const approxMin = Math.round((consecutiveDead * PROBE_INTERVAL_MS) / 60_000)
  const msg = `🔐 A(z) ${label} ágens halott OAuth tokent jelez (${reason}) több mint ~${approxMin} perce, és az automatikus újraindítás sem gyógyította (a refresh token is lejárt). Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb).`
  execFile('/bin/bash', [NOTIFY_SCRIPT, msg], { timeout: 10_000 }, (err) => {
    if (err) logger.warn({ err, label }, 'reauth-healer: notify.sh escalation failed')
  })
}

// One-shot best-effort restart of a confirmed dead-token-but-alive session.
// Sub-agents: a full stop+start. The MAIN always-on session: respawn-pane
// --continue via resumeMarveenSession (preserves the conversation, never kicks
// the attached client) -- but deferred if any other watcher (channel-monitor,
// stuck-tool-call-watcher, external systemd timer) respawned it inside the grace
// window, so we never double-respawn the main pane. The decision has already
// latched restartedAtMs either way, so a deferred restart still advances us into
// the grace tier rather than re-restarting next tick.
function performAutoRestart(label: string, session: string, isMain: boolean, reason?: string): void {
  if (isMain) {
    const sinceLastRespawn = Date.now() - lastMainRespawnAt()
    if (sinceLastRespawn < RESTART_GRACE_MS) {
      logger.warn({ label, session, sinceLastRespawn }, 'reauth-healer: dead main token, but the main session was respawned recently -- deferring to that respawn (state already latched)')
      return
    }
    logger.error({ label, session, reason }, 'reauth-healer: dead OAuth token on live MAIN session -- auto-restart via resumeMarveenSession (respawn-pane --continue)')
    try {
      resumeMarveenSession()
    } catch (err) {
      logger.warn({ err, label }, 'reauth-healer: main auto-restart (resumeMarveenSession) threw')
    }
    return
  }
  logger.error({ label, session, reason }, 'reauth-healer: dead OAuth token on live sub-agent -- auto-restart (stop+start)')
  try {
    const r = restartAgentProcess(label)
    if (!r.ok) logger.warn({ label, error: r.error }, 'reauth-healer: sub-agent auto-restart failed')
  } catch (err) {
    logger.warn({ err, label }, 'reauth-healer: sub-agent auto-restart threw')
  }
}

// Tier 2 (MAIN only): the soft --continue respawn failed to re-mint the token,
// so do a FRESH respawn (no --continue) via hardRestartMarveenChannels. This is
// the action that actually healed the 2026-06-14 outage. Conversation continuity
// is sacrificed (the fresh process has no --continue), but the soft restart has
// already failed and the deterministic conversation ledger restores recent
// context on the fresh boot.
function performHardRestart(label: string, session: string, reason?: string): void {
  logger.error({ label, session, reason }, 'reauth-healer: soft --continue restart did not re-mint the token -- escalating to a FRESH respawn (no --continue)')
  try {
    const r = hardRestartMarveenChannels()
    if (!r.ok) logger.warn({ label, error: r.error }, 'reauth-healer: main hard-restart failed')
  } catch (err) {
    logger.warn({ err, label }, 'reauth-healer: main hard-restart threw')
  }
}

function checkSession(label: string, session: string, isMain: boolean): void {
  const pane = capturePane(session)
  const sessionAlive = pane != null
  const reauth = detectReauthNeeded(pane)
  const prev = watchState.get(session) ?? NO_REAUTH_STATE

  const decision = decideReauthAction(
    { isDeadToken: reauth.needsReauth, sessionAlive, isMain, prev, nowMs: Date.now() },
    { restartThreshold: RESTART_THRESHOLD, restartGraceMs: RESTART_GRACE_MS, cooldownMs: ESCALATION_COOLDOWN_MS },
  )

  if (decision.next.consecutiveDead === 0) {
    watchState.delete(session)
  } else {
    watchState.set(session, decision.next)
  }

  if (decision.restart) {
    performAutoRestart(label, session, isMain, reauth.reason)
  }
  if (decision.hardRestart) {
    performHardRestart(label, session, reauth.reason)
  }
  if (decision.sendKeys) {
    logger.warn({ label, session }, 'reauth-healer: still dead after auto-restart -- best-effort /login send-keys (sub-agent)')
    void sendBestEffortLogin(session)
  }
  if (decision.escalate) {
    logger.error({ label, session, reason: reauth.reason }, 'reauth-healer: dead OAuth token survived auto-restart -- escalating to owner for manual /login')
    escalate(label, reauth.reason ?? 'auth failure', decision.next.consecutiveDead)
  }
}

export function startReauthHealer(): NodeJS.Timeout | null {
  // Production-host only, like the other recovery loops: sending /login keys on
  // a dev box would fight the production host (and there is nothing to heal).
  if (!RESPAWN_ENABLED) {
    logger.info('reauth-healer disabled (respawn is production-only)')
    return null
  }

  function sweep(): void {
    // Main agent: one-shot --continue respawn (heals a refreshable token without
    // losing the conversation) then escalate-only -- still no autonomous /login
    // send-keys into a live always-on conversation. capturePane returns null
    // when it is down -> spell ends.
    try {
      checkSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, true)
    } catch (err) {
      logger.debug({ err }, 'reauth-healer: main agent check error')
    }
    for (const name of listAgentNames()) {
      const session = resolveAgentSession(name)
      if (!isAgentRunning(name)) {
        watchState.delete(session)
        continue
      }
      try {
        checkSession(name, session, false)
      } catch (err) {
        logger.debug({ err, agent: name }, 'reauth-healer: agent check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, PROBE_INTERVAL_MS)
}
