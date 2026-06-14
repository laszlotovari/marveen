import { describe, it, expect } from 'vitest'
import { decideReauthAction, NO_REAUTH_STATE, type ReauthHealerState } from '../web/reauth-healer.js'

const T = { restartThreshold: 2, restartGraceMs: 5 * 60 * 1000, cooldownMs: 30 * 60 * 1000 }
const base = (over: Partial<Parameters<typeof decideReauthAction>[0]> = {}) => ({
  isDeadToken: true,
  sessionAlive: true,
  isMain: false,
  prev: NO_REAUTH_STATE,
  nowMs: 1_000_000,
  ...over,
})

// Restart-first re-auth healer decision (Adam stability-fix #1 + restart tiers).
// Conservative: false-positive avoidance is the priority since the action now
// restarts a session. Three tiers: a SOFT restart heals the refreshable-token
// case; for the MAIN agent a HARD restart (fresh respawn) re-mints when the
// conversation-preserving --continue restart could not (2026-06-14); escalation
// only fires once every applicable restart has demonstrably failed.
describe('decideReauthAction', () => {
  it('clean token resets the spell, no action', () => {
    const d = decideReauthAction(base({ isDeadToken: false, prev: { consecutiveDead: 2, lastActionAtMs: 5, restartedAtMs: 5, hardRestartedAtMs: 5 } }), T)
    expect(d.restart).toBe(false)
    expect(d.hardRestart).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next).toEqual(NO_REAUTH_STATE)
  })

  it('dead session-gone resets the spell (capture-null treated as not-applicable)', () => {
    const d = decideReauthAction(base({ sessionAlive: false, prev: { consecutiveDead: 2, lastActionAtMs: null, restartedAtMs: 1, hardRestartedAtMs: null } }), T)
    expect(d.restart).toBe(false)
    expect(d.hardRestart).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next.consecutiveDead).toBe(0)
  })

  it('debounces: 1st dead probe does not act', () => {
    const p1 = decideReauthAction(base({ prev: NO_REAUTH_STATE }), T)
    expect(p1.restart).toBe(false)
    expect(p1.escalate).toBe(false)
    expect(p1.next.consecutiveDead).toBe(1)
    expect(p1.next.restartedAtMs).toBeNull()
  })

  it('2nd consecutive dead probe fires the one-shot SOFT restart (not escalation)', () => {
    const d = decideReauthAction(base({ prev: { consecutiveDead: 1, lastActionAtMs: null, restartedAtMs: null, hardRestartedAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.restart).toBe(true)
    expect(d.hardRestart).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.next.restartedAtMs).toBe(2_000_000)
    expect(d.next.hardRestartedAtMs).toBeNull()
    expect(d.next.consecutiveDead).toBe(2)
  })

  it('main agent soft-restarts too (the conversation-preserving --continue respawn)', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 1, lastActionAtMs: null, restartedAtMs: null, hardRestartedAtMs: null } }), T)
    expect(d.restart).toBe(true)
    expect(d.hardRestart).toBe(false)
    expect(d.escalate).toBe(false)
  })

  it('within the post-soft-restart grace: do not judge it still-dead, no action', () => {
    const restartedAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 2, lastActionAtMs: null, restartedAtMs, hardRestartedAtMs: null },
      nowMs: restartedAtMs + 2 * 60 * 1000, // 2 min later, inside the 5 min grace
    }), T)
    expect(d.restart).toBe(false)
    expect(d.hardRestart).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next.restartedAtMs).toBe(restartedAtMs) // latch preserved
    expect(d.next.consecutiveDead).toBe(3)
  })

  it('SUB-AGENT still dead past the grace: escalates + send-keys, NO hard restart', () => {
    const restartedAtMs = 1_000_000
    const nowMs = restartedAtMs + 6 * 60 * 1000 // past the 5 min grace
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 3, lastActionAtMs: null, restartedAtMs, hardRestartedAtMs: null },
      nowMs,
    }), T)
    expect(d.restart).toBe(false)
    expect(d.hardRestart).toBe(false) // sub-agent Tier-1 was already a fresh restart
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(true)
    expect(d.next.lastActionAtMs).toBe(nowMs)
    expect(d.next.restartedAtMs).toBe(restartedAtMs) // never restarts twice in one spell
  })

  it('MAIN still dead past the soft grace: HARD restart, no escalation yet, no send-keys', () => {
    const restartedAtMs = 1_000_000
    const nowMs = restartedAtMs + 6 * 60 * 1000 // past the 5 min soft grace
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 3, lastActionAtMs: null, restartedAtMs, hardRestartedAtMs: null },
      nowMs,
    }), T)
    expect(d.restart).toBe(false)
    expect(d.hardRestart).toBe(true)
    expect(d.escalate).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.next.hardRestartedAtMs).toBe(nowMs) // latch the hard restart
    expect(d.next.restartedAtMs).toBe(restartedAtMs)
  })

  it('MAIN within the post-hard-restart grace: do not judge it still-dead, no action', () => {
    const restartedAtMs = 1_000_000
    const hardRestartedAtMs = restartedAtMs + 6 * 60 * 1000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 4, lastActionAtMs: null, restartedAtMs, hardRestartedAtMs },
      nowMs: hardRestartedAtMs + 2 * 60 * 1000, // inside the 5 min hard grace
    }), T)
    expect(d.restart).toBe(false)
    expect(d.hardRestart).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next.hardRestartedAtMs).toBe(hardRestartedAtMs) // latch preserved
  })

  it('MAIN still dead past the hard-restart grace: escalates, does NOT hard-restart again, does NOT send-keys', () => {
    const restartedAtMs = 1_000_000
    const hardRestartedAtMs = restartedAtMs + 6 * 60 * 1000
    const nowMs = hardRestartedAtMs + 6 * 60 * 1000 // past the hard grace too
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 5, lastActionAtMs: null, restartedAtMs, hardRestartedAtMs },
      nowMs,
    }), T)
    expect(d.hardRestart).toBe(false) // never hard-restarts twice in one spell
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false) // never send-keys for the main agent
    expect(d.next.lastActionAtMs).toBe(nowMs)
  })

  it('cooldown: still-dead within 30min of the last alert does not re-fire (sub-agent)', () => {
    const restartedAtMs = 1_000_000
    const lastActionAtMs = restartedAtMs + 6 * 60 * 1000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 5, lastActionAtMs, restartedAtMs, hardRestartedAtMs: null },
      nowMs: lastActionAtMs + 10 * 60 * 1000, // 10 min after the alert
    }), T)
    expect(d.escalate).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.next.lastActionAtMs).toBe(lastActionAtMs) // unchanged
    expect(d.next.consecutiveDead).toBe(6) // keeps counting
  })

  it('cooldown: re-fires after 30min if still dead (does not forget)', () => {
    const restartedAtMs = 1_000_000
    const lastActionAtMs = restartedAtMs + 6 * 60 * 1000
    const nowMs = lastActionAtMs + 31 * 60 * 1000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 12, lastActionAtMs, restartedAtMs, hardRestartedAtMs: null },
      nowMs,
    }), T)
    expect(d.escalate).toBe(true)
    expect(d.next.lastActionAtMs).toBe(nowMs)
  })

  it('full lifecycle: dead -> soft restart heals -> reset -> a later spell restarts again', () => {
    // dead probe 1: debounce
    let s: ReauthHealerState = NO_REAUTH_STATE
    let r = decideReauthAction(base({ prev: s, nowMs: 1_000 }), T)
    expect(r.restart).toBe(false)
    s = r.next
    // dead probe 2: soft restart fires
    r = decideReauthAction(base({ prev: s, nowMs: 2_000 }), T)
    expect(r.restart).toBe(true)
    s = r.next
    // restart healed it -> clean probe resets the spell
    r = decideReauthAction(base({ isDeadToken: false, prev: s, nowMs: 3_000 }), T)
    expect(r.next).toEqual(NO_REAUTH_STATE)
    s = r.next
    // a fresh dead spell later restarts again (latch was reset)
    r = decideReauthAction(base({ prev: s, nowMs: 9_000_000 }), T)
    expect(r.restart).toBe(false) // debounce
    s = r.next
    r = decideReauthAction(base({ prev: s, nowMs: 9_000_001 }), T)
    expect(r.restart).toBe(true)
  })

  it('MAIN full escalation ladder: soft -> hard -> escalate, each tier once', () => {
    const t0 = 1_000_000
    const grace = T.restartGraceMs
    let s: ReauthHealerState = NO_REAUTH_STATE
    // probe 1: debounce
    let r = decideReauthAction(base({ isMain: true, prev: s, nowMs: t0 }), T)
    expect(r.restart).toBe(false)
    s = r.next
    // probe 2: SOFT restart
    r = decideReauthAction(base({ isMain: true, prev: s, nowMs: t0 + 1 }), T)
    expect(r.restart).toBe(true)
    expect(r.hardRestart).toBe(false)
    s = r.next
    // probe inside soft grace: noop
    r = decideReauthAction(base({ isMain: true, prev: s, nowMs: t0 + grace - 1 }), T)
    expect(r.restart).toBe(false)
    expect(r.hardRestart).toBe(false)
    s = r.next
    // probe past soft grace: HARD restart
    r = decideReauthAction(base({ isMain: true, prev: s, nowMs: t0 + grace + 1 }), T)
    expect(r.hardRestart).toBe(true)
    expect(r.escalate).toBe(false)
    s = r.next
    const hardAt = s.hardRestartedAtMs!
    // probe past hard grace, still dead: ESCALATE (no more restarts)
    r = decideReauthAction(base({ isMain: true, prev: s, nowMs: hardAt + grace + 1 }), T)
    expect(r.restart).toBe(false)
    expect(r.hardRestart).toBe(false)
    expect(r.escalate).toBe(true)
    expect(r.sendKeys).toBe(false)
  })
})
