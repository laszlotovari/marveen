/**
 * Screenshot capture tool for the dashboard-kezikonyv (user manual).
 *
 * Not a pass/fail test suite -- each "test" just navigates to a dashboard
 * page and saves a PNG into ./kepek/. Named *.shots.ts, not *.spec.ts, so the
 * repo's vitest run does not collect it (it throws without DASHBOARD_TOKEN).
 * Point it at the DEMO instance only, never at a live one:
 *
 *   DASHBOARD_URL=http://localhost:3421 DASHBOARD_TOKEN=$(cat ~/marveen-demo/app/store/.dashboard-token) \
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
  {
    // The former Activity page is now the Agents page's "Aktivitás" view; its
    // live body is filled by a 3s poll, so wait one full tick after switching.
    name: '04b-ugynokok-aktivitas',
    page: 'agents',
    after: async (p) => {
      await p.click('#agentsViewActivity')
      await p.waitForTimeout(3500)
    },
  },
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

// #toast is position:fixed and "hidden" only by a translateY(100px) below the
// bottom edge (web/style.css .toast). Once the viewport is grown to the page's
// scrollHeight (below), that parked toast peeks in as a dark bar at the bottom
// centre -- measured on the Kanban shot, 2026-10-01. display:none removes it
// whatever its state, instead of racing showToast()'s 3s auto-hide.
async function hideToast(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const toast = document.getElementById('toast')
    if (toast) toast.style.display = 'none'
  })
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
    await hideToast(page)
    // Chromium's fullPage screenshot stitches multiple viewport-sized frames
    // together for any page taller than the configured viewport, and that
    // stitching pass reliably left a solid black rounded-rect compositing
    // glitch at the same pixel offset (704,952) on every page that needed
    // more than one frame -- confirmed by pixel-scanning several captures.
    // Growing the viewport to the page's actual scrollHeight first means a
    // single-frame capture covers everything, so `fullPage` never has to
    // stitch, sidestepping the glitch entirely.
    const contentHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    await page.setViewportSize({ width: 1440, height: contentHeight })
    await page.screenshot({ path: path.join(KEPEK_DIR, `${shot.name}.png`), fullPage: true })
  })
}
