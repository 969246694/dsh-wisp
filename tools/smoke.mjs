/* ============================================================================
   smoke.mjs — 真实浏览器冒烟测试。

   为什么需要它：`verify-wisp.mjs` 用假 DOM 跑 190+ 条断言，覆盖不到"真实布局与合成"这类
   行为。本项目的三个真 bug 全部只有真实浏览器能发现：
     · 躲起来后气泡仍挂在屏幕上（假 DOM 里"移除了"就算过）
     · 菜单越界（夹取用的是几何，假 DOM 没有布局）
     · display:none 是否真的让她不挡点击
   所以这些检查必须留在仓库里，而不是散在开发机的工作区脚本中。

   RUN
     node tools/smoke.mjs
     node tools/smoke.mjs --headed        # 看着它跑

   浏览器是**可选依赖**：找不到就以 0 退出并说明原因（CI 上不该因为缺浏览器而红）。
   ========================================================================== */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const argv = process.argv.slice(2)
const headed = argv.includes('--headed')

/* ---- 可选依赖：Playwright 与一份 Chromium --------------------------------
   pnpm 布局下顶层不一定有 `node_modules/playwright-core` 这个具体名字（只有
   `.pnpm/playwright-core@<ver>/`），所以除了正常的 require 解析，还要扫一遍 .pnpm。 */
function findPlaywright() {
  const bases = [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'package.json') : null,
    join(here, 'package.json'),
    'E:/deepseek-harness/package.json',
  ].filter((p) => p && existsSync(p))
  for (const base of bases) {
    for (const spec of ['playwright-core', 'playwright', 'playwright-chromium']) {
      try {
        // 必须**真的**有 chromium 才算命中：require 成功但导出里没有它的情况是存在的，
        // 直接返回会让调用处拿到 undefined 再炸在别处（tools/perf.mjs 上就踩过一次）。
        const mod = createRequire(base)(spec)
        if (mod && mod.chromium) return { chromium: mod.chromium, from: `${base} → ${spec}` }
      } catch (e) { /* 试下一个 */ }
    }
  }
  const roots = [process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, '..') : null, here, 'E:/deepseek-harness']
    .filter(Boolean)
  for (const root of roots) {
    const pnpm = join(root, 'node_modules', '.pnpm')
    if (!existsSync(pnpm)) continue
    for (const entry of readdirSync(pnpm)) {
      if (!/^playwright(-core)?@/.test(entry)) continue
      const pkg = join(pnpm, entry, 'node_modules', 'playwright-core')
      if (!existsSync(pkg)) continue
      try { return { chromium: require(pkg).chromium, from: pkg } } catch (e) { /* 下一个版本 */ }
    }
  }
  return null
}

const playwright = findPlaywright()
if (!playwright) {
  console.log('smoke: 未找到 Playwright —— 跳过真实浏览器检查（这不是失败）')
  console.log('        安装后即可运行: npm i -D playwright-core  （并准备一份 Chromium）')
  process.exit(0)
}
const chromium = playwright.chromium

const chromeCandidates = [
  process.env.WISP_CHROME,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe') : null,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean)
const executablePath = chromeCandidates.find((p) => existsSync(p))

/* 环境中断 vs 检查失败 —— 两者的退出码必须不同。

   这个套件里每一次真实问题都会以 FAIL 行出现；而"Target page, context or browser has
   been closed"是**环境**中断：headless Chromium 在内存压力下会被关掉，与本插件的正确性
   无关。它的触发点随机（同一个脚本有时全过、有时在中途死掉），所以：
     · 只对这类中断重试一次；
     · 两次都中断就以 2 退出，而不是 1 —— 1 永远意味着"有检查没过"。
   不要因为它偶发就把断言放宽：那会把真正的产品问题一起放过。 */
const ENV_ABORT = /Target page|context or browser has been closed|browser has been closed|Target closed/i

function abortEnvironment(message) {
  if (ENV_ABORT.test(message) && process.env.WISP_SMOKE_RETRY !== '1') {
    console.error(`\nsmoke: 环境中断（浏览器被关闭），重试一次 —— ${message}`)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
      stdio: 'inherit',
      env: { ...process.env, WISP_SMOKE_RETRY: '1' },
    })
    process.exit(child.status ?? 2)
  }
  console.error(`\nsmoke: aborted — ${message}`)
  if (ENV_ABORT.test(message)) {
    console.error('smoke: 两次都是环境中断：headless Chromium 在内存压力下被关闭，不是检查失败。')
  }
  process.exit(ENV_ABORT.test(message) ? 2 : 1)
}

