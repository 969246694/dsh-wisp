/* ============================================================================
   verify-wisp.mjs — pre-flight checks for the dsh-wisp bundle.

   TWO FILES, TWO DIFFERENT CONTRACTS. Getting this wrong caused every load
   failure this plugin had, so the checks are organised around it.

     lib/index.js   the HOST half — a plain ES module the host imports.
                    The loader entry in cordis.patch.yml points at the PACKAGE
                    (`dsh-wisp`), which resolves here.

     lib/client.js  the BROWSER half — a CLASSIC script that registers with the
                    web shell:  window.__ModuleLoader__.load({ id, factory })
                    Reached through exports["./client"], served by /plugins.

   The browser half is not just syntax-checked: it is EXECUTED against a
   harness that reproduces the surfaces it really meets —

     * all six globals the dynamic runner traps (setTimeout, setInterval,
       clearTimeout, clearInterval, fetch, require) are shadowed by THROWING
       functions, so touching one fails the run instead of the user's session;
     * a virtual clock drives BOTH scheduling paths (the Client `timer` service
       and the requestAnimationFrame fallback), so timer behaviour is asserted
       rather than assumed;
     * a fake DOM, Blob/URL pipeline, localStorage (including one that throws,
       like an opaque origin), and a scriptable busy/composer state.

   RUN
     node verify-wisp.mjs
   EXIT CODE 0 = both halves match their contract.
   ========================================================================== */

import { readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { verifyAudit } from './tools/audit-log.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = join(here, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const hostPath = resolve(here, pkg.main ?? 'lib/index.js')
const clientRel = pkg.exports?.['./client']?.default
const clientPath = clientRel ? resolve(here, clientRel) : null

let failures = 0
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? '  — ' + d : ''}`)
const bad = (l, d = '') => { failures++; console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`) }
const head = (t) => console.log(`\n=== ${t} ===`)
const check = (cond, l, d = '') => (cond ? ok(l, d) : bad(l, d))

/* ============================================================ 0. the traps == */

/**
 * The six globals a dynamic client half must never touch. The runner shadows
 * them with throwing parameters; this suite reproduces that exactly, so a
 * regression here fails the build instead of crashing a live page.
 */
const TRAPPED = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'require']

/** The client half's reaction poll period; kept in step with lib/client.template.js. */
const POLL_MS = 1200

/* ==================================================== the browser harness === */

let active = null
let urlSeq = 0

/* 插件依次尝试的输入框钩子数量（与 client.template.js 的 COMPOSER_HOOKS 对应）。
   写成常量是为了让"它到底试了几条"成为一个可断言的数字，而不是一句描述。 */
const COMPOSER_HOOK_COUNT = 3

/* 台词池从**产物**里读出来，而不是在测试里抄一份。
   抄一份的话，每次改文案都要同步改测试 —— 而且改漏了才发现，比如"庆祝说了别的池子的话"
   这种真 bug 会被硬编码的列表掩盖。
   惰性求值：`clientSrc` 在文件后面才声明，写成立即求值会踩 TDZ。 */
let linesCache
const linesInBundle = () => {
  if (linesCache !== undefined) return linesCache
  linesCache = null
  if (typeof clientSrc === 'string') {
    const match = clientSrc.match(/const LINES = (\{[\s\S]*?\n {4}\})/)
    if (match) {
      try { linesCache = new Function(`return ${match[1]}`)() } catch (e) { linesCache = null }
    }
  }
  return linesCache
}

/* 假的主题令牌表：doctor() 会把它们读出来，所以替身必须真的给值 ——
   全空的替身会让"主题令牌读不到"这条告警永远成立，测不出真实行为。 */
const styleTokens = {
  '--dsw-alias-label-primary': '#1b1b1f',
  '--dsw-alias-bg-overlay': 'rgba(255,255,255,.93)',
  '--dsw-alias-border-l1': 'rgba(15,30,40,.10)',
  '--dsw-alias-bg-layer-2': 'rgba(120,170,255,.22)',
  '--dsw-alias-brand-primary': '#4c8dff',
}

class FakeBlob {
  constructor(parts, opts) {
    this.parts = parts
    this.type = (opts && opts.type) || ''
    this.size = parts[0] ? parts[0].length : 0
    if (active) active.blobs.push(this)
  }
}
const FakeURL = {
  createObjectURL() { const url = `blob:dsh-app/verify-${++urlSeq}`; if (active) active.urLs.push(url); return url },
  revokeObjectURL(url) { if (active) active.revoked.push(url) },
}
/* The constructor writes the backing field directly: routing its own
   initialisation through the instrumented setter would record a phantom empty
   src for every `new Image()`. */
const FakeImage = function FakeImage() { this._src = '' }
Object.defineProperty(FakeImage.prototype, 'src', {
  get() { return this._src ?? '' },
  set(value) {
    this._src = value
    if (active) active.srcs.push(value)
    // The plugin builds its alpha hit-mask from an Image load, so the harness
    // fires onload synchronously rather than leaving the mask path untested.
    if (typeof this.onload === 'function') this.onload()
  },
})
const fakeAtob = (s) => Buffer.from(s, 'base64').toString('binary')

/**
 * Build one isolated page.
 * @param {object} [options] - timer (service present), busy, composerText,
 *   storage ('memory' | 'throwing' | 'absent'), theme, viewport.
 * @returns the harness: element factory, dispatch helpers, clock driver, ctx.
 */
function createHarness(options = {}) {
  const state = {
    now: 0,
    busy: !!options.busy,
    composerText: options.composerText === undefined ? null : options.composerText,
    pending: options.pending === undefined ? null : options.pending,
    errors: options.errors === undefined ? 0 : options.errors,
    ariaLabels: options.ariaLabels === undefined ? [] : options.ariaLabels,
    overlayStack: options.overlayStack === undefined ? [] : options.overlayStack,
  }

  const created = []
  const frames = []
  const rafSlots = new Map()
  let rafSeq = 0
  const timers = []
  /* 可预置的存储：跨天归零这类行为没法用虚拟时钟测（它读真实日期），
     但可以用"存着昨天的数据"来测。 */
  const clipboardWrites = []
  const store = new Map()
  if (options.storageSeed && typeof options.storageSeed === 'object') {
    for (const [k, v] of Object.entries(options.storageSeed)) store.set(k, v)
  }
  /* 最小焦点模型：真实 DOM 里 focus() 会更新 document.activeElement，键盘导航依赖这一点。
     没有它，"焦点在哪一项"就无法断言 —— 替身缺能力会被误读成产品缺陷。 */
  let activeEl = null

  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [], parentNode: null, dataset: {}, attrs: {},
      style: { setProperty(k, v) { this[k] = v }, getPropertyValue(k) { return this[k] ?? '' } },
      className: '', textContent: '', id: '', value: '',
      listeners: Object.create(null),
      _src: '',
      focus() { activeEl = el },
      blur() { if (activeEl === el) activeEl = null },
      get firstChild() { return this.children[0] ?? null },
      get src() { return this._src },
      set src(v) { this._src = v; if (this.tagName === 'IMG') harness.srcs.push(v) },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null },
      hasAttribute(k) { return Object.hasOwn(this.attrs, k) },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c },
      append(...cs) { for (const c of cs) this.appendChild(c) },
      insertBefore(c, before) {
        if (c.parentNode) c.parentNode.removeChild(c)
        c.parentNode = this
        const at = before ? this.children.indexOf(before) : -1
        if (at < 0) this.children.unshift(c)
        else this.children.splice(at, 0, c)
        return c
      },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c)
        c.parentNode = null
        /* 移除必须**递归**标记：真实 DOM 的 querySelectorAll 只返回还连在文档上的元素。
           只标记被直接摘掉的那个，会让"页面上还剩几个她"把早已移除的旧子树也数进来。 */
        const markRemoved = (node) => {
          node.removed = true
          for (const child of node.children || []) markRemoved(child)
        }
        markRemoved(c)
        return c
      },
      remove() { if (this.parentNode) this.parentNode.removeChild(this) },
      descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]) },
      querySelector(sel) {
        const found = this.querySelectorAll(sel)
        return found.length > 0 ? found[0] : null
      },
      querySelectorAll(sel) {
        // 类选择器与标签选择器都要支持：只支持前者时，一个用 'img' 查询的断言会
        // 静默返回空集 —— 测试替身的局限会伪装成产品缺陷。
        if (typeof sel !== 'string' || sel === '') return []
        if (sel.startsWith('.')) {
          const cls = sel.slice(1)
          return this.descendants().filter((d) => d.className === cls)
        }
        const tag = sel.toUpperCase()
        return this.descendants().filter((d) => d.tagName === tag)
      },
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
      removeEventListener(type, fn) {
        const list = this.listeners[type]
        if (!list) return
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
      },
      dispatch(type, event) { for (const fn of [...(this.listeners[type] ?? [])]) fn(event ?? {}) },
      listenerCount(type) { return (this.listeners[type] ?? []).length },
    }
    if (String(tag).toLowerCase() === 'canvas') {
      // A deterministic stand-in for the sprite's alpha channel: opaque across
      // the middle half of the width, transparent outside it. That is what the
      // shipped sprites look like (55-87% of the width is figure, the rest is
      // margin) and it makes the hit test assertable.
      el.getContext = () => ({
        drawImage() {},
        getImageData(x, y, w, h) {
          const data = new Uint8ClampedArray(w * h * 4)
          for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
              const opaque = px >= w * 0.25 && px < w * 0.75
              data[(py * w + px) * 4 + 3] = opaque ? 255 : 0
            }
          }
          return { data }
        },
      })
    }
    created.push(el)
    return el
  }

  const bodyEl = makeEl('body')
  const headEl = makeEl('head')
  /* The composer is a live node whose text follows `state.composerText`, and it
     is absent (null) while that is null — so the plugin's caching AND its
     re-resolution are both exercised for real. */
  const composerNode = {
    tagName: 'DIV',
    isConnected: true,
    get textContent() { return state.composerText ?? '' },
  }
  const queries = { stop: 0, composer: 0, all: 0, pending: 0, errors: 0 }
  const COMPOSER_HOOKS = ['[data-composer-input]', 'textarea', '[contenteditable="true"]']

  /* 匹配集合的唯一真源。querySelector 与 querySelectorAll 在真实 DOM 里匹配的是同一个集合，
     所以替身也必须只有一处逻辑 —— 之前两处各写一半，结果是 doctor()（用 querySelectorAll）
     在替身里永远看到 0，而产品代码在真实浏览器里是对的：**替身说谎**。 */
  const matchAll = (sel) => {
    if (typeof sel !== 'string') return []
    /* 类选择器：真实 DOM 里按 class 查询是最常见的一种，替身必须支持 ——
       否则"页面上有几个她"那条兜底逻辑在替身里永远看不到任何东西。 */
    if (sel.startsWith('.')) {
      const want = sel.slice(1)
      return created.filter((e) => !e.removed && String(e.className || '').split(/\s+/).includes(want))
    }
    // 带 aria-label 的按钮：doctor() 在忙碌钩子 miss 时会采样它们。
    // 必须放在忙碌分支【之前】：'button[aria-label]' 也以 'button[' 开头，而真实 DOM 是精确
    // 匹配选择器的 —— 顺序写错会让这条断言空过（替身说谎的又一例）。
    if (sel === 'button[aria-label]') {
      return state.ariaLabels.map((label) => ({ tagName: 'BUTTON', getAttribute: (k) => (k === 'aria-label' ? label : null) }))
    }
    if (sel.startsWith('button[')) return state.busy ? [pendingNode] : []
    if (sel.startsWith('[data-question-key]')) {
      return state.pending === null
        ? []
        : [{ getAttribute: (n) => (n === 'data-question-key' ? state.pending : null) }]
    }
    if (COMPOSER_HOOKS.includes(sel)) {      // 真实页面里只会存在**一种**形态的输入框钩子，所以替身也只让被选中的那一种命中 ——
      // 让三个同时命中会掩盖回退链：第二、三条到底能不能用，只有分开才测得到。
      const shape = options.composerShape ?? 0
      return COMPOSER_HOOKS[shape] === sel && state.composerText !== null ? [composerNode] : []
    }
    // 出错行：DSH 给失败的工具行/命令卡标 data-error="true"，按 state.errors 造出同等数量
    if (sel === '[data-error="true"]') {
      return Array.from({ length: state.errors }, (_, i) => ({ tagName: 'SPAN', className: 'err', key: i }))
    }
    // 带 aria-label 的按钮：doctor() 在忙碌钩子 miss 时会采样它们
    if (sel === 'button[aria-label]') {
      return state.ariaLabels.map((label) => ({ tagName: 'BUTTON', getAttribute: (k) => (k === 'aria-label' ? label : null) }))
    }
    return []
  }
  // 计数仍按原来的语义各自统计，这样性能类断言（"空闲时 0 次全量查询"）不受影响
  const countQuery = (sel) => {
    if (typeof sel === 'string' && sel.startsWith('button[')) queries.stop++
    else if (typeof sel === 'string' && sel.startsWith('[data-question-key]')) queries.pending++
    else if (COMPOSER_HOOKS.includes(sel)) queries.composer++
  }
  const pendingNode = {}

  const documentShim = {
    body: bodyEl,
    head: headEl,
    get activeElement() { return activeEl },
    createElement: (t) => makeEl(t),
    getElementById: (id) => created.find((e) => e.id === id && !e.removed) ?? null,
    /* 采样点上的元素栈：按"最上面优先"返回。窗口背景那一段要靠它判断
       "谁在铺满视口的地方画了不透明底色"，所以替身必须真的按尺寸过滤。 */
    elementsFromPoint: () => (state.overlayStack || []).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width >= (options.width ?? 1920) * 0.8 && r.height >= (options.height ?? 1200) * 0.3
    }),
    querySelector: (sel) => {
      countQuery(sel)
      return matchAll(sel)[0] ?? null
    },
    querySelectorAll: (sel) => {
      queries.all++
      if (sel === '[data-error="true"]') queries.errors++
      return matchAll(sel)
    },
  }

  const winListeners = Object.create(null)
  const localStorageShim = options.storage === 'absent' ? undefined : {
    getItem: (k) => {
      if (options.storage === 'throwing') throw new Error('storage disabled (opaque origin)')
      return store.has(k) ? store.get(k) : null
    },
    setItem: (k, v) => {
      if (options.storage === 'throwing') throw new Error('storage disabled (opaque origin)')
      store.set(k, String(v))
    },
    removeItem: (k) => {
      if (options.storage === 'throwing') throw new Error('storage disabled (opaque origin)')
      store.delete(k)
    },
  }

  const win = {
    innerWidth: options.width ?? 1920,
    innerHeight: options.height ?? 1200,
    performance: { now: () => state.now },
    requestAnimationFrame: (fn) => { const id = ++rafSeq; rafSlots.set(id, fn); frames.push({ id, fn }); return id },
    cancelAnimationFrame: (id) => {
      // A no-op here would let a disposed frame survive teardown and make the
      // "the loop stops" assertions meaningless.
      if (!rafSlots.has(id)) return
      rafSlots.delete(id)
      const at = frames.findIndex((rec) => rec.id === id)
      if (at >= 0) frames.splice(at, 1)
    },
    localStorage: localStorageShim,
    /* 剪贴板默认**不存在** —— 这样「没有权限时静默降级」那条才测得到；
       要测复制成功用 createHarness({ clipboard: true })。 */
    navigator: options.clipboard === true
      ? { clipboard: { writeText: (text) => { clipboardWrites.push(text); return Promise.resolve() } } }
      : {},
    /* 真实浏览器里 getComputedStyle 是 window 上的方法。替身必须给出它 ——
       缺这一项会让"用了裸全局"这类可移植性问题无法被发现（doctor() 第一次就撞上了）。 */
    getComputedStyle: (el) => ({
      getPropertyValue: (name) => (options.tokens === 'empty' ? '' : (styleTokens[name] ?? '')),
      /* 背景色按"元素的第一个类名"查表 —— 替身没有真实级联，这样足够表达
         "这个元素画不画底色"这一件事，而它正是窗口背景那段逻辑唯一关心的。 */
      get backgroundColor() {
        const cls = String(el?.className || '').split(/\s+/).filter(Boolean)[0]
        return (options.backgrounds && cls && options.backgrounds[cls]) || 'rgba(0, 0, 0, 0)'
      },
    }),
    addEventListener(type, fn) { (winListeners[type] ??= []).push(fn) },
    removeEventListener(type, fn) {
      const list = winListeners[type]
      if (!list) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    dispatch(type, event) { for (const fn of [...(winListeners[type] ?? [])]) fn(event ?? {}) },
    listenerCount: (type) => (winListeners[type] ?? []).length,
    __ModuleLoader__: { load(def) { harness.loaded = def } },
  }
  win.window = win

  /* The Client `timer` service: registrations plus their disposers. */
  const timerService = options.timer === false ? undefined : {
    timeout(cb, ms) { const t = { cb, due: state.now + ms, every: 0, cancelled: false }; timers.push(t); return () => { t.cancelled = true } },
    interval(cb, ms) { const t = { cb, due: state.now + ms, every: ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true } },
  }

  const themeListeners = []
  const themeSnapshot = { preference: options.themeDark ? 'dark' : 'light', active: { id: 'x', colorScheme: options.themeDark ? 'dark' : 'light', tokens: {} } }
  /* 真实的 ctx.effect(fn) **立即调用 fn**，把返回值当 disposer 记下来，卸载时按反序调用。
     只"存起来等卸载"的替身会让注册类 effect（设置页就是）永远不执行 —— 那是替身不准。 */
  const effects = []
  const effectDisposers = []
  const runEffects = () => {
    const out = effectDisposers.splice(0, effectDisposers.length)
    out.reverse().forEach((dispose) => { try { dispose() } catch (e) { /* ignore */ } })
    return out
  }
  const registerEffect = (fn, label) => {
    effects.push({ fn, label })
    const result = typeof fn === 'function' ? fn() : undefined
    if (typeof result === 'function') effectDisposers.push(result)
    return () => {}
  }

  const styleInserts = []

  const ctx = {
    get: (name) => {
      if (name === 'timer') return timerService
      if (name === 'styles') return { insert: (css) => { styleInserts.push(css); return () => { styleInserts.pop() } } }
      if (name === 'theme') return { getTheme: () => themeSnapshot }
      return undefined
    },
    on: (name, fn) => {
      if (name !== 'theme/change') return () => {}
      themeListeners.push(fn)
      return () => { const at = themeListeners.indexOf(fn); if (at >= 0) themeListeners.splice(at, 1) }
    },
    effect: registerEffect,
  }

  const harness = {
    state, ctx, win, document: documentShim, bodyEl, created, frames, timers, queries,
    srcs: [], urLs: [], revoked: [], blobs: [], styleInserts,
    loaded: null,
    timerService,
    get teardown() { return runEffects },
    get effectLabels() { return effects.map((e) => e.label) },
    emitTheme(snapshot) { for (const fn of [...themeListeners]) fn(snapshot ?? themeSnapshot) },
    themeListenerCount: () => themeListeners.length,
    fireTimers() {
      for (let guard = 0; guard < 2000; guard++) {
        const due = timers.filter((t) => !t.cancelled && t.due <= state.now).sort((a, b) => a.due - b.due)
        if (due.length === 0) return
        const t = due[0]
        if (t.every > 0) t.due = state.now + t.every
        else { t.cancelled = true; timers.splice(timers.indexOf(t), 1) }
        t.cb()
      }
    },
    /** Advance virtual time, pumping both scheduling paths. */
    advance(ms, stepMs = 25) {
      let left = ms
      while (left > 0) {
        const delta = Math.min(stepMs, left)
        state.now += delta
        left -= delta
        harness.fireTimers()
        // Two frames per step is enough to run everything already due; a frame
        // loop that re-arms itself does not need to be drained to infinity.
        for (let i = 0; i < 2 && frames.length > 0; i++) {
          const rec = frames.shift()
          rafSlots.delete(rec.id)
          rec.fn()
        }
      }
    },
    pendingTimers: () => timers.filter((t) => !t.cancelled),
    /** 假 document：有些断言要直接查插件往页面里放了什么（例如窗口背景那条规则）。 */
    document: documentShim,
    find: (className) => created.find((e) => e.className === className) ?? null,
    all: (className) => created.filter((e) => e.className === className),
    /** Evaluate lib/client.js the way the shell does, with every trap armed. */
    evaluate(src) {
      const traps = {}
      for (const name of TRAPPED) traps[name] = () => { throw new Error(`${name} is not available in a dynamic client half`) }
      // `host` 是 shell 注入给客户端半包的座位（是**能力**，不是 fetch 那种陷阱）。
      // 默认不给 —— 这样"没有 host 时降级"才测得到；要测检查更新就传 hostCall。
      const hostSeat = typeof options.hostCall === 'function' ? { call: options.hostCall } : undefined
      // eslint-disable-next-line no-new-func
      new Function('window', 'document', 'host', ...TRAPPED, src)(
        win, documentShim, hostSeat, ...TRAPPED.map((name) => traps[name]),
      )
    },
    module() {
      if (!harness.loaded) throw new Error('load() was never called')
      return harness.loaded.factory(() => ({}))
    },
    /* 剪贴板收件箱（只有 clipboard: true 时会收到东西）—— 测试要能从外面看它，
       所以挂到替身上，而不是留在 createHarness 的词法作用域里。 */
    clipboardWrites,
  }
  return harness
}

