/* ============================================================================
   perf.mjs — 性能探针：README 的「性能」一节就是用它量的。

   为什么要有这个脚本：那张表里的数字必须**可复现**，否则它只是"我说过"。
   计数与耗时都靠**包装原生 querySelector/querySelectorAll** 得到，不靠估算。

   RUN
     node tools/perf.mjs
     node tools/perf.mjs --quick     # 只测稳态，跳过交替重复的帧测量

   浏览器是**可选依赖**：找不到就以 0 退出并说明原因（同 tools/smoke.mjs）。
   ========================================================================== */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const quick = argv.includes('--quick')

function findPlaywright() {
  const bases = [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'package.json') : null,
    join(here, 'package.json'),
    'E:/deepseek-harness/package.json',
  ].filter((p) => p && existsSync(p))
  for (const base of bases) {
    for (const spec of ['playwright-core', 'playwright', 'playwright-chromium']) {
      try {
        // 必须**真的**拿到 chromium 才算命中：require 成功但导出里没有它的情况是存在的，
        // 那种情况下直接返回会让调用处拿到 undefined.chromium。
        const mod = createRequire(base)(spec)
        if (mod && mod.chromium) return { chromium: mod.chromium, from: base + ' → ' + spec }
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
  console.log('perf: 未找到 Playwright —— 跳过测量（这不是失败）')
  process.exit(0)
}

const chromeCandidates = [
  process.env.WISP_CHROME,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe') : null,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean)
const executablePath = chromeCandidates.find((p) => existsSync(p))
const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

/* 页面上要有东西可查 —— 否则"查询很便宜"这句话没有意义 */
const FILLER = `
  const root = document.createElement('div')
  for (let i = 0; i < 5000; i++) {
    const row = document.createElement('div'); row.className = 'row'
    const a = document.createElement('span'); a.textContent = 'message ' + i
    row.appendChild(a); root.appendChild(row)
  }
  document.body.appendChild(root)
`

const browser = await playwright.chromium.launch({ headless: true, executablePath })

const run = async (withPlugin, withComposer = false) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.setContent('<!doctype html><html><head></head><body></body></html>')
  await page.evaluate(({ filler, withComposer }) => {
    window.__q = { sel: 0, all: 0, selMs: 0, allMs: 0, deltas: [] }
    const q1 = Document.prototype.querySelector
    const q2 = Document.prototype.querySelectorAll
    Document.prototype.querySelector = function (s) {
      const t = performance.now()
      const r = q1.call(this, s)
      window.__q.sel++
      window.__q.selMs += performance.now() - t
      return r
    }
    Document.prototype.querySelectorAll = function (s) {
      const t = performance.now()
      const r = q2.call(this, s)
      window.__q.all++
      window.__q.allMs += performance.now() - t
      return r
    }
    new Function(filler)()
    if (withComposer) {
      const box = document.createElement('textarea')
      box.setAttribute('data-composer-input', '')
      document.body.appendChild(box)
    }
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      window.__q.deltas.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, { filler: FILLER, withComposer })

  let mountMs = null
  if (withPlugin) {
    mountMs = await page.evaluate((src) => {
      window.__ML = { def: null }
      window.__ModuleLoader__ = { load: (d) => { window.__ML.def = d } }
      const t0 = performance.now()
      new Function(src)()
      window.__ML.def.factory(() => ({})).apply({
        get: (n) => (n === 'timer'
          ? { timeout: (cb, ms) => { const i = setTimeout(cb, ms); return () => clearTimeout(i) }, interval: (cb, ms) => { const i = setInterval(cb, ms); return () => clearInterval(i) } }
          : n === 'styles' ? { insert: (css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); return () => s.remove() } } : undefined),
        on: () => () => {}, effect: () => () => {},
      }, { wander: false })
      return performance.now() - t0
    }, bundle)
  }

  await page.waitForTimeout(1200)
  const t0 = await page.evaluate(() => {
    window.__q.sel = 0; window.__q.all = 0; window.__q.selMs = 0; window.__q.allMs = 0; window.__q.deltas = []
    return performance.now()
  })
  await page.waitForTimeout(10000)
  const sample = await page.evaluate((startedAt) => {
    const seconds = (performance.now() - startedAt) / 1000
    const d = window.__q.deltas.filter((x) => x > 0 && x < 200)
    return {
      seconds: Number(seconds.toFixed(2)),
      sel: window.__q.sel, all: window.__q.all,
      selMs: window.__q.selMs, allMs: window.__q.allMs,
      meanFrame: Number((d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0).toFixed(3)),
    }
  }, t0)
  await page.close()
  return { mountMs, ...sample }
}

const per = (v, s) => Number((v / s).toFixed(2))
const bare = await run(false)
const wired = await run(true, true)
const pessimistic = await run(true, false)

console.log('== 10 秒静置（页面上有 5000 行合成会话记录）==')
console.log(`无插件           帧间隔 ${bare.meanFrame} ms   querySelector ${per(bare.sel, bare.seconds)}/s   querySelectorAll ${per(bare.all, bare.seconds)}/s`)
console.log(`挂载后·有输入框  帧间隔 ${wired.meanFrame} ms   querySelector ${per(wired.sel, wired.seconds)}/s   querySelectorAll ${per(wired.all, wired.seconds)}/s   ← 真实应用的形态`)
console.log(`挂载后·无输入框  帧间隔 ${pessimistic.meanFrame} ms   querySelector ${per(pessimistic.sel, pessimistic.seconds)}/s   ← 最悲观：每轮都要探一次输入框钩子`)
console.log('')
console.log(`DOM 查询耗时 ${wired.selMs.toFixed(2)} ms 选中 + ${wired.allMs.toFixed(2)} ms 全量`)
console.log(`            = ${per(wired.selMs + wired.allMs, wired.seconds)} ms/秒（占单核 ${(per(wired.selMs + wired.allMs, wired.seconds) / 10).toFixed(3)}%）`)
console.log(`挂载一次性开销 ${wired.mountMs?.toFixed(1)} ms（含 ${(Buffer.byteLength(bundle) / 1024 / 1024).toFixed(1)} MB 包的解析）`)

if (!quick) {
  /* 帧开销必须**交替重复**测：单次差值里的噪声就有 0.1 ms 量级，一次测量说明不了任何事 */
  console.log('\n== 帧间隔：交替重复 4 轮（每轮 6 秒静置）==')
  const samples = { bare: [], wired: [] }
  for (let i = 0; i < 4; i++) {
    const which = i % 2 === 0 ? 'bare' : 'wired'
    const r = await run(which === 'wired')
    samples[which].push(r.meanFrame)
    console.log(`  第 ${i + 1} 轮 ${which === 'bare' ? '无插件' : '挂载后'}  ${r.meanFrame} ms`)
  }
  const mean = (a) => Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(3))
  console.log(`  均值：无插件 ${mean(samples.bare)} ms  vs  挂载后 ${mean(samples.wired)} ms  →  差 ${(mean(samples.wired) - mean(samples.bare)).toFixed(3)} ms`)
}

await browser.close()