process.on('uncaughtException', (error) => abortEnvironment(error?.stack ?? String(error)))
process.on('unhandledRejection', (error) => abortEnvironment(error?.stack ?? String(error)))

let pass = 0
let fail = 0
const ok = (label, detail = '') => { pass++; console.log(`  PASS  ${label}${detail ? '  — ' + detail : ''}`) }
const bad = (label, detail = '') => { fail++; console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
const check = (cond, label, detail = '') => (cond ? ok(label, detail) : bad(label, detail))
const head = (t) => console.log(`\n=== ${t} ===`)

const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

const browser = await chromium.launch({ headless: !headed, executablePath })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

/* 一个最小的宿主页面：只有 __ModuleLoader__ 与客户端服务替身。
   整轮只用一个页面 —— 每个页面都要装下这份包与解码后的精灵图，多开一个页面就是
   多一份内存；之前正是在这里把浏览器推崩了（见文件末尾的内存记录）。 */
const mountPage = async (config = { wander: false }) => {
  await page.setContent('<!doctype html><html><head></head><body><div style="height:80px">会话</div></body></html>')
  await page.evaluate(({ src, config }) => {
    const ctxFake = {
      get: (n) => (n === 'timer'
        ? {
            timeout: (cb, ms) => { const i = setTimeout(cb, ms); return () => clearTimeout(i) },
            interval: (cb, ms) => { const i = setInterval(cb, ms); return () => clearInterval(i) },
          }
        : n === 'styles'
          ? { insert: (css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); return () => s.remove() } }
          : undefined),
      on: () => () => {},
      effect: () => () => {},
    }
    // 同一页里重新挂载：插件的单例守卫会先销毁上一个实例（并回收它的 blob），
    // 所以不需要第二个页面来测"换一套配置从零开始"的行为。
    window.__mountWisp = (cfg) => {
      window.__ML = { def: null }
      window.__ModuleLoader__ = { load: (d) => { window.__ML.def = d } }
      new Function(src)()
      return window.__ML.def.factory(() => ({})).apply(ctxFake, cfg)
    }
    window.__mountWisp(config)
  }, { src: bundle, config })
  await page.waitForTimeout(1200)
}

const state = () => page.evaluate(() => {
  const root = document.querySelector('.wisp-root')
  const layer = document.querySelector('.wisp-layer')
  const se = document.scrollingElement
  return {
    mounted: root !== null,
    mood: root?.dataset.mood ?? null,
    hidden: window.__wisp?.hidden ?? null,
    skin: window.__wisp?.skin ?? null,
    position: window.__wisp?.position ?? null,
    rootDisplay: root ? getComputedStyle(root).display : null,
    rootArea: root ? Math.round(root.getBoundingClientRect().width * root.getBoundingClientRect().height) : 0,
    layerChildren: layer ? layer.children.length : 0,
    scrollable: se.scrollHeight > innerHeight || se.scrollWidth > innerWidth,
    activeTag: document.activeElement?.tagName ?? null,
    activeClass: document.activeElement?.className ?? null,
  }
})

/* ------------------------------------------------------ 1. 挂载与覆盖层 --- */
head('1. mount and the overlay layer')

await mountPage()
let s = await state()
check(s.mounted, 'the companion mounts')
check(!s.scrollable, 'the page is not made scrollable by her layer', 'the 560x840 box must not extend the document')
check(s.rootDisplay !== 'none' && s.rootArea > 0, 'she is actually drawn', `${s.rootArea} px²`)

/* ------------------------------------------------------ 2. 右键菜单几何 --- */
head('2. context menu geometry and keyboard')

const openMenu = () => page.evaluate(() => {
  const p = window.__wisp.position
  const b = document.querySelector('.wisp-body').getBoundingClientRect()
  document.querySelector('.wisp-body').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
  }))
  const menu = document.querySelector('.wisp-menu')
  if (!menu) return null
  const r = menu.getBoundingClientRect()
  return {
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    items: [...menu.querySelectorAll('.wisp-menu-item')].map((i) => i.textContent),
  }
})

