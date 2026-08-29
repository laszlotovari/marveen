/**
 * Screenshot capture tool for the dashboard-kezikonyv (user manual).
 *
 * Not a pass/fail test suite -- each "test" just navigates to a dashboard
 * page and saves a PNG into ./kepek/. Run with:
 *
 *   DASHBOARD_URL=http://localhost:3420 DASHBOARD_TOKEN=$(cat store/.dashboard-token) \
 *     npx playwright test --config=docs/dashboard-kezikonyv/playwright.screenshots.config.ts
 *
 * To capture a subset while iterating, pass -g "<title fragment>".
 */

import { test } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const TOKEN = process.env.DASHBOARD_TOKEN || ''
if (!TOKEN) {
  throw new Error('DASHBOARD_TOKEN is not set (cat store/.dashboard-token).')
}

const KEPEK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kepek')

// One entry per screenshot. `page` is the switchPage() key; `after` runs
// extra UI actions once that page has loaded (e.g. opening a sub-view).
// `name` becomes the PNG filename (without extension).
type Shot = {
  name: string
  page: string
  after?: (p: import('@playwright/test').Page) => Promise<void>
}

const SHOTS: Shot[] = [
  { name: '01-attekintes', page: 'overview' },
  { name: '02-kanban', page: 'kanban' },
  {
    name: '02b-kanban-archivaltak',
    page: 'kanban',
    after: async (p) => {
      await p.click('#kanbanViewArchived')
      await p.waitForTimeout(400)
    },
  },
  { name: '03-jovahagyasok', page: 'approvals' },
  { name: '04-ugynokok', page: 'agents' },
  { name: '05-aktivitas', page: 'activity' },
  { name: '06-uzenetek', page: 'messages' },
  { name: '07-utemezesek', page: 'tasks' },
  { name: '08-hatter', page: 'bgTasks' },
  { name: '09-memoria', page: 'memories' },
  { name: '10-naplo', page: 'naplo' },
  { name: '11-skillek', page: 'skills' },
  { name: '12-kutatas', page: 'research' },
  { name: '13-otletlada', page: 'ideas' },
  { name: '14-koltsegek', page: 'costs' },
  { name: '15-token-monitor', page: 'tokenUsage' },
  { name: '16-statusz', page: 'status' },
  { name: '17-frissitesek', page: 'updates' },
  { name: '18-beallitasok', page: 'settings' },
  { name: '19-vault', page: 'vault' },
  { name: '20-mcp', page: 'connectors' },
  { name: '21-federacio', page: 'federation' },
  { name: '22-koltoztetes', page: 'migrate' },
  { name: '23-dokumentacio', page: 'docs' },
]

test.beforeEach(async ({ page }) => {
  // Force light theme so every screenshot is visually consistent, regardless
  // of whatever theme this browser profile last saved. Also dismiss the
  // first-run onboarding wizard ('Marveen beallitasa': Nev / Claude auth /
  // Telegram bot / Parositas) -- on a fresh install it covers every page
  // full-screen and has no server-side toggle, only this localStorage flag.
  await page.addInitScript(() => {
    window.localStorage.setItem('cc-theme', 'light')
    window.localStorage.setItem('mvOnboardingDismissed', '1')
  })
})

// Dismiss the dev-branch-drift and no-auth-configured banners: they reflect
// this specific checkout's transient setup state, not what a properly
// configured customer install looks like, and would be confusing/misleading
// in a manual screenshot.
async function dismissSetupBanners(page: import('@playwright/test').Page) {
  for (const id of ['branchDriftDismiss', 'authBannerDismiss']) {
    const btn = page.locator(`#${id}`)
    if (await btn.isVisible().catch(() => false)) await btn.click()
  }
}

for (const shot of SHOTS) {
  test(`capture: ${shot.name}`, async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    await page.waitForLoadState('networkidle')
    await page.evaluate((key) => {
      ;(window as unknown as { switchPage: (k: string) => void }).switchPage(key)
    }, shot.page)
    await page.waitForTimeout(600) // let the page's own load*() fetch + render settle
    await dismissSetupBanners(page)
    if (shot.after) await shot.after(page)
    await page.screenshot({ path: path.join(KEPEK_DIR, `${shot.name}.png`), fullPage: true })
  })
}
