/* ---------------------------------------------------------------------------
 * 真实引擎探针（不需要 Playwright）。
 *
 * 为什么存在：`tools/smoke.mjs` 的能力上限就是 Playwright 有没有装 —— 没装时它整份
 * 跳过（这是刻意的：CI 不该因为缺浏览器而红）。可**假 DOM 验不了 CSS**：关键帧里的
 * `calc()`/`var()` 有没有真的解析、`rotate()` 有没有真的转、媒体查询有没有真的生效，
 * 只有真引擎能给答案。所以这台机器上"预检全过 + 冒烟跳过"曾经等于**没有任何视觉验证**。
 *
 * 这个探针直接用 Node 自带的 fetch + WebSocket 走 CDP，驱动机器上已有的
 * Edge / Chrome：零依赖、零安装，找到浏览器就跑，找不到就说清楚然后以 0 退出。
 *
 * 它验的是"引擎到底认不认"，不是几何与布局（那是 smoke.mjs 的活）：
 *   1. 结构：body > motion > lean > sprite 真的在页面上
 *   2. `rotate(var(--wisp-tilt))` 真的转（读计算后的 matrix，不是读源码）
 *   3. `wisp-press` / `wisp-land` 真的在跑（getAnimations），而且关键帧**解析后有效**
 *      —— 动画"在跑"不等于有效：calc() 写错时浏览器会静默丢掉那一条 keyframe，
 *      动画照跑但什么都不动。这条只有把 getKeyframes() 读出来才能证明。
 *   4. 动作幅度档：`静止` 下计算后的 animationName 是 none，姿势被钉在 0
 *   5. `prefers-reduced-motion`（CDP Emulation）：姿势与动作都不写
 *   6. 帧动画（v1.46.1 起是动图 WebP；v1.46.5 起是两条：idle + sleepy）：
 *      `<img>` 真的解得开（naturalWidth = **素材自己的**画布宽度）、与立绘同一格、
 *      冻结时 display:none 且立绘可见
 *   7. 尺寸校正（v1.46.4）：**计算后**的 transform 真的是 scale(1.186)，底边真的下移
 *      9.3% 个盒高 —— 她在那张 720p 素材里只占 0.8352 个盒高，立绘占 0.9883。
 *      v1.46.5：idle 那段**不该**带这条校正（差 1%，小于 2% 那条线），计算后是 none
 *
 * 用法：node tools/engine-probe.mjs      （WISP_CHROME=<可执行文件> 可指定浏览器）
 * 退出码：0 通过或跳过 · 1 有检查没过 · 2 环境起不来（找不到可用的调试端口）
 * ------------------------------------------------------------------------- */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

/* 素材自己的画布尺寸（VP8X 里那三字节，存的是值-1）。探针要断言的是 naturalWidth
   **等于素材实际宽度**，而不是等于一个写死在探针里的 720 —— 素材换了尺寸、探针还
   念着旧数字，正是这种断言最该抓到的漂移。 */
const motionCanvas = (name) => {
  const file = join(here, 'assets', 'motion', name)
  /* 缺素材不是崩溃的理由：探针要能**报**"这一条没有/解不开"，而不是在 readFileSync
     上抛出去 —— 那样整份探针会在第一条缺失的素材上停住，后面的断言一条都跑不到。 */
  if (!existsSync(file)) return { w: 0, h: 0 }
  const buf = readFileSync(file)
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.subarray(off, off + 4).toString('latin1')
    const size = buf.readUInt32LE(off + 4)
    if (id === 'VP8X') return { w: buf.readUIntLE(off + 12, 3) + 1, h: buf.readUIntLE(off + 15, 3) + 1 }
    off += 8 + size + (size % 2)
  }
  return { w: 0, h: 0 }
}
const IDLE_CANVAS = motionCanvas('idle.webp')

/* 浏览器从哪来：环境变量优先，然后按平台猜几个常见位置。
   找不到就跳过 —— 这台机器没浏览器不是这个插件的缺陷。 */
const candidates = [
  process.env.WISP_CHROME,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.HOME && join(process.env.HOME, '.cache', 'ms-playwright', 'chromium-1234', 'chrome-linux', 'chrome'),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean)
const executablePath = candidates.find((p) => existsSync(p))

if (!executablePath) {
  console.log('engine-probe: 这台机器上没找到 Edge / Chrome —— 跳过真实引擎检查（这不是失败）')
  console.log('              指定一个：WISP_CHROME=<可执行文件> node tools/engine-probe.mjs')
  process.exit(0)
}

const PORT = Number(process.env.WISP_CDP_PORT ?? 9333)

/* ---- 探针自己起一个最小的 HTTP 载体（v1.47.0）--------------------------------
   动图不再是内联的 data URI，而是**页面自己 origin 下**的文件
   `new URL('wisp-motion/<文件>', document.baseURI)`。所以"真引擎里它解得开吗"
   这个问题必须先有一个真的 origin 才能问：about:blank 上 baseURI 不是可解析的
   基址，那一行会抛，探针就会变成在测"环境不像真页面"。

   这里发的两个东西就是投递链的两端：
     /probe.html          一个空页面（就是页面的 base）
     /wisp-motion/<文件>   assets/motion/ 里的真字节，规则与宿主半包那个 handler 一致
   （宿主那一半在 verify-wisp.mjs 里被直接驱动着查过一遍；这里负责**浏览器**那一半：
   真 <img>、真解码、真 naturalWidth。） */
