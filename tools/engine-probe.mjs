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
 *
 * 用法：node tools/engine-probe.mjs      （WISP_CHROME=<可执行文件> 可指定浏览器）
 * 退出码：0 通过或跳过 · 1 有检查没过 · 2 环境起不来（找不到可用的调试端口）
 * ------------------------------------------------------------------------- */
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

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
     假 DOM 能证明"调了 pause()、把 currentTime 写回了 0"，证明不了**这段视频真的
     解得开**：VP9 + alpha 平面在浏览器里出不出画、`videoWidth` 是不是 480、叠在
     立绘上有没有对齐、角落里是不是真的透明 —— 全是解码与合成的事，而它的失败
     在页面上表现为"她还是不动"，和"没有素材"长得一模一样。 */
  head('the first frame animation (a real alpha WebM loop)')
  /* 上一节把 Emulation 设成了 reduce 而且没恢复 —— 先清掉，
     否则下面看到的"冻结"其实是上一节那个设置还在（那不是这条要测的东西）。 */
  await send('Emulation.setEmulatedMedia', { features: [] })
  const clip = await evaluate(`(async () => {
    const waitFor = async (ok, ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)) }
      return ok()
    }
    window.__wisp.configure({ motion: 'full' })
    window.__wisp.mood('sleep')
    await waitFor(() => document.querySelector('.wisp-video') !== null, 5000)
    const video = document.querySelector('.wisp-video')
    if (!video) return { built: false }
    await waitFor(() => video.readyState >= 2 && video.videoWidth > 0, 8000)
    const img = document.querySelector('.wisp-img')
    const a = video.getBoundingClientRect()
    const b = img.getBoundingClientRect()
    /* 角落的 alpha：把她画进一张 8x8 的画布，读四个角的 alpha 通道。
       不透明的话这里会是 255 —— 那说明 alpha 平面根本没解码出来（黑底）。 */
    let corners = null
    try {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8
      const ctx = c.getContext('2d')
      ctx.drawImage(video, 0, 0, 8, 8)
      const d = ctx.getImageData(0, 0, 8, 8).data
      corners = [0, 7, 56, 63].map((i) => d[i * 4 + 3])
    } catch (e) { corners = String(e.name || e.message || e) }
    return {
      built: true, src: String(video.src).slice(0, 5), readyState: video.readyState,
      w: video.videoWidth, h: video.videoHeight, paused: video.paused,
      display: getComputedStyle(video).display,
      pointerEvents: getComputedStyle(video).pointerEvents,
      dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top),
      dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height),
      corners,
    }
  })()`)
  check(clip.built === true && clip.w > 0 && clip.h > 0,
    'the alpha WebM really decodes in the engine — the clip is not just a data URI sitting in the bundle',
    clip.built ? `${clip.src}… ${clip.w}x${clip.h} readyState=${clip.readyState}` : 'no <video> was built')
  check(clip.paused === false && clip.display !== 'none',
    'and it is playing on its own (muted autoplay is allowed)', `paused=${clip.paused} display=${clip.display}`)
  check(Array.isArray(clip.corners) && Math.min(...clip.corners) < 32,
    'a corner of the frame is TRANSPARENT — that is the alpha plane, and the reason this asset had to be a WebM',
    Array.isArray(clip.corners) ? `corner alpha ${clip.corners.join('/')}` : `canvas readback: ${clip.corners}`)
  check(clip.dx < 1 && clip.dy < 1 && clip.dw < 1 && clip.dh < 1,
    'and it lands on exactly the sprite box, so the loop does not make her jump',
    `delta ${clip.dx.toFixed(2)},${clip.dy.toFixed(2)} size ${clip.dw.toFixed(2)}x${clip.dh.toFixed(2)}`)
  check(clip.pointerEvents === 'none', 'the layer takes no pointer events', String(clip.pointerEvents))

  const clipFrozen = await evaluate(`(() => {
    const video = document.querySelector('.wisp-video')
    video.currentTime = 2.4                    // 已经循环到一半
    window.__wisp.configure({ motion: 'off' })
    const img = document.querySelector('.wisp-img')
    return {
      paused: video.paused, t: video.currentTime,
      display: getComputedStyle(video).display,
      sprite: getComputedStyle(img).display !== 'none' && Number(getComputedStyle(img).opacity) > 0.5,
    }
  })()`)
  check(clipFrozen.paused === true && clipFrozen.t === 0 && clipFrozen.display === 'none',
    '"still" freezes the loop at the first frame in the real engine too',
    JSON.stringify(clipFrozen))
  check(clipFrozen.sprite === true, 'and the static sprite is still painted underneath', String(clipFrozen.sprite))

  const clipBack = await evaluate(`(async () => {
    window.__wisp.configure({ motion: 'full' })
    await new Promise((r) => setTimeout(r, 400))
    const v = document.querySelector('.wisp-video')
    return { paused: v.paused, display: getComputedStyle(v).display }
  })()`)
  check(clipBack.paused === false && clipBack.display !== 'none',
    'and putting the level back resumes it', JSON.stringify(clipBack))

  /* 会话中途把系统设置改成"减少动态效果"：CSS 的媒体查询是实时的，而播放状态是 JS 的。
     插件订阅了 matchMedia 的 change，所以这一下必须**当场**生效 —— 不订阅的话，
     她会在你刚关掉动画之后继续动到下一次换表情。 */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await sleep(600)
  const clipReduced = await evaluate(`(() => {
    const v = document.querySelector('.wisp-video')
    return {
      reduced: window.__wisp.doctor().motion.reduced,
      paused: v.paused, t: v.currentTime, display: getComputedStyle(v).display,
    }
  })()`)
  check(clipReduced.reduced === true && clipReduced.paused === true && clipReduced.t === 0
    && clipReduced.display === 'none',
  'turning reduced motion on mid-session stops the loop where it stands, with no reload',
  JSON.stringify(clipReduced))
  await send('Emulation.setEmulatedMedia', { features: [] })
  await evaluate(`window.__wisp.mood('idle')`)

  console.log(`\n=== ${failures === 0 ? 'ENGINE PROBE PASSED' : `${failures} PROBE CHECK(S) FAILED`} ===`)
} finally {
  try { ws.close() } catch (e) { /* ignore */ }
  await cleanup()
}

process.exit(failures === 0 ? 0 : 1)