/* ======================================================= 1. the HOST half == */

head('1. host half (lib/index.js) must be importable ES module')

if (!existsSync(hostPath)) {
  bad('host half exists', pkg.main)
} else {
  const src = readFileSync(hostPath, 'utf8')
  if (/^\s*(import|export)\s/m.test(src)) ok('uses ES module syntax')
  else bad('uses ES module syntax', 'the host imports this file; a classic script cannot be imported')

  try {
    const mod = await import(pathToFileURL(hostPath).href + '?probe=host')
    ok('host module imports cleanly')
    if (typeof mod.apply === 'function') ok('exports apply()')
    else bad('exports apply()')
  } catch (error) {
    bad('host module imports cleanly', `${error.constructor.name}: ${error.message}`)
  }
}

/* ================================================= 1b. the update handler == */

head('1b. the host half answers checkUpdate through the platform web service')

/* 检查更新**必须**走平台给的通道：浏览器半包的 fetch 是陷阱，宿主半包在 vm 沙箱里
   没有 Node API，而 `ctx.web.fetch` 是 DSH 自己的 web_fetch 工具用的那一条服务。
   这一节把宿主编译出来的逻辑当纯函数测 —— 第一次真正测到宿主半包的行为。 */
{
  const mod = await import(pathToFileURL(hostPath).href + '?probe=update')
  const { readPublishedVersion, compareVersions, registerHandlers, inject } = mod

  /* web 服务必须声明为**可选**：硬依赖一个没加载的服务会让 fiber 永远 waiting，
     她会直接从界面上消失。这条是安全属性，不是风格偏好。 */
  const declaresWeb = inject && typeof inject === 'object'
  check(Boolean(declaresWeb) && Array.isArray(inject.optional) && inject.optional.includes('web'),
    'web is declared as an OPTIONAL inject', JSON.stringify(inject))
  check(Boolean(declaresWeb) && Array.isArray(inject.required) && !inject.required.includes('web'),
    'and not as a required one — a missing service must not hide her', JSON.stringify(inject))

  /* 每个 URL 一个态度：可以按 URL 给不同的结果，才能测"两个源"的组合。 */
  const webWith = (byUrl) => ({
    fetch: async (request) => {
      const outcome = byUrl[request.url] ?? { status: 404, body: 'nope' }
      if (outcome.throw) throw new Error(outcome.throw)
      return {
        url: request.url,
        statusCode: outcome.status ?? 200,
        body: { kind: 'text', content: outcome.body ?? '' },
        truncated: false,
      }
    },
  })
  const U = { npm: 'https://npm/x', github: 'https://gh/y' }
  const only = (key, outcome) => webWith({ [U[key]]: outcome })

  const good = await readPublishedVersion(only('npm', { body: '{"name":"dsh-wisp","version":"9.9.9"}' }), U)
  check(good.ok === true && good.latest === '9.9.9' && good.from === 'npm',
    'a 200 with a version field is read correctly', JSON.stringify(good))

  const notFound = await readPublishedVersion(only('npm', { status: 404, body: 'nope' }), U)
  check(notFound.ok === false && notFound.reason === 'http-404',
    'a non-2xx is a result, not a throw — and is reported as such', JSON.stringify(notFound))

  const noWeb = await readPublishedVersion(undefined, U)
  check(noWeb.ok === false && noWeb.reason === 'no-web-service',
    'without the web service it says so instead of throwing', JSON.stringify(noWeb))

  const blewUp = await readPublishedVersion(only('npm', { throw: 'socket closed' }), U)
  check(blewUp.ok === false && blewUp.reason === 'fetch-failed',
    'a transport failure is caught and reported', JSON.stringify(blewUp))

  const notJson = await readPublishedVersion(only('npm', { body: '<html>404</html>' }), U)
  check(notJson.ok === false && notJson.reason === 'not-json', 'a non-JSON body is reported', JSON.stringify(notJson))

  const noField = await readPublishedVersion(only('npm', { body: '{"name":"dsh-wisp"}' }), U)
  check(noField.ok === false && noField.reason === 'no-version-field',
    'a manifest without a version is reported', JSON.stringify(noField))

  /* ---- 两个源：取更高的那个，而不是"谁先谁赢" ---- */
  const bothAgree = await readPublishedVersion(webWith({
    [U.npm]: { body: '{"version":"1.25.1"}' },
    [U.github]: { body: '{"version":"1.25.1"}' },
  }), U)
  check(bothAgree.ok === true && bothAgree.latest === '1.25.1',
    'when both sources agree the answer is that version', JSON.stringify(bothAgree))
  check(bothAgree.sources.npm.ok === true && bothAgree.sources.github.ok === true,
    'and both sources are reported individually', JSON.stringify(bothAgree.sources))

  /* 真实情况：npm 卡在旧的 0.6.0，GitHub 已经是 1.25.1 —— 必须报 1.25.1 */
  const staleNpm = await readPublishedVersion(webWith({
    [U.npm]: { body: '{"version":"0.6.0"}' },
    [U.github]: { body: '{"version":"1.25.1"}' },
  }), U)
  check(staleNpm.ok === true && staleNpm.latest === '1.25.1' && staleNpm.from === 'github',
    'a stale npm cannot mask a newer GitHub release', JSON.stringify(staleNpm))

  /* 反过来也一样：npm 更新时必须报 npm 那个 */
  const newerNpm = await readPublishedVersion(webWith({
    [U.npm]: { body: '{"version":"2.0.0"}' },
    [U.github]: { body: '{"version":"1.25.1"}' },
  }), U)
  check(newerNpm.ok === true && newerNpm.latest === '2.0.0' && newerNpm.from === 'npm',
    'and a newer npm wins over an older GitHub', JSON.stringify(newerNpm))

  /* 一个挂了、另一个还在：仍然要有答案，并且说清哪个挂了 */
  const oneDown = await readPublishedVersion(webWith({
    [U.github]: { body: '{"version":"1.25.1"}' },
  }), U)
  check(oneDown.ok === true && oneDown.latest === '1.25.1' && oneDown.sources.npm.ok === false,
    'one dead source does not break the check', JSON.stringify(oneDown))

  const bothDown = await readPublishedVersion(webWith({ [U.npm]: { throw: 'x' } }), U)
  check(bothDown.ok === false && bothDown.sources.npm.ok === false && bothDown.sources.github.ok === false,
    'when every source fails the check fails — with per-source reasons', JSON.stringify(bothDown))

  check(compareVersions('1.2.3', '1.2.4') === -1 && compareVersions('1.2.3', '1.2.3') === 0
    && compareVersions('1.3.0', '1.2.9') === 1, 'version comparison is numeric, not lexicographic',
    `${compareVersions('1.10.0', '1.9.0')} for 1.10.0 vs 1.9.0`)

  /* 注册：harness 是沙箱全局，测试里临时摆一个座位 */
  const previousSeat = globalThis.harness
  const handlers = new Map()
  globalThis.harness = { handle: (method, fn) => { handlers.set(method, fn); return () => handlers.delete(method) } }
  const registered = registerHandlers({ web: only('npm', { body: '{"version":"9.9.9"}' }) }, { urls: U })
  check(registered.registered === true && handlers.has('checkUpdate'),
    'registerHandlers puts checkUpdate on the harness seat', JSON.stringify({ registered: registered.registered }))
  const answer = await handlers.get('checkUpdate')({ current: '1.0.0' })
  check(answer.ok === true && answer.latest === '9.9.9' && answer.current === '1.0.0'
    && typeof answer.checkedAt === 'string',
    'the handler returns a plain, serializable verdict', JSON.stringify(answer))
  const urls = registered.urls ?? {}
  check(typeof urls.npm === 'string' && urls.npm.startsWith('https://')
    && typeof urls.github === 'string' && urls.github.startsWith('https://'),
    'and it reads from two real https sources', JSON.stringify(urls))

  /* 座位不在时不许抛：宿主半包在别的运行时里也要能 import */
  delete globalThis.harness
  let noSeatThrew = false
  let noSeat = null
  try { noSeat = registerHandlers({}, {}) } catch (error) { noSeatThrew = true }
  check(noSeatThrew === false && noSeat && noSeat.registered === false,
    'without a harness seat it reports that instead of throwing', JSON.stringify(noSeat))

  globalThis.harness = { handle: (method, fn) => { handlers.set(method, fn); return () => handlers.delete(method) } }
  const effects = []
  let appliedThrew = false
  try {
    mod.apply({ web: only('npm', { body: '{"version":"9.9.9"}' }), effect: (fn, label) => { effects.push(label); return () => {} } }, {})
  } catch (error) { appliedThrew = true }
  check(appliedThrew === false && handlers.has('checkUpdate') && effects.length === 1,
    'apply() registers the handler and keeps its disposer on the fiber', effects.join(', '))

  if (previousSeat === undefined) delete globalThis.harness
  else globalThis.harness = previousSeat
}

/* ===================================================== 2. the BROWSER half == */

head('2. browser half (lib/client.js) must register with the module loader')

const clientSrc = clientPath && existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : null