const MOTION_ROUTE = '/wisp-motion/'
const clipHits = new Map()
const clipServer = createServer((req, res) => {
  let pathname = '/'
  try { pathname = new URL(String(req.url ?? '/'), 'http://127.0.0.1').pathname } catch (e) { /* keep '/' */ }
  if (pathname === '/' || pathname === '/probe.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>wisp engine probe</title></head><body></body></html>')
    return
  }
  if (pathname.startsWith(MOTION_ROUTE)) {
    const name = pathname.slice(MOTION_ROUTE.length)
    const safe = /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/.test(name)
    const file = safe ? join(here, 'assets', 'motion', name) : null
    if (file === null || !existsSync(file)) { res.writeHead(404); res.end(); return }
    clipHits.set(name, (clipHits.get(name) ?? 0) + 1)
    const bytes = readFileSync(file)
    res.writeHead(200, { 'content-type': 'image/webp', 'content-length': String(bytes.length) })
    res.end(bytes)
    return
  }
  res.writeHead(404); res.end()
})
const ORIGIN = await new Promise((resolve, reject) => {
  clipServer.once('error', reject)
  clipServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${clipServer.address().port}`))
})

const profile = mkdtempSync(join(tmpdir(), 'wisp-probe-'))
const child = spawn(executablePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  /* 视口要显式给：默认 headless 窗口只有 800x600，而她是 560x840 —— 点位全在屏幕外，
     elementFromPoint 会返回 null 让检查变成假红（这条真踩过）。 */
  '--window-size=1920,1200',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}
const head = (title) => console.log(`\n=== ${title} ===`)

const cleanup = async () => {
  try { child.kill() } catch (e) { /* ignore */ }
  try { clipServer.close() } catch (e) { /* ignore */ }
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* ignore */ }
}

const targets = await (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (res.ok) return await res.json()
    } catch (e) { /* 还没起来 */ }
    await sleep(250)
  }
  return null
})()

if (targets === null) {
  await cleanup()
  console.error(`engine-probe: 浏览器的调试端口没有起来（${executablePath}）—— 环境问题，不是检查失败`)
  process.exit(2)
}

const page = targets.find((t) => t.type === 'page')
if (!page) {
  await cleanup()
  console.error('engine-probe: 没有可用的页面目标 —— 环境问题')
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

let seq = 0
const pendingCalls = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (!msg.id || !pendingCalls.has(msg.id)) return
  const { resolve, reject } = pendingCalls.get(msg.id)
  pendingCalls.delete(msg.id)
  if (msg.error) reject(new Error(JSON.stringify(msg.error)))
  else resolve(msg.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pendingCalls.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}

try {
  await send('Runtime.enable')
  await send('Page.enable')

  /* 页面必须落在一个**真的 origin** 上（见上面 clipServer 那段）：动图是相对
     `document.baseURI` 解析的，about:blank 上解析不出来 —— 而那是探针环境的问题，
     不是插件的问题。导航之后等 load 再注入半包。 */
  const loaded = new Promise((resolve) => {
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Page.loadEventFired') { ws.removeEventListener('message', onMessage); resolve(true) }
    }
    ws.addEventListener('message', onMessage)
  })
  await send('Page.navigate', { url: `${ORIGIN}/probe.html` })
  await Promise.race([loaded, sleep(5000)])
  const origin = await evaluate('location.origin')
  check(origin === ORIGIN, 'the probe page runs on a real origin, so the clip URLs can resolve',
    `${String(origin)} vs ${ORIGIN}`)

  console.log(`engine-probe: ${executablePath}`)

  head('mount')
  const mounted = await evaluate(`(() => {
    const src = ${JSON.stringify(bundle)}
    document.body.innerHTML = '<div style="height:80px">会话</div>' +
      '<div id="under" style="position:fixed;inset:0;z-index:0;background:#eef">' +
      '<button id="underBtn" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:.02">under</button></div>'
    window.__clicks = 0
    document.getElementById('underBtn').addEventListener('click', () => { window.__clicks++ })
    window.__ML = { def: null }
    window.__ModuleLoader__ = { load: (d) => { window.__ML.def = d } }
    new Function(src)()
    window.__ML.def.factory(() => ({})).apply({
      get: (n) => (n === 'timer'
        ? { timeout: (cb, ms) => { const i = setTimeout(cb, ms); return () => clearTimeout(i) },
            interval: (cb, ms) => { const i = setInterval(cb, ms); return () => clearInterval(i) } }
        : n === 'styles' ? { insert: (css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); return () => s.remove() } } : undefined),
      on: () => () => {}, effect: () => () => {},
    }, { wander: false, reactions: false, sleepAfterMs: 3600000, persist: false })
    const motion = document.querySelector('.wisp-motion')
    const lean = document.querySelector('.wisp-lean')
    return {
      version: window.__wisp.version,
      nesting: motion?.parentNode === document.querySelector('.wisp-body') && lean?.parentNode === motion,
      imgInsideLean: lean?.querySelectorAll('.wisp-img').length,
    }
  })()`)
  check(mounted.version !== undefined, 'the real bundle mounts', String(mounted.version))
  check(mounted.nesting === true && mounted.imgInsideLean === 1,
    'body > motion > lean > sprite is the live tree', JSON.stringify(mounted))

  /* 命中判定：她那个 560x840 的盒子里**大部分是透明的**（实测抽样：只有约四分之一
     的格是她）。透明处必须整层穿透到下面的应用 —— 这件事假 DOM 验不了（它没有命中
     判定），只有真引擎能给答案：`elementFromPoint` 会同时考虑 pointer-events 与
     clip-path，再用 CDP 发一次真实点击看下面那个按钮收不收得到。 */
  head('the hit area is her silhouette, not her box')
  await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`)
  /* 这一段会把她挪到确定位置来采样；**结束时必须放回原处** —— 她的左右半边是镜像的，
     留她在左半边会让后面所有"侧倾方向"的断言整体反号（这条真踩过）。 */
  const wasAt = await evaluate('window.__wisp.position')
  const picks = await evaluate(`(() => {
    window.__wisp.move(600, 150)
    const img = document.querySelector('.wisp-img')
    const c = document.createElement('canvas'); c.width = 96; c.height = 144
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 96, 144)
    const data = ctx.getImageData(0, 0, 96, 144).data
    const p = window.__wisp.position
    const clear = [], solid = []
    for (let row = 2; row < 142; row += 4) {
      for (let col = 2; col < 94; col += 4) {
        const a = data[(row * 96 + col) * 4 + 3]
        const x = Math.round(p.x + (col + 0.5) * (560 / 96))
        const y = Math.round(p.y + (row + 0.5) * (840 / 144))
        if (a === 0) clear.push({ x, y })
        else if (a > 240) solid.push({ x, y })
      }
    }
    const hitEl = document.querySelector('.wisp-hit')
    return {
      clear, solid,
      hasHitLayer: hitEl !== null,
      clip: hitEl ? String(hitEl.style.clipPath).slice(0, 0) + String(getComputedStyle(hitEl).clipPath).slice(0, 48) : null,
      bodyPointerEvents: getComputedStyle(document.querySelector('.wisp-body')).pointerEvents,
    }
  })()`)
  check(picks.hasHitLayer && picks.bodyPointerEvents === 'none',
    'the body stops taking pointer events and a dedicated hit layer takes them',
    `hitLayer=${picks.hasHitLayer} body=${picks.bodyPointerEvents}`)
  check(String(picks.clip).startsWith('path('),
    'the hit layer is clipped to the sprite silhouette (the browser does the pixel test)',
    String(picks.clip) + '…')
  check(picks.clear.length > picks.solid.length,
    'and most of her box really is transparent — which is why a box-shaped hit area is wrong',
    `${picks.solid.length} opaque samples vs ${picks.clear.length} transparent`)

  const clearPoint = picks.clear[Math.floor(picks.clear.length / 2)]
  const solidPoint = picks.solid[Math.floor(picks.solid.length / 2)]
  const topAt = async (x, y) => evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? (el.id || el.className || el.tagName) : null })()`)
  const realClick = async (x, y) => {
    const before = await evaluate('window.__clicks')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(150)
    return (await evaluate('window.__clicks')) - before
  }
  const clearTop = await topAt(clearPoint.x, clearPoint.y)
  check(clearTop === 'underBtn' || clearTop === 'under',
    'at a transparent pixel the topmost element is the APP, not her', String(clearTop))
  const clearClicks = await realClick(clearPoint.x, clearPoint.y)
  check(clearClicks === 1, 'a real click there reaches the app underneath', `${clearClicks} click(s)`)
  const movedByClearClick = await evaluate('(() => { const p = window.__wisp.position; return p.x !== 600 || p.y !== 150 })()')
  check(movedByClearClick === false, 'and it does not count as touching her')

  const solidTop = await topAt(solidPoint.x, solidPoint.y)
  check(solidTop === 'wisp-hit', 'on her body the topmost element is her hit layer', String(solidTop))
  const solidClicks = await realClick(solidPoint.x, solidPoint.y)
  check(solidClicks === 0, 'and clicking her does NOT fall through to the app', `${solidClicks} click(s)`)
  const focusedAfterClick = await evaluate(`document.activeElement ? String(document.activeElement.className || document.activeElement.tagName) : null`)
  check(String(focusedAfterClick).includes('wisp-body'),
    'clicking her still hands her the keyboard focus (so Enter still opens the menu)',
    String(focusedAfterClick))
  /* 焦点环：只能是**贴着剪影的辉光**，不能是画在盒子上的矩形。用户报的"有时会出现
     素材的矩形边界线"就是后者 —— 默认焦点环画在 .wisp-body 那个 560×840 的盒子上，
     而盒子里大部分是透明的，于是一次点击之后屏幕上凭空多出一个方框。
     这里量的是引擎**真的算出来**的样式：outline-style 必须是 none，而不是 auto
     （修之前这里就是 auto —— 假 DOM 验不出来，它是浏览器的默认行为）。 */
  const ringState = () => evaluate(`(() => {
    const body = document.querySelector('.wisp-body')
    const root = document.querySelector('.wisp-root')
    const img = document.querySelector('.wisp-img')
    const filter = getComputedStyle(img).filter
    return {
      outline: getComputedStyle(body).outlineStyle,
      focusAttr: root.dataset.focus === undefined ? null : root.dataset.focus,
      shadows: (filter.match(/drop-shadow\\(/g) || []).length,
    }
  })()`)
  const ringAfterClick = await ringState()
  check(ringAfterClick.outline === 'none' && ringAfterClick.focusAttr === null,
    'a click gives her focus but paints no box outline (the default focus ring is off)',
    JSON.stringify(ringAfterClick))

  /* 键盘路径：Enter 开菜单、Esc 关掉并把焦点交还给她 —— 关掉默认环之后，键盘用户
     必须仍然看得见焦点，而且那圈光必须跟着她的剪影走（多一层 drop-shadow）。 */
  const pressKey = async (k, code, keyCode) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
    await sleep(350)
  }
  await pressKey('Enter', 'Enter', 13)
  await pressKey('Escape', 'Escape', 27)
  const ringByKeyboard = await ringState()
  check(ringByKeyboard.outline === 'none' && ringByKeyboard.focusAttr === 'key'
    && ringByKeyboard.shadows === ringAfterClick.shadows + 1,
  'keyboard focus is shown by a silhouette halo (one more drop-shadow), never by a box outline',
  JSON.stringify(ringByKeyboard))
  await evaluate(`document.querySelector('.wisp-body').blur()`)
  /* 滤镜有 .5s 过渡 —— 等它走完再量，否则量到的是「正在淡出」的那一帧。 */
  await sleep(700)
  const ringCleared = await ringState()
  check(ringCleared.focusAttr === null && ringCleared.shadows === ringAfterClick.shadows,
    'and the halo is gone the moment focus leaves her', JSON.stringify(ringCleared))
  await evaluate(`window.__wisp.move(${wasAt.x}, ${wasAt.y})`)

  await sleep(1200)

  head('baseline')
  const base = await evaluate(`(() => ({
    bodyAnim: getComputedStyle(document.querySelector('.wisp-body')).animationName,
    amp: getComputedStyle(document.querySelector('.wisp-root')).getPropertyValue('--wisp-amp').trim(),
    tilt: document.querySelector('.wisp-root').style.getPropertyValue('--wisp-tilt'),
  }))()`)
  check(base.bodyAnim === 'none', 'the standing bob is gone - nothing animates the body layer any more', base.bodyAnim)
  check(base.amp === '1' && base.tilt === '0deg',
    'the amplitude variable and the initial posture resolve', `--wisp-amp=${base.amp} --wisp-tilt=${base.tilt}`)

  /* 插进两层空盒子之后，精灵图**必须还铺满原来的盒子**。这一条是假 DOM 永远
     验不了的：替身没有布局，两层 wrapper 少一个 inset:0，在那里也照样"通过"，
     而真页面上她会缩成半张图或者偏到底部。 */
  const geom = await evaluate(`(() => {
    const body = document.querySelector('.wisp-body').getBoundingClientRect()
    const img = document.querySelector('.wisp-img').getBoundingClientRect()
    const lean = document.querySelector('.wisp-lean').getBoundingClientRect()
    return { dx: Math.abs(img.left - body.left), dy: Math.abs(img.top - body.top), dw: Math.abs(img.width - body.width), dh: Math.abs(img.height - body.height), leanW: lean.width, bodyW: body.width }
  })()`)
  check(geom.dx < 1 && geom.dy < 1 && geom.dw < 1 && geom.dh < 1,
    'the sprite still fills her box exactly after the two layers went in (a missing inset:0 would shrink her)',
    `offset ${geom.dx.toFixed(2)},${geom.dy.toFixed(2)} size delta ${geom.dw.toFixed(2)}x${geom.dh.toFixed(2)}`)

  head('the pointer lean, in the real cascade')
  const near = await evaluate(`(() => {
    const p = window.__wisp.position
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x + 280 + 60, clientY: p.y + 420, bubbles: true }))
    return document.querySelector('.wisp-root').style.getPropertyValue('--wisp-tilt')
  })()`)
  await sleep(750)          // 姿势有 0.5s 过渡，读太早只会读到中途
  const leanState = await evaluate(`(() => {
    const m = /matrix(?:3d)?\\(([^)]+)\\)/.exec(getComputedStyle(document.querySelector('.wisp-lean')).transform)
    return { shear: m ? Math.abs(Number(m[1].split(',')[1])) : -1, raw: getComputedStyle(document.querySelector('.wisp-lean')).transform }
  })()`)
  check(near !== '0deg', 'a nearby pointer writes a posture angle', near)
  check(leanState.shear > 0.005,
    'and the engine really rotates the layer — rotate(var(--wisp-tilt)) resolves',
    `sin(theta)=${leanState.shear.toFixed(4)} (${leanState.raw})`)

  head('the press accent')
  const pressRun = await evaluate(`(async () => {
    const p = window.__wisp.position
    const body = document.querySelector('.wisp-body')
    const motion = document.querySelector('.wisp-motion')
    const ev = new PointerEvent('pointerdown', { button: 0, clientX: p.x + 280, clientY: p.y + 420, bubbles: true, cancelable: true })
    body.dispatchEvent(ev)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const anim = motion.getAnimations().find((a) => a.animationName === 'wisp-press')
    const keyframes = anim ? anim.effect.getKeyframes().map((k) => String(k.transform)) : []
    const out = { grabbed: ev.defaultPrevented, accent: document.querySelector('.wisp-root').dataset.accent, keyframes }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return out
  })()`)
  check(pressRun.grabbed === true && pressRun.accent === 'press',
    'a real press grabs her and sets the accent', `accent=${pressRun.accent}`)
  const moved = pressRun.keyframes.filter((t) => t && t !== 'none' && !/matrix\\(1, 0, 0, 1, 0, 0\\)/.test(t))
  check(pressRun.keyframes.length >= 3 && moved.length >= 1,
    'the calc()/var() keyframes survive parsing and really move her — a dropped keyframe would run but animate nothing',
    pressRun.keyframes.join(' | ') || '(none)')

  head('the landing after a drag')
  const landRun = await evaluate(`(async () => {
    const p = window.__wisp.position
    const body = document.querySelector('.wisp-body')
    const motion = document.querySelector('.wisp-motion')
    body.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: p.x + 280, clientY: p.y + 420, bubbles: true, cancelable: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x + 280 + 40, clientY: p.y + 420, bubbles: true }))
    const midTilt = document.querySelector('.wisp-root').style.getPropertyValue('--wisp-tilt')
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return {
      midTilt,
      accent: document.querySelector('.wisp-root').dataset.accent,
      names: motion.getAnimations().map((a) => a.animationName),
      afterTilt: document.querySelector('.wisp-root').style.getPropertyValue('--wisp-tilt'),
    }
  })()`)
  check(Number.parseFloat(landRun.midTilt) < 0, 'dragging to the right leans her back (negative screen tilt)',
    landRun.midTilt)
  check(landRun.accent === 'land' && landRun.names.includes('wisp-land'),
    'releasing after a drag lands her', `${landRun.accent} / ${landRun.names.join(', ') || '(none)'}`)
  check(landRun.afterTilt === '0deg', 'and the posture returns to upright', landRun.afterTilt)

  head('the mood pop (a gesture pops on every poke; a steady state never does)')
  const popRun = await evaluate(`(async () => {
    const motion = document.querySelector('.wisp-motion')
    const root = () => document.querySelector('.wisp-root')
    const body = document.querySelector('.wisp-body')
    const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const names = () => motion.getAnimations().map((a) => a.animationName)
    /* 先让上一步可能挂着的 flashHappy 计时器烧掉：它到点会把 mood 打回 idle，
       而那会让"同一个表情"那一步其实又变了一次 —— 这个假警报真出现过。 */
    await new Promise((r) => setTimeout(r, 1600))
    window.__wisp.mood('idle')
    await wait()
    window.__wisp.mood('happy')
    await wait()
    const changed = { accent: root().dataset.accent, names: names(), mood: window.__wisp.currentMood }
    /* 同一个表情再来一次 = 稳态重算（attn 每 1.2 秒走的就是这条路）：
       等上一次弹收尾之后必须**什么都不放**。 */
    await new Promise((r) => setTimeout(r, 600))
    window.__wisp.mood('happy')
    await wait()
    const steady = { accent: root().dataset.accent ?? null, names: names(), mood: window.__wisp.currentMood }
    /* 手势路径：戳两下，两下都要弹，而且名字要交替（同一个值不重播）。 */
    const p = window.__wisp.position
    const tap = async () => {
      body.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, clientX: p.x + 280, clientY: p.y + 420, bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      await wait()
      return { accent: root().dataset.accent, names: names() }
    }
    await new Promise((r) => setTimeout(r, 600))
    const tap1 = await tap()
    await new Promise((r) => setTimeout(r, 600))
    const tap2 = await tap()
    return { changed, steady, tap1, tap2 }
  })()`)
  const popOk = (r) => /^pop-/.test(String(r.accent)) && r.names.includes('wisp-' + r.accent)
  check(popOk(popRun.changed), 'a mood change pops instead of only cross-fading',
    `${popRun.changed.accent}:${popRun.changed.names.join(',')}`)
  check(popRun.steady.mood === 'happy' && popRun.steady.accent === null
    && !popRun.steady.names.some((n) => String(n).startsWith('wisp-pop')),
  'but re-asserting the same mood stays silent — that is the path the attention poll takes every 1.2s',
  `mood=${popRun.steady.mood} accent=${popRun.steady.accent} animations=${popRun.steady.names.join(',') || '(none)'}`)
  check(popOk(popRun.tap1) && popOk(popRun.tap2) && popRun.tap1.accent !== popRun.tap2.accent,
    'two taps in a row both pop, with alternating names',
    `${popRun.tap1.accent} -> ${popRun.tap2.accent}`)

  head('the "still" level')
  const stillState = await evaluate(`(() => {
    window.__wisp.configure({ motion: 'off' })
    const root = document.querySelector('.wisp-root')
    const p = window.__wisp.position
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x + 280 + 60, clientY: p.y + 420, bubbles: true }))
    return {
      attr: root.dataset.motion,
      amp: getComputedStyle(root).getPropertyValue('--wisp-amp').trim(),
      bodyAnim: getComputedStyle(document.querySelector('.wisp-body')).animationName,
      tilt: root.style.getPropertyValue('--wisp-tilt'),
    }
  })()`)
  check(stillState.attr === 'off' && stillState.amp === '0' && stillState.bodyAnim === 'none',
    '"still" stops the breathing as well — she is a static sticker, not a slow one', JSON.stringify(stillState))
  check(stillState.tilt === '0deg', 'and the posture is pinned upright', stillState.tilt)

  head('system reduced motion (Emulation.setEmulatedMedia)')
  await evaluate(`window.__wisp.configure({ motion: 'full' })`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await sleep(800)     // 等上一步可能还挂在属性上的动作收尾，否则会把残留当成新动作
  const rm = await evaluate(`(() => {
    const root = document.querySelector('.wisp-root')
    const p = window.__wisp.position
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x + 280 + 60, clientY: p.y + 420, bubbles: true }))
    document.querySelector('.wisp-body').dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: p.x + 280, clientY: p.y + 420, bubbles: true, cancelable: true }))
    const out = {
      reduced: window.__wisp.doctor().motion.reduced,
      tilt: root.style.getPropertyValue('--wisp-tilt'),
      accent: root.dataset.accent ?? null,
      bodyAnim: getComputedStyle(document.querySelector('.wisp-body')).animationName,
      motionAnim: getComputedStyle(document.querySelector('.wisp-motion')).animationName,
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return out
  })()`)
  check(rm.reduced === true, 'the plugin reads the system setting through matchMedia', String(rm.reduced))
  check(rm.tilt === '0deg' && rm.accent === null,
    'no posture and no accent are written — the media query cannot reach a JS-written variable, so this guard is load-bearing',
    `--wisp-tilt=${rm.tilt}, accent=${rm.accent}`)
  check(rm.bodyAnim === 'none' && rm.motionAnim === 'none',
    'and the media query stops every animation', `${rm.bodyAnim} / ${rm.motionAnim}`)

  /* ---------------------- 帧动画：这一段只有真引擎能回答 ----------------------
     假 DOM 能证明"把动图藏起来了、画面交回立绘"，证明不了**这张动图真的解得开**：
     动图 WebP 在浏览器里出不出画、`naturalWidth` 是不是 720、叠在立绘上有没有
     对齐 —— 全是解码与合成的事，而它的失败在页面上表现为"她还是不动"，和"没有
     素材"长得一模一样。
     这里**不读像素**：alpha 是 WebP 格式自己保证的（角落就是透的），把一张 720x1280
     的动图缩进 8x8 画布只能测出 canvas 的重采样，测不出格式；而"她是不是真的透"
     已经由 `<img>` + WebP 这条路径决定了，不需要探针再证一遍。 */
  head('the frame animations (real animated WebPs)')
  /* 上一节把 Emulation 设成了 reduce 而且没恢复 —— 先清掉，
     否则下面看到的"冻结"其实是上一节那个设置还在（那不是这条要测的东西）。 */
  await send('Emulation.setEmulatedMedia', { features: [] })

  /* ---- idle：**默认**状态就该有动图（v1.46.5）----
     假 DOM 能证明"元素建了、映射对、显隐跟着状态走"，证明不了这张 720x1280 的动图
     在真引擎里**解得开**：naturalWidth 是不是素材自己的宽度、变换**之前**是不是
     真的落在立绘那个盒子里。idle 不做尺寸校正（差 1.0~1.6%，小于 2% 那条线），
     所以它的计算后 transform 必须是 none —— 这条同时钉住"base 那条 1.186 没有
     落到 idle 头上"（落到她头上就是放大 18.6%，而页面上只会看起来"她今天有点大"）。 */
  const idleClip = await evaluate(`(async () => {
    const waitFor = async (ok, ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)) }
      return ok()
    }
    window.__wisp.configure({ motion: 'full' })
    window.__wisp.mood('idle')
    await waitFor(() => document.querySelector('.wisp-video') !== null, 5000)
    const motion = document.querySelector('.wisp-video')
    if (!motion) return { built: false }
    await waitFor(() => motion.complete && motion.naturalWidth > 0, 8000)
    const img = document.querySelector('.wisp-img')
    /* 与立绘同格必须在**变换之前**量：idle 没有变换，但这条断言要能和 sleepy 那段
       用同一把尺子（那边要临时把 transform 摘掉才量得到布局盒）。 */
    const saved = motion.style.transform
    motion.style.transform = 'none'
    const a = motion.getBoundingClientRect()
    motion.style.transform = saved
    const b = img.getBoundingClientRect()
    return {
      built: true, tag: String(motion.tagName), clip: motion.dataset.clip ?? null,
      complete: motion.complete, w: motion.naturalWidth, h: motion.naturalHeight,
      display: getComputedStyle(motion).display,
      transform: getComputedStyle(motion).transform,
      inline: motion.style.transform,
      dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top),
      dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height),
      visibility: getComputedStyle(img).visibility,
      frame: document.querySelector('.wisp-root').dataset.frame ?? null,
    }
  })()`)
  check(idleClip.built === true && idleClip.tag === 'IMG' && idleClip.clip === 'idle',
    'the idle state really builds the motion layer in the engine — the standing loop is live at mount (v1.46.5)',
    idleClip.built ? `${idleClip.tag} clip=${String(idleClip.clip)}` : 'no motion layer was built')
  check(idleClip.built === true && idleClip.complete === true
    && idleClip.w === IDLE_CANVAS.w && idleClip.h === IDLE_CANVAS.h,
    "and the idle animated WebP decodes at the asset's own size — naturalWidth is read from assets/motion/idle.webp, not hard-coded here",
    idleClip.built ? `${idleClip.w}x${idleClip.h} vs asset ${IDLE_CANVAS.w}x${IDLE_CANVAS.h} complete=${idleClip.complete}` : 'no <img> was built')
  check(idleClip.built === true && idleClip.dx < 1 && idleClip.dy < 1 && idleClip.dw < 1 && idleClip.dh < 1,
    'and it is laid out on exactly the sprite box, so handing the picture over cannot make her jump',
    `delta ${Number(idleClip.dx ?? NaN).toFixed(2)},${Number(idleClip.dy ?? NaN).toFixed(2)} size ${Number(idleClip.dw ?? NaN).toFixed(2)}x${Number(idleClip.dh ?? NaN).toFixed(2)}`)
  check(idleClip.built === true && String(idleClip.transform) === 'none' && idleClip.inline === 'none',
    "and NO size correction is applied to it — computed transform is none, so the sleeping clip's 1.186 did not leak onto idle (v1.46.5)",
    `computed ${String(idleClip.transform)} / inline ${JSON.stringify(idleClip.inline)}`)
  check(idleClip.built === true && idleClip.display !== 'none'
    && idleClip.visibility === 'hidden' && idleClip.frame === 'on',
    'and it owns the picture while the sprite is hidden — the two layers are never visible at once (v1.45.2)',
    `display=${String(idleClip.display)} sprite visibility=${String(idleClip.visibility)} data-frame=${String(idleClip.frame)}`)

  const clip = await evaluate(`(async () => {
    const waitFor = async (ok, ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)) }
      return ok()
    }
    window.__wisp.configure({ motion: 'full' })
    window.__wisp.mood('sleep')
    await waitFor(() => document.querySelector('.wisp-video') !== null, 5000)
    const motion = document.querySelector('.wisp-video')
    if (!motion) return { built: false }
    await waitFor(() => motion.complete && motion.naturalWidth > 0, 8000)
    const img = document.querySelector('.wisp-img')
    /* 尺寸校正（v1.46.4）：动作层**故意**比立绘那一格大 —— 她在 720x1280 的素材里只占
       0.8352 个盒高，立绘占 0.9883。所以"两层同格"必须量**变换之前**的布局盒：
       行内 transform 临时置 none 读一次 rect，读完立刻还回去（行内这条盖得住样式表那条，
       所以快照真的是干净的布局盒）。渲染后的 rect 单独读一次，用来验放大倍率与底边落点。 */
    const savedZoom = motion.style.transform
    motion.style.transform = 'none'
    const a = motion.getBoundingClientRect()
    motion.style.transform = savedZoom
    const b = img.getBoundingClientRect()
    const cs = getComputedStyle(motion)
    const shown = motion.getBoundingClientRect()
    return {
      built: true, tag: String(motion.tagName), isImg: motion instanceof HTMLImageElement,
      src: String(motion.src).slice(0, 5),
      complete: motion.complete, w: motion.naturalWidth, h: motion.naturalHeight,
      display: getComputedStyle(motion).display,
      pointerEvents: getComputedStyle(motion).pointerEvents,
      /* 画面归谁（v1.45.2）：这一条是**计算后**的 visibility，只有真引擎算得出来 ——
         假 DOM 里没有级联，只能读到"属性写了、规则也在"，证明不了它真的生效。 */
      visibility: getComputedStyle(img).visibility,
      frame: document.querySelector('.wisp-root').dataset.frame ?? null,
      dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top),
      dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height),
      transform: cs.transform,
      origin: motion.style.transformOrigin,
      layoutH: a.height,
      zoom: shown.height / a.height,
      drop: (shown.bottom - b.bottom) / a.height,
      videos: document.querySelector('.wisp-root').querySelectorAll('video').length,
    }
  })()`)
  check(clip.built === true && clip.tag === 'IMG' && clip.isImg === true && clip.videos === 0,
    'the motion layer really is an <img> in the engine — and not a single <video> exists under her root',
    clip.built ? `${clip.tag} isImg=${clip.isImg} videos=${clip.videos}` : 'no motion layer was built')
  check(clip.complete === true && clip.w === 720 && clip.h === 1280,
    'the animated WebP really decodes in the engine — 720x1280 natural size, not just a data URI in the bundle',
    clip.built ? `${clip.src}… ${clip.w}x${clip.h} complete=${clip.complete}` : 'no <img> was built')
  check(clip.display !== 'none',
    'and it is on screen by default — the browser runs the animation itself', `display=${clip.display}`)
  check(clip.dx < 1 && clip.dy < 1 && clip.dw < 1 && clip.dh < 1,
    'and BEFORE the size correction it is laid out on exactly the sprite box, so handing the picture over cannot make her jump',
    `delta ${clip.dx.toFixed(2)},${clip.dy.toFixed(2)} size ${clip.dw.toFixed(2)}x${clip.dh.toFixed(2)}`)
  /* 尺寸校正（v1.46.4）：**计算后**的 transform 才是"引擎认不认"的答案 —— 源码里写着
     scale(1.186) 不算数，它要么生效、要么被别的东西盖掉。两个数一起看：
     她的显示高度放大了多少倍，底边相对立绘那条落地线下移了多少（都按盒高归一化）。 */
  check(/^matrix\(1\.186/.test(String(clip.transform)) && Math.abs(clip.zoom - 1.186) < 0.004,
    'the engine really applies the size correction — the computed transform is scale(1.186), so she is as tall as the static sprite (v1.46.4)',
    `computed ${clip.transform} → rendered height ${clip.zoom.toFixed(4)}x the box`)
  check(Math.abs(clip.drop - 0.0930) < 0.004 && clip.origin === '50% 100%',
    "and it is dropped 9.3% of its own height about a bottom-centre origin, so her feet land where the sprite's do (v1.46.4)",
    `bottom shift ${(clip.drop * 100).toFixed(2)}% of ${clip.layoutH}px, inline transform-origin ${clip.origin}`)
  check(clip.pointerEvents === 'none', 'the layer takes no pointer events', String(clip.pointerEvents))
  /* 重影修复（v1.45.2）：动图在画面上时立绘必须**真的**看不见（计算后的 visibility 是
     hidden，而不是"读源码看到写了 visibility"）。 */
  check(clip.visibility === 'hidden' && clip.frame === 'on',
    'while the animation is on screen the static sprite is hidden in the real engine — the two layers are never visible at once (v1.45.2)',
    `sprite visibility=${clip.visibility} data-frame=${String(clip.frame)}`)

  const clipFrozen = await evaluate(`(() => {
    window.__wisp.configure({ motion: 'off' })
    const motion = document.querySelector('.wisp-video')
    const img = document.querySelector('.wisp-img')
    return {
      display: getComputedStyle(motion).display,
      sprite: getComputedStyle(img).display !== 'none' && Number(getComputedStyle(img).opacity) > 0.5,
      spriteVisibility: getComputedStyle(img).visibility,
      frame: document.querySelector('.wisp-root').dataset.frame ?? null,
      doctor: window.__wisp.doctor().motion.frame,
    }
  })()`)
  check(clipFrozen.display === 'none',
    '"still" takes the animation off screen in the real engine too — an <img> has no pause(), so hiding it IS the freeze',
    JSON.stringify(clipFrozen))
  check(clipFrozen.sprite === true, 'and the static sprite is still painted underneath', String(clipFrozen.sprite))
  /* 冻结时立绘必须**回来**：它这时是屏幕上唯一的那个她。 */
  check(clipFrozen.spriteVisibility === 'visible' && clipFrozen.frame === null
    && clipFrozen.doctor.showing === false,
  'and it is visible again, not just present — freezing hands the picture back to the sprite (v1.45.2)',
  `sprite visibility=${clipFrozen.spriteVisibility} data-frame=${String(clipFrozen.frame)} doctor.showing=${clipFrozen.doctor.showing}`)

  const clipBack = await evaluate(`(async () => {
    window.__wisp.configure({ motion: 'full' })
    await new Promise((r) => setTimeout(r, 400))
    const v = document.querySelector('.wisp-video')
    return { display: getComputedStyle(v).display, tag: String(v.tagName) }
  })()`)
  check(clipBack.display !== 'none' && clipBack.tag === 'IMG',
    'and putting the level back shows that same <img> again', JSON.stringify(clipBack))

  /* 会话中途把系统设置改成"减少动态效果"：CSS 的媒体查询是实时的，而这层显不显示是
     JS 写的。插件订阅了 matchMedia 的 change，所以这一下必须**当场**生效 —— 不订阅
     的话，她会在你刚关掉动画之后继续动到下一次换表情。 */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await sleep(600)
  const clipReduced = await evaluate(`(() => {
    const v = document.querySelector('.wisp-video')
    const img = document.querySelector('.wisp-img')
    return {
      reduced: window.__wisp.doctor().motion.reduced,
      display: getComputedStyle(v).display,
      spriteVisibility: getComputedStyle(img).visibility,
    }
  })()`)
  check(clipReduced.reduced === true && clipReduced.display === 'none'
    && clipReduced.spriteVisibility === 'visible',
  'turning reduced motion on mid-session takes the animation off screen at once, with no reload',
  JSON.stringify(clipReduced))
  await send('Emulation.setEmulatedMedia', { features: [] })

  /* 加载/解码失败的兜底：把 error 事件真的派给那张动图。假 DOM 里这条只证明了
     "调了 hideMotion()"；这里要证明的是**级联之后**立绘回到 visible —— 那正是
     "动图坏了也还有她"这句话的全部内容。 */
  const clipFailed = await evaluate(`(async () => {
    const waitFor = async (ok, ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)) }
      return ok()
    }
    const v = document.querySelector('.wisp-video')
    const root = document.querySelector('.wisp-root')
    const img = document.querySelector('.wisp-img')
    /* 先等**这一层真的回到画面上**：上一节把 Emulation 关掉之后，matchMedia 的 change
       是异步来的，这里不等就会在"她还没回来"的状态下快照 before —— 那样这条断言测的
       就不是"出错会交回画面"，而是"上一节还没生效"。 */
    await waitFor(() => v !== null && v.complete
      && getComputedStyle(v).display !== 'none'
      && getComputedStyle(img).visibility === 'hidden', 5000)
    const before = {
      visibility: getComputedStyle(img).visibility,
      frame: root.dataset.frame ?? null,
      tag: String(v.tagName),
    }
    v.dispatchEvent(new Event('error'))
    return {
      before,
      visibility: getComputedStyle(img).visibility,
      display: getComputedStyle(v).display,
      frame: root.dataset.frame ?? null,
      failed: window.__wisp.doctor().motion.frame.failed,
      spriteHidden: window.__wisp.doctor().motion.frame.spriteHidden,
    }
  })()`)
  check(clipFailed.before.visibility === 'hidden' && clipFailed.before.frame === 'on'
    && clipFailed.visibility === 'visible' && clipFailed.display === 'none'
    && clipFailed.frame === null && clipFailed.failed === true,
  'an animation that errors hands the picture straight back to the static sprite — hidden -> visible in the real engine (v1.45.2)',
  JSON.stringify(clipFailed))

  await evaluate(`window.__wisp.mood('idle')`)

  /* ---- 泳装那八条：在真引擎里逐条解开（v1.47.0）------------------------------
     "素材落盘了"和"页面上真的画出来了"是两件事。动图这条路（外置 URL -> <img> ->
     浏览器解码）只有真引擎能回答三个问题：URL 解析得出来吗、720x1280 的动图 WebP
     解得开吗（naturalWidth 是不是素材自己的宽度）、在**变换之前**是不是正好落在
     立绘那一格里。八条是八份独立素材，所以逐条查 —— 一条坏了在页面上只会表现为
     "她这个状态不动"，而那是静默降级，没有任何报错。 */
  const SWIM_STATES = [
    ['idle', 'swim_idle'], ['attn', 'swim_attn'], ['happy', 'swim_happy'], ['sleep', 'swim_sleepy'],
    ['alert', 'swim_work'], ['proud', 'swim_proud'], ['eat', 'swim_eat'], ['poked', 'swim_poked'],
  ]
  const SWIM_CANVAS = Object.fromEntries(SWIM_STATES.map(([, clip]) => [clip, motionCanvas(`${clip}.webp`)]))
  /* 判据是**磁盘上实际带着什么**：八条都在就逐条查，一条都没有就查真引擎里的静默降级。
     两者都是真的断言 —— 没有空过的一档（同 verify-wisp.mjs 的 SHIPPED_SWIM）。 */
  const SHIPPED_SWIM = existsSync(join(here, 'assets', 'motion'))
    ? readdirSync(join(here, 'assets', 'motion')).filter((f) => /^swim_[a-z]+\.webp$/.test(f)).sort()
    : []
  if (SHIPPED_SWIM.length === 8) {
  const swimClips = await evaluate(`(async () => {
    const waitFor = async (ok, ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) { const v = ok(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) }
      return ok()
    }
    window.__wisp.configure({ motion: 'full' })
    window.__wisp.setSkin('swim')
    const out = []
    for (const [state, clip] of ${JSON.stringify(SWIM_STATES)}) {
      window.__wisp.mood(state)
      const motion = await waitFor(() => {
        const el = document.querySelector('.wisp-video')
        return el && el.dataset.clip === clip && el.complete && el.naturalWidth > 0 ? el : null
      }, 8000)
      const img = document.querySelector('.wisp-img')
      if (!motion) { out.push({ state, clip, built: false }); continue }
      /* 与立绘同格必须在**变换之前**量（和 idle / sleepy 两段用同一把尺子）。 */
      const saved = motion.style.transform
      motion.style.transform = 'none'
      const a = motion.getBoundingClientRect()
      motion.style.transform = saved
      const b = img.getBoundingClientRect()
      out.push({
        state, clip, built: true, tag: String(motion.tagName),
        src: String(motion.getAttribute('src')),
        w: motion.naturalWidth, h: motion.naturalHeight, complete: motion.complete,
        display: getComputedStyle(motion).display,
        visibility: getComputedStyle(img).visibility,
        frame: document.querySelector('.wisp-root').dataset.frame ?? null,
        dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top),
        dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height),
      })
    }
    return out
  })()`)
  const swimMissing = swimClips.filter((c) => c.built !== true || c.tag !== 'IMG')
  check(swimMissing.length === 0,
    'all eight swimsuit clips really decode in the engine — every state builds its own <img> from the host route (v1.47.0)',
    swimMissing.length ? swimMissing.map((c) => `${c.state}/${c.clip ?? '?'}`).join(', ') : swimClips.map((c) => c.clip).join(', '))
  const swimSize = swimClips.filter((c) => c.built === true
    && (c.w !== SWIM_CANVAS[c.clip]?.w || c.h !== SWIM_CANVAS[c.clip]?.h))
  check(swimSize.length === 0,
    "and each one decodes at its asset's own size — naturalWidth comes from assets/motion/<clip>.webp, not from a number written here",
    swimSize.length
      ? swimSize.map((c) => `${c.clip}: ${c.w}x${c.h} vs ${SWIM_CANVAS[c.clip]?.w}x${SWIM_CANVAS[c.clip]?.h}`).join(' | ')
      : swimClips.map((c) => `${c.clip} ${c.w}x${c.h}`).join(', '))
  const swimBox = swimClips.filter((c) => c.built === true
    && !(c.dx < 1 && c.dy < 1 && c.dw < 1 && c.dh < 1))
  check(swimBox.length === 0,
    'and every one is laid out on exactly the sprite box BEFORE its size correction — the correction is the only thing that moves her, never a second grid',
    swimBox.length
      ? swimBox.map((c) => `${c.clip}: d=${Number(c.dx).toFixed(2)},${Number(c.dy).toFixed(2)} s=${Number(c.dw).toFixed(2)}x${Number(c.dh).toFixed(2)}`).join(' | ')
      : swimClips.map((c) => `${c.clip} d=${Number(c.dx).toFixed(2)},${Number(c.dy).toFixed(2)}`).join(', '))
  const swimOwner = swimClips.filter((c) => c.built === true
    && !(c.display !== 'none' && c.visibility === 'hidden' && c.frame === 'on'))
  check(swimOwner.length === 0,
    'and while each one plays the swimsuit sprite is out of the picture — one of her, in the real engine (v1.45.2 rule)',
    swimOwner.length
      ? swimOwner.map((c) => `${c.clip}: display=${c.display} sprite=${c.visibility} frame=${String(c.frame)}`).join(' | ')
      : `${swimClips.length} clips: display!=none, sprite hidden, data-frame=on`)
  const swimUrls = swimClips.filter((c) => c.built === true && !String(c.src).startsWith(`${ORIGIN}/wisp-motion/`))
  check(swimUrls.length === 0 && [...SWIM_STATES].every(([, clip]) => (clipHits.get(`${clip}.webp`) ?? 0) > 0),
    'and every clip really came over HTTP from the page’s own origin — the delivery path, not an inlined copy',
    swimUrls.length
      ? swimUrls.map((c) => `${c.clip}: ${c.src}`).join(' | ')
      : `${clipHits.size} clip file(s) served, e.g. ${String(swimClips[0]?.src)}`)
  } else {
    /* 素材还没生成（0/8）：真引擎里要看到的是**静默降级** —— 泳装那一档一个动图元素
       都不建、立绘一直在画面上，而且**不许**退回通用那段循环（穿着泳装播别的皮肤的
       动作，比不动更糟）。然后换回一套有素材的皮肤，动图必须立刻回来 ——
       这一条把"这个皮肤没有素材"和"帧动画坏了"分开。 */
    const swimQuiet = await evaluate(`(async () => {
      const waitFor = async (ok, ms) => {
        const until = Date.now() + ms
        while (Date.now() < until) { const v = ok(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) }
        return ok()
      }
      window.__wisp.configure({ motion: 'full' })
      window.__wisp.setSkin('swim')
      const leaks = []
      for (const [state] of ${JSON.stringify(SWIM_STATES)}) {
        window.__wisp.mood(state)
        await waitFor(() => false, 120)
        const v = document.querySelector('.wisp-video')
        if (v && getComputedStyle(v).display !== 'none') leaks.push(state + ':' + (v.dataset.clip ?? '?'))
      }
      const img = document.querySelector('.wisp-img')
      const quiet = {
        leaks,
        sprite: getComputedStyle(img).visibility,
        frame: document.querySelector('.wisp-root').dataset.frame ?? null,
        asset: window.__wisp.doctor().motion.frame.asset,
      }
      window.__wisp.mood('idle')
      await waitFor(() => false, 120)
      const beforeSwitch = document.querySelector('.wisp-video')
      const beforeVideos = [...document.querySelectorAll('.wisp-video')]
        .map((v) => String(v.dataset.clip) + ':' + getComputedStyle(v).display)
      window.__wisp.setSkin('deepsea')
      /* 用 idle 而不是 sleep：这一页上半段那条"加载失败静默降级"的检查**故意**把
         sleepy 这一段标成坏过的（失败按素材记，不再重指源），拿它当"回来了"的判据
         会测到那条规则头上。 */
      const back = await waitFor(() => {
        const v = document.querySelector('.wisp-video')
        return v && v.dataset.clip === 'idle' && v.complete && v.naturalWidth > 0 ? v : null
      }, 8000)
      return {
        quiet,
        beforeSwitch: beforeVideos.length === 0 || beforeVideos.every((s) => s.endsWith(':none')),
        beforeVideos,
        backClip: back === null ? null : back.dataset.clip,
        backW: back === null ? 0 : back.naturalWidth,
      }
    })()`)
    check(swimQuiet.quiet.leaks.length === 0 && swimQuiet.quiet.sprite === 'visible'
      && swimQuiet.quiet.frame === null && swimQuiet.quiet.asset === null,
      'with no swimsuit clips shipped, the engine builds NO frame layer for any of the eight states — and the sprite keeps the picture (v1.47.0)',
      `leaks=${swimQuiet.quiet.leaks.join(',') || 'none'} sprite=${swimQuiet.quiet.sprite} data-frame=${String(swimQuiet.quiet.frame)} asset=${String(swimQuiet.quiet.asset)}`)
    check(swimQuiet.beforeSwitch === true && swimQuiet.backClip === 'idle' && swimQuiet.backW > 0,
      'and a skin WITH clips brings the animation straight back in the same engine — missing swimsuit art is not a broken frame layer',
      `swim/idle quiet=${swimQuiet.beforeSwitch} → deepsea/idle clip=${String(swimQuiet.backClip)} ${swimQuiet.backW}px wide`)
    console.log(`  NOTE  ${SHIPPED_SWIM.length}/8 swimsuit clips generated yet — the eight-clip checks are replaced by the degradation checks above`)
  }

  console.log(`\n=== ${failures === 0 ? 'ENGINE PROBE PASSED' : `${failures} PROBE CHECK(S) FAILED`} ===`)
} finally {
  try { ws.close() } catch (e) { /* ignore */ }
  await cleanup()
}

process.exit(failures === 0 ? 0 : 1)