/* 夹取：在她身体的下半部开菜单，那个位置按"不夹取"算会超出视口底边。
   候选点依次尝试 —— 这条断言要验的是**夹取**，不该被"某一点恰好落在她轮廓的
   透明区"这种无关因素干扰。同时断言 naive 位置确实越界：否则这条断言是空的
   （菜单本来就在视口内，夹不夹取都过）。 */
const cornerMenu = await page.evaluate(() => {
  const body = document.querySelector('.wisp-body')
  const b = body.getBoundingClientRect()
  const cands = [[0.5, 0.72], [0.46, 0.72], [0.54, 0.72], [0.5, 0.64], [0.44, 0.6], [0.56, 0.6]]
  for (const [fx, fy] of cands) {
    const x = b.x + b.width * fx
    const y = b.y + b.height * fy
    body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
    const menu = document.querySelector('.wisp-menu')
    if (!menu) continue
    const r = menu.getBoundingClientRect()
    return {
      fx, fy,
      pointerY: Math.round(y),
      naiveBottom: Math.round(y + r.height),
      bottom: Math.round(r.bottom),
      right: Math.round(r.right),
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    }
  }
  return null
})
check(cornerMenu !== null, 'a menu can be opened near the bottom of her body',
  cornerMenu ? `pointer at y=${cornerMenu.pointerY}` : 'no candidate point hit her silhouette')
check(cornerMenu !== null && cornerMenu.naiveBottom > 900,
  'the case actually needs clamping (otherwise the next check is vacuous)',
  cornerMenu ? `unclamped bottom would be ${cornerMenu.naiveBottom} > 900` : 'n/a')
check(cornerMenu !== null && cornerMenu.inside,
  'and the menu is clamped back inside the viewport',
  cornerMenu ? `bottom ${cornerMenu.bottom} (was ${cornerMenu.naiveBottom}), right ${cornerMenu.right}` : 'n/a')

const menu = await openMenu()
// 项数从皮肤数推导（13 项固定 + 每套皮肤一项），不写死：加一套皮肤不该让测试变红 ——
// 那是数据的错，不是行为的错。
// api.skins 是**数组**；用 Object.keys 数数组只是碰巧数对（预检里踩过这个坑，这里一并对齐）。
const skinCount = await page.evaluate(() => {
  const s = window.__wisp.skins
  return Array.isArray(s) ? s.length : Object.keys(s ?? {}).length
})
check(menu !== null && menu.items.length === 13 + skinCount, 'the menu lists every entry',
  `${menu?.items.length} items = 13 + ${skinCount} skin(s)`)

// 键盘：打开即聚焦第一项，方向键移动，Esc 关闭并把焦点还给她
const kbd = await page.evaluate(() => {
  const before = document.activeElement?.textContent ?? null
  const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  press('ArrowDown')
  const afterDown = document.activeElement?.textContent ?? null
  const tabbable = [...document.querySelectorAll('.wisp-menu-item')].filter((i) => i.tabIndex === 0).length
  press('Escape')
  return {
    before, afterDown, tabbable,
    menuGone: document.querySelector('.wisp-menu') === null,
    focusAfter: document.activeElement?.className ?? null,
  }
})
check(kbd.before === menu.items[0], 'opening the menu focuses the first item', String(kbd.before))
check(kbd.afterDown === menu.items[1], 'ArrowDown moves focus', String(kbd.afterDown))
check(kbd.tabbable === 1, 'roving tabindex keeps exactly one item tabbable', `${kbd.tabbable}`)
check(kbd.menuGone, 'Escape closes the menu')
check(kbd.focusAfter === 'wisp-body', 'and focus lands back on her, not on <body>', String(kbd.focusAfter))

// 点击菜单项要真的生效
const openedAgain = await openMenu()
check(openedAgain !== null, 'the menu reopens for the activation check')
const zoomed = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.wisp-menu-item')].find((i) => i.textContent === '放大一点')
  if (!item) return { missing: true }
  item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return { width: document.querySelector('.wisp-root').style.width, menuGone: document.querySelector('.wisp-menu') === null }
})
check(zoomed.width === '630px' && zoomed.menuGone, 'a menu item runs and closes the menu',
  zoomed.missing ? 'the item was not found' : `width=${zoomed.width}`)

/* 键盘入口：假 DOM 证明不了原生按键处理与事件冒泡（窗口上的捕获监听会先看到 keydown），
   所以这里用真实按键事件走一遍。 */
