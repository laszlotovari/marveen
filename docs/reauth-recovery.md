# reauth-recovery — autonomous OAuth re-auth healer

## Problem

A Marveen agent logs in to Claude Code with a subscription OAuth token that
**expires every ~8 hours**. When that happens to a session that is otherwise
process-*alive* but idle, the next request fails with a `401` and the agent
**silently stops working** — it stops answering Telegram, the dashboard activity
panel errors, and the only fix used to be a manual browser `/login`.

Two different failure modes hide behind the same `401`:

1. **Refreshable** — the 8h *access* token lapsed but the *refresh* token is
   still valid. A **fresh** `claude` process re-mints the access token silently
   on start. This is the common case.
2. **Fully expired** — the refresh token itself is dead. No restart helps; a
   human browser authorize step is required.

The plain watchdog only restarts *missing* sessions, and the dashboard reauth
badge only *surfaces* the dead-token state. Neither acts on an alive-but-401
session.

## What the healer does

`src/web/reauth-healer.ts` runs an in-process probe loop (every 3 min, after a
90s boot offset) over the main agent and every running sub-agent. For each it
captures the tmux pane, scans the live tail for distinctive auth-failure markers
(`src/web/reauth-detect.ts`), and drives a **three-tier escalation ladder** via a
pure, unit-tested decision function (`decideReauthAction`):

1. **Soft restart** — after 2 consecutive dead probes (debounces a blip),
   restart once. Sub-agents: a full `stop+start` (already a fresh process). The
   main always-on channels session: `resumeMarveenSession` (`tmux respawn-pane
   --continue`), which preserves the conversation and never kicks an attached
   client.
2. **Hard restart (main agent only)** — if the main session is *still* dead a
   boot-grace later, do one **fresh** respawn with no `--continue`
   (`hardRestartMarveenChannels`). This is necessary because a `--continue`
   respawn resumes the conversation **without making a startup API call**, so
   Claude Code's lazy token refresh never triggers and a refreshable token stays
   dead. A fresh process re-mints it reliably. Sub-agents skip this tier — their
   tier-1 restart was already fresh, so a second identical restart cannot heal.
3. **Escalate** — if it is *still* dead after every applicable restart, the
   refresh token is genuinely expired. Page the owner via `scripts/notify.sh`
   (plugin-independent Bot API, so the alert arrives even when the channel plugin
   is also wedged) for a manual `/login`, re-alerting at most once per 30 min.
   Sub-agents additionally get a best-effort `/login` send-keys here.

Each restart tier latches (`restartedAtMs` / `hardRestartedAtMs`), so a
genuinely-expired token restarts **at most twice** per dead-spell and can never
drive a respawn loop. A clean probe (token healed, or session gone) ends the
spell and re-arms the ladder.

## Production-host gating

The healer takes restart/keys actions only when `RESPAWN_ENABLED` is true (the
same gate as the other recovery loops), so a dev box running the same checkout
never fights the production host. On a single-host install it defaults on.

## Where to look when it misbehaves

Application logs go to `store/dashboard.log` (pino), **not** journald. Grep it for
`reauth-healer` to see the exact tier transitions and timestamps for any
dead-spell. The pure decision is covered by `src/__tests__/reauth-healer.test.ts`.

## Related

A complementary **proactive** layer (refreshing the token *before* it expires, so
an idle session never serves a `401` in the first place) is tracked separately.
This document covers the **reactive** healer.