if (clientSrc === null) {
  bad('exports["./client"] resolves', String(clientRel))
} else {
  if (/^\s*(import|export)\s/m.test(clientSrc)) {
    bad('no import/export statements', 'this is a classic script, not a module')
  } else ok('no import/export statements')

  if (/window\.__ModuleLoader__\.load\(\s*\{/.test(clientSrc)) ok('calls window.__ModuleLoader__.load({…})')
  else bad('calls window.__ModuleLoader__.load({…})', 'this is how a browser half registers')

  if (/id:\s*['"]dsh-wisp\/client['"]/.test(clientSrc)) ok("registers under id 'dsh-wisp/client'")
  else bad("registers under id 'dsh-wisp/client'")

  if (/factory:\s*\(require\)\s*=>/.test(clientSrc)) ok('factory takes `require`')
  else bad('factory takes `require`')

  if (/return\s+module\.exports/.test(clientSrc)) ok('factory returns module.exports')
  else bad('factory returns module.exports')

  if (/<\/script/i.test(clientSrc)) bad('no literal </script>', 'would break inline embedding')
  else ok('no literal </script>')

  // Static floor under the trap test below: a call to a trapped global is a
  // guaranteed runtime throw in a client half, and no bundler flags it.
  const trappedCall = clientSrc.match(/(setTimeout|setInterval|clearTimeout|clearInterval|fetch|require)\s*\(/)
  if (trappedCall) bad('never calls a trapped global', `found ${trappedCall[1]}(`)
  else ok('never calls a trapped global', 'checked statically; execution below proves it')
}

/* ============================ 3. the browser half, executed and driven ===== */

head('3. browser half runs against the real contract (traps armed)')

const installFakes = () => {
  globalThis.URL = FakeURL
  globalThis.Blob = FakeBlob
  globalThis.atob = fakeAtob
  globalThis.Image = FakeImage
}

if (clientSrc !== null) {
  const savedGlobals = { URL: globalThis.URL, Blob: globalThis.Blob, atob: globalThis.atob, Image: globalThis.Image }
  installFakes()

  try {
    /* ---------------------------------------------------------- 3a. mount -- */
    head('3a. Client timer service path')

    const h = createHarness({ timer: true })
    active = h
    h.evaluate(clientSrc)
    ok('registers without throwing', `id=${h.loaded.id}`)

    const exportsObj = h.module()
    const plugin = exportsObj?.default
    check(typeof plugin?.apply === 'function', 'exports a mountable plugin', `name=${plugin?.name}`)

    plugin.apply(h.ctx, { happyMs: 6000 })
    const api = h.win.__wisp
    check(typeof api?.destroy === 'function', 'public handle exposed', Object.keys(api ?? {}).join(','))
    check(api?.clock === 'timer-service', 'schedules on the Client timer service', String(api?.clock))

    h.advance(50)
    const layer = h.find('wisp-layer')
    const root = h.find('wisp-root')
    check(layer !== null && layer.parentNode === h.bodyEl, 'mounted into document.body')
    check(root !== null, 'creature element exists', `mood=${root?.dataset.mood}`)
    check(h.styleInserts.length === 1, 'stylesheet pushed through the styles builtin')
    check(h.frames.length === 0, 'spends zero animation frames while scheduling', 'the rAF loop is not even armed')
    check(root.style.width === '560px' && root.style.height === '840px',
      'drawn at the enlarged default (140x210 base x 4)', `${root.style.width} x ${root.style.height}`)

    /* ------------------------------------------------- 3b. sprite pipeline -- */
    head('3b. sprite pipeline (the broken-image regression)')

    if (h.srcs.length === 0) {
      bad('sprite assigned to an <img>', 'no src was ever set')
    } else if (h.srcs.every((s) => typeof s === 'string' && s.startsWith('blob:'))) {
      ok('sprites use blob: object URLs', h.srcs[0])
    } else if (h.srcs.some((s) => typeof s === 'string' && s.startsWith('data:'))) {
      bad('sprites must not use data: URIs', 'this shell renders them as a broken image')
    } else {
      bad('sprite URL scheme', JSON.stringify(h.srcs).slice(0, 200))
    }
    check(h.blobs.length > 0, 'base64 decoded into Blob objects', `${h.blobs.length} blob(s)`)
    check(h.blobs.every((b) => b.type.startsWith('image/')), 'blob MIME types are images', h.blobs[0]?.type)

    /* ------------------------------------------------ 3c. moods and speech -- */
    head('3c. moods, speech and idle/sleep')

    h.advance(900)
    const layerEl = api.element.parentNode
    check(layerEl.querySelectorAll('.wisp-say').length === 1, 'says hello after mount')
    api.say('测试')
    check(layerEl.querySelectorAll('.wisp-say').length === 1, 'say() replaces the bubble rather than stacking',
      `${layerEl.querySelectorAll('.wisp-say').length} attached`)
    check(api.element.querySelectorAll('.wisp-say').length === 0,
      'the bubble is not inside the mirrored root', 'a child of the root would render its text backwards')
    api.mood('happy')
    check(root.dataset.mood === 'happy', 'mood() control works')
    check(h.srcs[h.srcs.length - 1] !== h.srcs[0], 'sprite switches with mood', String(h.srcs[h.srcs.length - 1]))

    // The swap must be a cross-fade: two layers for the length of the fade,
    // then the outgoing one is dropped. A hard `src` swap reads as a glitch.
    // attn 以前借用 work 那张图（两个状态长得一样，只能靠光晕区分）；现在有自己的一张，
    // 而且某套皮肤缺 attn 时会退回 work —— 这条断言把"用的是哪一张"钉住。
    const bodyNode = root.querySelector('.wisp-body')
    const imgLayers = () => bodyNode.querySelectorAll('.wisp-img').length
    check(imgLayers() === 2, 'a mood change cross-fades instead of swapping the src', `${imgLayers()} layers`)
    h.advance(400)
    check(imgLayers() === 1, 'the outgoing sprite layer is dropped after the fade', `${imgLayers()} layers`)

    api.mood('idle')
    h.advance(91000, 500)
    check(root.dataset.mood === 'sleep', 'sleeps after the idle window', String(root.dataset.mood))
    const zzz = root.querySelectorAll('.wisp-zzz').length
    check(zzz === 2, 'shows two z glyphs while asleep', `${zzz}`)
    h.win.dispatch('pointermove', {})
    h.advance(10)
    check(root.dataset.mood === 'idle', 'any input wakes her')
    check(root.querySelectorAll('.wisp-zzz').length === 0, 'the z glyphs go when she wakes')

    /* --------------------------------------------------- 3d. reactions ----- */
    head('3d. reactions: busy, composer, completion')

    // Each phase advances just past one poll so the assertion lands inside the
    // state it is testing instead of one poll later.
    h.state.busy = true
    h.advance(1300, 100)
    check(root.dataset.mood === 'alert', 'agent busy -> alert', String(root.dataset.mood))
    h.advance(4000, 500)
    h.state.busy = false
    h.advance(1300, 100)
    check(root.dataset.mood === 'happy', 'a finished run is celebrated', String(root.dataset.mood))
    const said = layerEl.querySelector('.wisp-say')
    check(said !== null && Array.isArray(linesInBundle()?.done) && linesInBundle().done.includes(said.textContent),
      'the celebration line comes from the done pool',
      said?.textContent + '（池子里有 ' + (linesInBundle()?.done?.length ?? '?') + ' 句）')
    h.advance(7000, 500)
    check(root.dataset.mood === 'idle', 'the celebration ends on its own', String(root.dataset.mood))

    h.state.composerText = 'hello'
    h.advance(1300, 100)
    check(root.dataset.mood === 'alert', 'composer text -> alert', String(root.dataset.mood))
    h.state.composerText = null
    h.advance(1300, 100)
    check(root.dataset.mood === 'idle', 'back to idle when nothing is happening', String(root.dataset.mood))

    /* ------------------------------------------- 3d-bis. what a tick costs -- */
    head('3d-bis. one tick does not re-walk the document')

    // A composer that is present and unchanged must be resolved once and then
    // read directly; a tick that re-queries it is the difference between
    // ~0.3 ms and ~0 ms per tick on a long transcript.
    const beforeQueries = { ...h.queries }
    h.state.composerText = 'still typing'
    h.advance(POLL_MS * 8, 100)
    const composerSpend = h.queries.composer - beforeQueries.composer
    check(composerSpend === 0, 'a resolved composer is not re-queried per tick', `${composerSpend} query/queries over 8 ticks`)
    check(h.queries.all === beforeQueries.all, 'the tick never collects a NodeList', `${h.queries.all - beforeQueries.all}`)
    h.state.composerText = null
    h.advance(1300, 100)

    // With no composer open at all (the blank-session Hero), the precise hook is
    // probed — cheaply, and so a session that opens is noticed at once — while
    // the ambiguous legacy shapes are only probed on the retry cadence.
    const hm = createHarness({ timer: true, composerText: null })
    active = hm
    hm.evaluate(clientSrc)
    hm.module().apply(hm.ctx, {})
    const TICKS = 9
    hm.advance(POLL_MS * TICKS, 100)
    const probes = hm.queries.composer
    check(probes <= TICKS + Math.ceil(TICKS / 4) * 2,
      'an absent composer costs one probe per tick, not three',
      `${probes} probes over ${TICKS} ticks (the old shape paid ${TICKS * 3})`)
    hm.win.__wisp.destroy()
    active = h   // hand the Blob/URL recorder back to the main harness

    /* ------------------------------------- 3d-ter. 有东西在等你处理 ------- */
    head('3d-ter. attention when the harness is waiting on you')

    const bubbles = () => h.all('wisp-say').length
    const beforeAttn = bubbles()
    h.state.pending = 'q-1'
    h.advance(1300, 100)
    check(root.dataset.mood === 'attn', 'a pending question switches her to attention', String(root.dataset.mood))
    check(h.srcs[h.srcs.length - 1] !== h.srcs[0],
      'the attention state has its own sprite rather than borrowing idle',
      String(h.srcs[h.srcs.length - 1]).slice(0, 22))
    check(bubbles() > beforeAttn, 'she says something about it',
      layerEl.querySelector('.wisp-say')?.textContent)

    // 同一件事不重复念；换了一件才再说
    const afterFirst = bubbles()
    h.advance(6000, 300)
    check(bubbles() === afterFirst, 'she does not repeat herself for the same item', `${bubbles()} vs ${afterFirst}`)
    check(root.dataset.mood === 'attn', 'and she stays on attention while it is unanswered')
    h.state.pending = 'q-2'
    h.advance(1300, 100)
    check(bubbles() > afterFirst, 'a different item is announced again', `${bubbles()}`)

    // 睡着了也要被叫起来 —— 这是唯一"不理它就卡住"的状态
    h.state.pending = null
    h.advance(1300, 100)
    check(root.dataset.mood === 'idle', 'she relaxes once it is answered', String(root.dataset.mood))
    api.mood('sleep')
    h.state.pending = 'q-3'
    h.advance(1300, 100)
    check(root.dataset.mood === 'attn', 'a question wakes her up', String(root.dataset.mood))
    h.state.pending = null
    h.advance(1300, 100)
    h.state.composerText = null
    check(root.dataset.mood === 'idle', 'back to normal afterwards', String(root.dataset.mood))

    /* ------------------------------------- 3d-quater. 出错时的反应 --------- */
    head('3d-quater. she notices when a run fails')

    // 先制造一轮 busy -> idle，并且这一轮里有 2 个出错行
    const errorsBefore = h.queries.errors
    h.state.errors = 2
    h.state.busy = true
    h.advance(3000, 200)
    check(root.dataset.mood !== 'worried', 'no verdict while the run is still going', String(root.dataset.mood))
    const bubblesBeforeError = h.all('wisp-say').length
    h.state.busy = false
    h.advance(1300, 100)
    check(root.dataset.mood === 'worried', 'a failed run puts her in the worried state', String(root.dataset.mood))
    check(h.all('wisp-say').length > bubblesBeforeError, 'and she says something about it',
      layerEl.querySelector('.wisp-say')?.textContent)
    check(h.queries.errors - errorsBefore === 1,
      'the document is scanned for errors once per finished run, not once per poll',
      `${h.queries.errors - errorsBefore} scan(s) for ${Math.ceil(3000 / POLL_MS) + 1} polls`)

    // 同一批错误不该每轮都重念一遍
    const afterFirstError = h.all('wisp-say').length
    h.state.busy = true
    h.advance(3000, 200)
    h.state.busy = false
    h.advance(1300, 100)
    check(h.all('wisp-say').length === afterFirstError,
      'the same errors are not announced again on the next run', `${h.all('wisp-say').length} vs ${afterFirstError}`)
    check(h.queries.errors - errorsBefore === 2, 'still one scan per run', `${h.queries.errors - errorsBefore}`)

    // 错误清掉之后再出现新的，还要再说一次
    h.state.errors = 0
    h.advance(1300, 100)
    h.state.errors = 3
    h.state.busy = true
    h.advance(3000, 200)
    h.state.busy = false
    h.advance(1300, 100)
    check(h.all('wisp-say').length > afterFirstError, 'fresh errors are announced again',
      `${h.all('wisp-say').length}`)

    // 她不会一直挂着这个表情
    h.advance(4000, 300)
    check(root.dataset.mood === 'idle', 'the worried look is temporary', String(root.dataset.mood))

    // 干净的一轮不该有任何反应
    h.state.errors = 0
    const cleanBubbles = h.all('wisp-say').length
    h.state.busy = true
    h.advance(3000, 200)
    h.state.busy = false
    h.advance(1300, 100)
    check(root.dataset.mood !== 'worried', 'a clean run leaves her alone', String(root.dataset.mood))

    // reactions: false 时连扫都不扫
    h.state.busy = false
    h.state.errors = 1
    api.configure({ reactions: false })
    const scansOff = h.queries.errors
    h.state.busy = true
    h.advance(1500, 150)
    h.state.busy = false
    h.advance(1500, 150)
    check(h.queries.errors === scansOff, 'reactions: false skips the error scan entirely', `${h.queries.errors - scansOff} scans`)
    api.configure({ reactions: true })
    h.state.errors = 0
    h.advance(1300, 100)

    /* ---------------- 3d-senies. doctor()：钩子自检 ----------------------- */
    head('3d-senies. doctor() reports whether the selectors actually resolve')

    // 这些选择器是读 DSH 源码推出来的，错了不会有任何报错 —— 对应功能只是永远不触发。
    // doctor() 就是为此存在的：让页面自己报告哪条链路是活的。
    h.state.composerText = ''
    h.state.busy = true
    const snapshotBefore = { mood: root.dataset.mood, position: api.position, hidden: api.hidden }
    const report = api.doctor()
    check(typeof report === 'object' && report !== null, 'doctor() returns a report')
    check(report.version === '1.4.0' || /^\d+\.\d+\.\d+$/.test(String(report.version)),
      'the report carries the running version', String(report.version))
    check(Array.isArray(report.hooks?.composer) && report.hooks.composer.length === COMPOSER_HOOK_COUNT,
      'it lists every composer hook it tries', `${report.hooks?.composer?.length} hooks`)
    check(report.hooks.composer.filter((x) => x.matches > 0).length === 1,
      'exactly one composer hook resolves while the composer is present',
      report.hooks.composer.map((x) => `${x.selector}=${x.matches}`).join(' '))
    check(report.hooks.composer[0].matches === 1 && report.hooks.composer[1].matches === 0,
      'and it is the most specific one that wins', 'the fallbacks stay cold when the best hook is there')
    check(report.hooks.busy.matches === 1, 'the busy hook resolves while a run is going',
      `${report.hooks.busy.selector} = ${report.hooks.busy.matches}`)
    check(report.hooks.busy.ariaLabelsOnPage === undefined,
      'and it does not attach the label sample when the hook works',
      'the sample only appears on a miss')

    /* 忙碌钩子是唯一无法静态确认的（aria-label 来自语言表），所以它 miss 时必须自解释：
       把页面上真实的按钮标签带出来，一次 doctor() 就能看出该匹配什么。 */
    const idle = createHarness({ timer: true, busy: false, composerText: '', ariaLabels: ['停止', '搜索', '停止'] })
    const keepIdle = active
    active = idle
    idle.evaluate(clientSrc)
    idle.module().default.apply(idle.ctx, { reactions: false, wander: false })
    const idleReport = idle.win.__wisp.doctor()
    check(idleReport.hooks.busy.matches === 0, 'with no run going the busy hook is a miss',
      String(idleReport.hooks.busy.matches))
    check(JSON.stringify(idleReport.hooks.busy.ariaLabelsOnPage) === JSON.stringify(['停止', '搜索']),
      'and the miss carries the page labels it should have matched, deduplicated',
      JSON.stringify(idleReport.hooks.busy.ariaLabelsOnPage))
    idle.win.__wisp.destroy()
    active = keepIdle
    check(Array.isArray(report.hooks.pending) && report.hooks.pending.length === 3,
      'it reports all three pending-panel hooks', `${report.hooks.pending?.length}`)
    check(typeof report.hooks.error === 'object' && report.hooks.error.matches === 0,
      'it reports the error hook even when nothing is failing', String(report.hooks.error?.matches))
    check(report.tokens.length === 5 && report.tokens.every((t) => typeof t.token === 'string'),
      'it reads the theme tokens the stylesheet depends on', `${report.tokens.length} tokens`)
    check(report.tokens.every((t) => t.value !== ''),
      'and the tokens resolve to real values in a healthy page',
      report.tokens.map((t) => `${t.token.replace('--dsw-alias-', '')}=${t.value || '(空)'}`).join(' '))
    check(report.problems.length === 0, 'a healthy page reports no problems', report.problems.join(' / '))
    check(Array.isArray(report.problems), 'and returns a problems list', `${report.problems.length} problem(s)`)
    check(typeof report.sessionsService === 'boolean',
      'it records whether the sessions service is reachable', String(report.sessionsService))

    // 只读：自检不能改变任何状态
    const snapshotAfter = { mood: root.dataset.mood, position: api.position, hidden: api.hidden }
    check(snapshotBefore.mood === snapshotAfter.mood && snapshotBefore.hidden === snapshotAfter.hidden
      && snapshotBefore.position.x === snapshotAfter.position.x
      && snapshotBefore.position.y === snapshotAfter.position.y,
      'doctor() has no side effects', `${snapshotBefore.mood} -> ${snapshotAfter.mood}`)

    // 关键：钩子真的坏掉时它必须**报出来**，而不是永远说"一切正常"
    h.state.composerText = null
    const degraded = api.doctor()
    check(degraded.hooks.composer.every((x) => x.matches === 0),
      'with the composer gone, no composer hook resolves', 'the harness models a composer that comes and goes')
    check(degraded.problems.some((p) => p.includes('输入框')) ,
      'and doctor() names the feature that stops working, not just a number',
      degraded.problems.join(' / '))
    h.state.composerText = ''
    h.state.busy = false
    h.advance(1300, 100)

    /* 回退链：真实页面可能换一种输入框形态。第二、三条钩子必须真的能用 ——
       之前替身让三个同时命中，回退链等于没测。
       注意这里必须 reactions: true —— 轮询由它控制，关掉它等于把被测功能本身关掉了。 */
    for (const shape of [1, 2]) {
      const fallback = createHarness({ timer: true, composerText: '', composerShape: shape })
      const keepActive = active
      active = fallback
      fallback.evaluate(clientSrc)
      fallback.module().default.apply(fallback.ctx, { reactions: true, wander: false, celebrate: false })
      fallback.state.composerText = '正在打字'
      fallback.advance(1300, 100)
      const early = fallback.find('wisp-root').dataset.mood
      fallback.advance(8000, 200)
      const mood = fallback.find('wisp-root').dataset.mood
      const doctorOfFallback = fallback.win.__wisp.doctor()
      check(mood === 'alert' && doctorOfFallback.hooks.composer[shape].matches === 1,
        `the composer fallback #${shape + 1} (${['[data-composer-input]', 'textarea', '[contenteditable="true"]'][shape]}) really works`,
        `mood=${mood}（1 个周期后是 ${early}）, matches=${doctorOfFallback.hooks.composer.map((x) => x.matches).join('/')}`)
      fallback.win.__wisp.destroy()
      active = keepActive
    }
    h.state.composerText = ''

    /* ---------------- 3d-septies. 台词池与时段招呼 ------------------------ */
    head('3d-septies. line pools and the time-of-day greeting')

    const pools = linesInBundle()
    check(pools !== null, 'the line pools can be read back out of the bundle', 'data-driven, not copied into the test')
    if (pools !== null) {
      /* 阈值按**见到的频率**分级，而不是一刀切：
         · hint 一辈子只说一次，3 句绰绰有余；
         · 招呼语一次挂载说一句，5 句够；
         · 其余场景一天会被看到几十次，池子窄了会在一周内被看穿。 */
      const WIDE = ['click', 'chatter', 'done', 'error', 'attn', 'move', 'home', 'happy', 'sleep', 'wake']
      const NARROW = ['hint', 'hello', 'morning', 'afternoon', 'evening', 'night']
      const tooThin = WIDE.filter((k) => !Array.isArray(pools[k]) || pools[k].length < 8)
        .map((k) => `${k}=${pools[k]?.length ?? 0} (<8)`)
      const thinNarrow = NARROW.filter((k) => !Array.isArray(pools[k]) || pools[k].length < 3)
        .map((k) => `${k}=${pools[k]?.length ?? 0} (<3)`)
      check(tooThin.length === 0 && thinNarrow.length === 0,
        'the pools you see repeatedly are wide, the one-off ones are merely non-empty',
        [...tooThin, ...thinNarrow].length
          ? [...tooThin, ...thinNarrow].join(' ')
          : `常用池 ≥8（${WIDE.map((k) => pools[k].length).join('/')}）, 罕见池 ≥3（${NARROW.map((k) => pools[k].length).join('/')}）`)
      const dupes = []
      for (const [name, pool] of Object.entries(pools)) {
        const seen = new Set()
        for (const line of pool) { if (seen.has(line)) dupes.push(`${name}:${line}`); seen.add(line) }
      }
      check(dupes.length === 0, 'no pool repeats a line', dupes.slice(0, 3).join(' | '))
      check(['morning', 'afternoon', 'evening', 'night'].every((k) => Array.isArray(pools[k]) && pools[k].length > 0),
        'all four time-of-day pools exist and are non-empty')
    }

    /* 招呼语必须来自**当前时段**的池子。时段在测试这边按同样的规则算一遍 ——
       挂载前后各算一次，跨过整点也不会误判。 */
    const poolNameOf = (h24) => (h24 < 5 || h24 >= 22 ? 'night' : h24 < 11 ? 'morning' : h24 < 18 ? 'afternoon' : 'evening')
    const hourBeforeMount = new Date().getHours()
    const greetHarness = createHarness({ timer: true, composerText: null })
    const keepGreet = active
    active = greetHarness
    greetHarness.evaluate(clientSrc)
    greetHarness.module().default.apply(greetHarness.ctx, { reactions: false, wander: false })
    const hourAfterMount = new Date().getHours()
    greetHarness.advance(1200, 100)
    const greetReport = greetHarness.win.__wisp.doctor()
    const greetLine = greetHarness.find('wisp-say')?.textContent
    const allowed = new Set([poolNameOf(hourBeforeMount), poolNameOf(hourAfterMount)])
    check(allowed.has(greetReport.greeting.pool),
      'the greeting pool matches the hour the mount happened in',
      `${greetReport.greeting.hour} 点 -> ${greetReport.greeting.pool}（允许 ${[...allowed].join('/')}）`)
    check(pools !== null && pools[greetReport.greeting.pool]?.includes(greetLine),
      'and the line she said really comes from that pool', `${greetLine}（${greetReport.greeting.pool}）`)
    check(greetReport.greeting.poolSize === pools?.[greetReport.greeting.pool]?.length,
      'the report exposes the pool size for debugging', `${greetReport.greeting.poolSize} 句`)
    greetHarness.win.__wisp.destroy()
    active = keepGreet

    /* ---------------- 3d-octies. 窗口背景（Mica）能否露出来 ----------------- */
    head('3d-octies. the option that lets the window backdrop through')

    /* "壁纸可见"有两条路：整窗 alpha（会把她一起乘掉）与 DWM 背景材质（内容保持不透明）。
       后者要求页面在背景处不画不透明像素 —— 这个功能就是清掉挡路的那一层。
       默认必须是关的：那是影响整个应用的视觉改动，不该由她替别人做主。 */
    const backdropOff = createHarness({ timer: true, composerText: '' })
    const keepBackdrop = active
    active = backdropOff
    backdropOff.evaluate(clientSrc)
    backdropOff.module().default.apply(backdropOff.ctx, { reactions: false, wander: false })
    check(backdropOff.win.__wisp.config.backdrop === false, 'the backdrop option is off by default')
    check(backdropOff.document.getElementById('wisp-backdrop') === null,
      'and nothing is injected while it is off', 'no style element')
    backdropOff.win.__wisp.destroy()
    active = keepBackdrop

    // 打开它：铺满视口的底色应当被清掉，内容卡片不能被碰
    const fullScreen = {
      tagName: 'DIV', className: 'appBackdrop',
      getBoundingClientRect() { return { width: 1920, height: 1200 } },
    }
    const card = {
      tagName: 'DIV', className: 'messageCard',
      getBoundingClientRect() { return { width: 600, height: 200 } },
    }
    const backdrop = createHarness({
      timer: true, composerText: '', overlayStack: [fullScreen, card],
      backgrounds: { appBackdrop: 'rgb(12, 14, 18)', messageCard: 'rgb(30, 32, 40)' },
    })
    const keepBackdrop2 = active
    active = backdrop
    backdrop.evaluate(clientSrc)
    backdrop.module().default.apply(backdrop.ctx, { reactions: false, wander: false, backdrop: true })
    const tag = backdrop.document.getElementById('wisp-backdrop')
    check(backdrop.win.__wisp.config.backdrop === true,
      'the mount config turns the option on', String(backdrop.win.__wisp.config.backdrop))
    check(tag !== null, 'with the option on and a full-viewport backdrop present, a rule is injected')
    check(tag !== null && tag.textContent.includes('.appBackdrop'),
      'and it targets the full-viewport element', tag?.textContent)
    check(tag !== null && !tag.textContent.includes('messageCard'),
      'but never a content card, even though it also paints a background',
      'the size floor keeps cards out')
    check(tag !== null && tag.textContent.includes('background-color:transparent !important'),
      'the rule neutralises the colour', tag?.textContent)

    const bdReport = backdrop.win.__wisp.doctor()
    check(bdReport.backdrop.enabled === true && bdReport.backdrop.cleared.length === 1,
      'doctor() reports what it cleared', JSON.stringify(bdReport.backdrop.cleared))
    check(bdReport.backdrop.blockers.length === 1 && bdReport.backdrop.blockers[0].background === 'rgb(12, 14, 18)',
      'and what it found blocking, with the colour', JSON.stringify(bdReport.backdrop.blockers))

    backdrop.win.__wisp.configure({ backdrop: false })
    check(backdrop.document.getElementById('wisp-backdrop') === null,
      'turning it off leaves no injected rule behind')
    backdrop.win.__wisp.destroy()
    active = keepBackdrop2
    check(backdrop.document.getElementById('wisp-backdrop') === null,
      'and teardown leaves none either', '她自己的东西自己清干净')

    // 类名以数字开头（哈希类名很常见）时不能写进选择器 —— 无效规则会毁掉整张样式表
    const oddClass = {
      tagName: 'DIV', className: '8xY_thing',
      getBoundingClientRect() { return { width: 1920, height: 1200 } },
    }
    const odd = createHarness({
      timer: true, composerText: '', overlayStack: [oddClass],
      backgrounds: { '8xY_thing': 'rgb(1, 2, 3)' },
    })
    const keepOdd = active
    active = odd
    odd.evaluate(clientSrc)
    odd.module().default.apply(odd.ctx, { reactions: false, wander: false, backdrop: true })
    const oddTag = odd.document.getElementById('wisp-backdrop')
    const oddCss = oddTag === null ? '' : oddTag.textContent
    check(!oddCss.includes('8xY_thing'), 'a class unsafe in a selector is skipped, not pasted in',
      oddCss === '' ? '没有注入规则' : oddCss)
    check(odd.win.__wisp.doctor().backdrop.skipped.length === 1,
      'and doctor() says so, so a silent miss stays visible',
      JSON.stringify(odd.win.__wisp.doctor().backdrop.skipped))
    odd.win.__wisp.destroy()
    active = keepOdd

    /* ---------------- 3d-nonies. 页面上只能有一个她 ------------------------ */
    head('3d-nonies. exactly one of her, no matter how many times it mounts')

    /* "出现了两个她"是用户先发现的，不该是这样。原因可能是"只靠 window.__wisp 那一个句柄
       不足以认定页面上没有旧层"（句柄属于另一次加载/另一个上下文时就会漏），
       所以挂载前按类名清场，而不是只信那个引用。 */
    const twice = createHarness({ timer: true, composerText: '' })
    const keepTwice = active
    active = twice
    twice.evaluate(clientSrc)
    const twicePlugin = twice.module().default
    twicePlugin.apply(twice.ctx, { reactions: false, wander: false, size: 2 })
    twice.advance(300, 100)
    const layersAfterFirst = twice.document.querySelectorAll('.wisp-layer').length
    /* 把句柄藏起来，模拟"旧层还在、但 window.__wisp 指向别处/已被清掉"这种漏网情形 */
    const firstApi = twice.win.__wisp
    delete twice.win.__wisp
    twicePlugin.apply(twice.ctx, { reactions: false, wander: false, size: 2 })
    twice.advance(300, 100)
    const layersAfterSecond = twice.document.querySelectorAll('.wisp-layer').length
    check(layersAfterFirst === 1, 'one mount leaves exactly one layer', String(layersAfterFirst))
    check(layersAfterSecond === 1,
      'and a second mount still leaves exactly one — the stray is removed by class, not by a remembered handle',
      `${layersAfterFirst} -> ${layersAfterSecond}`)
    const twiceInstances = twice.win.__wisp.doctor().instances
    check(twiceInstances.layers === 1 && twiceInstances.roots === 1,
      'doctor() reports the count so a duplicate can never hide', JSON.stringify(twiceInstances))
    check(firstApi !== twice.win.__wisp, 'the surviving instance is the newest one', '老实例被清掉')
    twice.win.__wisp.destroy()
    active = keepTwice

    /* ---------------- 3d-decies. 连戳 -> 抗议 -------------------------------- */
    head('3d-decies. poking her repeatedly turns into a protest')

    /* 这个行为需要一个**可控的时钟**：连戳窗口是 3 秒，如果它读真实时间，测试里根本推不动它。
       实现里已经改用 nowMs()（插件自己的时钟），所以这里能用 advance 精确推进。 */
    const pk = createHarness({ timer: true, composerText: '' })
    const keepPk = active
    active = pk
    pk.evaluate(clientSrc)
    pk.module().default.apply(pk.ctx, { reactions: true, wander: false, celebrate: false })
    pk.advance(1200, 100)
    const pkApi = pk.win.__wisp
    const pkBody = pk.find('wisp-body')
    const pkMood = () => pk.find('wisp-root').dataset.mood
    const pokeOnce = () => {
      const x = pkApi.position.x + 280
      const y = pkApi.position.y + 420
      pkBody.dispatch('pointerdown', {
        button: 0, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {},
      })
      pk.win.dispatch('pointerup', {})
      pk.advance(200, 50)
    }

    pokeOnce()
    check(pkMood() === 'happy', 'the first poke is the happy reaction', pkMood())
    pokeOnce()
    check(pkMood() === 'happy', 'so is the second', pkMood())
    pokeOnce()
    check(pkMood() === 'poked', 'the third poke in a row is a protest', pkMood())
    /* 气泡是每次新建一个、旧的移除：find() 拿到的是最早那条，必须取最新的。 */
    const protestLine = pk.all('wisp-say').at(-1)?.textContent
    check(Array.isArray(linesInBundle()?.poked) && linesInBundle().poked.includes(protestLine),
      'and it comes from the poked pool, not from the click pool',
      protestLine + '（池子 ' + (linesInBundle()?.poked?.length ?? '?') + ' 句）')

    // 瞬时状态必须活过同一时刻的反应轮询 —— worried 当初就是被它盖掉的
    pk.advance(1300, 100)
    check(pkMood() === 'poked', 'the reaction poll does not overwrite the protest', pkMood())
    pk.advance(2200, 100)
    check(pkMood() === 'idle', 'and it ends on its own', pkMood())

    // 窗口过期后重新计数：隔一会儿再戳一下，不该被记仇
    pokeOnce()
    pokeOnce()
    check(pkMood() === 'happy', 'two more pokes inside the window are still happy', pkMood())
    pk.advance(3500, 100)
    pokeOnce()
    check(pkMood() === 'happy',
      'after the window expires the streak resets — one poke later is not a protest', pkMood())
    pokeOnce()
    pokeOnce()
    check(pkMood() === 'poked', 'and it takes three fresh pokes to protest again', pkMood())

    /* api.sprites 是**当前皮肤的情绪名数组**（Object.keys(SPRITES[activeSkin])），不是 URL 表；
       "每套皮肤都带全部情绪"由解析产物 SPRITES 表那条检查覆盖，而且更强。 */
    check(Array.isArray(pkApi.sprites) && pkApi.sprites.includes('poked'),
      'the active skin actually serves a poked sprite', JSON.stringify(pkApi.sprites))
    pk.win.__wisp.destroy()
    active = keepPk

    /* ---------------- 3d-undecies. 久坐提醒 ---------------------------------- */
    head('3d-undecies. she notices when you have been sitting too long')

    /* 这个行为的难点不在"说话"，而在**判据**：什么时候算还在坐着、什么时候算离开、
       以及多久才该再说一次。这些用虚拟时钟都能精确推到边界的另一侧。
       注意：care 是个**瞬时状态**（4.2 秒），而 advance 是分步推进的 ——
       用"推进中观察到过 care"来断言，而不是在某一个瞬间采样（那样会正好错过它）。 */
    const care = createHarness({ timer: true, composerText: '在打字' })
    const keepCare = active
    active = care
    care.evaluate(clientSrc)
    // sleepAfterMs 拉满：这一段测的是久坐，不该被"她打盹"这件事干扰（打盹另有一条断言）
    care.module().default.apply(care.ctx, {
      reactions: true, wander: false, celebrate: false, careAfterMs: 600000, sleepAfterMs: 3600000,
    })
    care.advance(1300, 100)
    const careApi = care.win.__wisp
    const careMood = () => care.find('wisp-root').dataset.mood
    /* 推进并**观察**每一种出现过的情绪 */
    const careObserve = (ms, chunk = 1000) => {
      const seen = new Set()
      for (let left = ms; left > 0; left -= chunk) {
        care.advance(Math.min(chunk, left), 200)
        seen.add(careMood())
      }
      return seen
    }
    const bubbleIsCare = () => {
      const text = care.all('wisp-say').at(-1)?.textContent
      return Array.isArray(linesInBundle()?.care) && linesInBundle().care.includes(text)
    }

    check(careMood() === 'alert', 'while you are typing she is on alert, not reminding', careMood())

    // 推到 9 分钟：还没到 10 分钟的线，不该提醒
    const careBefore = careObserve(9 * 60000)
    check(!careBefore.has('care') && !bubbleIsCare(),
      'nine minutes in she has not reminded you yet', `观察到的情绪: ${[...careBefore].join(',')}`)

    // 越过 10 分钟。推进到「看到 care 为止」就停下 —— 它只活 4.2 秒，
    // 一口气推完再采样必然错过（这正是这个测试前两次失败的原因）。
    const advanceUntilCare = (limitMs, chunk = 1000) => {
      for (let left = limitMs; left > 0; left -= chunk) {
        care.advance(Math.min(chunk, left), 200)
        if (careMood() === 'care') return true
      }
      return false
    }
    check(advanceUntilCare(200000), 'past the threshold she speaks up')
    check(bubbleIsCare(), 'and the line comes from the care pool',
      (care.all('wisp-say').at(-1)?.textContent ?? '(无)') + '（池子 ' + (linesInBundle()?.care?.length ?? '?') + ' 句）')
    check(careMood() === 'care' && careApi.currentMood === 'care',
      'and both the DOM and the reported mood say care', `${careMood()} / ${careApi.currentMood}`)

    // 稳态轮询不能把它抹掉：趁它还活着时再走一个轮询周期
    care.advance(1000, 100)
    check(careMood() === 'care', 'the reaction poll does not overwrite the reminder', careMood())
    const careSettled = careObserve(6000)
    void careSettled
    /* 只断言"结束时回到 alert"：观察窗口的前几秒它本来就还在 care 里（CARE_MS = 4.2 秒），
       断言"这段时间里没出现过 care"是错的 —— 那是把"还没结束"当成了"没结束过"。 */
    check(careMood() === 'alert', 'and it ends on its own, back to alert', careMood())

    // 不该连着说：下一个完整间隔之前不再提
    const careNagging = careObserve(60000)
    check(!careNagging.has('care'), 'it does not nag again a minute later', `观察到的情绪: ${[...careNagging].join(',')}`)
    check(advanceUntilCare(600000), 'but it does come back after another full interval')
    care.advance(6000, 500)

    // 他离开了一阵：计时该从头开始，而不是接着攒
    care.win.__wisp.configure({ careAfterMs: 300000 })
    care.state.composerText = null                 // 输入框消失 = 没有活动
    careObserve(9 * 60000)
    care.state.composerText = '回来了'
    care.advance(1300, 100)
    const careRestarted = careObserve(120000)
    check(!careRestarted.has('care'), 'after you walk away the clock starts from zero', `观察到的情绪: ${[...careRestarted].join(',')}`)
    check(advanceUntilCare(300000), 'only a fresh full stretch brings it back')
    care.advance(6000, 500)

    // 关掉这个行为
    care.win.__wisp.configure({ careAfterMs: 0 })
    const careOff = careObserve(20 * 60000, 5000)
    check(!careOff.has('care'), 'careAfterMs: 0 turns the whole thing careOff', `观察到的情绪: ${[...careOff].join(',')}`)
    check(care.win.__wisp.config.careAfterMs === 0, 'and the config says so', String(care.win.__wisp.config.careAfterMs))
    care.win.__wisp.destroy()
    active = keepCare

    /* ---------------- 3d-octodecies. 干饭 ----------------------------------- */
    head('3d-octodecies. she gets hungry and says so (the rice thing)')

    /* 这是社区的设定里最像"她"的一条：白米饭是算力的硬通货。行为本身很简单 ——
       连续活动够久就该吃一碗 —— 但要测的是**判据**：别一回来就喊饿、别连着喊、
       能关掉。careAfterMs 关掉，免得住坐提醒和它互相干扰。 */
    const eat = createHarness({ timer: true, composerText: '在打字' })
    const keepEat = active
    active = eat
    eat.evaluate(clientSrc)
    eat.module().default.apply(eat.ctx, {
      reactions: true, wander: false, celebrate: false,
      careAfterMs: 0, hungerMs: 600000, sleepAfterMs: 3600000,
    })
    eat.advance(1300, 100)
    const eatApi = eat.win.__wisp
    const eatMood = () => eat.find('wisp-root').dataset.mood
    const eatUntil = (limitMs, chunk = 1000) => {
      for (let left = limitMs; left > 0; left -= chunk) {
        eat.advance(Math.min(chunk, left), 200)
        if (eatMood() === 'eat') return true
      }
      return false
    }
    const bubbleIsEat = () => {
      const text = eat.all('wisp-say').at(-1)?.textContent
      return Array.isArray(linesInBundle()?.eat) && linesInBundle().eat.includes(text)
    }

    check(Array.isArray(linesInBundle()?.eat) && linesInBundle().eat.length >= 8,
      'the rice pool exists and has some lines in it', `${linesInBundle()?.eat?.length ?? '?'} 句`)
    check(eatApi.doctor().hunger.enabled === true && eatApi.doctor().hunger.everyMs === 600000,
      'doctor reports the hunger setting', JSON.stringify(eatApi.doctor().hunger))

    // 9 分钟：还没到
    let sawEarlyEat = false
    for (let left = 9 * 60000; left > 0; left -= 1000) {
      eat.advance(1000, 200)
      if (eatMood() === 'eat') { sawEarlyEat = true; break }
    }
    check(!sawEarlyEat, 'nine minutes in she is not hungry yet', eatMood())

    check(eatUntil(200000), 'past the threshold she gets a bowl out')
    check(bubbleIsEat(), 'and the line comes from the rice pool',
      (eat.all('wisp-say').at(-1)?.textContent ?? '(无)'))
    check(eatMood() === 'eat' && eatApi.currentMood === 'eat',
      'and both the DOM and the reported mood say eat', `${eatMood()} / ${eatApi.currentMood}`)

    // 稳态轮询不能把它抹掉
    eat.advance(1000, 100)
    check(eatMood() === 'eat', 'the reaction poll does not overwrite the meal', eatMood())

    // 吃完自己回去（EAT_MS = 5.2 秒）
    for (let left = 8000; left > 0; left -= 500) eat.advance(500, 100)
    check(eatMood() === 'alert', 'and the meal ends on its own, back to alert', eatMood())

    // 不该连着说
    let saidAgain = false
    for (let left = 60000; left > 0; left -= 1000) {
      eat.advance(1000, 200)
      if (eatMood() === 'eat') { saidAgain = true; break }
    }
    check(!saidAgain, 'she does not ask for rice again a minute later', eatMood())
    check(eatUntil(600000), 'but another full stretch does bring it back')

    // 离开很久之后回来：不该一进门就喊饿
    eat.win.__wisp.configure({ hungerMs: 300000 })
    eat.state.composerText = null
    eat.advance(20 * 60000, 5000)
    eat.state.composerText = '回来了'
    eat.advance(1300, 100)
    let instantHunger = false
    for (let left = 120000; left > 0; left -= 1000) {
      eat.advance(1000, 200)
      if (eatMood() === 'eat') { instantHunger = true; break }
    }
    check(!instantHunger, 'after a long absence she does not ask for rice the moment you return', eatMood())
    check(eatUntil(300000), 'only a fresh full stretch makes her hungry')
    /* 让这一顿吃完（EAT_MS = 5.2 秒）再测关闭 —— 否则"还停在 eat"会被误判成"关不掉"。
       （这个坑久坐提醒那节也踩过，同样用一段推进收尾。） */
    eat.advance(8000, 500)

    // 关掉这个行为（两种关法）
    eat.win.__wisp.configure({ hungerMs: 0 })
    let offByZero = false
    for (let left = 20 * 60000; left > 0; left -= 5000) {
      eat.advance(5000, 500)
      if (eatMood() === 'eat') { offByZero = true; break }
    }
    check(!offByZero, 'hungerMs: 0 turns it off', eatMood())
    eat.win.__wisp.configure({ hungerMs: 300000, hungry: false })
    let offByFlag = false
    for (let left = 20 * 60000; left > 0; left -= 5000) {
      eat.advance(5000, 500)
      if (eatMood() === 'eat') { offByFlag = true; break }
    }
    check(!offByFlag, 'and hungry: false turns it off even with a live timer', eatMood())
    check(eatApi.config.hungry === false, 'and the config says so', String(eatApi.config.hungry))

    // 菜单开关：先把菜单叫出来（菜单项是开菜单时才建的），点一下就该翻转
    /* 主菜单的入口是 .wisp-body 上的 keydown（Enter / 空格 / ContextMenu / Shift+F10），
       不是 contextmenu —— 后者只挂在"躲起来"之后的迷你标签上。事件对象同样自建：
       ctxEvent 定义在文件后半部分，在这里用就是 TDZ。 */
    eat.win.__wisp.configure({ hungry: true })
    const eatBody = eat.find('wisp-root').querySelector('.wisp-body')
    eatBody.dispatch('keydown', {
      type: 'keydown', key: 'Enter', shiftKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
    })
    const eatToggle = eat.all('wisp-menu-item').filter((el) => el.removed !== true)
      .find((el) => (el.textContent || '').includes('饿了'))
    check(Boolean(eatToggle), 'the menu carries a rice toggle',
      eat.all('wisp-menu-item').filter((el) => el.removed !== true).length + ' 项')
    if (eatToggle) {
      /* 元素上的点击走 harness 的 dispatch(type, event) —— 不是浏览器的 dispatchEvent（没有那个方法）。 */
      eatToggle.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      check(eat.win.__wisp.config.hungry === false, 'and clicking it turns the behaviour off',
        String(eat.win.__wisp.config.hungry))
    }
    eat.win.__wisp.destroy()
    active = keepEat

    /* 睡着了也得被叫醒：这条单独测，因为它需要 sleepAfterMs 很短 */
    const sleepCare = createHarness({ timer: true, composerText: '在打字' })
    const keepSleepCare = active
    active = sleepCare
    sleepCare.evaluate(clientSrc)
    sleepCare.module().default.apply(sleepCare.ctx, {
      reactions: true, wander: false, celebrate: false, careAfterMs: 60000, sleepAfterMs: 5000,
    })
    sleepCare.advance(8000, 500)
    check(sleepCare.find('wisp-root').dataset.mood === 'sleep', 'with a short sleep timer she dozes careOff first',
      sleepCare.find('wisp-root').dataset.mood)
    const careWoke = (() => {
      const seen = new Set()
      for (let left = 90000; left > 0; left -= 1000) {
        sleepCare.advance(Math.min(1000, left), 200)
        seen.add(sleepCare.find('wisp-root').dataset.mood)
      }
      return seen
    })()
    check(careWoke.has('care'), 'and the reminder wakes her up rather than mumbling from sleep',
      `观察到的情绪: ${[...careWoke].join(',')}`)
    sleepCare.win.__wisp.destroy()
    active = keepSleepCare

    /* ---------------- 3d-duodecies. 今日轮次里程碑 --------------------------- */
    head('3d-duodecies. she counts the day and speaks up at milestones')

    const ms = createHarness({ timer: true, composerText: '' })
    const keepMs = active
    active = ms
    ms.evaluate(clientSrc)
    ms.module().default.apply(ms.ctx, { reactions: true, wander: false, celebrate: true, celebrateAfterMs: 0 })
    ms.advance(1300, 100)
    const msApi = ms.win.__wisp
    const msMood = () => ms.find('wisp-root').dataset.mood
    /* 驱动一轮「跑完」：busy true → false 就是那个边沿 */
    const finishRun = () => {
      ms.state.busy = true
      ms.advance(1500, 100)
      ms.state.busy = false
      ms.advance(1500, 100)
    }
    const milestoneHit = () => msMood() === 'proud'

    finishRun()
    check(msApi.doctor().runsToday.count === 1, 'a finished run is counted', JSON.stringify(msApi.doctor().runsToday))
    check(!milestoneHit(), 'and a single run is celebrated, not flattered', msMood())

    // 数到第 10 轮
    let milestoneSeen = false
    for (let i = 0; i < 9; i++) {
      finishRun()
      if (milestoneHit()) milestoneSeen = true
    }
    const day10 = msApi.doctor().runsToday
    check(day10.count === 10, 'the count reaches ten', JSON.stringify(day10))
    check(milestoneSeen, 'and the tenth run gets the proud reaction')
    const proudLine = ms.all('wisp-say').at(-1)?.textContent
    check(linesInBundle()?.milestone?.some((l) => l.split('{n}').join('10') === proudLine),
      'with the number actually substituted into the line', String(proudLine))
    check(day10.said.includes(10), 'and the milestone is remembered as said', JSON.stringify(day10.said))

    // 第 11 轮不该再说一遍
    finishRun()
    check(!milestoneHit(), 'the eleventh run does not repeat it', msMood())
    check(msApi.doctor().runsToday.count === 11, 'but it is still counted', String(msApi.doctor().runsToday.count))

    // 刷新页面：数字延续，已经说过的不再说
    msApi.destroy()
    ms.module().default.apply(ms.ctx, { reactions: true, wander: false, celebrate: true, celebrateAfterMs: 0 })
    ms.advance(1300, 100)
    const afterReload = ms.win.__wisp.doctor().runsToday
    check(afterReload.count === 11 && afterReload.said.includes(10),
      'a reload keeps the count and remembers what was already said', JSON.stringify(afterReload))
    finishRun()
    check(!milestoneHit(), 'so a reload does not make her repeat herself', msMood())
    ms.win.__wisp.destroy()
    active = keepMs

    // 换了一天：计数归零，昨天的里程碑不再算数
    const nextDay = createHarness({
      timer: true, composerText: '',
      storageSeed: { 'dsh-wisp:runs:v1': JSON.stringify({ day: '2000-1-1', count: 42, said: [10, 25] }) },
    })
    const keepNextDay = active
    active = nextDay
    nextDay.evaluate(clientSrc)
    nextDay.module().default.apply(nextDay.ctx, { reactions: true, wander: false, celebrate: true, celebrateAfterMs: 0 })
    nextDay.advance(1300, 100)
    check(nextDay.win.__wisp.doctor().runsToday.count === 0,
      'a stored count from another day starts at zero', JSON.stringify(nextDay.win.__wisp.doctor().runsToday))
    nextDay.state.busy = true
    nextDay.advance(1500, 100)
    nextDay.state.busy = false
    nextDay.advance(1500, 100)
    check(nextDay.win.__wisp.doctor().runsToday.count === 1,
      'and today starts counting from one', JSON.stringify(nextDay.win.__wisp.doctor().runsToday))
    nextDay.win.__wisp.destroy()
    active = keepNextDay

    /* ---------------- 3d-terdecies. 她记着你 -------------------------------- */
    head('3d-terdecies. she remembers a few things about you')

    /* 这个功能的难点全在**防噪**：同一条记忆一辈子只说一次、一天最多说一句。
       没有这两条，台词会在每次刷新时重复，很快从"她记得"变成"她唠叨"。 */
    const memKey = 'dsh-wisp:memory:v1'
    /* 断言"她说过"而不是"最后一条是她说的"：同一次挂载里可能还有别的台词（例如
       首次的右键提示），只看最后一条会把别的当成本条的结果。 */
    const saidAnywhere = (harness, pool, fill) =>
      harness.all('wisp-say').some((el) => pool.some((l) => l.split('{n}').join(fill).split('{c}').join(fill).split('{s}').join(fill) === el.textContent))
    const sixDaysAgo = (n) => {
      const out = []
      for (let i = n; i >= 1; i--) {
        const d = new Date(Date.now() - i * 86400000)
        out.push(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)
      }
      return out
    }

    // 第一次见面：只记下今天，不该有什么"我们 1 天了"这种话
    const m1 = createHarness({ timer: true, composerText: '' })
    const keepM1 = active
    active = m1
    m1.evaluate(clientSrc)
    m1.module().default.apply(m1.ctx, { reactions: true, wander: false, celebrate: false })
    m1.advance(4500, 200)
    const firstDay = m1.win.__wisp.doctor().memory
    check(firstDay.days === 1 && firstDay.said.length === 0,
      'the first day is recorded and nothing is claimed', JSON.stringify(firstDay))
    check(!saidAnywhere(m1, linesInBundle().days, '1'),
      'and she does not announce day one', '没有任何「第 1 天」的台词')
    m1.win.__wisp.destroy()
    active = keepM1

    // 一起第 7 天：存着前 6 天，今天挂载就是第 7 天
    const m7 = createHarness({
      timer: true, composerText: '',
      storageSeed: { [memKey]: JSON.stringify({ days: sixDaysAgo(6), corners: {}, skins: {}, said: [], remarkDay: '' }) },
    })
    const keepM7 = active
    active = m7
    m7.evaluate(clientSrc)
    m7.module().default.apply(m7.ctx, { reactions: true, wander: false, celebrate: false })
    m7.advance(9000, 200)
    const day7 = m7.win.__wisp.doctor().memory
    check(day7.days === 7, 'seven days together is counted', JSON.stringify({ days: day7.days }))
    check(saidAnywhere(m7, linesInBundle().days, '7'),
      'and she says so with the number substituted',
      m7.all('wisp-say').map((el) => el.textContent).join(' | '))
    check(day7.said.includes('days:7'), 'and marks it claimed', JSON.stringify(day7.said))

    // 同一天里再刷新：不该再说一遍
    m7.win.__wisp.destroy()
    m7.module().default.apply(m7.ctx, { reactions: true, wander: false, celebrate: false })
    const saidBefore = m7.all('wisp-say').length
    m7.advance(9000, 200)
    const newBubbles = m7.all('wisp-say').slice(saidBefore)
    check(!newBubbles.some((el) => linesInBundle().days.some((l) => l.split('{n}').join('7') === el.textContent)),
      'a reload on the same day does not say it again',
      newBubbles.map((el) => el.textContent).join(' | ') || '刷新后没有新台词')
    m7.win.__wisp.destroy()
    active = keepM7

    // 角落习惯：右下角用了 12 次、占绝大多数
    const cornerMem = createHarness({
      timer: true, composerText: '',
      storageSeed: {
        [memKey]: JSON.stringify({
          // 天数刻意避开里程碑：否则「一起 N 天」会先命中，角落那条就没机会开口（那是规则正确，不是 bug）
          days: sixDaysAgo(3), corners: { 右下角: 12, 左上角: 2 }, skins: {}, said: [], remarkDay: '',
        }),
      },
    })
    const keepCorner = active
    active = cornerMem
    cornerMem.evaluate(clientSrc)
    cornerMem.module().default.apply(cornerMem.ctx, { reactions: true, wander: false, celebrate: false })
    cornerMem.advance(9000, 200)
    check(saidAnywhere(cornerMem, linesInBundle().habitCorner, '右下角'),
      'a corner habit gets mentioned once it is established',
      cornerMem.all('wisp-say').map((el) => el.textContent).join(' | '))
    check(cornerMem.find('wisp-root').dataset.mood === 'proud', 'and it is said with the proud look',
      cornerMem.find('wisp-root').dataset.mood)
    check(cornerMem.win.__wisp.doctor().memory.said.includes('corner:右下角'),
      'and it will not be said twice', JSON.stringify(cornerMem.win.__wisp.doctor().memory.said))
    cornerMem.win.__wisp.destroy()
    active = keepCorner

    // 证据不够就不说：只用了 3 次，或者刚过半数
    const weakCorner = createHarness({
      timer: true, composerText: '',
      storageSeed: {
        [memKey]: JSON.stringify({
          days: sixDaysAgo(3), corners: { 右下角: 3, 左上角: 3 }, skins: {}, said: [], remarkDay: '',
        }),
      },
    })
    const keepWeak = active
    active = weakCorner
    weakCorner.evaluate(clientSrc)
    weakCorner.module().default.apply(weakCorner.ctx, { reactions: true, wander: false, celebrate: false })
    weakCorner.advance(9000, 200)
    const weakSaid = weakCorner.all('wisp-say').map((el) => el.textContent)
    check(!weakSaid.some((t) => /你总把我放在|你习惯那儿了|都快成我的位置了/.test(String(t))),
      'a couple of uses is not a habit', weakSaid.join(' | '))
    weakCorner.win.__wisp.destroy()
    active = keepWeak

    // 皮肤习惯：常穿的那套不是当前这套
    const skinMem = createHarness({
      timer: true, composerText: '',
      storageSeed: {
        [memKey]: JSON.stringify({ days: sixDaysAgo(3), corners: {}, skins: { pajama: 7 }, said: [], remarkDay: '' }),
      },
    })
    const keepSkinMem = active
    active = skinMem
    skinMem.evaluate(clientSrc)
    skinMem.module().default.apply(skinMem.ctx, { reactions: true, wander: false, celebrate: false })
    skinMem.advance(9000, 200)
    const skinSaid = skinMem.all('wisp-say').map((el) => el.textContent).join(' | ')
    check(/睡衣/.test(skinSaid), 'a skin habit is mentioned by its label', skinSaid)
    skinMem.win.__wisp.destroy()
    active = keepSkinMem

    // 一天最多一句：同时满足"第 7 天"和"角落习惯"，也只能说一句
    const bothMem = createHarness({
      timer: true, composerText: '',
      storageSeed: {
        [memKey]: JSON.stringify({
          days: sixDaysAgo(6), corners: { 右下角: 12 }, skins: {}, said: [], remarkDay: '',
        }),
      },
    })
    const keepBoth = active
    active = bothMem
    bothMem.evaluate(clientSrc)
    bothMem.module().default.apply(bothMem.ctx, { reactions: true, wander: false, celebrate: false })
    bothMem.advance(9000, 200)
    const bothSaid = bothMem.win.__wisp.doctor().memory.said
    check(bothSaid.length === 1, 'only one memory line per day, even when several apply', JSON.stringify(bothSaid))
    bothMem.win.__wisp.destroy()
    active = keepBoth

    // 记录不能无限长
    const longMem = createHarness({
      timer: true, composerText: '',
      storageSeed: {
        [memKey]: JSON.stringify({
          days: Array.from({ length: 300 }, (_, i) => `2000-1-${(i % 28) + 1}`), corners: {}, skins: {}, said: [], remarkDay: '',
        }),
      },
    })
    const keepLong = active
    active = longMem
    longMem.evaluate(clientSrc)
    longMem.module().default.apply(longMem.ctx, { reactions: true, wander: false, celebrate: false })
    longMem.advance(200, 100)
    check(longMem.win.__wisp.doctor().memory.days <= 90,
      'the day list stays bounded', String(longMem.win.__wisp.doctor().memory.days))
    longMem.win.__wisp.destroy()
    active = keepLong

    // memory: false 关掉
    const noMem = createHarness({
      timer: true, composerText: '',
      storageSeed: {
        [memKey]: JSON.stringify({ days: sixDaysAgo(6), corners: {}, skins: {}, said: [], remarkDay: '' }),
      },
    })
    const keepNoMem = active
    active = noMem
    noMem.evaluate(clientSrc)
    noMem.module().default.apply(noMem.ctx, { reactions: true, wander: false, celebrate: false, memory: false })
    noMem.advance(9000, 200)
    check(noMem.win.__wisp.doctor().memory.said.length === 0, 'memory: false turns the remarks off',
      JSON.stringify(noMem.win.__wisp.doctor().memory.said))
    noMem.win.__wisp.destroy()
    active = keepNoMem

    /* ---------------- 3d-quattuordecies. 交互三件事 --------------------------- */
    head('3d-quattuordecies. resize by wheel, move by keyboard, reach her when hidden')

    /* 这三条都是「只能靠鼠标」的缺口：调大小只能开菜单、定位只能拖、躲起来之后够不着任何设置。 */
    const ix = createHarness({ timer: true, composerText: '' })
    const keepIx = active
    active = ix
    ix.evaluate(clientSrc)
    ix.module().default.apply(ix.ctx, { reactions: true, wander: false, celebrate: false })
    ix.advance(1300, 100)
    const ixApi = ix.win.__wisp
    const ixBody = ix.find('wisp-body')
    const wheel = (deltaY, mods) => {
      const ev = {
        deltaY, ctrlKey: false, metaKey: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...(mods || {}),
      }
      ixBody.dispatch('wheel', ev)
      return ev
    }
    const arrow = (key, shift) => {
      const ev = {
        key, shiftKey: shift === true, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
      }
      ixBody.dispatch('keydown', ev)
      return ev
    }

    /* ---- Ctrl/⌘ + 滚轮：调大小 ---- */
    const size0 = ixApi.config.size
    wheel(-100, { ctrlKey: true })
    const sizeUp = ixApi.config.size
    check(Math.abs(sizeUp - (size0 + 0.25)) < 1e-9, 'ctrl+wheel up makes her a step bigger',
      String(size0) + ' -> ' + String(sizeUp))
    wheel(100, { ctrlKey: true })
    check(Math.abs(ixApi.config.size - size0) < 1e-9, 'and ctrl+wheel down takes it back',
      String(ixApi.config.size))
    wheel(-100, { metaKey: true })
    check(Math.abs(ixApi.config.size - (size0 + 0.25)) < 1e-9, '⌘+wheel does the same on macOS',
      String(ixApi.config.size))
    wheel(100, { metaKey: true })

    /* 上下限由 CONFIG_SPEC 统一夹紧 —— 滚到天边也不该越界 */
    for (let i = 0; i < 60; i++) wheel(100, { ctrlKey: true })
    check(ixApi.config.size === 0.4, 'wheeling down stops at the lower bound', String(ixApi.config.size))
    for (let i = 0; i < 80; i++) wheel(-100, { ctrlKey: true })
    check(ixApi.config.size === 8, 'and up stops at the upper bound', String(ixApi.config.size))
    ixApi.configure({ size: size0 })

    /* ---- 普通滚轮：一个字都不许动 ---- */
    const plain = wheel(-100)
    check(ixApi.config.size === size0, 'a plain wheel never resizes her', String(ixApi.config.size))
    check(plain.defaultPrevented === false,
      'and a plain wheel is left alone so the page still scrolls over her', 'defaultPrevented=false')

    /* ---- 方向键：微调位置 ---- */
    const pos0 = ixApi.position
    const right = arrow('ArrowRight')
    check(ixApi.position.x === pos0.x + 16 && ixApi.position.y === pos0.y,
      'the right arrow nudges her 16px',
      pos0.x + ',' + pos0.y + ' -> ' + ixApi.position.x + ',' + ixApi.position.y)
    check(right.defaultPrevented, 'and the arrow is swallowed so the page does not scroll with it')
    check(JSON.parse(ix.win.localStorage.getItem('dsh-wisp:position:v1') || 'null')?.x === ixApi.position.x,
      'a nudge is remembered like a drag', ix.win.localStorage.getItem('dsh-wisp:position:v1'))
    arrow('ArrowDown')
    check(ixApi.position.y === pos0.y + 16, 'the down arrow moves her down', String(ixApi.position.y))
    arrow('ArrowRight', true)
    check(ixApi.position.x === pos0.x + 20, 'shift+arrow is the fine step (4px)', String(ixApi.position.x))

    /* 边界：一直按左键不该把她推出去 */
    ixApi.move(0, 100)
    for (let i = 0; i < 5; i++) arrow('ArrowLeft')
    check(ixApi.position.x === 0 && ixApi.position.y === 100,
      'nudging into the edge clamps instead of pushing her out',
      ixApi.position.x + ',' + ixApi.position.y)
    for (let i = 0; i < 10; i++) arrow('ArrowUp')
    check(ixApi.position.y === 0, 'same at the top', String(ixApi.position.y))

    /* ---- 躲起来之后：迷你按钮右键也能开菜单 ---- */
    ixApi.hide()
    ix.advance(200, 100)
    const ixTab = ix.find('wisp-tab')
    check(ixTab !== null, 'the mini tab is there while she is hidden')
    const tabEv = {
      clientX: 900, clientY: 500, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
    }
    ixTab.dispatch('contextmenu', tabEv)
    check(ix.find('wisp-menu') !== null, 'right-clicking the mini tab opens the menu')
    check(tabEv.defaultPrevented, 'and the browser context menu is suppressed')
    /* all() 会把已移除的旧菜单项一起返回（关掉的菜单、重开的菜单）—— 只认还在文档里的。 */
    const liveItems = () => ix.all('wisp-menu-item').filter((el) => el.removed !== true)
    const toggleHidden = liveItems().map((el) => el.textContent)
      .find((t) => t.includes('回来吧') || t.includes('先躲起来'))
    check(toggleHidden !== undefined && toggleHidden.includes('回来吧'),
      'while hidden the hide entry turns into a way back', String(toggleHidden))
    const backEl = liveItems().find((el) => el.textContent.includes('回来吧'))
    backEl.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    check(ixApi.hidden === false, 'clicking it brings her back', String(ixApi.hidden))
    check(ixApi.element.dataset.hidden === 'false', 'and the root is marked visible again')

    /* 可见时它是单向的「先躲起来」。
       这里用键盘 Enter 开菜单：rightClickOnHer() 定义在本节之后，直接调用会踩 TDZ
       （Enter 走的是同一条 openMenu，测的是同一件事）。 */
    arrow('Enter')
    const toggleVisible = liveItems().map((el) => el.textContent)
      .find((t) => t.includes('回来吧') || t.includes('先躲起来'))
    check(toggleVisible !== undefined && toggleVisible.includes('先躲起来'),
      'while visible the same entry says hide', String(toggleVisible))

    ix.win.__wisp.destroy()
    active = keepIx

    /* ---------------- 3d-quindecies. 版本与更新 ------------------------------- */
    head('3d-quindecies. she knows her version — and is honest about what she cannot do')

    /* 平台事实（源码级查过）：宿主半包跑在 vm 沙箱里，harness 只给
       { defineTool, registerTool, handle }，沙箱里 nodeApiTraps() 挡住 Node API ——
       插件**既不能联网、也不能写文件**，DSH 的安装器也没有可注入的服务。
       所以"自己检查并安装更新"做不到；这一节测的是能真正做到的那几件事。 */
    const uv = createHarness({ timer: true, composerText: '', clipboard: true })
    const keepUv = active
    active = uv
    uv.evaluate(clientSrc)
    uv.module().default.apply(uv.ctx, { reactions: true, wander: false, celebrate: false })
    uv.advance(1300, 100)
    const uvApi = uv.win.__wisp
    const pkgVersion = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version

    check(uvApi.version === pkgVersion, 'the running bundle reports the packaged version',
      `${uvApi.version} vs ${pkgVersion}`)
    check(uvApi.doctor().version === pkgVersion, 'and doctor() agrees', String(uvApi.doctor().version))

    /* 版本说明表必须写当前版本 —— 忘了更新就红，不会静默过期 */
    const update = uvApi.doctor().update
    check(typeof update?.whatsNew === 'string' && update.whatsNew.length > 0,
      'the what-is-new note covers the CURRENT version', String(update?.whatsNew))

    /* 能力边界要如实报告，不能让人以为她能自己更新 */
    check(update.canSelfUpdate === false, 'she does not pretend she can update herself',
      String(update.canSelfUpdate))
    check(typeof update.hint === 'string' && update.hint.includes('dsh-wisp'),
      'but she does say which package to install', String(update.hint))
    check(/沙箱|sandbox/.test(String(update.why)), 'and why — in plain words', String(update.why))

    /* 菜单里那一项：说出当前版本，并把包名复制好 */
    const beforeWrites = uv.clipboardWrites.length
    const updateResult = uvApi.showUpdate()
    check(updateResult.version === pkgVersion && updateResult.copied === true,
      'the update action reports the version and copies the package name', JSON.stringify(updateResult))
    const lastBubble = uv.all('wisp-say').at(-1)?.textContent
    check(String(lastBubble).includes(pkgVersion), 'and she says the version out loud', String(lastBubble))
    check(uv.clipboardWrites.length === beforeWrites + 1 && uv.clipboardWrites[uv.clipboardWrites.length - 1] === 'dsh-wisp',
      'the clipboard actually received the package name',
      JSON.stringify(uv.clipboardWrites.slice(-1)))
    uv.win.__wisp.destroy()
    active = keepUv

    /* 没有剪贴板（没有权限 / 不是安全上下文）：**静默降级**，不许抛错 */
    const noClip = createHarness({ timer: true, composerText: '' })
    const keepNoClip = active
    active = noClip
    noClip.evaluate(clientSrc)
    noClip.module().default.apply(noClip.ctx, { reactions: true, wander: false, celebrate: false })
    noClip.advance(1300, 100)
    let threw = false
    let res = null
    try { res = noClip.win.__wisp.showUpdate() } catch (e) { threw = true }
    check(threw === false && res !== null && res.copied === false,
      'without a clipboard she still speaks and reports the copy as not done', JSON.stringify(res))
    noClip.win.__wisp.destroy()
    active = keepNoClip

    /* ---- 真的去查：走 host.call → 宿主半包的 checkUpdate → ctx.web.fetch ---- */
    const mkChecker = (reply) => createHarness({
      timer: true, composerText: '',
      hostCall: async (method, args) => {
        if (typeof reply === 'function') return reply(method, args)
        throw reply
      },
    })
    const checkCases = [
      ['available', async () => ({ ok: true, latest: '99.0.0', current: pkgVersion })],
      ['current', async () => ({ ok: true, latest: pkgVersion, current: pkgVersion })],
      ['failed', async () => ({ ok: false, reason: 'no-web-service' })],
    ]
    for (const [expected, reply] of checkCases) {
      const hc = mkChecker(reply)
      const keepHc = active
      active = hc
      hc.evaluate(clientSrc)
      hc.module().default.apply(hc.ctx, { reactions: true, wander: false, celebrate: false })
      hc.advance(1300, 100)
      const res = await hc.win.__wisp.checkForUpdate()
      check(res.state === expected, `a ${expected} answer from the host lands in that state`, JSON.stringify(res))
      check(hc.win.__wisp.doctor().update.lastCheck.state === expected,
        'and doctor() reports the last check', JSON.stringify(hc.win.__wisp.doctor().update.lastCheck))
      if (expected === 'available') {
        hc.win.__wisp.showUpdate()
        /* hostCall 是 async 的，链上有好几跳微任务；两个 await 不够，
           换成 setImmediate 一次冲干净（这里的 setTimeout 是测试进程的，不是被陷阱的那个）。 */
        await new Promise((resolve) => setImmediate(resolve))
        const line = hc.all('wisp-say').at(-1)?.textContent
        check(String(line).includes('99.0.0'), 'and she says the new version out loud', String(line))
      }
      hc.win.__wisp.destroy()
      active = keepHc
    }

    /* 宿主调用抛错：不能变成未处理的 rejection */
    const thrower = mkChecker('boom')
    const keepThrower = active
    active = thrower
    thrower.evaluate(clientSrc)
    thrower.module().default.apply(thrower.ctx, { reactions: true, wander: false, celebrate: false })
    thrower.advance(1300, 100)
    const threwRes = await thrower.win.__wisp.checkForUpdate()
    check(threwRes.state === 'failed' && threwRes.reason === 'call-failed' && threwRes.detail === 'boom',
      'a throwing host call is caught and reported', JSON.stringify(threwRes))
    thrower.win.__wisp.destroy()
    active = keepThrower

    /* 没有 host 座位（默认替身）：如实说"查不了"，不抛 */
    const noHost = createHarness({ timer: true, composerText: '' })
    const keepNoHost = active
    active = noHost
    noHost.evaluate(clientSrc)
    noHost.module().default.apply(noHost.ctx, { reactions: true, wander: false, celebrate: false })
    noHost.advance(1300, 100)
    const unsupported = await noHost.win.__wisp.checkForUpdate()
    check(unsupported.state === 'unsupported',
      'with no host seat she reports that checking is not available', JSON.stringify(unsupported))
    const stillWorks = noHost.win.__wisp.showUpdate()
    check(stillWorks.version === pkgVersion && stillWorks.checking === true,
      'and the update entry still works without it', JSON.stringify(stillWorks))
    noHost.win.__wisp.destroy()
    active = keepNoHost

    /* 更新过了就说一句；第一次安装不吭声 */
    const upgraded = createHarness({
      timer: true, composerText: '',
      storageSeed: { 'dsh-wisp:seen-version:v1': JSON.stringify('0.0.1-old') },
    })
    const keepUp = active
    active = upgraded
    upgraded.evaluate(clientSrc)
    upgraded.module().default.apply(upgraded.ctx, { reactions: true, wander: false, celebrate: false })
    upgraded.advance(3000, 200)
    const upgradeBubbles = upgraded.all('wisp-say').map((el) => el.textContent)
    check(upgradeBubbles.some((t) => String(t).includes(pkgVersion)),
      'a version change since last time makes her say she was updated',
      upgradeBubbles.join(' | '))
    check(JSON.parse(upgraded.win.localStorage.getItem('dsh-wisp:seen-version:v1')) === pkgVersion,
      'and the new version is remembered',
      upgraded.win.localStorage.getItem('dsh-wisp:seen-version:v1'))
    upgraded.win.__wisp.destroy()
    active = keepUp

    const sameVer = createHarness({
      timer: true, composerText: '',
      storageSeed: { 'dsh-wisp:seen-version:v1': JSON.stringify(pkgVersion) },
    })
    const keepSame = active
    active = sameVer
    sameVer.evaluate(clientSrc)
    sameVer.module().default.apply(sameVer.ctx, { reactions: true, wander: false, celebrate: false })
    sameVer.advance(3000, 200)
    check(!sameVer.all('wisp-say').some((el) => String(el.textContent).includes('更新到')),
      'but the same version says nothing about updating',
      sameVer.all('wisp-say').map((el) => el.textContent).join(' | '))
    sameVer.win.__wisp.destroy()
    active = keepSame

    /* ------------------------------------------------------ 3e. theme ------ */
    head('3e. theme follows the shell')

    check(h.themeListenerCount() === 1, 'subscribed to theme/change')
    h.emitTheme({ active: { colorScheme: 'dark' } })
    check(root.dataset.wispTheme === 'dark', 'dark theme is reflected on the element', String(root.dataset.wispTheme))
    h.emitTheme({ active: { colorScheme: 'light' } })
    check(root.dataset.wispTheme === 'light', 'light theme is reflected on the element', String(root.dataset.wispTheme))

    /* ------------------------------------------------- 3f. drag + persistence */
    head('3f. drag, and the position it remembers')

    const bodyWisp = h.find('wisp-body')
    const SCALE = 4
    const BOX_W = 140 * SCALE
    const BOX_H = 210 * SCALE
    const centre = () => ({ x: api.position.x + BOX_W / 2, y: api.position.y + BOX_H / 2 })
    const press = (x, y) => {
      const ev = { button: 0, clientX: x, clientY: y, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
      bodyWisp.dispatch('pointerdown', ev)
      return ev
    }

    const before = api.position
    const start = centre()
    check(press(start.x, start.y).defaultPrevented, 'a press on her body takes the pointer', `${start.x},${start.y}`)
    h.win.dispatch('pointermove', { clientX: start.x - 300, clientY: start.y - 60 })
    h.win.dispatch('pointerup', {})
    const after = api.position
    check(after.x !== before.x || after.y !== before.y, 'dragging moves her', `${before.x},${before.y} -> ${after.x},${after.y}`)
    check(after.x === before.x - 300 && after.y === before.y - 60, 'she follows the pointer exactly', `${after.x},${after.y}`)

    /* The transform must place the box's TOP-LEFT at the reported position. An
       earlier build translated by `x + boxW/2` "for the centre origin", which a
       CSS translation ignores — the box rendered half a box-width to the right,
       off the viewport edge, while the hit mask kept sampling from `coords.x`.
       That made her impossible to grab. Assert the rendered box, not the state. */
    const boxAt = (t) => {
      const m = /translate3d\(([-\d.]+)px,([-\d.]+)px,0\) scaleX\((-?\d)\)/.exec(String(t))
      return m === null ? null : { x: Number(m[1]), y: Number(m[2]), facing: Number(m[3]) }
    }
    const placed = boxAt(root.style.transform)
    check(placed !== null && Math.abs(placed.x - after.x) <= 1 && Math.abs(placed.y - after.y) <= 1,
      'the rendered box starts exactly where the position says',
      `transform at ${placed?.x},${placed?.y} vs position ${after.x},${after.y}`)

    const storedRaw = h.win.localStorage.getItem('dsh-wisp:position:v1')
    check(typeof storedRaw === 'string' && JSON.parse(storedRaw).x === after.x, 'drag end persists the position', storedRaw)

    // A plain click must not be mistaken for a drag.
    const held = api.position
    const c1 = centre()
    press(c1.x, c1.y)
    h.win.dispatch('pointerup', {})
    check(api.position.x === held.x && api.position.y === held.y, 'a click does not move her')

    /* ---- the transparent margin must not swallow the app's clicks ------ */
    const edge = press(api.position.x + 4, api.position.y + BOX_H / 2)
    check(edge.defaultPrevented === false,
      'a press on her transparent margin passes through to the app', `defaultPrevented=${edge.defaultPrevented}`)
    const stillHeld = api.position
    h.win.dispatch('pointermove', { clientX: 0, clientY: 0 })
    h.win.dispatch('pointerup', {})
    check(api.position.x === stillHeld.x && api.position.y === stillHeld.y,
      'a margin press does not start a drag', `${api.position.x},${api.position.y}`)

    /* ---- she is grabbable wherever she is drawn ------------------------ */
    // Deliberate product decision: she does not yield to a control underneath,
    // because the user can simply move her. Pin it so a future "safety" tweak
    // cannot quietly make parts of her undraggable again.
    const c3 = centre()
    const heldBy = api.position
    const regrab = press(c3.x, c3.y)
    check(regrab.defaultPrevented, 'a press on her body always grabs her, control or not')
    h.win.dispatch('pointermove', { clientX: c3.x - 40, clientY: c3.y })
    h.win.dispatch('pointerup', {})
    check(api.position.x === heldBy.x - 40, 'and it drags her', `${api.position.x} vs ${heldBy.x - 40}`)

    /* ---- geometry must follow the render scale, and the mirror must pivot -- */
    const c2 = centre()
    press(c2.x, c2.y)
    h.win.dispatch('pointermove', { clientX: 9999, clientY: 9999 })
    h.win.dispatch('pointerup', {})
    const corner = api.position
    check(corner.x === h.win.innerWidth - BOX_W && corner.y === h.win.innerHeight - BOX_H,
      'the clamp uses the SCALED box, so she cannot hang off the edge',
      `x=${corner.x} (max ${h.win.innerWidth - BOX_W}), y=${corner.y} (max ${h.win.innerHeight - BOX_H})`)

    api.move(0, 300)
    const tr = boxAt(root.style.transform)
    check(tr !== null, 'the transform is a plain translate plus a mirror', String(root.style.transform))
    if (tr !== null) {
      check(tr.facing === -1, 'she turns to face left on the left half', `scaleX(${tr.facing})`)
      check(tr.x === 0 && tr.y === 300, 'turning around does not shift her box',
        `translate ${tr.x},${tr.y} for position 0,300`)
    }
    api.move(after.x, after.y)   // put her back for the teardown/persistence checks

    /* ------------------------------------------------------ 3g. teardown --- */
    head('3g. teardown')

    const liveBefore = h.pendingTimers().length
    check(typeof h.teardown === 'function', 'ctx.effect teardown registered')
    check(h.effectLabels.includes('dsh-wisp: teardown'),
      'the mount is registered on the caller fiber for teardown', h.effectLabels.join(' / '))
    const disposals = h.teardown()
    check(disposals.length >= 1 && disposals.every((d) => typeof d === 'function'),
      'every ctx.effect callback returns a real disposer', `${disposals.length} disposer(s)`)
    check(liveBefore > 0, 'timers were live before teardown', `${liveBefore}`)
    for (const dispose of disposals) dispose()

    check(h.pendingTimers().length === 0, 'every timer is disposed', `left ${h.pendingTimers().length}`)
    check(h.win.listenerCount('pointermove') === 0, 'window listeners are removed')
    check(h.win.listenerCount('keydown') === 0, 'keydown listener is removed')
    check(layer.parentNode === null, 'the layer leaves the DOM')
    check(h.srcs.length > 0 && h.revoked.length > 0, 'sprite blob URLs are revoked', `${h.revoked.length} revoked`)
    check(h.win.__wisp === undefined, 'the public handle is withdrawn')
    check(h.themeListenerCount() === 0, 'the theme subscription is released', `${h.themeListenerCount()} left`)

    // destroy() twice must be a no-op, not a second teardown.
    let doubleThrow = null
    try { api.destroy() } catch (error) { doubleThrow = error }
    check(doubleThrow === null, 'destroy() is idempotent')

    /* ------------------------------- 3h. re-apply: singleton + fresh blobs -- */
    head('3h. re-apply keeps exactly one companion (HMR / duplicate row)')

    // Same module instance: the blob cache is module-scoped, so a stale cache
    // here is exactly how a re-mount served a revoked URL and drew a broken
    // image. The new instance must get URLs that are not in the revoked set.
    plugin.apply(h.ctx, {})
    const layers = h.all('wisp-layer')
    check(layers.length === 2 && layers.filter((l) => l.parentNode === h.bodyEl).length === 1,
      'exactly one companion is mounted', `${layers.filter((l) => l.parentNode === h.bodyEl).length} attached`)
    const second = h.win.__wisp
    check(second !== api && typeof second?.destroy === 'function', 'the handle points at the new instance')
    const freshSrcs = h.srcs.slice(-1)
    check(freshSrcs[0]?.startsWith('blob:') && !h.revoked.includes(freshSrcs[0]),
      'the re-mount is not handed a revoked blob URL', String(freshSrcs[0]))
    const restored = second.position
    check(restored.x === after.x && restored.y === after.y, 'the remembered position is restored on the next mount',
      `${restored.x},${restored.y}`)

    /* ------------------------------------------------- 3i. reconfigure ------ */
    head('3i. configure() merges instead of resetting')

    plugin.apply(h.ctx, { reactions: false, persist: false })
    const third = h.win.__wisp
    // Read geometry off the LIVE handle: `h.find` returns the first element with
    // that class, which belongs to an instance that was already replaced.
    const liveRoot = third.element
    const timersBefore = h.pendingTimers().length
    third.configure({ size: 2 })
    check(liveRoot.style.width === '280px' && liveRoot.style.height === '420px', 'configure() resizes her box',
      `${liveRoot.style.width} x ${liveRoot.style.height}`)
    check(h.pendingTimers().length <= timersBefore + 1, 'configure() did not resurrect the reaction poll',
      `${timersBefore} -> ${h.pendingTimers().length}`)
    third.configure({ size: 'huge', sleepAfterMs: -1 })
    check(!String(liveRoot.style.width).includes('NaN') && !String(liveRoot.style.transform).includes('NaN'),
      'a nonsense config cannot produce NaN geometry', `${liveRoot.style.width} / ${liveRoot.style.transform}`)
    third.destroy()

    /* ------------------------------------------- 3i-bis. 自己踱步 + 右键归位 */
    head('3i-bis. idle wander and the right-click trip home')

    plugin.apply(h.ctx, { reactions: false, wander: true, wanderMs: 5000, wanderRange: 200 })
    const fifth = h.win.__wisp
    const body5 = fifth.element.querySelector('.wisp-body')
    const BOX_W5 = 140 * 4
    const BOX_H5 = 210 * 4
    const centreOf = () => ({ x: fifth.position.x + BOX_W5 / 2, y: fifth.position.y + BOX_H5 / 2 })

    fifth.move(200, 200)                       // away from the corners, so any bearing can move
    h.advance(6000, 200)
    const strolled = fifth.position
    check(strolled.x !== 200 || strolled.y !== 200, 'she strolls on her own while idle',
      `200,200 -> ${strolled.x},${strolled.y}`)
    check(Math.abs(strolled.x - 200) <= 200 && Math.abs(strolled.y - 200) <= 200,
      'a stroll stays inside the configured range', `${strolled.x},${strolled.y}`)
    check(fifth.element.dataset.gliding === 'true', 'the stroll is a glide, not a teleport')
    h.advance(2000, 200)
    check(fifth.element.dataset.gliding === undefined, 'the glide class is cleared afterwards')
    check(JSON.parse(h.win.localStorage.getItem('dsh-wisp:position:v1') || '{}').x !== strolled.x,
      'a stroll does not overwrite the position the user chose', h.win.localStorage.getItem('dsh-wisp:position:v1'))

    // 右键：弹出菜单（归位只是其中一项）
    const ctxEvent = (x, y) => ({
      clientX: x, clientY: y, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
    })
    const itemEvent = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} })
    // 菜单挂在 layer 上（与气泡同一层，屏幕坐标系），不是挂在会被镜像/缩放的 root 上
    const menuHost = () => fifth.element.parentNode
    const menuOf = () => menuHost().querySelector('.wisp-menu')
    const itemsOf = () => menuHost().querySelectorAll('.wisp-menu-item')
    // 尺寸会变（菜单里就能放大缩小），所以每次都要按当前实时状态算，不能用写死常量
    const boxNow = () => ({
      w: parseInt(fifth.element.style.width, 10),
      h: parseInt(fifth.element.style.height, 10),
    })
    const rightClickOnHer = () => {
      const b = boxNow()
      const p = fifth.position
      const ev = ctxEvent(p.x + b.w / 2, p.y + b.h / 2)
      // 现在归位用的兜底尺寸也要跟着当前尺寸走
      return { ev, homeX: h.win.innerWidth - 26 - b.w, homeY: h.win.innerHeight - 46 - b.h }
    }

    const firstClick = rightClickOnHer()
    body5.dispatch('contextmenu', firstClick.ev)
    check(firstClick.ev.defaultPrevented, 'a right-click on her body is handled')
    check(menuOf() !== null, 'the right-click opens a context menu')
    check(menuOf()?.getAttribute('role') === 'menu', 'the menu carries menu semantics')
    /* 项数从皮肤数**推导**，不写死：加一套皮肤不该让测试变红（那是数据的错，不是行为的错）。
       固定部分 = 6 个动作 + 4 个开关 + 4 个角落 = 14；其余是每套皮肤一项。 */
    /* api.skins 是数组（SKIN_IDS 的拷贝），不是对象 —— 用 Object.keys 只是碰巧数对了。 */
    const skinCount = Array.isArray(api.skins) ? api.skins.length : Object.keys(api.skins ?? {}).length
    check(itemsOf().length === 14 + skinCount,
      'the menu lists fixed actions and corners plus exactly one entry per skin',
      `${itemsOf().length} items = 14 + ${skinCount} skin(s)`)
    const byText = (t) => itemsOf().filter((i) => i.textContent.includes(t))
    const heads = menuOf().querySelectorAll('.wisp-menu-head')
    check(heads.length === 3, 'the behaviour, position and skin sections each get a header', `${heads.length} headers`)
    check(heads[0].textContent === '行为' && heads[1].textContent === '位置' && heads[2].textContent === '皮肤',
      'the headers name their sections', heads.map((x) => x.textContent).join(' / '))
    /* 从 API 派生，**不写死皮肤名**。写死过「初版女仆」，改名成「素绘女仆」之后
       三条断言当场全炸，其中一条 undefined.dispatch 还把整个套件截断了。 */
    /* 既有 API 的形状是**有序数组** [{id,label}]，不是 id→label 的对象。 */
    const skinNames = api.skinLabels.map((s) => s.label)
    const plainSkinLabel = (el) => el.textContent.replace(/^[✓　]\s*/, '')
    const skinItems = itemsOf().filter((i) => skinNames.includes(plainSkinLabel(i)))
    check(skinItems.length === skinCount,
      'every shipped skin is offered',
      `${skinItems.length} 项 / ${skinCount} 套；名字表=${JSON.stringify(skinNames)}；菜单=${itemsOf().map((i) => i.textContent).join('|')}`)
    // 勾现在有三处（三个行为开关都默认开）—— 皮肤那一段必须**恰有一个**勾
    check(skinItems.filter((i) => i.textContent.startsWith('✓')).length === 1,
      'exactly one skin is ticked as current',
      skinItems.map((i) => i.textContent).join(' / '))
    check(body5.querySelectorAll('.wisp-menu').length === 0,
      'the menu lives beside her body, not inside it', 'inside it would be mirrored and scale with her')

    /* ---- 三个行为开关（原本在设置页里，那页撤掉后落到菜单） -------------- */
    const toggleItem = (label) => itemsOf().find((i) => i.textContent.replace(/^[✓　]\s*/, '') === label)
    const togglesPresent = ['自己溜达', '跟随状态', '跑完撒花'].every((l) => toggleItem(l) !== undefined)
    check(togglesPresent, 'all three behaviour toggles are in the menu',
      itemsOf().filter((i) => /溜达|跟随状态|撒花/.test(i.textContent)).map((i) => i.textContent).join(' / '))
    check(toggleItem('自己溜达').textContent.startsWith('✓'),
      'a toggle shows its current state', toggleItem('自己溜达').textContent)
    const wanderBefore = fifth.config.wander
    toggleItem('自己溜达').dispatch('click', itemEvent())
    check(fifth.config.wander === !wanderBefore, 'clicking a toggle really flips the config',
      `${wanderBefore} -> ${fifth.config.wander}`)
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    const reopened = toggleItem('自己溜达')
    check(reopened !== undefined && reopened.textContent.startsWith('　'),
      'and reopening the menu shows the new state',
      reopened ? reopened.textContent : `菜单没重开（${itemsOf().length} 项）`)
    if (reopened !== undefined) {
      reopened.dispatch('click', itemEvent())
      check(fifth.config.wander === wanderBefore, 'toggling back restores it', String(fifth.config.wander))
    }

    // 换皮肤：精灵图必须真的换掉，位置和情绪不能动。
    // 自己开菜单，不依赖上一节留下的状态 —— 隐含的跨节状态是测试脆弱性的常见来源。
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu opens for the skin checks')
    const skinBefore = fifth.skin
    const posBefore = fifth.position
    const srcBeforeSkin = h.srcs[h.srcs.length - 1]
    /* 同样不写死名字：挑一套「和当前不同」的皮肤，用它的显示名去点菜单 */
    const targetSkin = fifth.skins.find((id) => id !== skinBefore)
    const targetLabel = fifth.skinLabels.find((s) => s.id === targetSkin).label
    const targetEl = itemsOf().filter((i) => i.textContent.replace(/^[✓　]\s*/, '') === targetLabel)[0]
    check(targetEl !== undefined, 'the other skin has a menu entry', String(targetSkin))
    targetEl.dispatch('click', itemEvent())
    check(fifth.skin === targetSkin, 'choosing a skin switches to it', String(fifth.skin))
    check(fifth.skin !== skinBefore, 'and it is a different skin than before', `${skinBefore} -> ${fifth.skin}`)
    check(h.srcs[h.srcs.length - 1] !== srcBeforeSkin, 'the sprite is swapped for the new skin',
      `${String(srcBeforeSkin).slice(0, 22)} -> ${String(h.srcs[h.srcs.length - 1]).slice(0, 22)}`)
    check(fifth.position.x === posBefore.x && fifth.position.y === posBefore.y,
      'switching skins leaves her where she was', `${fifth.position.x},${fifth.position.y}`)
    check(JSON.parse(h.win.localStorage.getItem('dsh-wisp:skin:v1') || 'null')?.id === targetSkin,
      'the choice is remembered', h.win.localStorage.getItem('dsh-wisp:skin:v1'))
    check(fifth.setSkin('no-such-skin') === false && fifth.skin === targetSkin,
      'an unknown skin name is refused rather than blanking her', String(fifth.skin))
    check(fifth.configure({ skin: 'deepsea' }) && fifth.skin === 'deepsea',
      'configure({skin}) goes through the same path as the menu', String(fifth.skin))

    // 点「放大一点」—— 真改尺寸，并且菜单自己关掉
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    const menuItems = itemsOf()
    byText('放大一点')[0].dispatch('click', itemEvent())
    check(fifth.element.style.width === '630px' && fifth.element.style.height === '945px',
      'a menu action runs (zoom one step up)', `${fifth.element.style.width}x${fifth.element.style.height}`)
    check(menuOf() === null, 'choosing an item closes the menu')

    // 再右键一次，用「回到右下角」归位（此时她已经被放大了，兜底尺寸要跟着变）
    const secondClick = rightClickOnHer()
    body5.dispatch('contextmenu', secondClick.ev)
    check(menuOf() !== null, 'the menu reopens')
    byText('右下角')[0].dispatch('click', itemEvent())
    const homed = fifth.position
    check(homed.x === secondClick.homeX && homed.y === secondClick.homeY,
      'the trip-home item works at the current size', `${homed.x},${homed.y} (want ${secondClick.homeX},${secondClick.homeY})`)
    check(JSON.parse(h.win.localStorage.getItem('dsh-wisp:position:v1')).x === homed.x,
      'the remembered position follows her home')

    // 菜单的关闭时机：Esc / 点外面 / 滚轮
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu opens again for the dismissal checks')
    h.win.dispatch('keydown', { key: 'Escape' })
    check(menuOf() === null, 'Escape closes the menu')
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    h.win.dispatch('pointerdown', { clientX: 900, clientY: 100 })
    check(menuOf() === null, 'a click elsewhere closes the menu')
    /* ---- 菜单的键盘可达性 --------------------------------------------- */
    // role="menu" 而没有键盘支持，对屏幕阅读器来说比不声明更糟
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu opens for the keyboard checks')
    const kbd = () => ({
      at: h.document.activeElement,
      label: h.document.activeElement?.textContent ?? '(none)',
      zero: itemsOf().filter((i) => i.tabIndex === 0).length,
    })
    check(kbd().at !== null && kbd().at.tagName === 'BUTTON',
      'opening the menu focuses its first item', kbd().label)
    check(kbd().at?.className === 'wisp-menu-item' && kbd().label === '说句话',
      'and the focus lands on the first real action', kbd().label)
    check(kbd().zero === 1, 'exactly one item is in the tab order (roving tabindex)', `${kbd().zero}`)
    check(itemsOf()[0].getAttribute('aria-selected') === 'true',
      'the focused item is marked as selected for assistive tech')

    const firstLabel = itemsOf()[0].textContent
    const lastLabel = itemsOf()[itemsOf().length - 1].textContent
    h.win.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} })
    check(kbd().label === itemsOf()[1].textContent, 'ArrowDown moves to the next item', kbd().label)
    check(kbd().zero === 1, 'still exactly one item in the tab order', `${kbd().zero}`)
    h.win.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} })
    h.win.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} })
    check(kbd().label === lastLabel, 'ArrowUp wraps around to the last item', `${kbd().label} (last is ${lastLabel})`)
    h.win.dispatch('keydown', { key: 'Home', preventDefault() {} })
    check(kbd().label === firstLabel, 'Home jumps to the first item', kbd().label)
    h.win.dispatch('keydown', { key: 'End', preventDefault() {} })
    check(kbd().label === lastLabel, 'End jumps to the last item', `${kbd().label} (last is ${lastLabel})`)
    // 小标题只是分组标签，键盘不该停在一个按不动的东西上
    h.win.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} })
    h.win.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} })
    check(itemsOf().every((i) => i.getAttribute('role') === 'menuitem'),
      'only real actions are in the menu, headers are not focusable',
      menuOf().querySelectorAll('.wisp-menu-head').length + ' header(s) skipped')

    // 焦点项是原生 <button>：Enter / Space 的激活交给浏览器，自己再拦一次会双重触发
    const focusedNow = h.document.activeElement
    check(focusedNow?.tagName === 'BUTTON' && focusedNow.getAttribute('type') === 'button',
      'the focused item is a native button, so Enter and Space activate it natively',
      `${focusedNow?.tagName} type=${focusedNow?.getAttribute('type')}`)

    h.win.dispatch('keydown', { key: 'Escape', preventDefault() {} })
    check(menuOf() === null, 'Escape closes the menu from the keyboard')
    check(h.document.activeElement?.className === 'wisp-body',
      'and focus returns to her instead of falling into <body>',
      String(h.document.activeElement?.className ?? h.document.activeElement?.tagName))
    check(h.document.activeElement?.getAttribute('tabindex') === '0',
      'her body is focusable, which is what makes the menu reachable without a mouse',
      String(h.document.activeElement?.getAttribute('tabindex')))

    /* ---- 键盘入口：声明了 role="menu" 就得有办法用键盘打开它 ---------------- */
    const bodyKey = (key, opts = {}) => body5.dispatch('keydown', Object.assign(
      { key, preventDefault() {}, stopPropagation() {} }, opts))
    check(body5.getAttribute('tabindex') === '0', 'she is in the tab order',
      `tabindex=${body5.getAttribute('tabindex')}`)
    check(body5.getAttribute('aria-haspopup') === 'menu',
      'and she announces that activating her opens a menu', String(body5.getAttribute('aria-haspopup')))
    bodyKey('Enter')
    check(menuOf() !== null, 'Enter opens the menu from her body')
    h.win.dispatch('keydown', { key: 'Escape', preventDefault() {} })
    bodyKey(' ')
    check(menuOf() !== null, 'so does Space')
    h.win.dispatch('keydown', { key: 'Escape', preventDefault() {} })
    bodyKey('F10', { shiftKey: true })
    check(menuOf() !== null, 'and Shift+F10, the platform convention for a context menu')
    h.win.dispatch('keydown', { key: 'Escape', preventDefault() {} })
    bodyKey('a')
    check(menuOf() === null, 'an unrelated key does nothing', 'no menu on a plain letter')

    // Tab 离开 = 关掉，别把人困在菜单里
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu reopens')
    h.win.dispatch('keydown', { key: 'Tab', preventDefault() {} })
    check(menuOf() === null, 'Tab leaves the menu rather than trapping focus in it')

    // 滚轮关闭 + 关闭时必须摘掉自己的监听器（用 wheel 计数，它不是唤醒事件，
    // 不会被唤醒逻辑的增删干扰）
    const wheelsIdle = h.win.listenerCount('wheel')
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu opens for the scroll check')
    check(h.win.listenerCount('wheel') === wheelsIdle + 1, 'the menu adds its own dismissal listener')
    h.win.dispatch('wheel', {})
    check(menuOf() === null, 'scrolling closes the menu')
    check(h.win.listenerCount('wheel') === wheelsIdle, 'and removes its listener when it closes')

    // 但踱步不能在她被拖拽 / 睡着 / 忙碌时乱动
    fifth.move(300, 300)
    fifth.mood('sleep')
    h.advance(6000, 200)
    check(fifth.position.x === 300 && fifth.position.y === 300, 'no strolling while she is asleep',
      `${fifth.position.x},${fifth.position.y}`)

    /* ---- 躲起来 / 叫回来 ------------------------------------------------ */
    const menuHost5 = () => fifth.element.parentNode
    const tabOf = () => menuHost5().querySelector('.wisp-tab')
    fifth.mood('idle')
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    byText('先躲起来')[0].dispatch('click', itemEvent())
    check(fifth.hidden === true, 'the menu can hide her', String(fifth.hidden))
    check(fifth.element.dataset.hidden === 'true', 'hiding marks the root so CSS can take her out of the way')
    check(menuOf() === null, 'hiding closes the menu')
    check(tabOf() !== null, 'a mini tab is left behind rather than nothing')
    // 必须查当前实例的 layer：layerEl 是第一次挂载时的节点，3g 拆掉后已经游离，
    // 但仍然抱着它自己的旧气泡 —— 用它做断言等于在测一个已死的 DOM。
    check(menuHost5().querySelectorAll('.wisp-say').length === 0,
      'hiding takes the speech bubble with her', 'the bubble lives in the layer, not in the root')
    const thumb = tabOf().querySelectorAll('img')
    check(thumb.length === 1, 'the tab carries a thumbnail', `${thumb.length} img`)
    check(thumb[0]?.className === 'wisp-tab-thumb', 'the thumbnail is addressable by class',
      String(thumb[0]?.className))
    check(String(thumb[0].getAttribute('src')).indexOf('blob:') === 0,
      'the thumbnail goes through the blob path like every sprite',
      String(thumb[0].getAttribute('src')).slice(0, 22))
    check(JSON.parse(h.win.localStorage.getItem('dsh-wisp:hidden:v1') || 'null')?.hidden === true,
      'the hidden state is remembered', h.win.localStorage.getItem('dsh-wisp:hidden:v1'))

    // 躲着的时候她不该在幕后继续溜达
    const awayPos = fifth.position
    h.advance(9000, 300)
    check(fifth.position.x === awayPos.x && fifth.position.y === awayPos.y,
      'no strolling while she is away', `${fifth.position.x},${fifth.position.y}`)

    // 点迷你按钮回来
    tabOf().dispatch('click', itemEvent())
    check(fifth.hidden === false, 'the tab brings her back', String(fifth.hidden))
    check(fifth.element.dataset.hidden === 'false', 'the root is visible again')
    check(tabOf() === null, 'the tab is removed once she is back')

    // 藏着的状态要能跨挂载保留，否则刷新后她会在你以为藏起来时突然出现
    fifth.hide()
    fifth.destroy()
    plugin.apply(h.ctx, { reactions: false, wander: false })
    const resumed = h.win.__wisp
    check(resumed.hidden === true, 'a hidden state survives a remount', String(resumed.hidden))
    check(resumed.element.parentNode.querySelector('.wisp-tab') !== null,
      'and the mini tab comes back with it', 'a hidden companion with no way back is a trap')
    resumed.show()
    resumed.destroy()
    fifth.destroy()

    /* ------------------------------- 3i-quinquies. 尺寸记忆 / 角落 / 首次提示 */
    head('3i-quinquies. remembered size, four corners, and the one-time hint')

    plugin.apply(h.ctx, { reactions: false, wander: false, size: 4 })
    const sized = h.win.__wisp
    check(sized.element.style.width === '560px', 'a fresh mount uses the configured size', sized.element.style.width)
    sized.configure({ size: 6 })
    check(sized.element.style.width === '840px', 'configure() resizes her', sized.element.style.width)
    const prefsRaw = h.win.localStorage.getItem('dsh-wisp:prefs:v1')
    check(JSON.parse(prefsRaw || 'null')?.size === 6, 'the size lands in storage', String(prefsRaw))
    sized.destroy()

    // 重挂载：菜单里调过的尺寸必须活过刷新，否则用户每次开页面都要重调。
    // 注意这里刻意【不】显式传 size —— 传了就等于项目钉死了尺寸，记忆不该生效。
    plugin.apply(h.ctx, { reactions: false, wander: false })
    const remembered = h.win.__wisp
    check(remembered.element.style.width === '840px',
      'the remembered size survives a remount when the config does not pin one',
      `${remembered.element.style.width}, default would be 560px`)
    remembered.configure({ size: 2 })
    check(remembered.element.style.width === '280px', 'and it can still be changed', remembered.element.style.width)
    remembered.destroy()

    // 但配置里显式写死的 size 是项目级设定，比一次临时缩放更权威
    plugin.apply(h.ctx, { reactions: false, wander: false, size: 3 })
    const pinned = h.win.__wisp
    check(pinned.element.style.width === '420px',
      'an explicit config size beats the remembered one', `${pinned.element.style.width}, remembered 280px`)

    // 四个角落
    const bodyOf = (inst) => inst.element.querySelector('.wisp-body')
    const boxOf = (inst) => ({
      w: parseInt(inst.element.style.width, 10),
      h: parseInt(inst.element.style.height, 10),
    })
    const openMenuOn = (inst) => {
      const b = boxOf(inst)
      const p = inst.position
      bodyOf(inst).dispatch('contextmenu', ctxEvent(p.x + b.w / 2, p.y + b.h / 2))
    }
    const pickExact = (inst, text) => {
      const found = inst.element.parentNode.querySelectorAll('.wisp-menu-item').filter((i) => i.textContent === text)
      if (found.length !== 1) return false
      found[0].dispatch('click', itemEvent())
      return true
    }
    // 四个角落。期望值按【当前】尺寸算 —— 写死尺寸的话，一旦尺寸变了断言会
    // 指着正确的实现说它错。
    const cur = boxOf(pinned)
    const EXPECT = {
      '左上角': { x: 26, y: 46 },
      '左下角': { x: 26, y: h.win.innerHeight - 46 - cur.h },
      '右上角': { x: h.win.innerWidth - 26 - cur.w, y: 46 },
      '右下角': { x: h.win.innerWidth - 26 - cur.w, y: h.win.innerHeight - 46 - cur.h },
    }
    for (const [label, want] of Object.entries(EXPECT)) {
      openMenuOn(pinned)
      const hit = pickExact(pinned, label)
      check(hit && pinned.position.x === want.x && pinned.position.y === want.y,
        `the ${label} item puts her there`, `${pinned.position.x},${pinned.position.y} (want ${want.x},${want.y})`)
    }
    pinned.destroy()

    // 首次见面提一句右键；第二次不该再念叨。
    // 新 harness 必须把全局窗口切过去（active = fresh）并重新求值，否则挂载会落到
    // 上一个 harness 上 —— 用完还要还原 active，不然后面的 section 会查错窗口。
    const fresh = createHarness({ timer: true, composerText: null })
    const prevActive = active
    active = fresh
    fresh.evaluate(clientSrc)
    const freshPlugin = fresh.module().default
    freshPlugin.apply(fresh.ctx, { reactions: false, wander: false })
    const firstEver = fresh.win.__wisp
    check(typeof firstEver?.destroy === 'function', 'a second harness mounts its own instance',
      Object.keys(firstEver ?? {}).slice(0, 3).join(','))
    fresh.advance(1000, 100)
    const greeted = fresh.all('wisp-say').length
    fresh.advance(4200, 200)
    check(fresh.all('wisp-say').length > greeted, 'the first ever mount mentions the right-click menu',
      `${fresh.all('wisp-say').length - greeted} extra bubble(s)`)
    check(fresh.win.localStorage.getItem('dsh-wisp:hint:v1') !== null, 'and records that it did',
      String(fresh.win.localStorage.getItem('dsh-wisp:hint:v1')))
    firstEver.destroy()
    const afterFirstHint = fresh.all('wisp-say').length
    freshPlugin.apply(fresh.ctx, { reactions: false, wander: false })
    fresh.advance(5200, 200)
    check(fresh.all('wisp-say').length === afterFirstHint + 1,
      'a later mount only greets, it does not hint again',
      `${fresh.all('wisp-say').length - afterFirstHint} bubble(s), expected exactly the hello`)
    fresh.win.__wisp.destroy()
    active = prevActive

    /* ------------------------------------------- 3i-ter. 关掉踱步就不动 ---- */
    plugin.apply(h.ctx, { reactions: false, wander: false })
    const sixth = h.win.__wisp
    sixth.move(300, 300)
    h.advance(3000, 200)
    check(sixth.position.x === 300 && sixth.position.y === 300, 'wander: false keeps her still',
      `${sixth.position.x},${sixth.position.y}`)
    sixth.destroy()

    /* ------------------------------ 3j. storage that throws (opaque origin) - */
    head('3j. a page without usable storage still works')

    for (const mode of ['throwing', 'absent']) {
      const hs = createHarness({ timer: true, storage: mode })
      active = hs
      let error = null
      try {
        hs.evaluate(clientSrc)
        const mod = hs.module()
        mod.apply(hs.ctx, {})
        hs.advance(100)
        const body = hs.find('wisp-body')
        body?.dispatch('pointerdown', { button: 0, clientX: 900, clientY: 700, preventDefault() {}, stopPropagation() {} })
        hs.win.dispatch('pointermove', { clientX: 400, clientY: 300 })
        hs.win.dispatch('pointerup', {})
        const handle = hs.win.__wisp
        handle.destroy()
      } catch (e) { error = e }
      check(error === null, `mounts and tears down with storage ${mode}`, error ? String(error.message) : '')
    }

    /* --------------------------------- 3k. the rAF fallback (no timer svc) -- */
    head('3k. requestAnimationFrame fallback when the timer service is absent')

    const hf = createHarness({ timer: false, composerText: null })
    active = hf
    hf.evaluate(clientSrc)
    const modF = hf.module()
    modF.apply(hf.ctx, { reactions: false, chatterMs: 0, sleepAfterMs: 5000, wander: false })
    const apiF = hf.win.__wisp
    const rootF = apiF.element
    check(apiF?.clock === 'animation-frame', 'falls back to the frame clock', String(apiF?.clock))
    check(hf.frames.length > 0, 'the fallback arms a frame while work is pending')
    hf.advance(6000, 50)
    check(rootF.dataset.mood === 'sleep', 'the fallback still sleeps on schedule', String(rootF.dataset.mood))
    // Long enough that the bubble job the sleep line may have armed is gone too.
    hf.advance(8000, 50)
    check(hf.frames.length === 0, 'the fallback stops the frame loop once nothing is pending',
      `${hf.frames.length} frame(s) armed`)
    apiF.destroy()
    check(hf.frames.length === 0, 'teardown leaves no armed frame', `${hf.frames.length} frame(s) armed`)

    /* ------------------------------------------------- 3l. 长时间运行的泄漏 */
    head('3l. soak: nothing accumulates across hundreds of interactions')

    /* 其余测试都是"一次性"的：挂载、动几下、拆掉。没有一条验证过**反复**开关菜单、反复换皮肤、
       反复进出状态之后，定时器 / 监听器 / DOM 节点会不会累积。虚拟时钟让这件事很便宜。 */
    const soak = createHarness({ timer: true, composerText: '' })
    const keepSoak = active
    active = soak
    soak.evaluate(clientSrc)
    const soakPlugin = soak.module().default
    soakPlugin.apply(soak.ctx, { wander: true, wanderMs: 5000, reactions: true, celebrate: false })
    const soakApi = soak.win.__wisp
    const soakBody = soakApi.element.querySelector('.wisp-body')
    soak.advance(2000, 100)

    const EVENT_TYPES = ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'wheel', 'resize', 'contextmenu']
    const domCounts = () => ({
      menu: soakApi.element.parentNode.querySelectorAll('.wisp-menu').length,
      tab: soakApi.element.parentNode.querySelectorAll('.wisp-tab').length,
      say: soakApi.element.parentNode.querySelectorAll('.wisp-say').length,
      img: soakApi.element.querySelectorAll('.wisp-img').length,
    })
    const baseline = {
      timers: soak.pendingTimers().length,
      listeners: Object.fromEntries(EVENT_TYPES.map((t) => [t, soak.win.listenerCount(t)])),
    }

    const CYCLES = 120
    for (let i = 0; i < CYCLES; i++) {
      // 菜单：开 → 方向键走一遍 → Esc
      const centre = { clientX: soakApi.position.x + 280, clientY: soakApi.position.y + 420 }
      soakBody.dispatch('contextmenu', { ...centre, preventDefault() {}, stopPropagation() {} })
      soak.win.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} })
      soak.win.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} })
      soak.win.dispatch('keydown', { key: 'Escape', preventDefault() {} })
      // 情绪与气泡
      soakApi.mood(i % 2 === 0 ? 'happy' : 'sleep')
      soakApi.say('soak ' + i)
      // 皮肤来回换：blob URL 必须复用，不能每轮新建
      soakApi.setSkin(i % 2 === 0 ? 'classic' : 'deepsea')
      // 躲起来再叫回来（每隔几轮，别每轮都动）
      if (i % 7 === 0) { soakApi.hide(); soak.advance(60, 30); soakApi.show() }
      // 拖一下
      soakBody.dispatch('pointerdown', { button: 0, clientX: centre.clientX, clientY: centre.clientY, preventDefault() {}, stopPropagation() {} })
      soak.win.dispatch('pointermove', { clientX: centre.clientX + 30, clientY: centre.clientY + 10 })
      soak.win.dispatch('pointerup', {})
      soak.advance(1500, 150)
    }

    const grown = {}
    for (const [type, before] of Object.entries(baseline.listeners)) {
      const now = soak.win.listenerCount(type)
      if (now !== before) grown[type] = `${before} -> ${now}`
    }
    check(Object.keys(grown).length === 0,
      `window listeners are unchanged after ${CYCLES} interaction cycles`,
      Object.keys(grown).length ? JSON.stringify(grown) : 'every type back to its baseline')
    // 基线里含 hello / 首次提示 / 精灵预热这些**一次性**任务，它们正常结束会让计数下降；
    // 这里要钉住的是"不增长"，不是"相等"。
    check(soak.pendingTimers().length <= baseline.timers,
      'and no timer accumulated', `${baseline.timers} -> ${soak.pendingTimers().length}（一次性任务结束后会下降）`)

    const counts = domCounts()
    check(counts.menu === 0 && counts.tab === 0,
      'transient UI leaves nothing behind', `menu=${counts.menu} tab=${counts.tab}`)
    check(counts.say <= 1, 'at most one speech bubble exists', `${counts.say}`)
    check(counts.img <= 2, 'at most the two cross-fade layers exist', `${counts.img}`)

    /* 皮肤来回换 120 次，如果 blob URL 每轮都新建，这里会是 120+ —— 缓存命中应该是常数 */
    check(soak.urLs.length <= 12,
      'switching skins reuses cached blob URLs instead of minting new ones',
      `${soak.urLs.length} object URLs ever created across ${Array.isArray(api.skins) ? api.skins.length : 0} skins and ${CYCLES} switches`)

    soakApi.destroy()
    check(soak.pendingTimers().length === 0 && soak.revoked.length === soak.urLs.length,
      'teardown still releases everything after the soak',
      `timers=${soak.pendingTimers().length}, revoked ${soak.revoked.length}/${soak.urLs.length}`)
    active = keepSoak
  } catch (error) {
    bad('browser half executes', `${error.constructor.name}: ${error.message}`)
    console.log(error.stack)
  } finally {
    active = null
    for (const [key, value] of Object.entries(savedGlobals)) globalThis[key] = value
  }
}

