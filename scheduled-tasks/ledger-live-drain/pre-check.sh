#!/usr/bin/env bash
# preCheck gate for the ledger-live-drain scheduled task.
#
# Without it the runner injects the task prompt into the agent's session every
# 2 minutes, so the model wakes up, reads its whole context and runs a script
# that prints nothing -- ~720 wake-ups a day to conclude "nothing to do".
#
# This runs in the SCHEDULER process instead: it prints SKIP when there is no
# unanswered inbound (the runner then drops the tick with zero model calls),
# and otherwise prints a line that the runner injects as the [Pre-check
# eredmeny] prefix, which wakes the session exactly when there is work.
#
# --peek is deliberate: the gate must not consume the drain's dedup marker,
# because a tick can still be dropped after the gate passes (skipIfBusy, a dead
# session) and the question would then never be surfaced. Marking stays in the
# session's own run of the script.
#
# Fail-open by contract: any failure exits 0 with no output, which the runner
# reads as "run the LLM anyway" -- the old behaviour, never silence.
set -u

DRAIN="{{PROJECT_ROOT}}/scripts/hooks/ledger-live-drain.py"

cd "{{PROJECT_ROOT}}" 2>/dev/null || exit 0

# Version guard: an update that ships a drain WITHOUT --peek would make this
# gate run the full surfacing path -- which consumes the dedup marker outside a
# session, exactly the loss this design avoids. Unknown flag -> fail open.
grep -q 'PEEK_FLAG' "$DRAIN" 2>/dev/null || exit 0

out="$(python3 "$DRAIN" --peek 2>/dev/null)" || exit 0

if [ -z "${out//[[:space:]]/}" ]; then
  echo "SKIP"
else
  echo "$out"
fi
