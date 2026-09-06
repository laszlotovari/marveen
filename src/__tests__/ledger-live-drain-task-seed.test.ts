import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// docs/conversation-continuity.md promises that ledger-live-drain.py is "run
// every ~2 min by the ledger-live-drain scheduled task" -- but no such task was
// ever shipped: scheduled-tasks/ only seeded dream-engine, memoria-heartbeat
// and reggeli-napindito, so the drain NEVER ran and the mid-session deafness
// gap it exists to close stayed open. Same dead-feature class as the
// skill-usage-capture registration gap: tested logic, zero production wiring.
// These tests pin the promise to the seed.

const ROOT = join(__dirname, '..', '..')
const TASK_DIR = join(ROOT, 'scheduled-tasks', 'ledger-live-drain')

describe('ledger-live-drain scheduled-task seed', () => {
  it('the task the docs promise is actually shipped', () => {
    expect(existsSync(join(TASK_DIR, 'task-config.json'))).toBe(true)
    expect(existsSync(join(TASK_DIR, 'SKILL.md'))).toBe(true)
  })

  it('config parses, is enabled, and runs on the ~2-minute cadence the docs state', () => {
    const cfg = JSON.parse(readFileSync(join(TASK_DIR, 'task-config.json'), 'utf-8'))
    expect(cfg.enabled).toBe(true)
    expect(cfg.schedule).toBe('*/2 * * * *')
    // Seeded for the main agent; copyTaskConfigWithAgentRewrite() rewrites this
    // to the install's MAIN_AGENT_ID, but only when the field is a string.
    expect(typeof cfg.agent).toBe('string')
  })

  it('the prompt invokes the drain script via the placeholder the seeder resolves', () => {
    const skill = readFileSync(join(TASK_DIR, 'SKILL.md'), 'utf-8')
    expect(skill).toContain('{{PROJECT_ROOT}}/scripts/hooks/ledger-live-drain.py')
  })

  it('the drain script the task invokes exists', () => {
    expect(existsSync(join(ROOT, 'scripts', 'hooks', 'ledger-live-drain.py'))).toBe(true)
  })

  // The task fires every 2 minutes and its script prints nothing almost every
  // time, so without a preCheck gate the runner wakes the model ~720x/day to
  // read an empty stdout. runPreCheck() has existed (and been tested) all
  // along, but no shipped task used it -- the same dead-feature class this
  // file was written for.
  it('is gated by a preCheck script so an empty tick costs no model call', () => {
    const cfg = JSON.parse(readFileSync(join(TASK_DIR, 'task-config.json'), 'utf-8'))
    expect(cfg.preCheck).toBe('pre-check.sh')
    expect(existsSync(join(TASK_DIR, 'pre-check.sh'))).toBe(true)
  })

  it('the gate probes read-only (--peek) and never consumes the dedup marker', () => {
    const gate = readFileSync(join(TASK_DIR, 'pre-check.sh'), 'utf-8')
    // A tick can still be dropped after the gate passes (skipIfBusy, dead
    // session). If the gate ran the surfacing path, that message would be
    // marked surfaced and then lost for good.
    expect(gate).toContain('--peek')
    const drain = readFileSync(join(ROOT, 'scripts', 'hooks', 'ledger-live-drain.py'), 'utf-8')
    expect(drain).toContain('PEEK_FLAG')
    const peekBlock = drain.slice(drain.indexOf('if peek:'))
    expect(peekBlock.slice(0, peekBlock.indexOf('snippet ='))).not.toContain('_record_surfaced')
  })

  it('the gate emits SKIP and resolves the install path via the seeder placeholder', () => {
    const gate = readFileSync(join(TASK_DIR, 'pre-check.sh'), 'utf-8')
    expect(gate).toContain('echo "SKIP"')
    expect(gate).toContain('{{PROJECT_ROOT}}/scripts/hooks/ledger-live-drain.py')
  })

  // A drain without --peek would treat the flag as noise and run the SURFACING
  // path from the scheduler, consuming the dedup marker outside any session.
  // The gate checks the script it is about to call and fails open instead.
  it('the gate refuses to run a drain that does not know --peek', () => {
    const gate = readFileSync(join(TASK_DIR, 'pre-check.sh'), 'utf-8')
    expect(gate).toContain("grep -q 'PEEK_FLAG'")
  })
})