/* ================================================== 3z. generation audit ==== */
head('3z. every shipped sprite traces back to a text-only call')

/* 这条把「素材是纯文生图来的、且事后没被改过」变成常驻保证：
   链校验 + 重算入包文件哈希 + 代理登记表里不得出现 edit_image（图生图）。
   注意它证明的范围：代理那条（工具名）是硬证据；自我声明的参数只覆盖有 declare 的那些。 */
const audit = verifyAudit(here)
check(audit.problems.length === 0 && audit.assets.length > 0,
  'the generation audit chain verifies and covers shipped sprites',
  audit.entries + ' 条记录 / 覆盖 ' + audit.assets.length + ' 个素材' +
  (audit.problems.length ? '；问题：' + audit.problems.slice(0, 3).join(' | ') : ''))
check(audit.img2img.length === 0,
  'no image-to-image call appears in the audit',
  audit.img2img.length ? audit.img2img.slice(0, 3).map((e) => e.name).join(', ')
    : audit.assets.length + ' 个素材全部来自 generate_image / batch_generate_images')

/* ======================================================= 4. packaging ====== */

head('4. packaging consistency')

const patchPath = pkg.dsh?.bundle?.patch ? resolve(here, pkg.dsh.bundle.patch) : null
if (patchPath && existsSync(patchPath)) {
  ok('dsh.bundle.patch exists', pkg.dsh.bundle.patch)
  const yml = readFileSync(patchPath, 'utf8')
  const nameMatch = yml.match(/^\s*name:\s*["']?([^"'\s]+)["']?\s*$/m)
  const entry = nameMatch ? nameMatch[1] : null
  if (entry === pkg.name) ok('patch entry points at the host half', entry)
  else bad('patch entry points at the host half', `patch says '${entry}', should be '${pkg.name}' (never '<pkg>/client')`)
} else bad('dsh.bundle.patch exists')