const focusHer = await page.evaluate(() => {
  document.querySelector('.wisp-body').focus()
  return document.activeElement?.className ?? null
})
check(focusHer === 'wisp-body', 'her body takes focus', String(focusHer))
await page.keyboard.press('Enter')
await page.waitForTimeout(250)
check(await page.evaluate(() => document.querySelector('.wisp-menu') !== null),
  'a real Enter key opens the menu', 'no pointer involved')
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
const afterEscape = await page.evaluate(() => ({
  menuGone: document.querySelector('.wisp-menu') === null,
  focus: document.activeElement?.className ?? null,
}))
check(afterEscape.menuGone && afterEscape.focus === 'wisp-body',
  'and a real Escape closes it and hands focus back to her',
  `menu gone=${afterEscape.menuGone}, focus=${afterEscape.focus}`)

/* ------------------------------------------------------ 3. 躲起来 --------- */
head('3. hide and the way back')

await page.evaluate(() => window.__wisp.say('测试气泡'))
await page.evaluate(() => window.__wisp.hide())
await page.waitForTimeout(250)
s = await state()
check(s.hidden === true && s.rootDisplay === 'none' && s.rootArea === 0,
  'hiding takes her out of the layout', `display=${s.rootDisplay} area=${s.rootArea}`)
const bubblesLeft = await page.evaluate(() => document.querySelectorAll('.wisp-say').length)
check(bubblesLeft === 0, 'and takes the speech bubble with her', `${bubblesLeft} left on screen`)
const tabBox = await page.evaluate(() => {
  const t = document.querySelector('.wisp-tab')
  if (!t) return null
  const r = t.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height), inside: r.right <= innerWidth && r.bottom <= innerHeight }
})
check(tabBox !== null && tabBox.inside, 'a mini tab is left in the corner', JSON.stringify(tabBox))

await page.click('.wisp-tab')
await page.waitForTimeout(300)
s = await state()
check(s.hidden === false && s.rootDisplay !== 'none' && s.rootArea > 0, 'clicking the tab brings her back',
  `display=${s.rootDisplay} area=${s.rootArea}`)

/* ------------------------------------------------------ 6. 状态反应 ------- */
head('6. reactions against the real DOM hooks')

/* attn / worried 都挂在 DSH 真实渲染出来的 data-* 属性上。假 DOM 里那是我自己造的选择器，
   只有真实页面才能证明"这个钩子确实存在、确实能被驱动"。 */

await page.evaluate(() => {
  const panel = document.createElement('div')
  panel.setAttribute('data-question-key', 'smoke-question-1')
  panel.id = 'wisp-question'
  document.body.append(panel)
})
await page.waitForTimeout(1600)
const attnState = await page.evaluate(() => ({
  mood: document.querySelector('.wisp-root').dataset.mood,
  bubble: document.querySelector('.wisp-say')?.textContent ?? null,
}))
check(attnState.mood === 'attn',
  'a [data-question-key] panel switches her to attention', `${attnState.mood} / 「${attnState.bubble}」`)

const attnRepeat = await page.evaluate(async () => {
  const before = document.querySelectorAll('.wisp-say').length
  await new Promise((r) => setTimeout(r, 2600))
  return { before, after: document.querySelectorAll('.wisp-say').length }
})
check(attnRepeat.after <= attnRepeat.before,
  'she does not repeat herself for the same pending item', `${attnRepeat.before} -> ${attnRepeat.after}`)

await page.evaluate(() => document.getElementById('wisp-question').remove())
await page.waitForTimeout(1600)
check(await page.evaluate(() => document.querySelector('.wisp-root').dataset.mood) === 'idle',
  'answering it lets her relax')

// 一轮跑完 + 这一轮有失败行 → worried
await page.evaluate(() => {
  const failed = document.createElement('span')
  failed.setAttribute('data-error', 'true')
  failed.id = 'wisp-error'
  failed.textContent = 'a failed tool row'
  document.body.append(failed)
  const stop = document.createElement('button')
  stop.setAttribute('aria-label', '停止')
  stop.id = 'wisp-stop'
  document.body.append(stop)
})
await page.waitForTimeout(1600)
const whileBusy = await page.evaluate(() => document.querySelector('.wisp-root').dataset.mood)
check(whileBusy === 'alert', 'a running agent puts her on alert', String(whileBusy))
await page.evaluate(() => document.getElementById('wisp-stop').remove())
await page.waitForTimeout(1600)
const worriedState = await page.evaluate(() => ({
  mood: document.querySelector('.wisp-root').dataset.mood,
  bubble: document.querySelector('.wisp-say')?.textContent ?? null,
}))
check(worriedState.mood === 'worried',
  'a finished run with a failed row puts her in the worried state',
  `${worriedState.mood} / 「${worriedState.bubble}」`)
