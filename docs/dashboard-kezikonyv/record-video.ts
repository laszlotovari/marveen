/**
 * Raw screen-recording capture for the FB video creative (see
 * docs/marween-onprem-fb-video-kreativ.md, "A koncepció" scene list).
 *
 * Produces ONE continuous, unedited, no-caption, no-audio screen recording of
 * the dashboard-kezikonyv demo instance: Áttekintés (Csapat) -> Ügynökök
 * (kártyák) -> Kanban -> Üzenetek (FÜGGŐBEN pillanat) -> Áttekintés
 * (Aktivitás feed). Vágás, felirat és hang Sophie/Laci oldalán készül -- ez a
 * lépés csak a nyersanyagot adja.
 *
 * Usage:
 *   DASHBOARD_URL=http://localhost:3421 DASHBOARD_TOKEN=$(cat ~/marveen-demo/app/store/.dashboard-token) \
 *     npx tsx docs/dashboard-kezikonyv/record-video.ts
 *
 * Same DASHBOARD_URL guard as the stills tool: never silently point at a live
 * instance. Output lands in ./video/raw.webm (Playwright names it by a
 * generated hash; the script renames it after close()).
 */
import { chromium } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { readdirSync, renameSync, mkdirSync } from 'fs'

const DASHBOARD_URL = process.env.DASHBOARD_URL
if (!DASHBOARD_URL) {
  throw new Error(
    [
      'DASHBOARD_URL is not set.',
      'Point it at the dashboard instance to record, e.g.:',
      '  DASHBOARD_URL=http://localhost:3421 npx tsx docs/dashboard-kezikonyv/record-video.ts',
    ].join('\n'),
  )
}
const TOKEN = process.env.DASHBOARD_TOKEN || ''
if (!TOKEN) throw new Error('DASHBOARD_TOKEN is not set (cat store/.dashboard-token).')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIDEO_DIR = path.join(HERE, 'video')
mkdirSync(VIDEO_DIR, { recursive: true })

async function switchPage(page: import('@playwright/test').Page, key: string) {
  await page.evaluate((k) => {
    ;(window as unknown as { switchPage: (k: string) => void }).switchPage(k)
  }, key)
}

// Smoothly move the mouse to an element's center over several intermediate
// steps -- a raw camera-ready recording should not show teleporting cursors.
async function hoverSmooth(page: import('@playwright/test').Page, locator: import('@playwright/test').Locator, holdMs: number) {
  const box = await locator.boundingBox()
  if (!box) return
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 })
  await page.waitForTimeout(holdMs)
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1920, height: 1080 } },
  })
  const page = await context.newPage()

  await page.addInitScript(() => {
    window.localStorage.setItem('cc-theme', 'light')
    window.localStorage.setItem('mvOnboardingDismissed', '1')
  })

  await page.goto(`${DASHBOARD_URL}/?token=${TOKEN}`)
  await page.waitForLoadState('networkidle')
  for (const id of ['branchDriftDismiss', 'authBannerDismiss']) {
    const btn = page.locator(`#${id}`)
    if (await btn.isVisible().catch(() => false)) await btn.click()
  }

  // --- 1. Áttekintés: Csapat doboz -------------------------------------
  await switchPage(page, 'overview')
  await page.waitForTimeout(1200)
  await hoverSmooth(page, page.locator('#overviewTeamGrid'), 3500)
  await page.mouse.move(0, 0) // idle drift, avoid a static cursor sitting on one node
  await page.waitForTimeout(5500)

  // --- 2. Ügynökök: kurzor végigpásztáz a kártyákon ---------------------
  await switchPage(page, 'agents')
  await page.waitForTimeout(1000)
  const cards = page.locator('.agent-card:not(.add-card)')
  const cardCount = await cards.count()
  for (let i = 0; i < cardCount; i++) {
    await hoverSmooth(page, cards.nth(i), 3300)
  }

  // --- 3. Kanban tábla ----------------------------------------------------
  await switchPage(page, 'kanban')
  await page.waitForTimeout(1200)
  const kanbanCards = page.locator('.kanban-card')
  const kCount = Math.min(await kanbanCards.count(), 4)
  for (let i = 0; i < kCount; i++) {
    await hoverSmooth(page, kanbanCards.nth(i), 2300)
  }
  await page.waitForTimeout(2500)

  // --- 4. Üzenetek: delegálás + FÜGGŐBEN pillanat ------------------------
  await switchPage(page, 'messages')
  await page.waitForTimeout(1800)
  const pending = page.getByText('FÜGGŐBEN', { exact: true }).first()
  if (await pending.isVisible().catch(() => false)) {
    await hoverSmooth(page, pending, 7000)
  } else {
    await page.waitForTimeout(7000)
  }
  await page.waitForTimeout(3000)

  // --- 5. Vissza az Áttekintésre: Aktivitás feed -------------------------
  await switchPage(page, 'overview')
  await page.waitForTimeout(1200)
  await hoverSmooth(page, page.locator('#overviewActivity'), 2800)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(3000)
  await page.mouse.wheel(0, -200)
  await page.waitForTimeout(4000)

  await context.close()
  await browser.close()

  // Playwright names the file by an internal id; rename to something stable.
  const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'))
  const latest = files.sort().pop()
  if (latest) {
    const dest = path.join(VIDEO_DIR, 'raw-a-koncepcio.webm')
    renameSync(path.join(VIDEO_DIR, latest), dest)
    console.log('Video mentve:', dest)
  } else {
    console.error('Nem talalhato .webm kimenet a video/ mappaban.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