if (!pkg.dsh?.client?.inject && !pkg.dsh?.client?.shared) ok('no inject/shared declarations')
else bad('inject/shared declared', 'a local-path install cannot satisfy them')

/* ---- 5. shipping readiness: sprites inlined, attribution present ---- */

head('5. redistribution readiness')

/* 包里的文档不能指向包外：别人 `npm i` 之后，绝对路径与开发机的 `_perf/` 都是死引用。
   这条正好能抓住"README 说探针可复现、而探针在包外"这类错误。 */
if (existsSync(join(here, 'README.md'))) {
  const docs = ['README.md', 'NOTICE.md', 'tools/CHARACTER-PROMPT.md']
    .filter((f) => existsSync(join(here, f)))
    .map((f) => readFileSync(join(here, f), 'utf8'))
    .join('\n')
  // 注意：正则里要匹配**一个**反斜杠，写多了就成了假通过（第一次就写错了，README 里明明有
  // `F:\...` 却报"没有包外引用"）。
  const outside = [...new Set([...docs.matchAll(/[A-Z]:\\[^\s`)|，。]+|_perf[/\\][^\s`)|，。]*/g)].map((m) => m[0]))]
  check(outside.length === 0, 'no shipped doc points at files outside the package',
    outside.length ? outside.slice(0, 4).join(' | ') : 'every referenced path is inside the package')

  /* 文档里提到的每个 tools/* 都必须在 files[] 里，否则收到包的人找不到它 */
  const mentioned = [...new Set([...docs.matchAll(/tools\/([A-Za-z0-9_.-]+)/g)].map((m) => 'tools/' + m[1]))]
  const declared = new Set(JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).files ?? [])
  const undeclared = mentioned.filter((m) => !declared.has(m))
  check(undeclared.length === 0, 'every tool the docs mention actually ships',
    undeclared.length ? undeclared.join(' | ') : `${mentioned.length} tool(s) referenced, all in files[]`)
}