await page.waitForTimeout(4200)
check(await page.evaluate(() => document.querySelector('.wisp-root').dataset.mood) === 'idle',
  'the worried look expires on its own')

/* ------------------------------------------------------ 7. 体积与自包含 --- */
head('7. shipping shape')

const bundleKb = Math.round(Buffer.byteLength(bundle) / 1024)
/* 这里**只记录体积，不设上限**。
   曾经有过 4 MB / 6 MB 两条上限，都是我为了"别让它悄悄变胖"自己拍的数 —— 不是任何真实约束。
   后来把它量清楚了：24 MB 的包解析+执行 46.5 ms，斜率约 1.45 ms/MB（次线性），
   再加一整套皮肤（+1.1 MB）约 +1.6 ms。**代价小到不值得为它设一条会挡住功能的红线。**
   真正该守的是"代价"而不是"体积"：挂载开销由 tools/perf.mjs 量并写进 README。 */
check(bundleKb > 0, 'bundle size is recorded', `${bundleKb} KB`)
check(!/["'][^"']*\.(webp|png)["']/.test(bundle), 'the bundle references no external image files')
const scrolling = await page.evaluate(() => document.scrollingElement.scrollHeight > innerHeight)
check(!scrolling, 'still no page scrollbar after everything above')

/* 解码后的显存/内存占用：一张 2048x3072 的精灵图在内存里是 2048*3072*4 = 25 MB。
   本轮真实浏览器测试就是被这个推崩的（多开一个页面 = 多一份解码结果）。
   这里量出来并记录，因为它是"选哪一档"的一个真实约束 —— 不只是锐度。 */
const memory = await page.evaluate(async () => {
  const w = window.__wisp
  const measure = async () => {
    if (!performance.memory) return null
    if (typeof gc === 'function') gc()
    return Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)
  }
  const before = await measure()
  w.setSkin(w.skin === 'deepsea' ? 'classic' : 'deepsea')
  await new Promise((r) => setTimeout(r, 900))
  const after = await measure()
  const img = document.querySelector('.wisp-img')
  return { before, after, decodedPerSprite: img.naturalWidth * img.naturalHeight * 4 / 1024 / 1024 }
})
check(memory.decodedPerSprite > 0, 'decoded sprite size is recorded',
  `${memory.decodedPerSprite.toFixed(1)} MB per sprite` +
  (memory.before !== null ? `（JS 堆 ${memory.before} -> ${memory.after} MB）` : '（本浏览器不暴露 performance.memory）'))
check(memory.decodedPerSprite < 40, 'a single decoded sprite stays under 40 MB',
  `${memory.decodedPerSprite.toFixed(1)} MB — the hi tier would be 4x this`)

/* ------------------------------------------------------ doctor() ---------- */
head('8. doctor() against a real DOM')

const doctorBefore = await page.evaluate(() => window.__wisp.doctor())
check(doctorBefore.hooks.composer.every((h) => h.matches === 0),
  'on a page with no composer it correctly finds no composer hook',
  doctorBefore.hooks.composer.map((h) => `${h.selector}=${h.matches}`).join(' '))
check(doctorBefore.problems.some((p) => p.includes('输入框')),
  'and names the feature that would go quiet, instead of just reporting a number',
  doctorBefore.problems.join(' / '))
check(doctorBefore.tokens.every((t) => t.value === '') && doctorBefore.problems.some((p) => p.includes('主题令牌')),
  'without the app stylesheet it reports the empty theme tokens as a problem',
  `令牌全空=${doctorBefore.tokens.every((t) => t.value === '')}，problems=${doctorBefore.problems.length}`)

// 放一个输入框进去：诊断必须跟着变 —— 这条才证明它读的是**当前** DOM，不是缓存
await page.evaluate(() => {
  const box = document.createElement('textarea')
  box.id = 'smoke-composer'
  document.body.append(box)
})
await page.waitForTimeout(150)
const doctorAfter = await page.evaluate(() => window.__wisp.doctor())
check(doctorAfter.hooks.composer.some((h) => h.matches > 0),
  'and once a composer exists it is found',
  doctorAfter.hooks.composer.map((h) => `${h.selector}=${h.matches}`).join(' '))
