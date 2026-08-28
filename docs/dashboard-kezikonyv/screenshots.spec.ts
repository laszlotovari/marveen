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
  {
    name: '01-attekintes',
    page: 'overview',
    after: async (p) => {
      // SAMPLE-ONLY SAFEGUARD: this is Laci's own live instance, and the
      // Aktivitás feed shows real internal project chatter (client names,
      // security-finding card titles) that must never appear in a
      // customer-facing manual. Hide it until a clean/demo dashboard
      // instance is available for the final capture pass (see kanban
      // e6faf48c discussion) -- do NOT remove this without checking that
      // decision first.
      await p.evaluate(() => {
        const card = document.getElementById('overviewActivity')?.closest('.overview-card')
        if (card) (card as HTMLElement).style.visibility = 'hidden'
      })
    },
  },
  { name: '02-kanban', page: 'kanban' },
  {
    name: '02b-kanban-archivaltak',
    page: 'kanban',
    after: async (p) => {
      await p.click('#kanbanViewArchived')
      await p.waitForTimeout(400)
    },
  },
]

test.beforeEach(async ({ page }) => {
  // Force light theme so every screenshot is visually consistent, regardless
  // of whatever theme this browser profile last saved.
  await page.addInitScript(() => {
    window.localStorage.setItem('cc-theme', 'light')
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