if (clientSrc !== null) {
  /* 每一套皮肤都必须凑齐四个情绪。只数 data: URI 的总数是不够的 —— 总数对上
     也可能是某一套缺一张、另一套多一张，而缺一张的皮肤切过去就是空白。 */
  const table = clientSrc.match(/const SPRITES = (\{[\s\S]*?\n {4}\})/)
  let skinReport = 'table not found'
  let skinsOk = false
  if (table) {
    try {
      const value = new Function(`return ${table[1]}`)()
      const skins = Object.keys(value)
      const missing = []
      for (const skin of skins) {
        /* 八个情绪：加了 eat（干饭）之后这里也要跟上 —— 漏一个就会让"每套皮肤都齐"变成假绿。 */
        for (const mood of ['idle', 'happy', 'sleepy', 'work', 'attn', 'poked', 'proud', 'eat']) {
          const uri = value[skin]?.[mood]
          if (typeof uri !== 'string' || uri.indexOf('data:image/') !== 0) missing.push(`${skin}/${mood}`)
        }
      }
      skinsOk = skins.length > 0 && missing.length === 0
      skinReport = `${skins.length} skin(s): ${skins.join(', ')}${missing.length ? ' | missing ' + missing.join(', ') : ''}`
    } catch (error) {
      skinReport = `table does not evaluate: ${error.message}`
    }
  }
  if (skinsOk) ok('every skin carries all eight moods as data URIs', skinReport)
  else bad('every skin carries all eight moods as data URIs', skinReport)

  if (clientSrc.includes('__SPRITES__')) bad('no leftover build placeholder', 'run `node build.mjs`')
  else ok('no leftover build placeholder')

  // The bundle must be self-contained: a share carries no asset paths.
  const refsAssetFile = /['"][^'"]*\.(?:webp|png)['"]/.test(clientSrc)
  if (!refsAssetFile) ok('bundle references no external image files')
  else bad('bundle references no external image files', 'a share would break on missing assets')

  const stamped = clientSrc.match(/const VERSION = '([^']+)'/)
  if (stamped && stamped[1] === pkg.version) ok('the bundle stamps the package version', stamped[1])
  else bad('the bundle stamps the package version', `bundle ${stamped?.[1] ?? 'none'} vs package ${pkg.version}`)
}