check(!doctorAfter.problems.some((p) => p.includes('输入框')),
  'so the warning clears', String(doctorAfter.problems.length) + ' problem(s) left')

/* 把 README 的性能声明钉成断言：以后谁再加一个"每轮都查一次"的功能，这里会先红，
   而不是等 README 悄悄过期。 */
const idleQueries = await page.evaluate(async () => {
  const q = { sel: 0, all: 0 }
  const q1 = Document.prototype.querySelector
  const q2 = Document.prototype.querySelectorAll
  Document.prototype.querySelector = function (s) { q.sel++; return q1.call(this, s) }
  Document.prototype.querySelectorAll = function (s) { q.all++; return q2.call(this, s) }
  const started = performance.now()
  await new Promise((r) => setTimeout(r, 6000))
  const seconds = (performance.now() - started) / 1000
  Document.prototype.querySelector = q1
  Document.prototype.querySelectorAll = q2
  return { seconds, sel: q.sel, all: q.all }
})
const selPerSec = idleQueries.sel / idleQueries.seconds
const allPerSec = idleQueries.all / idleQueries.seconds
check(selPerSec <= 4, 'idle DOM queries stay around two per poll',
  `${selPerSec.toFixed(2)} 次/秒（每 1.2s 一轮：忙碌 + 待处理 + 输入框）`)
check(allPerSec === 0, 'and no full-document scans while idle',
  `${allPerSec.toFixed(2)} 次/秒 —— 出错扫描只在跑完一轮时发生`)

/* 换皮肤放在最后：它是唯一会解码**第二套**精灵图的操作（一套 5 张 × 6 MB）。
   放在反应段之前，会让后面所有断言都在峰值内存下跑 —— 之前的随机中断就是在这里之后发生的。 */
/* ------------------------------------------------------ 4. 换皮肤 --------- */
head('4. skins swap the actual sprite')

const skinSwap = await page.evaluate(async () => {
  const w = window.__wisp
  const before = { skin: w.skin, src: document.querySelector('.wisp-img').src, natural: document.querySelector('.wisp-img').naturalWidth }
  /* 目标皮肤**动态挑一个和当前不同的**：前面几段可能已经切过皮肤（菜单那段就会切），
     写死 'classic' 会变成"切到自己"的空操作 —— 断言于是永远看不到换图。 */
  /* w.skins 是**数组**（api 刻意返回 SKIN_IDS.slice()，防止外部改动），不是以 id 为键的对象。
     之前用 Object.keys() 拿到的是 ['0','1','2','3']，setSkin('0') 被正确拒绝 —— 断言于是停在原地。 */
  const ids = Array.isArray(w.skins) ? w.skins.slice() : Object.keys(w.skins || {})
  const target = ids.find((id) => id !== w.skin) || w.skin
  w.setSkin(target)
  await new Promise((r) => setTimeout(r, 700))
  const img = document.querySelector('.wisp-img')
  return {
    target,
    ids,
    afterSkin: w.skin,
    before,
    after: { skin: w.skin, src: img.src, natural: img.naturalWidth },
    // 交叉淡入淡出期间应有第二层
    layersDuringFade: document.querySelectorAll('.wisp-img').length,
  }
})
check(skinSwap.after.skin === skinSwap.target && skinSwap.after.src !== skinSwap.before.src,
  'switching skins loads a different image',
  `${skinSwap.before.skin} -> ${skinSwap.after.skin}；候选 ${JSON.stringify(skinSwap.ids)}，目标 ${skinSwap.target}`)
check(skinSwap.after.natural > 0, 'the swapped sprite actually decodes', `${skinSwap.after.natural}px wide`)
check(skinSwap.layersDuringFade === 1, 'the cross-fade layer is gone once it settles', `${skinSwap.layersDuringFade} img layer(s)`)


// 先收掉这个浏览器再开下一个：**每个浏览器只驻留一个页面**。
// 每个页面都要装下这份包与解码后的精灵图（单张就是 naturalWidth*naturalHeight*4 字节），
// 多开一个页面 = 多一份；之前正是这样把浏览器推崩的，表现为随机的
// "Target page, context or browser has been closed"，极难定位。
await browser.close()

