/* ============================================================================
   bundle-cost.mjs — 包体积到底值多少钱？

   背景：这个插件曾经在冒烟里有一条"包体不得超过 4 MB（后来 6 MB）"的守卫。
   那条红线是我为了"别让它悄悄变胖"自己拍的数，不是任何真实约束 —— 有人问
   "包体哪来的上限"，才把它量清楚：解析代价是 1.45 ms/MB 量级，次线性，
   再加一整套皮肤约 +1.6 ms。红线因此删掉，改成"记录体积 + 量代价"。

   做法：拿真实的 lib/client.js，追加等量字符串字面量（精灵图的 base64 也是字符串
   字面量，所以负担同源），逐个体积在真实 Chromium 里计时。

   RUN
     node tools/bundle-cost.mjs

   浏览器是可选依赖：找不到就以 0 退出并说明原因（同 tools/smoke.mjs）。
   ========================================================================== */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function findPlaywright() {
  /* 与 tools/smoke.mjs、tools/perf.mjs 保持同一套解析顺序：
     profile → 本包 → 开发机检出。Playwright 是可选依赖，找不到就跳过（不是失败）。 */
  const bases = [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'package.json') : null,
    join(here, 'package.json'),
    'E:/deepseek-harness/package.json',
  ].filter((p) => p && existsSync(p))
  for (const base of bases) {
    for (const spec of ['playwright-core', 'playwright', 'playwright-chromium']) {
      try {
        const mod = createRequire(base)(spec)
        if (mod && mod.chromium) return { chromium: mod.chromium, from: `${base} → ${spec}` }
      } catch (e) { /* 试下一个 */ }
    }
  }
  const roots = [process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, '..') : null, here, 'E:/deepseek-harness'].filter(Boolean)
  for (const root of roots) {
    const pnpm = join(root, 'node_modules', '.pnpm')
    if (!existsSync(pnpm)) continue
    for (const entry of readdirSync(pnpm)) {
      if (!/^playwright(-core)?@/.test(entry)) continue
      const pkg = join(pnpm, entry, 'node_modules', 'playwright-core')
      if (!existsSync(pkg)) continue
      try {
        const mod = createRequire(pkg)(pkg)
        if (mod && mod.chromium) return { chromium: mod.chromium, from: pkg }
      } catch (e) { /* 下一个版本 */ }
    }
  }
  return null
}

const playwright = findPlaywright()
if (!playwright) {
  console.log('bundle-cost: 未找到 Playwright —— 跳过测量（这不是失败）')
  process.exit(0)
}

const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
const baseMb = Buffer.byteLength(bundle) / 1048576
console.log(`真实包: ${baseMb.toFixed(2)} MB（lib/client.js）\n`)

const chromeCandidates = [
  process.env.WISP_CHROME,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe') : null,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean)
const executablePath = chromeCandidates.find((p) => existsSync(p))
const browser = await playwright.chromium.launch({ headless: true, executablePath })

console.log('目标体积   实际体积   解析+执行   每 MB')
const rows = []
for (const target of [baseMb, 8, 16, 24]) {
  const extra = Math.max(0, Math.round((target - baseMb) * 1048576))
  const src = extra > 0 ? `${bundle}\n;globalThis.__pad = "${'x'.repeat(extra)}";\n` : bundle
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><head></head><body></body></html>')
  const ms = await page.evaluate((code) => {
    window.__ML = { def: null }
    window.__ModuleLoader__ = { load: (d) => { window.__ML.def = d } }
    const t0 = performance.now()
    new Function(code)()
    window.__ML.def.factory(() => ({}))
    return performance.now() - t0
  }, src)
  await page.close()
  const mb = Buffer.byteLength(src) / 1048576
  rows.push({ mb, ms })
  console.log(`${String(target).padStart(6)} MB  ${mb.toFixed(2).padStart(8)} MB  ${ms.toFixed(1).padStart(8)} ms  ${(ms / mb).toFixed(2)} ms/MB`)
}

const first = rows[0]
const last = rows[rows.length - 1]
const slope = (last.ms - first.ms) / (last.mb - first.mb)
console.log('')
console.log(`  从 ${first.mb.toFixed(1)} MB 到 ${last.mb.toFixed(1)} MB：${first.ms.toFixed(1)} → ${last.ms.toFixed(1)} ms`)
console.log(`  斜率约 ${slope.toFixed(2)} ms/MB（次线性）`)
console.log(`  再加一整套皮肤（约 +1.1 MB）的解析代价约为 ${(1.1 * slope).toFixed(1)} ms`)
await browser.close()