if (existsSync(join(here, 'NOTICE.md'))) ok('NOTICE.md present', 'character provenance + image licence')
else bad('NOTICE.md present', 'required when redistributing the character images')

const notice = existsSync(join(here, 'NOTICE.md')) ? readFileSync(join(here, 'NOTICE.md'), 'utf8') : ''
if (/非官方|unofficial|not affiliated/i.test(notice)) ok('NOTICE states it is unofficial')
else bad('NOTICE states it is unofficial')

if (/CC BY-NC-SA/i.test(notice)) ok('NOTICE separates the image licence from MIT')
else bad('NOTICE separates the image licence from MIT')

if (pkg.private === true) bad('package is publishable', 'remove "private": true to share it')
else ok('package is publishable')

if (pkg.dsh?.client?.platform) ok('dsh.client.platform declared', pkg.dsh.client.platform)
else bad('dsh.client.platform declared')

const deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.peerDependencies ?? {}).length
if (deps === 0) ok('no dependencies at all')
else bad(`${deps} dependency declaration(s)`)

// Every path the manifest promises must exist, or an install ships a hole.
const declaredFiles = Array.isArray(pkg.files) ? pkg.files : []
const missingFiles = declaredFiles.filter((rel) => !existsSync(join(here, rel)))
if (declaredFiles.length === 0) bad('package.json files[] declares the shipped set')
else if (missingFiles.length === 0) ok('every path in files[] exists', `${declaredFiles.length} entries`)
else bad('every path in files[] exists', `missing: ${missingFiles.join(', ')}`)

/* ============================================================= done ====== */

head(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
console.log(failures === 0
  ? '  Both halves match their contracts. A remaining failure would be outside\n  this package: restart the app to rebuild its loader graph.\n'
  : '  Fix the FAIL lines above before reloading the app.\n')
process.exit(failures === 0 ? 0 : 1)
