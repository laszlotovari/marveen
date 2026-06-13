import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, RESPAWN_ENABLED } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane, restartAgentProcess } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { resumeMarveenSession, lastMainRespawnAt } from './channel-monitor.js'
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
// So the loop is now: autonomous DETECTION -> one best-effort RESTART (heals
// case 1 silently) -> if still dead past a boot grace, LOUD escalation to the
// owner via notify.sh (plugin-independent Bot API, so it reaches the owner even
// when the channel plugin is also wedged) for the manual browser /login.
//
// Restart action: sub-agents via restartAgentProcess (stop+start); the MAIN
// always-on channels session via resumeMarveenSession (tmux respawn-pane
// --continue -- preserves the conversation, never kicks the attached client,
// and writes the shared respawn stamp so the other watchers defer). The restart
// is ONE-SHOT per dead-spell (restartedAtMs latches), so a genuinely-expired
// token can never drive a respawn loop: it restarts once, then only escalates.
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
  restartedAtMs: number | null  // when the one-shot auto-restart fired this spell (null = not yet)
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
  restart: boolean    // one-shot best-effort restart (heals the refreshable case)
  sendKeys: boolean   // best-effort autonomous /login (sub-agents only, after restart failed)
  escalate: boolean   // notify.sh alert to the owner (after restart failed)
  next: ReauthHealerState
}

export const NO_REAUTH_STATE: ReauthHealerState = { consecutiveDead: 0, lastActionAtMs: null, restartedAtMs: null }

/**
 * Pure decision for the healer. A clean probe (token healed, or session gone)
 * resets the spell. A confirmed dead-token-but-alive session goes through two
 * tiers: first ONE best-effort restart (after `restartThreshold` consecutive
 * dead probes, which heals the refreshable-token case silently), then -- if it
 * is still dead once `restartGraceMs` has elapsed since that restart -- escalate
 * to the owner, re-firing no more than once per `cooldownMs`. The restart latches
 * via `restartedAtMs`, so a genuinely-expired token restarts at most once per
 * spell and can never drive a respawn loop. send-keys never fires for the main
 * agent.
 */
export function decideReauthAction(input: ReauthHealerInput, t: ReauthHealerThresholds): ReauthHealerDecision {
  const { isDeadToken, sessionAlive, isMain, prev, nowMs } = input

  // Clean / not-applicable: end the spell, allow a fresh heal next time.
  if (!isDeadToken || !sessionAlive) {
    return { restart: false, sendKeys: false, escalate: false, next: NO_REAUTH_STATE }
  }

  const consecutiveDead = prev.consecutiveDead + 1
  const noop = (next: ReauthHealerState): ReauthHealerDecision =>
    ({ restart: false, sendKeys: false, escalate: false, next })

  // Tier 1 -- one-shot restart. After `restartThreshold` consecutive dead probes
  // (debounces a transient blip), restart ONCE. A fresh process re-mints a
  // refreshable token silently; restartedAtMs latches so we never loop.
  if (prev.restartedAtMs == null) {
    if (consecutiveDead < t.restartThreshold) {
      return noop({ consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: null })
    }
    return {
      restart: true, sendKeys: false, escalate: false,
      next: { consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: nowMs },
    }
  }

  // Post-restart grace -- the fresh process needs time to boot and make its
  // first authenticated call. A dead reading inside the window is likely stale
  // boot output, so do not judge it yet.
  if (nowMs - prev.restartedAtMs < t.restartGraceMs) {
    return noop({ consecutiveDead, lastActionAtMs: prev.lastActionAtMs, restartedAtMs: prev.restartedAtMs })
  }

  // Tier 2 -- the restart did not heal it (still dead past the grace): the
  // fully-expired case. Escalate to the owner for a manual browser /login, and
  // (sub-agents only) fire a best-effort /login into the session. Rate-limited.
  const cooldownElapsed = prev.lastActionAtMs == null || (nowMs - prev.lastActionAtMs) >= t.cooldownMs
  return {
    restart: false,
    sendKeys: cooldownElapsed && !isMain,
    escalate: cooldownElapsed,
    next: {
      consecutiveDead,
      lastActionAtMs: cooldownElapsed ? nowMs : prev.lastActionAtMs,
      restartedAtMs: prev.restartedAtMs,
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
