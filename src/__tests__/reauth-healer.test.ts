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

// Restart-first re-auth healer decision (Adam stability-fix #1 + restart tier).
// Conservative: false-positive avoidance is the priority since the action now
// restarts a session. Two tiers: one-shot restart heals the refreshable-token
// case; escalation only fires once the restart has demonstrably failed.
describe('decideReauthAction', () => {
  it('clean token resets the spell, no action', () => {
    const d = decideReauthAction(base({ isDeadToken: false, prev: { consecutiveDead: 2, lastActionAtMs: 5, restartedAtMs: 5 } }), T)
    expect(d.restart).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next).toEqual(NO_REAUTH_STATE)
  })

  it('dead session-gone resets the spell (capture-null treated as not-applicable)', () => {
    const d = decideReauthAction(base({ sessionAlive: false, prev: { consecutiveDead: 2, lastActionAtMs: null, restartedAtMs: 1 } }), T)
    expect(d.restart).toBe(false)
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

  it('2nd consecutive dead probe fires the one-shot restart (not escalation)', () => {
    const d = decideReauthAction(base({ prev: { consecutiveDead: 1, lastActionAtMs: null, restartedAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.restart).toBe(true)
    expect(d.escalate).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.next.restartedAtMs).toBe(2_000_000)
    expect(d.next.consecutiveDead).toBe(2)
  })

  it('main agent restarts too (the conversation-preserving --continue respawn)', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 1, lastActionAtMs: null, restartedAtMs: null } }), T)
    expect(d.restart).toBe(true)
    expect(d.escalate).toBe(false)
  })

  it('within the post-restart grace: do not judge it still-dead, no action', () => {
    const restartedAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 2, lastActionAtMs: null, restartedAtMs },
      nowMs: restartedAtMs + 2 * 60 * 1000, // 2 min later, inside the 5 min grace
    }), T)
    expect(d.restart).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next.restartedAtMs).toBe(restartedAtMs) // latch preserved
    expect(d.next.consecutiveDead).toBe(3)
  })

  it('still dead past the grace: escalates + send-keys (sub-agent), no second restart', () => {
    const restartedAtMs = 1_000_000
    const nowMs = restartedAtMs + 6 * 60 * 1000 // past the 5 min grace
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 3, lastActionAtMs: null, restartedAtMs },
      nowMs,
    }), T)
    expect(d.restart).toBe(false)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(true)
    expect(d.next.lastActionAtMs).toBe(nowMs)
    expect(d.next.restartedAtMs).toBe(restartedAtMs) // never restarts twice in one spell
  })

  it('main agent past the grace escalates but does NOT send-keys', () => {
    const restartedAtMs = 1_000_000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 3, lastActionAtMs: null, restartedAtMs },
      nowMs: restartedAtMs + 6 * 60 * 1000,
    }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false)
  })

  it('cooldown: still-dead within 30min of the last alert does not re-fire', () => {
    const restartedAtMs = 1_000_000
    const lastActionAtMs = restartedAtMs + 6 * 60 * 1000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 5, lastActionAtMs, restartedAtMs },
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
      prev: { consecutiveDead: 12, lastActionAtMs, restartedAtMs },
      nowMs,
    }), T)
    expect(d.escalate).toBe(true)
    expect(d.next.lastActionAtMs).toBe(nowMs)
  })

  it('full lifecycle: dead -> restart heals -> reset -> a later spell restarts again', () => {
    // dead probe 1: debounce
    let s: ReauthHealerState = NO_REAUTH_STATE
    let r = decideReauthAction(base({ prev: s, nowMs: 1_000 }), T)
    expect(r.restart).toBe(false)
    s = r.next
    // dead probe 2: restart fires
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
})