/* ------------------------------------------------------ 8. 自己踱步 ------- */
head('9. idle wander')

const wanderBrowser = await chromium.launch({ headless: !headed, executablePath })
const wanderPage = await wanderBrowser.newPage({ viewport: { width: 1440, height: 900 } })
const wanderLogs = []
wanderPage.on('console', (msg) => { if (msg.type() === 'error') wanderLogs.push(msg.text()) })
wanderPage.on('pageerror', (err) => wanderLogs.push('pageerror: ' + err.message))
await wanderPage.setContent('<!doctype html><html><head></head><body></body></html>')
await wanderPage.evaluate((src) => {
  window.__ML = { def: null }
  window.__ModuleLoader__ = { load: (d) => { window.__ML.def = d } }
  new Function(src)()
  window.__ML.def.factory(() => ({})).apply({
    get: (n) => (n === 'timer'
      ? { timeout: (cb, ms) => { const i = setTimeout(cb, ms); return () => clearTimeout(i) }, interval: (cb, ms) => { const i = setInterval(cb, ms); return () => clearInterval(i) } }
      : n === 'styles' ? { insert: (css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); return () => s.remove() } } : undefined),
    on: () => () => {}, effect: () => () => {},
  }, { wander: true, wanderMs: 5000, wanderRange: 200, reactions: false })
}, bundle)
await wanderPage.waitForTimeout(1600)

const wanderMounted = await wanderPage.evaluate(() =>
  typeof window.__wisp === 'object' && window.__wisp !== null && typeof window.__wisp.move === 'function')
check(wanderMounted, 'a wander-enabled mount comes up',
  wanderMounted ? 'ok' : `no handle; console: ${wanderLogs.join(' | ') || '(empty)'}`)

const wander = wanderMounted
  ? await wanderPage.evaluate(async () => {
      const w = window.__wisp
      w.move(400, 200)                      // 离边角远一点，任何方向都走得动
      const before = { x: w.position.x, y: w.position.y }
      let gliding = false
      let prev = { ...before }
      let maxStep = 0                       // 单次踱步的位移
      let steps = 0
      const started = Date.now()
      while (Date.now() - started < 11000) {
        if (document.querySelector('.wisp-root').dataset.gliding === 'true') gliding = true
        await new Promise((r) => setTimeout(r, 120))
        const now = w.position
        const d = Math.hypot(now.x - prev.x, now.y - prev.y)
        // 踱步间隔 5s，远大于 120ms 的采样间隔，所以每一步都能被单独看到
        if (d > 1) { steps++; maxStep = Math.max(maxStep, d) }
        prev = now
      }
      return { before, after: prev, gliding, steps, maxStep }
    })
  : { before: { x: 0, y: 0 }, after: { x: 0, y: 0 }, gliding: false, steps: 0, maxStep: -1 }
check(wanderMounted && wander.steps > 0, 'she strolls on her own while idle',
  `${wander.steps} stroll(s) from ${wander.before.x},${wander.before.y} to ${wander.after.x},${wander.after.y}`)
// 上限的【精确】断言在确定性 harness 里（verify-wisp.mjs 的 "a stroll stays inside the
// configured range"）。这里只能验"她真的动了、而且用滑行"，不能验精确上限：
// headless 页面被节流后定时器会补发，两次踱步会挤进同一个采样间隔被合成一步
// （实测最大单步 226px —— 插件的公式是 d·√(cos²+0.36·sin²) ≤ d，不可能超）。
check(wanderMounted && wander.maxStep <= 400, 'no observed step exceeds twice the range',
  `最大单步 ${Math.round(wander.maxStep)}px（上限的精确断言在 verify-wisp.mjs）`)
check(wanderMounted && wander.gliding, 'and it is a glide, not a teleport', 'data-gliding was observed during the stroll')
await wanderBrowser.close()



console.log(`\n${fail === 0 ? '=== SMOKE PASSED ===' : '=== SMOKE FAILED ==='}`)
console.log(`  ${pass} passed, ${fail} failed  (real Chromium, ${headed ? 'headed' : 'headless'})`)
console.log(`  playwright: ${playwright.from}`)
if (executablePath) console.log(`  browser:    ${executablePath}`)
process.exit(fail === 0 ? 0 : 1)
