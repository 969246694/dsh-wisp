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

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { verifyAudit } from './tools/audit-log.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = join(here, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

/* 帧动画素材（v1.47.0）。判据是**磁盘上实际有什么**，不是"应该有什么"：
   一条都没有（还没生成）与八条都在（生成完了）都是合法状态，**只到一半**不是 ——
   半套素材在页面上表现为"她有些状态不动"，而那和"没有素材"长得一模一样。
   投递机制（motion 清单 + 宿主路由 + 客户端 URL 解析）在没有素材时照样成立：
   它是一条"有文件就发、没有就静默降级"的路。

   v1.49.0 起有两批八条（泳装 / 原版）。**默认皮肤是 canon**（v1.48.2），
   所以"挂载时就有动图"那一段验的是原版那八条。 */
const MOTION_DIR = join(here, 'assets', 'motion')
const shippedClips = (prefix) => (existsSync(MOTION_DIR)
  ? readdirSync(MOTION_DIR).filter((f) => new RegExp(`^${prefix}[a-z]+\\.webp$`).test(f)).sort()
  : [])
const SHIPPED_SWIM = shippedClips('swim_')
const SHIPPED_CANON = shippedClips('canon_')

const hostPath = resolve(here, pkg.main ?? 'lib/index.js')
const clientRel = pkg.exports?.['./client']?.default
const clientPath = clientRel ? resolve(here, clientRel) : null

let failures = 0
let checks = 0
const ok = (l, d = '') => { checks++; console.log(`  PASS  ${l}${d ? '  — ' + d : ''}`) }
const bad = (l, d = '') => { checks++; failures++; console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`) }
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
    /* 中文池现在叫 LINES_ZH（英文是覆盖层，最后合并成 LINES）。
       这里读**中文池**：测试验的是"她说的那句话确实来自对应池子"，
       而中文字面量永远存在，不受语言环境影响。 */
    const match = clientSrc.match(/const LINES_ZH = (\{[\s\S]*?\n {4}\})/)
      || clientSrc.match(/const LINES = (\{[\s\S]*?\n {4}\})/)
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
/* 替身 URL 必须**同时**是那个构造函数：v1.47.0 起客户端的动图源是
   `new URL('wisp-motion/<文件>', document.baseURI)` —— 只给 createObjectURL 的
   假 URL 会让这一行当场抛错，而那是"替身不像真页面"，不是插件的问题。 */
class FakeURL extends URL {
  static createObjectURL() { const url = `blob:dsh-app/verify-${++urlSeq}`; if (active) active.urLs.push(url); return url }
  static revokeObjectURL(url) { if (active) active.revoked.push(url) }
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
      /* focus() / blur() 必须**真的派发事件**：真实 DOM 里 focus 事件是会响的，
         而插件正靠它把"这一次焦点是谁给的"翻译成画面（键盘 -> 贴剪影的辉光；
         鼠标 -> 什么都不画）。替身不发事件时，这条产品行为在预检里永远测不出来 ——
         而它出错的样子正是用户报的"有时会出现素材的矩形边界线"。
         顺序照真实语义：activeElement 先更新，所以 focus 事件里读到的已经是新元素。 */
      focus() {
        if (activeEl === el) return
        const previous = activeEl
        activeEl = el
        if (previous) previous.dispatch('blur', { type: 'blur', target: previous })
        el.dispatch('focus', { type: 'focus', target: el })
      },
      blur() {
        if (activeEl !== el) return
        activeEl = null
        el.dispatch('blur', { type: 'blur', target: el })
      },
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
          /* 同 matchAll：类选择器按类名列表匹配，不是精确相等 */
      return this.descendants().filter((d) => String(d.className || '').split(/\s+/).includes(cls))
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
      /* 蒙版的留白默认恒为 25%（所有形状断言都按它写）。需要"换一张留白不同的图"这个场景
       的 section 用 options.maskMargins 轮换 —— 真实的素材每张留白都不一样（v1.49.2）。 */
    const MASK_MARGINS = options.maskMargins || [0.25]
    el.getContext = () => ({
        drawImage() {},
        getImageData(x, y, w, h) {
          const margin = MASK_MARGINS[maskBuilds++ % MASK_MARGINS.length]
          const data = new Uint8ClampedArray(w * h * 4)
          for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
              const opaque = px >= w * margin && px < w * (1 - margin)
              data[(py * w + px) * 4 + 3] = opaque ? 255 : 0
            }
          }
          return { data }
        },
      })
    }
    if (String(tag).toLowerCase() === 'video') {
      /* <video> 的替身（v1.45.0）。v1.46.1 起产品里**一个 <video> 都不该建**
         （帧动画换成了动图 <img>），所以这个替身现在是个哨兵：谁把媒体通道加回来，
         它就会开始记录 play()/pause()，而 3f-ter 里那条"一次都没有"立刻会红。
         真实浏览器里 play()/pause() 是**方法**、currentTime 是**可写属性**，
         替身缺了它们，那条断言就只能靠读源码文本 —— 读文本证明不了行为。 */
      el.currentTime = 0
      el.paused = true
      el.play = () => {
        el.paused = false
        if (active) active.videoPlays.push(el)
        return Promise.resolve()
      }
      el.pause = () => {
        el.paused = true
        if (active) active.videoPauses.push(el)
      }
      el.load = () => {}
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
  /* 每建一张 alpha 蒙版就 +1：canvas 替身用它轮换留白（v1.49.2）。 */
  let maskBuilds = 0
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

  const documentListeners = Object.create(null)
  const documentShim = {
    body: bodyEl,
    head: headEl,
    /* 动图源的基准（v1.47.0）：客户端只写 `wisp-motion/<文件>`，其它一律由页面
       自己的 base 带出来。替身给一个真实的 Web 载体地址，而不是
       `dsh-app://app/` —— 后者没有 HTTP 服务器，正是"路由不在"的那一档。 */
    baseURI: options.baseURI ?? 'http://127.0.0.1:19387/',
    get activeElement() { return activeEl },
    /* 真 document 有事件接口，替身也得有 —— 否则"插件是否正确处理文档级 Esc"根本测不到，
       而且少一个方法会让插件在替身里整个起不来（这坑踩过一次）。 */
    addEventListener(type, fn) { (documentListeners[type] ??= []).push(fn) },
    removeEventListener(type, fn) {
      const list = documentListeners[type]
      if (!list) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    dispatch(type, event) { for (const fn of [...(documentListeners[type] ?? [])]) fn(event ?? {}) },
    get documentListenerCount() { return Object.values(documentListeners).reduce((n, l) => n + l.length, 0) },
    documentListenerCountOf(type) { return (documentListeners[type] ?? []).length },
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
    /* prefers-reduced-motion：CSS 那边由媒体查询负责，但**姿势是 JS 写进去的**，
       媒体查询管不到它 —— 所以"系统要求别动时她真的不动"必须能被问一次。
       替身缺 matchMedia 时那条只能靠读 CSS 文本，而读文本证明不了行为。 */
    matchMedia: (query) => ({
      media: String(query),
      matches: options.reducedMotion === true && String(query).indexOf('reduce') >= 0,
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

  /* 由**别的包**注册的客户端服务（v1.46.0）：余额那条路要的 remote.account 就是这种。
     默认空表 —— 一条通道都没有的情形才测得到。 */
  const extraServices = options.services && typeof options.services === 'object' ? options.services : {}
  const ctx = {
    get: (name) => {
      if (name === 'timer') return timerService
      if (name === 'styles') return { insert: (css) => { styleInserts.push(css); return () => { styleInserts.pop() } } }
      if (name === 'theme') return { getTheme: () => themeSnapshot }
      if (Object.prototype.hasOwnProperty.call(extraServices, name)) return extraServices[name]
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
    /* <video> 的播放记录（v1.45.0）。v1.46.1 起它的用途反过来：断言"这一层一次
       play()/pause() 都没有" —— 图片路径上不存在媒体通道，也不该有人偷偷搭回来。 */
    videoPlays: [], videoPauses: [],
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
    /* 按**类名列表**匹配，和 matchAll 一致：真实 DOM 的 .a 选择器本来就命中有多个类的元素，
       精确相等会让 'wisp-menu-item wisp-menu-row' 这类行在替身里变成不存在（这个坑踩过两次）。 */
    find: (className) => created.find((e) => String(e.className || '').split(/\s+/).includes(className)) ?? null,
    all: (className) => created.filter((e) => String(e.className || '').split(/\s+/).includes(className)),
    /** Evaluate lib/client.js the way the shell does, with every trap armed. */
    evaluate(src) {
      const traps = {}
      for (const name of TRAPPED) traps[name] = () => { throw new Error(`${name} is not available in a dynamic client half`) }
      // `host` 是 shell 注入给客户端半包的座位（是**能力**，不是 fetch 那种陷阱）。
      // 默认不给 —— 这样"没有 host 时降级"才测得到；要测检查更新就传 hostCall。
      const hostSeat = typeof options.hostCall === 'function' ? { call: options.hostCall } : undefined
      // eslint-disable-next-line no-new-func
      /* 追加 sourceURL：new Function 里的代码否则在堆栈里是 anonymous，定位不到行。
         navigator 必须显式注入：浏览器里裸 navigator === window.navigator，而 **Node 21+
         也有全局 navigator**（navigator.language = 系统语言）。不注入的话，客户端读到的是
         Node 的 —— 中文机器上绿、英文 runner 上红（真踩过：Node 22 上 24 项台词池检查全红，
         Node 20 上因为那个全局还不存在而"恰好"绿）。 */
      new Function('window', 'document', 'host', 'navigator', ...TRAPPED, src + '\n//# sourceURL=wisp-client-half.js')(
        win, documentShim, hostSeat, win.navigator ?? {}, ...TRAPPED.map((name) => traps[name]),
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

/* ================================ 1c. the host half serves the frame clips == */

head('1c. the host half claims /wisp-motion/ on the platform HTTP carrier (v1.47.0)')

/* 这一节查的是**接线**，不是 handler 本身（handler 在 4b 里被真字节驱动过一遍）。
   为什么单独查：`ctx.inject(['webServer'], cb)` 是唯一一处"把插件的路由挂到平台载体上"
   的调用 —— 名字、kind、path 写错了都不会有任何报错，页面上只表现为"她怎么不动了"
   （静默降级）。用假 ctx 把这条链走一遍，就不必等到重启应用才发现。 */
{
  const mod = await import(pathToFileURL(hostPath).href + '?probe=motion-wiring')
  const registered = []
  const effects = []
  let injected = null
  const webCtx = {
    webServer: { register: (route) => { registered.push(route); return () => {} } },
    effect: (fn, label) => { effects.push({ label, dispose: fn() }) },
  }
  const ctx = {
    inject: (deps, cb) => { injected = deps; cb(webCtx) },
    effect: () => () => {},
  }
  let threw = null
  try { mod.apply(ctx, {}) } catch (error) { threw = error }
  check(threw === null && Array.isArray(injected) && injected.includes('webServer') && registered.length === 1,
    'apply() claims its route through ctx.inject([\'webServer\']) — exactly one registration',
    `inject=${JSON.stringify(injected)} routes=${registered.length}${threw ? ` threw=${threw.message}` : ''}`)
  check(registered[0]?.kind === 'prefix' && registered[0]?.path === mod.MOTION_ROUTE_PATH
    && typeof registered[0]?.handler === 'function',
    'and it is a prefix route at the path the client half asks for, with a real handler',
    `${String(registered[0]?.kind)} ${String(registered[0]?.path)} handler=${typeof registered[0]?.handler}`)
  /* ---- 注册键必须**真的能被载体匹配上**（v1.48.1）------------------------------
     1.47.0/1.47.1 的 404 不是"没注册"，是注册了却永远匹配不到：载体
     （@deepseek-ai/dsh-host-webserver 的 match()）判的是
        pathname === prefix || pathname.startsWith(`${prefix}/`)
     —— 斜杠由**载体**补。所以注册 '/wisp-motion/' 只匹配 '/wisp-motion' 与
     '/wisp-motion//…'，而页面要的 '/wisp-motion/idle.webp' 一条都匹配不上：
     fiber 拿到了路由、dispose 也正常，请求却全部落到平台自己的 404 兜底。
     这条断言把那条规则原样跑一遍：正确的键必须匹配，带尾斜杠的那种必须不匹配。 */
  const carrierMatches = (prefix, pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  const askedUrl = `${mod.MOTION_PATH}idle.webp`
  const askedDiag = `${mod.MOTION_ROUTE_PATH}/${mod.MOTION_DIAG_NAME}`
  check(carrierMatches(String(registered[0]?.path), askedUrl) === true
    && carrierMatches(String(registered[0]?.path), askedDiag) === true
    && carrierMatches(mod.MOTION_PATH, askedUrl) === false
    && carrierMatches(mod.MOTION_PATH, askedDiag) === false,
    'the registered key is the one the carrier’s prefix rule actually matches (the trailing-slash spelling is the 1.47.x bug, pinned here)',
    `registered ${String(registered[0]?.path)} → ${askedUrl}=${carrierMatches(String(registered[0]?.path), askedUrl)} · `
    + `trailing-slash ${mod.MOTION_PATH} → ${askedUrl}=${carrierMatches(mod.MOTION_PATH, askedUrl)}`)
  check(typeof mod.MOTION_DIAG_NAME === 'string' && carrierMatches(String(registered[0]?.path), askedDiag)
    && mod.motionFile(mod.MOTION_DIAG_NAME) === null,
    'the read-only diagnostic lives under the same prefix, and its name can never be served as a clip',
    `${askedDiag} · motionFile("${mod.MOTION_DIAG_NAME}")=${String(mod.motionFile(mod.MOTION_DIAG_NAME))}`)
  check(effects.length === 1 && /wisp/i.test(String(effects[0]?.label ?? '')),
    'registered as an OWNED effect, so disabling the package takes the route down with it',
    String(effects[0]?.label ?? '(no effect)'))
  /* 载体没有 webServer（Electron 没有 HTTP 服务器）不是加载失败 —— 这条路是**可选**的，
     少一条路由的画面就是静态立绘。两条都要真的试：一个空的 inject 回调、一个连
     ctx.inject 都没有的 ctx（更老的宿主）。 */
  let silent = null
  let noInject = null
  try { silent = mod.registerMotionRoute({ inject: (deps, cb) => cb({}) }) } catch (error) { silent = { threw: String(error.message) } }
  try { noInject = mod.registerMotionRoute({}) } catch (error) { noInject = { threw: String(error.message) } }
  check(silent?.registered === true && !('threw' in (silent ?? {}))
    && noInject?.registered === false && typeof noInject?.why === 'string',
    'and a carrier with no webServer (or no ctx.inject at all) degrades to "no route", never to a load failure',
    `empty-carrier=${JSON.stringify(silent)} no-inject=${JSON.stringify(noInject)}`)
}

/* ========================= 1d. the runtime reader IS the platform fs service == */

head('1d. the runtime reader reads through the platform fs service, never a Node module (v1.48.1)')

/* 宿主半包在真壳里读素材走的必须是**服务**：方法签名是从活的 Service 注册表
   （cordis_inspect_query → Host Service.listService，服务 fs）抄下来的，不是猜的：
     fs.resolve(path, opts?)            -> Promise<FsTarget>
     fs.contains(parent, child)         -> boolean
     fs.stat(target, signal?)           -> Promise<FsInfo | undefined>
     fs.readBytes(target, signal, cap)  -> Promise<Uint8Array>
   这一节用一个**记账的假 fs 服务**把这条链整个驱动一遍：
   ① 真字节回来了；② 四个方法真的被按这个顺序用了；③ 解析到包外的目标（符号链接
   逃逸那一种）被 contains() 挡下 —— 名字正则一个人挡不住这个；④ **服务不在时
   返回"读不到"，而不是偷偷回落到 node:fs**（那正是这一版要立的反面规矩）。 */
{
  const mod = await import(pathToFileURL(hostPath).href + '?probe=motion-reader')
  const dir = mod.motionDir()
  const idle = mod.motionFile('canon_idle.webp')
  const disk = idle !== null && existsSync(idle) ? readFileSync(idle) : null
  const calls = []
  const resolved = new Map()
  const bytesByPath = new Map(disk === null ? [] : [[idle, disk]])
  const fakeFs = {
    async resolve(p) { calls.push('resolve'); const real = resolved.get(p) ?? p; return { targetKey: real, displayPath: real } },
    contains(parent, child) {
      calls.push('contains')
      const root = String(parent.targetKey).replace(/[\\/]+$/, '')
      const kid = String(child.targetKey)
      return kid === root || kid.startsWith(`${root}\\`) || kid.startsWith(`${root}/`)
    },
    async stat(t) {
      calls.push('stat')
      if (!bytesByPath.has(t.targetKey)) return undefined
      return { version: 'v1', type: 'file', size: bytesByPath.get(t.targetKey).length }
    },
    async readBytes(t, signal, maxBytes) {
      calls.push('readBytes')
      const bytes = bytesByPath.get(t.targetKey)
      if (bytes === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      if (bytes.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      return new Uint8Array(bytes)
    },
  }
  const reader = mod.createServiceReader({ get: (name) => (name === 'fs' ? fakeFs : undefined) }, dir)
  const served = await reader.read(idle)
  check(served !== null && disk !== null && Buffer.from(served).equals(disk) && disk.length > 0,
    'the fs-service reader hands back the clip’s real bytes',
    served === null ? `null (${String(reader.state.lastError)})` : `${Buffer.from(served).length} B vs disk ${disk === null ? 'n/a' : disk.length} B`)
  check(['resolve', 'contains', 'stat', 'readBytes'].every((name) => calls.includes(name))
    && calls.indexOf('contains') < calls.indexOf('readBytes'),
    'and it goes through the documented signatures — resolve → contains → stat → readBytes',
    calls.join(' · '))
  check(reader.state.lastBytes === (disk === null ? null : disk.length) && reader.state.lastError === null,
    'and the reader state says which path ran and how many bytes it produced (that is what __diag reports)',
    JSON.stringify({ via: reader.state.via, bytes: reader.state.lastBytes, error: reader.state.lastError }))
  /* 符号链接逃逸：名字完全合法（`canon_idle.webp`），但解析出来的真实路径在包外。
     只查名字的实现会**照发**；这是 contains() 存在的理由。 */
  if (idle !== null) {
    resolved.set(idle, process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname')
    const escaped = await reader.read(idle)
    check(escaped === null && reader.state.lastError === 'outside-motion-dir',
      'a servable NAME whose real path lands outside assets/motion is refused — the symlink escape the name regex cannot see',
      `lastError=${String(reader.state.lastError)}`)
  }
  /* 服务不在时：**绝不能**悄悄用 node:fs 顶上（verify 自己就跑在 Node 里，
     所以"偷偷回落"在这条断言下会当场现形）。 */
  const orphan = mod.createServiceReader({}, dir)
  const orphaned = await orphan.read(idle)
  check(orphaned === null && orphan.state.lastError === 'no-fs-service',
    'with no fs service the reader returns NOTHING — it never quietly falls back to a Node module',
    `lastError=${String(orphan.state.lastError)} bytes=${orphaned === null ? 'null' : orphaned.byteLength}`)
  const throwing = mod.createServiceReader({ get: () => { throw new Error('boom') } }, dir)
  const threw = await throwing.read(idle)
  check(threw === null && typeof throwing.state.why === 'string' && throwing.state.why.includes('boom'),
    'and a ctx.get that throws is reported, not swallowed into a wrong answer',
    String(throwing.state.why))
}

/* ================================================= 1b. the update handler == */

head('1b. the host half answers checkUpdate through the platform web service')

/* 检查更新**必须**走平台给的通道：浏览器半包的 fetch 是陷阱，宿主半包在 vm 沙箱里
   没有 Node API，而 `ctx.web.fetch` 是 DSH 自己的 web_fetch 工具用的那一条服务。
   这一节把宿主编译出来的逻辑当纯函数测 —— 第一次真正测到宿主半包的行为。 */
{
  const mod = await import(pathToFileURL(hostPath).href + '?probe=update')
  const { readPublishedVersion, compareVersions, registerHandlers, inject } = mod
  const { readBalance, accountClientMetadata, normalizeWallets, resolveWebService, readManagedVersion, resolveAccountService } = mod

  /* ---------------------------------------------------------------------------
     `inject` 的形状曾经在这里被断言**反了**（v1.48.3 更正）。
     旧断言要求 `{ required: [], optional: ['web','deepseekAccount'] }` —— 一个**看起来**
     像"可选依赖声明"、实际上把整个宿主半包钉死的字面量：

       cordis 的静态 `inject` 不是 `{ required, optional }`。它是"服务名 → 拦截配置"的
       映射（或名字数组），loader 的归一化规则就是
         Array.isArray(inject) ? [...inject] : Object.keys(inject)
       —— 于是上面那个字面量声明的是两个**叫 `required` 和 `optional` 的服务**。
       任何组合里都不存在这两个服务，`Fiber._refresh()` 永远凑不齐 `_store`，fiber 停在
       PENDING，`apply()` 一次都不执行：`/wisp-motion/` 路由、checkUpdate、checkBalance
       全都不存在，而界面上的表现只是"她不动了 / 查不了更新"。安装日志原话：
         wisp (dsh-wisp): pending (waiting for services: required, optional)

     所以判据不是"web 要声明成 optional"，而是**声明的服务名必须都是运行时确实注册的**
     —— 这份包能证明的只有空集：需要的服务全部在调用时用 `ctx.get(name)` 取
     （web / deepseekAccount / fs，另有 pluginManager）。下面按 cordis 自己的规则复算
     一遍声明：任何会让 fiber 永久 pending 的形状都红，那个字面量本身再单独钉一遍。 */
  const cordisInjectNames = (decl) => {
    if (decl === null || decl === undefined) return []
    if (Array.isArray(decl)) return [...decl]
    if (typeof decl === 'object') return Object.keys(decl)
    return [String(decl)]
  }
  const declaredNames = cordisInjectNames(inject)
  check(declaredNames.length === 0,
    'the host half declares NO service dependency — a fiber with zero names to wait for cannot be parked',
    `inject=${JSON.stringify(inject)} → cordis 会等 [${declaredNames.join(', ')}]`)
  check(!(inject && typeof inject === 'object' && !Array.isArray(inject)
    && ('required' in inject || 'optional' in inject)),
  'and the { required, optional } literal is gone — cordis reads those two keys as service NAMES (the pending bug, pinned here)',
  JSON.stringify(inject))
  /* 不靠声明也要拿得到服务：`ctx.get` 是调用时查表；而 `ctx.web` / `ctx.deepseekAccount`
     在没声明的壳里要么不存在、要么**抛错**。这里把属性访问做成会抛的，两条解析路都必须
     照样拿到服务 —— "没有声明"与"拿不到服务"是两件事。 */
  const webStub = { fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: '{"version":"1.0.0"}' } }) }
  const accountStub = { getBalance: async () => null, getState: async () => ({ status: 'signed-out' }) }
  const throwingProps = {
    get: (name) => (name === 'web' ? webStub : name === 'deepseekAccount' ? accountStub : undefined),
    get web() { throw new Error('cannot get property "web" without inject') },
    get deepseekAccount() { throw new Error('cannot get property "deepseekAccount" without inject') },
  }
  check(resolveWebService(throwingProps).service === webStub
    && resolveAccountService(throwingProps).service === accountStub,
  'both services are resolved through ctx.get at call time — a declaration is not what makes them reachable',
  JSON.stringify({ web: resolveWebService(throwingProps).how, account: resolveAccountService(throwingProps).how }))
  /* 最极端的组合：没有服务、没有 ctx.get、没有 effect。apply() 必须照样跑完 ——
     这是"任何组合都不会把 fiber 钉住"的正面证明。 */
  let bareThrew = null
  try { mod.apply({}, {}) } catch (error) { bareThrew = error }
  check(bareThrew === null,
    'apply() survives a context with no services, no ctx.get and no effect — activation never depends on a composition',
    bareThrew ? String(bareThrew.message) : 'ok')
  check(mod.VERSION === pkg.version, 'the host half stamps the packaged version',
    `${mod.VERSION} vs ${pkg.version}`)

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

  /* 源可以换：国内镜像 / 私有 registry 只需要把 config.urls 指过去。
     这一条钉住"换源真的会去问新地址"—— 否则"支持镜像"只是文档里的一句话。 */
  const asked = []
  const recorder = {
    fetch: async (request) => {
      asked.push(request.url)
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: '{"version":"1.2.3"}' }, truncated: false }
    },
  }
  const mirrorUrls = { npm: 'https://registry.npmmirror.com/dsh-wisp/latest' }
  const mirror = await readPublishedVersion(recorder, mirrorUrls, undefined, 50)
  check(mirror.ok === true && mirror.latest === '1.2.3' && mirror.from === 'npm'
    && asked.length === 1 && asked[0] === mirrorUrls.npm,
  'the npm source can be pointed at a mirror through config (only the configured URL is asked)',
  JSON.stringify({ asked, verdict: mirror }))

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

  /* ---- 服务在**调用时**解析，而不是吃启动那一刻的快照 ----
     宿主半包由 bundle patch 插进来，可能比 web 服务先就位；而 optional 依赖在启动时缺席
     并不会事后补上 —— `ctx.web` 会永远是 undefined，检查更新从此永久失效。
     `ctx.get('web')` 是调用时查表，所以这条竞态修得掉。 */  const lateService = { fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: '{"version":"9.9.9"}' } }) }
  const declaredService = { fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: '{"version":"1.0.0"}' } }) }
  check(resolveWebService({ get: () => lateService, web: declaredService }).service === lateService,
    'the web service is resolved at CALL time, not from the startup-time property')
  check(resolveWebService({ get: () => undefined, web: declaredService }).service === declaredService,
    'with ctx.get answering nothing, the declared property is still the fallback')
  check(resolveWebService({ get: () => { throw new Error('restricted ctx') }, web: declaredService }).service === declaredService,
    'a throwing ctx.get falls back instead of breaking the check')
  /* "有个对象但不是 web 服务"也算 partial：把形状说出来，让 readVersion 去报
     "有服务但没有 fetch" —— 那比一句"没有通道"更能指认问题在哪一层。 */
  check(resolveWebService({ web: { notAFetchService: true } }).how === 'partial'
    && resolveWebService({ web: { notAFetchService: true } }).service !== undefined
    && resolveWebService(undefined).service === undefined,
  'a non-service object is passed through as partial so the failure can name its shape')

  /* ---- 拿不到服务时，必须能说清"看见了什么" ------------------------------------
     真机上出现过"两条路都拿不到、界面只说没有联网通道"，而那句话没法追问。
     诊断至少要回答：ctx.get 是不是函数、拿到的东西有没有 fetch。 */
  const blind = resolveWebService({ get: () => ({ search: () => {} }) })
  check(blind.service !== undefined && blind.how === 'partial' && blind.why.includes('-fetch'),
    'a service without a callable fetch is reported as partial, with its shape spelled out',
    JSON.stringify({ how: blind.how, why: blind.why }))
  const nothing = resolveWebService({})
  check(nothing.service === undefined && nothing.how === 'none'
    && nothing.why.includes('ctx.get("web")→undefined') && nothing.why.includes('ctx.web→undefined'),
  'and a genuinely missing service says which lookups came back undefined', nothing.why)
  const noGet = resolveWebService(undefined)
  check(noGet.service === undefined && noGet.how === 'none', 'no ctx at all is reported, not thrown', noGet.why)

  /* ---- 兜底通道：web 拿不到时问插件管理器"这个包是什么版本" ---------------------
     它走的是应用自己的网络出口（安装前 inspect 本来就要去 registry 问），
     所以这条路不依赖插件能否拿到 web 服务。 */
  const managedCtx = {
    get: (name) => (name === 'pluginManager'
      ? { inspect: async (spec) => ({ status: 'accepted', name: spec, version: '7.7.7', registry: 'https://mirror.example' }) }
      : undefined),
  }
  const managed = await readManagedVersion(managedCtx, 'dsh-wisp', 500)
  check(managed.ok === true && managed.version === '7.7.7' && managed.registry === 'https://mirror.example',
    'the plugin manager can be asked for the published version as a fallback channel',
    JSON.stringify(managed))
  const noManager = await readManagedVersion({ get: () => undefined }, 'dsh-wisp', 500)
  check(noManager.ok === false && noManager.reason === 'no-plugin-manager',
    'and its absence is a named reason, not an exception', JSON.stringify(noManager))
  const refused = await readManagedVersion({ get: () => ({ inspect: async () => ({ status: 'refused', reason: 'no such package' }) }) }, 'dsh-wisp', 500)
  check(refused.ok === false && refused.reason === 'inspect-refused' && refused.detail === 'no such package',
    'a refusal keeps the manager\'s own words', JSON.stringify(refused))

  /* 端到端：没有 web 服务、但有插件管理器 → 检查更新照样能给出答案，并说明走的哪条通道 */
  {
    const handlers = new Map()
    const originalHarness = globalThis.harness
    globalThis.harness = { handle: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) } }
    try {
      registerHandlers(managedCtx, { urls: U })
      const viaManager = await handlers.get('checkUpdate')({ current: '1.0.0' })
      check(viaManager.ok === true && viaManager.latest === '7.7.7' && viaManager.from === 'npm'
        && viaManager.diag && viaManager.diag.via === 'pluginManager',
      'with no web service but a plugin manager, the check still answers — through the fallback',
      JSON.stringify(viaManager))
    } finally {
      if (originalHarness === undefined) delete globalThis.harness
      else globalThis.harness = originalHarness
    }
  }

  /* ---- 每个源一个自己的截止时间 ----
     共用一个信号时，一个卡住的源到点会把另一个**已经拿到结果**的源一起作废，
     整次检查失败 —— 而这台机器上 raw.githubusercontent.com 恰好就是连不上的那个。 */
  const halfHanging = {
    fetch: async (request, signal) => {
      if (request.url === U.github) {
        return new Promise((resolve, reject) => {
          if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          }
        })
      }
      return { statusCode: 200, body: { kind: 'text', content: '{"version":"1.40.0"}' } }
    },
  }
  const survived = await readPublishedVersion(halfHanging, U, undefined, 60)
  check(survived.ok === true && survived.latest === '1.40.0' && survived.from === 'npm'
    && survived.sources.github.ok === false && survived.sources.npm.ok === true,
  'a source that never answers is cut off on its own — it cannot sink the healthy one',
  JSON.stringify(survived))

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

  /* ---------------- 余额：走平台自己的账户服务，插件不碰 API key -------------- */
  /* 为什么不能自己打平台 API：`ctx.web.fetch` 的请求体只有 `{ url }`（实测的
     服务契约），**设不了 Authorization 头**；而 DSH 自己读余额用的是
     platform.deepseek.com 上的 x-dsh-auth-token（账户授权，不是 API key）。
     所以唯一干净的路是服务本身 —— 凭据留在平台手里，插件连读都读不到。 */
  const CLIENT = { version: 'x', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }
  const accountWith = (result, state) => ({
    getBalance: async () => {
      if (result && result.throw) throw new Error(result.throw)
      return result
    },
    getState: async () => state,
  })
  const wallet = (currency, balance) => ({ currency, balance })

  const ready = await readBalance(accountWith({
    status: 'ready',
    value: [wallet('CNY', '110.00')],
    bonusWallets: [wallet('CNY', '10.00')],
  }), CLIENT)
  check(ready.ok === true && ready.status === 'ready' && ready.wallets.length === 1
    && ready.wallets[0].currency === 'CNY' && ready.wallets[0].balance === '110.00'
    && ready.bonusWallets[0].balance === '10.00',
    'a ready answer carries the wallets through unchanged', JSON.stringify(ready))

  const platformFailed = await readBalance(accountWith({ status: 'failed' }), CLIENT)
  check(platformFailed.ok === true && platformFailed.status === 'failed' && platformFailed.wallets.length === 0,
    'a platform "failed" is a result, not a throw — and it never becomes a zero balance',
    JSON.stringify(platformFailed))

  /* null 同时意味着两件事，而这两句"话"不一样：没登录 vs 授权在查询途中换了。 */
  const signedOut = await readBalance(accountWith(null, { status: 'signed-out' }), CLIENT)
  check(signedOut.ok === true && signedOut.status === 'signed-out' && signedOut.signedIn === false,
    'a null balance while signed out is reported as signed out', JSON.stringify(signedOut))

  const grantMoved = await readBalance(accountWith(null, { status: 'credential-stored' }), CLIENT)
  check(grantMoved.ok === true && grantMoved.status === 'unavailable' && grantMoved.signedIn === true,
    'a null balance while STILL signed in is "try again", not "log in" — telling the wrong one is worse than silence',
    JSON.stringify(grantMoved))

  /* getState() 也失败时，我们**不知道**是不是未登录 —— 这时必须说"没读到"，
     而不是替平台断言"你没登录"（叫人去登录一个已经登录的账户，比什么都不说糟）。 */
  const stateBlewUp = await readBalance({
    getBalance: async () => null,
    getState: async () => { throw new Error('state unavailable') },
  }, CLIENT)
  check(stateBlewUp.ok === true && stateBlewUp.status === 'unavailable' && stateBlewUp.signedIn === null,
    'when even getState() fails it admits it does not know, instead of claiming "signed out"',
    JSON.stringify(stateBlewUp))

  const noService = await readBalance(undefined, CLIENT)
  check(noService.ok === false && noService.reason === 'no-account-service',
    'without the account service it says so instead of throwing', JSON.stringify(noService))

  const balanceBlewUp = await readBalance(accountWith({ throw: 'socket closed' }), CLIENT)
  check(balanceBlewUp.ok === false && balanceBlewUp.reason === 'call-failed'
    && balanceBlewUp.detail === 'socket closed',
  'a platform error is caught and reported', JSON.stringify(balanceBlewUp))

  /* 服务不接受 AbortSignal，所以只能竞速 —— 没有这一条，一个挂住的调用
     会让她永远不说话（气泡停在"看一下……"）。 */
  const hung = await readBalance({ getBalance: () => new Promise(() => {}) }, CLIENT, 20)
  check(hung.ok === false && hung.reason === 'timeout',
    'a call that never settles is bounded by the timeout, not left hanging', JSON.stringify(hung))

  const junk = await readBalance(accountWith({
    status: 'ready',
    value: [null, { currency: 'CNY' }, { currency: 'CNY', balance: '1.00' }, 'nope'],
    bonusWallets: 'not-an-array',
  }), CLIENT)
  check(junk.status === 'ready' && junk.wallets.length === 1 && junk.bonusWallets.length === 0,
    'malformed wallets are dropped instead of crashing the client', JSON.stringify(junk))
  check(normalizeWallets(new Array(50).fill(wallet('CNY', '1'))).length === 8,
    'and an unbounded list is capped before it crosses the sandbox',
    `${normalizeWallets(new Array(50).fill(wallet('CNY', '1'))).length} wallets`)

  const meta = accountClientMetadata('en-US')
  check(meta.version === pkg.version && meta.locale === 'en-US'
    && meta.timezoneOffsetSeconds === -new Date().getTimezoneOffset() * 60,
  'the request metadata carries version, locale and the UTC offset in the sign the service wants',
  JSON.stringify(meta))
  check(accountClientMetadata('').locale === 'zh-CN' && accountClientMetadata(undefined).locale === 'zh-CN',
    'a missing locale falls back instead of sending an empty string')

  /* handler：注册、回答、以及**两个一起摘掉** */
  const bothHandlers = registerHandlers({
    web: only('npm', { body: '{"version":"9.9.9"}' }),
    deepseekAccount: accountWith({ status: 'ready', value: [wallet('USD', '4.20')], bonusWallets: [] }, { status: 'credential-stored' }),
  }, { urls: U })
  check(handlers.has('checkBalance'), 'registerHandlers puts checkBalance on the harness seat',
    [...handlers.keys()].join(', '))
  const balanceAnswer = await handlers.get('checkBalance')({ locale: 'zh-CN' })
  check(balanceAnswer.ok === true && balanceAnswer.status === 'ready'
    && balanceAnswer.wallets[0].balance === '4.20' && typeof balanceAnswer.checkedAt === 'string',
    'the handler returns a plain, serializable verdict', JSON.stringify(balanceAnswer))

  const withoutAccount = registerHandlers({ web: only('npm', { body: '{}' }) }, { urls: U })
  const degraded = await handlers.get('checkBalance')({})
  check(degraded.ok === false && degraded.reason === 'no-account-service',
    'with the service missing the handler degrades to a reason the client can speak',
    JSON.stringify(degraded))
  check(typeof withoutAccount.dispose === 'function', 'and it still registers')

  bothHandlers.dispose()
  check(!handlers.has('checkUpdate') && !handlers.has('checkBalance'),
    'dispose releases BOTH handlers, not just the update one', [...handlers.keys()].join(', ') || '(none left)')

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

  /* v1.48.3：`__diag` 现在也回答"宿主半包到底跑没跑、注册了哪两个 handler"。
     这条现场检查口是被那次 pending 事故逼出来的：fiber 停在 PENDING 时，路由没注册、
     检查更新没有、查余额没有 —— 三种症状在外部看起来和"这一段就这样"完全一样。
     这里用假 req/res 把那条线上诊断真的取一次，证明它报的是 apply() 的实况。 */
  {
    let diagRoute = null
    let diagApplyError = null
    try {
      mod.apply({
        inject: (deps, cb) => {
          cb({
            /* effect() 必须**真的执行**那个回调：路由就是在那里面注册的。 */
            webServer: { register: (route) => { diagRoute = route; return () => {} } },
            effect: (fn) => { fn(); return () => {} },
          })
        },
        effect: () => () => {},
      }, {})
    } catch (error) { diagApplyError = String(error && error.message ? error.message : error) }
    const response = { status: 0, headers: null, body: null }
    let diag = null
    if (diagRoute !== null && typeof diagRoute.handler === 'function') {
      await diagRoute.handler(
        { method: 'GET', url: `${mod.MOTION_ROUTE_PATH}/${mod.MOTION_DIAG_NAME}` },
        {
          writeHead(status, headers) { response.status = status; response.headers = headers },
          end(chunk) { response.body = chunk ?? null },
          destroy() {},
        },
      )
      try { diag = JSON.parse(String(response.body ?? '')) } catch (error) { diag = null }
    }
    check(diag !== null && diag.host?.applied === true
      && Array.isArray(diag.host?.handlers) && diag.host.handlers.includes('checkUpdate') && diag.host.handlers.includes('checkBalance')
      && diag.host?.motion?.registered === true,
    'and __diag reports that apply() ran and registered BOTH host handlers — the question a PENDING fiber made unanswerable',
    diag === null
      ? `status=${response.status} route=${diagRoute === null ? 'none' : 'yes'}${diagApplyError ? ` apply threw=${diagApplyError}` : ''}`
      : JSON.stringify(diag.host))
  }

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

    try { plugin.apply(h.ctx, { happyMs: 6000 }) } catch (err) { console.log('MOUNT-THREW ' + (err && err.stack ? err.stack : String(err))) }
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

    /* v1.47.0：`h.srcs` 里现在**混着两种源** —— 立绘是 `blob:`（data URI 解码出来的
       object URL），帧动画是宿主路由下的文件 URL。混在一起数，两件事就都说不清了，
       所以先按来源分开，再各查各的。 */
    const spriteSrcs = () => h.srcs.filter((s) => typeof s === 'string' && s.startsWith('blob:'))
    const motionSrcs = () => h.srcs.filter((s) => typeof s === 'string' && s.indexOf('/wisp-motion/') >= 0)

    if (h.srcs.length === 0) {
      bad('sprite assigned to an <img>', 'no src was ever set')
    } else if (spriteSrcs().length > 0 && spriteSrcs().every((s) => s.startsWith('blob:'))) {
      ok('sprites use blob: object URLs', spriteSrcs()[0])
    } else if (h.srcs.some((s) => typeof s === 'string' && s.startsWith('data:'))) {
      bad('sprites must not use data: URIs', 'this shell renders them as a broken image')
    } else {
      bad('sprite URL scheme', JSON.stringify(h.srcs).slice(0, 200))
    }
    /* 帧动画走的是**另一条**路（v1.47.0）：宿主半包注册的 `/wisp-motion/` 路由，
       以页面自己的 base 解析。它必须既不是 blob:（那意味着素材又被内联回来了），
       也不是 data:（这个壳画不出来）。 */
    check(motionSrcs().length > 0
      && motionSrcs().every((s) => /^http:\/\/127\.0\.0\.1:19387\/wisp-motion\/[A-Za-z0-9._-]+\.webp$/.test(s)),
      'the frame-animation source is the host route resolved against the page base — never an inlined blob or data URI (v1.47.0)',
      `${motionSrcs().length} motion src(s): ${motionSrcs()[0] ?? '(none)'}`)
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

    /* 气泡的淡出时长必须**等于它的寿命**。样式表里写死一个数、代码里另活一个数，
       两边就会漂（曾经是 4.2s 的淡出配 4.4s 的寿命：气泡提前淡完再干等）。
       这里不硬编码 4.4 —— 读它自己声明的时长，再按那个时间推进虚拟时钟。

       **单开一个替身**：这一条要推进 4.4 秒，而主替身后面还有一堆与时间有关的断言
       （第一次跑就把「同一批错误不重复播报」的计数从 11 推成了 12）。断言不能靠
       打乱别人的时间轴来成立，所以它有自己的时钟。
       存储里预置"右键提示已经说过了"：那句提示在挂载后 3.6 秒会冒出来，而 say()
       是**替换**而不是排队 —— 不挡住它，被测的那个气泡会在 4.2 秒检查点之前
       被提示顶掉（这个假警报也真出现过，两次）。 */
    const bt = createHarness({
      timer: true,
      storageSeed: { 'dsh-wisp:hint:v1': JSON.stringify({ told: true }) },
    })
    const keepBt = active
    active = bt
    bt.evaluate(clientSrc)
    bt.module().default.apply(bt.ctx, { wander: false, reactions: false })
    /* 挂载后 800ms 她会先打一句招呼（按时段选池子）—— 等它说完再放我们要测的那句，
       否则 say() 的**替换**语义会把被测量对象换成问候语。 */
    bt.advance(1000)
    const btApi = bt.win.__wisp
    btApi.say('测时长')
    const btSay = bt.all('wisp-say').filter((el) => el.removed !== true).at(-1)
    const declaredMs = Number.parseFloat(String(btSay?.style.animationDuration ?? '')) * 1000
    check(Number.isFinite(declaredMs) && declaredMs > 0,
      'the bubble declares its own lifetime instead of trusting the stylesheet',
      `${btSay?.style.animationDuration}`)
    bt.advance(declaredMs - 200, 100)
    check(btSay !== undefined && btSay.removed !== true,
      'the bubble is still on screen just before that deadline',
      `removed=${btSay?.removed}, text=${JSON.stringify(btSay?.textContent)}`)
    bt.advance(400, 100)
    check(btSay !== undefined && btSay.removed === true,
      'and it is gone right after it — the CSS fade and the removal share one clock',
      `${declaredMs}ms`)
    btApi.destroy()
    active = keepBt
    api.mood('happy')
    check(root.dataset.mood === 'happy', 'mood() control works')
    check(spriteSrcs().at(-1) !== spriteSrcs()[0], 'sprite switches with mood', String(spriteSrcs().at(-1)))

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
    check(spriteSrcs().at(-1) !== spriteSrcs()[0],
      'the attention state has its own sprite rather than borrowing idle',
      String(spriteSrcs().at(-1)).slice(0, 22))
    check(bubbles() > beforeAttn, 'she says something about it',
      layerEl.querySelector('.wisp-say')?.textContent)

    // 同一件事不重复念；换了一件才再说
    const afterFirst = bubbles()
    h.advance(6000, 300)
    check(bubbles() === afterFirst, 'she does not repeat herself for the same item', `${bubbles()} vs ${afterFirst}`)
    check(root.dataset.mood === 'attn', 'and she stays on attention while it is unanswered')

    /* 稳态重算**不许**放动作。poll 每一轮都会重算 setMood('attn')，而 attn 在
       POPPY_MOODS 里 —— 弹一下曾经挂在去重**之前**，于是你盯着审批卡片等的
       时候她每 1.2 秒抽一下（真机实测：6 秒 5 次 animationstart）。这条盯着那个回归。 */
    check(root.dataset.accent === undefined,
      'the poll re-asserting attn does not fire an accent — a steady state that pulses is a twitch',
      String(root.dataset.accent))
    h.advance(5000, 200)                 // 四轮轮询
    check(root.dataset.accent === undefined &&
      root.querySelectorAll('.wisp-zzz').length === 0,
    'and it stays quiet across several poll ticks', String(root.dataset.accent))
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
    const openEatMenu = () => eatBody.dispatch('keydown', {
      type: 'keydown', key: 'Enter', shiftKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
    })
    const eatLive = () => eat.all('wisp-menu-item').filter((el) => el.removed !== true)
    openEatMenu()
    /* 开关在「行为」组里：先展开（分组行带着 data-group） */
    const groupRowOf = (name) => eatLive().find((el) => el.dataset && el.dataset.group === name)
    groupRowOf('行为').dispatch('click', { preventDefault() {}, stopPropagation() {} })
    /* 开关行现在是真的开关控件：文字在子 span 里，按 switchKey 找才靠谱。 */
    const eatToggle = eatLive().find((el) => el.dataset && el.dataset.switchKey === 'hungry')
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
    check(Math.abs(sizeUp - (size0 + 0.1)) < 1e-9, 'ctrl+wheel up makes her a step bigger',
      String(size0) + ' -> ' + String(sizeUp))
    wheel(100, { ctrlKey: true })
    check(Math.abs(ixApi.config.size - size0) < 1e-9, 'and ctrl+wheel down takes it back',
      String(ixApi.config.size))
    wheel(-100, { metaKey: true })
    check(Math.abs(ixApi.config.size - (size0 + 0.1)) < 1e-9, '⌘+wheel does the same on macOS',
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

    /* 边界（v1.49.2）：界线是**可见像素**的边，所以那 25% 盒宽的透明边可以出屏幕；
       再往外按就停住，不会整只跑掉。 */
    const nudgePad = 140          // 替身假 alpha：25% × 560（默认 size 4）
    ixApi.move(0, 100)
    for (let i = 0; i < 5; i++) arrow('ArrowLeft')
    check(ixApi.position.x === -80 && ixApi.position.y === 100,
      'a nudge may walk her transparent margin off screen — the visible edge is what counts',
      ixApi.position.x + ',' + ixApi.position.y)
    for (let i = 0; i < 12; i++) arrow('ArrowLeft')
    check(ixApi.position.x === -nudgePad && ixApi.position.y === 100,
      'but pushing further clamps at the visible edge instead of letting her leave',
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
       插件**自己**既不能联网、也不能写文件。但"装"这一步不用她自己做（v1.48.0）：
       平台把插件管理器做成了客户端可用的 Remote 命名空间（ctx.remote.pluginManager），
       installBundle 交给它就行 —— 平台自己的「插件」设置页走的是同一条路。
       这一节测能真正做到的那几件事，安装那一段在下面 3d-quindecies-bis。 */
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

    /* 能力边界要如实报告 —— 但 v1.48.0 起"能自己更新"这句**成立了一半**：
       她自己没有网络也没有 Node，可她能**让平台去装**（remote.pluginManager）。
       所以这里验的是"她说得准"，不是"她说不能"。 */
    check(update.canSelfUpdate === true && update.install !== undefined,
      'she no longer claims she cannot install an update — the platform plugin manager can',
      JSON.stringify({ canSelfUpdate: update.canSelfUpdate, via: update.install?.via }))
    check(typeof update.hint === 'string' && update.hint.includes('dsh-wisp'),
      'but she does say which package to install', String(update.hint))
    check(/沙箱|sandbox/.test(String(update.why)), 'and why — in plain words', String(update.why))

    /* 「关于她」里的那一项（v1.49.8）：**只冒短句** —— 第一句是"去看一眼"，查回来用结果覆盖掉。
       以前第一句是 `'我是 X。' + 整段 WHATS_NEW`，而那段文字与「关于她」弹窗里的「这一版：…」
       是同一段、这个按钮又本来就在那个弹窗里：用户的原话是"她似乎会把'关于她'的内容说一遍，
       然后再说结果"。这条断言就是钉住那个观感的。 */
    {
      const startsWithPool = (pool, text) => (Array.isArray(pool) ? pool : [])
        .some((line) => String(text).indexOf(String(line).split('{')[0]) === 0)
      const beforeWrites = uv.clipboardWrites.length
      const updateResult = uvApi.showUpdate()
      check(updateResult.version === pkgVersion && updateResult.copied === true,
        'the update action reports the version and copies the package name', JSON.stringify(updateResult))
      const firstBubble = String(uv.all('wisp-say').at(-1)?.textContent ?? '')
      check(startsWithPool(linesInBundle()?.updateChecking, firstBubble),
        'the first bubble is the short "checking" line', firstBubble)
      check(typeof updateResult.note === 'string' && updateResult.note.length > 0
        && firstBubble.indexOf(String(updateResult.note).slice(0, 24)) < 0,
      'and the what-is-new note is NOT recited into it — that text belongs to the dialog',
      'note starts: ' + String(updateResult.note).slice(0, 30))
      /* 查回来那一句要覆盖掉第一句，并且带上版本号（"我是 X。…"）。 */
      await new Promise((resolve) => setImmediate(resolve))
      const lastBubble = String(uv.all('wisp-say').at(-1)?.textContent ?? '')
      check(lastBubble.includes(pkgVersion) && lastBubble.indexOf(firstBubble) < 0,
        'and the result replaces it — with the version in it', lastBubble)
      check(uv.clipboardWrites.length === beforeWrites + 1 && uv.clipboardWrites[uv.clipboardWrites.length - 1] === 'dsh-wisp',
        'the clipboard actually received the package name',
        JSON.stringify(uv.clipboardWrites.slice(-1)))
    }
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


    /* ---- 3d-quindecies-bis. 直接装上最新版（v1.48.0；v1.49.5 修了"说不清为什么失败"）--
       客户端半包没有 host 座位，但 installUpdate **不需要它**：平台自己的「插件」设置页
       走的就是 ctx.remote.pluginManager.installBundle。用假命名空间把几种结果走一遍。

       **替身必须照平台真实的 ChangeResult 喂 —— v1.49.5 修的正是这里。** 平台失败时回的是
       `application: 'failed'`，而 `error.code` 一律是 `operation-error`（pnpm 挂了的话
       managementError 只给得出这一个），真正的分类在 `packageResult.kind`
       （dsh-plugin-manager 的 classifyInstallFailure 那九个值）。v1.48.0 的测试喂的是
       `{ ok: false, error: { code: 'no-matching-version' } }` —— 平台**永远不会**这么回，
       于是"npm 上还没有这一版"这句话一次都没说过，而这边的测试一直全绿。
       另一条路是 `ok: false`：那是**回信没回来**（平台自己的设置页管它叫 replyLost，
       并靠 waitForInstall(requestId) 把结果捞回来），不是失败 —— 不许谎报成"没装成"。 */
    {
      const inPool = (pool, text) => (Array.isArray(pool) ? pool : [])
        .some((line) => String(text).indexOf(String(line).split('{')[0]) === 0)
      const mkInstaller = (services) => createHarness({ timer: true, composerText: '', services })
      const runInstall = async (services, version) => {
        const hx = mkInstaller(services)
        const keep = active
        active = hx
        hx.evaluate(clientSrc)
        hx.module().default.apply(hx.ctx, { reactions: true, wander: false, celebrate: false })
        hx.advance(1300, 100)
        const state = await hx.win.__wisp.installUpdate(version)
        await new Promise((resolve) => setImmediate(resolve))
        const says = hx.all('wisp-say').map((el) => String(el.textContent ?? ''))
        const line = says.at(-1) ?? ''
        const doctor = hx.win.__wisp.doctor().update.install
        hx.win.__wisp.destroy()
        active = keep
        return { state, line, says, doctor }
      }
      /* 平台失败时的真实信封：分类在 packageResult.kind 上，error.code 只是 operation-error。 */
      const failedRun = (spec, kind, diagnostic) => Promise.resolve({
        ok: true,
        value: {
          changed: false, application: 'failed', stage: 'install', target: spec,
          error: { code: 'operation-error', diagnostic },
          packageResult: { exitCode: 1, output: diagnostic, truncated: false, logPath: 'C:/x/op/pnpm.log', kind },
        },
      })

      let asked = null
      const applied = await runInstall({
        'remote.pluginManager': {
          installBundle: (spec) => { asked = spec; return Promise.resolve({ ok: true, value: { changed: true, application: 'applied', stage: 'install', target: spec } }) },
        },
      }, '9.9.9')
      check(asked === 'dsh-wisp@9.9.9', 'the install asks for exactly the version that was offered', String(asked))
      check(applied.state.state === 'installed' && applied.state.application === 'applied',
        'a successful install lands in the installed state', JSON.stringify(applied.state))
      check(inPool(linesInBundle()?.installDone, applied.line)
        && applied.line.includes('9.9.9') && !applied.line.includes('dsh-wisp@'),
      'and she says it is installed — the bare version, not the dsh-wisp@ spec', applied.line)
      check(applied.doctor.via === 'remote.pluginManager' && applied.doctor.state === 'installed',
        'doctor() reports the channel and the last install result', JSON.stringify(applied.doctor))

      const restart = await runInstall({
        'remote.pluginManager': {
          installBundle: (spec) => Promise.resolve({ ok: true, value: { changed: true, application: 'restart-required', stage: 'install', target: spec } }),
        },
      }, '9.9.9')
      check(restart.state.state === 'installed' && restart.state.application === 'restart-required'
        && inPool(linesInBundle()?.installRestart, restart.line),
      'when the platform says a restart is required she says exactly that, not "done"',
      restart.line)

      /* ① 真实形状的"npm 上还没有这一版" —— 判据必须是 packageResult.kind。 */
      const noVersion = await runInstall({
        'remote.pluginManager': {
          installBundle: (spec) => failedRun(spec, 'no-matching-version',
            'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for dsh-wisp@9.9.9'),
        },
      }, '9.9.9')
      check(noVersion.state.state === 'failed' && noVersion.state.kind === 'no-matching-version'
        && noVersion.state.reason === 'operation-error'
        && inPool(linesInBundle()?.installNotPublished, noVersion.line) && noVersion.line.includes('9.9.9'),
      'a registry without that version gets its own sentence — read off packageResult.kind, not error.code',
      JSON.stringify(noVersion.state) + ' | ' + noVersion.line)

      /* ② 其余 pnpm 分类各说各的（v1.49.5 之前它们全是同一句"没装成"）。 */
      const netDown = await runInstall({
        'remote.pluginManager': { installBundle: (spec) => failedRun(spec, 'network', 'ERR_PNPM_FETCH_ECONNRESET  request to https://registry.npmjs.org/dsh-wisp failed') },
      }, '9.9.9')
      check(netDown.state.kind === 'network' && inPool(linesInBundle()?.installNetwork, netDown.line),
        'a network failure is not said as a generic failure', netDown.line)

      const noPerm = await runInstall({
        'remote.pluginManager': { installBundle: (spec) => failedRun(spec, 'permission', 'EPERM: operation not permitted, unlink C:/x/node_modules/dsh-wisp') },
      }, '9.9.9')
      check(noPerm.state.kind === 'permission' && inPool(linesInBundle()?.installPermission, noPerm.line),
        'a permission failure says so', noPerm.line)

      /* ③ 平台自己那几种拒绝走 error.code（这类没有 packageResult）。 */
      const incompatible = await runInstall({
        'remote.pluginManager': {
          installBundle: (spec) => Promise.resolve({
            ok: true,
            value: { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'incompatible-version' } },
          }),
        },
      }, '9.9.9')
      check(incompatible.state.reason === 'incompatible-version'
        && inPool(linesInBundle()?.installIncompatible, incompatible.line),
      'a version the platform refuses as incompatible is its own sentence', incompatible.line)

      /* ④ 分类不出来时**把诊断带出来**，不吞掉。 */
      const unknownKind = await runInstall({
        'remote.pluginManager': {
          installBundle: (spec) => Promise.resolve({
            ok: true,
            value: {
              changed: false, application: 'failed', stage: 'install', target: spec,
              error: { code: 'operation-error', diagnostic: 'dsh: installation rejected: Cannot validate installed package dsh-wisp: boom' },
            },
          }),
        },
      }, '9.9.9')
      check(unknownKind.state.state === 'failed' && inPool(linesInBundle()?.installFailedWhy, unknownKind.line)
        && unknownKind.line.includes('Cannot validate installed package dsh-wisp'),
      'an unclassified failure carries the platform diagnostic instead of a bare "did not install"',
      unknownKind.line)

      /* ⑤ 回信没回来（ok:false）**不是失败**：如实说不知道，再拿 requestId 去把结果捞回来。
         这条正是用户实际遇到的那一类 —— 以前它被谎报成"没装成"。 */
      let lostId = null
      let reconciledId = null
      const lostThenSettled = await runInstall({
        'remote.pluginManager': {
          installBundle: (spec, options) => { lostId = options?.requestId ?? null; return Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'client api: pluginManager/installBundle failed: socket closed' } }) },
          waitForInstall: (requestId) => {
            reconciledId = requestId
            return Promise.resolve({ ok: true, value: { changed: true, application: 'applied', stage: 'install', target: 'dsh-wisp@9.9.9' } })
          },
        },
      }, '9.9.9')
      check(typeof lostId === 'string' && lostId !== '' && reconciledId === lostId,
        'the install carries a requestId and the recovery asks about that very id',
      String(lostId) + ' / ' + String(reconciledId))
      check(lostThenSettled.says.some((s) => inPool(linesInBundle()?.installNoReceipt, s)),
        'a lost reply is first said out loud as "I do not know", never as "it did not install"',
      lostThenSettled.says.join(' | '))
      check(!lostThenSettled.says.some((s) => inPool(linesInBundle()?.installFailed, s)),
        'and the failing sentence is never used for a lost reply', lostThenSettled.says.join(' | '))
      check(lostThenSettled.state.state === 'installed' && inPool(linesInBundle()?.installDone, lostThenSettled.line),
        'the recovered outcome is the one she reports', JSON.stringify(lostThenSettled.state) + ' | ' + lostThenSettled.line)

      const lostForGood = await runInstall({
        'remote.pluginManager': {
          installBundle: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'no carrier' } }),
          waitForInstall: () => Promise.resolve({ ok: true, value: null }),
        },
      }, '9.9.9')
      check(lostForGood.state.state === 'unknown' && lostForGood.state.reason === 'gateway/internal'
        && inPool(linesInBundle()?.installUnknown, lostForGood.line)
        && !lostForGood.says.some((s) => inPool(linesInBundle()?.installFailed, s)),
      'when the platform has no record either, she stops at "I do not know" — not at "it failed"',
      JSON.stringify(lostForGood.state) + ' | ' + lostForGood.line)
      check(lostForGood.doctor.state === 'unknown' && lostForGood.doctor.detail === 'no carrier',
        'and doctor() keeps what came back so the next failure can be traced',
      JSON.stringify(lostForGood.doctor))

      /* ⑥ 调用本身抛了：同样没有回执，照样不许说"没装成"。 */
      const blewUp = await runInstall({
        'remote.pluginManager': { installBundle: () => { throw new Error('boom') } },
      }, '9.9.9')
      check(blewUp.state.state === 'unknown' && blewUp.state.detail === 'boom'
        && inPool(linesInBundle()?.installUnknown, blewUp.line),
      'a throwing install is kept as "no receipt", with the thrown message in doctor()',
      JSON.stringify(blewUp.state))

      const noManager = await runInstall({}, '9.9.9')
      check(noManager.state.state === 'unsupported' && noManager.doctor.via === null
        && inPool(linesInBundle()?.installUnsupported, noManager.line),
      'a shell without the plugin manager is its own sentence, never a silent no-op',
      noManager.line)

      /* 弹窗里的那一步：查到新版 → 「安装 vX」按钮 → 点它真的按那一版去装 */
      {
        let clicked = null
        let clickedOptions = null
        const dlgHx = createHarness({
          timer: true, composerText: '',
          services: { 'remote.pluginManager': { installBundle: (spec, options) => { clicked = spec; clickedOptions = options ?? null; return Promise.resolve({ ok: true, value: { changed: true, application: 'applied', stage: 'install', target: spec } }) } } },
        })
        const keepDlgHx = active
        active = dlgHx
        dlgHx.win.fetch = (url) => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '9.9.9' }),
        })
        dlgHx.evaluate(clientSrc)
        dlgHx.module().default.apply(dlgHx.ctx, { reactions: false, wander: false, celebrate: false })
        dlgHx.advance(1300, 100)
        const dlgApi2 = dlgHx.win.__wisp
        await dlgApi2.checkForUpdate()
        await new Promise((resolve) => setImmediate(resolve))
        dlgApi2.openAbout()
        const actions = dlgHx.all('wisp-dialog-action').filter((el) => el.removed !== true)
        const installBtn = actions.find((el) => String(el.textContent).includes('安装 v9.9.9'))
        check(installBtn !== undefined,
          'once a newer version is known, the about dialog offers an install button for THAT version',
          actions.map((el) => el.textContent).join(' | '))
        if (installBtn !== undefined) installBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
        await new Promise((resolve) => setImmediate(resolve))
        check(clicked === 'dsh-wisp@9.9.9',
          'and clicking it installs that very version through the plugin manager', String(clicked))
        check(typeof clickedOptions?.requestId === 'string' && clickedOptions.requestId !== '',
          'the button leaves a requestId behind, so a lost reply can be reconciled later',
          JSON.stringify(clickedOptions))
        check(dlgApi2.dialog === null, 'the dialog gets out of the way while it installs', String(dlgApi2.dialog))
        dlgHx.win.__wisp.destroy()
        active = keepDlgHx
      }

      /* 英文覆盖层：安装这几句也要有，而且一个汉字都不许有 */
      const enInstallKeys = ['installChecking', 'installDone', 'installRestart', 'installPending',
        'installCancelled', 'installNotPublished', 'installFailed', 'installUnsupported',
        'installNoReceipt', 'installUnknown', 'installNotFound', 'installNetwork', 'installPermission',
        'installDiskFull', 'installBuildBlocked', 'installIntegrity', 'installTimeout', 'installNoPnpm',
        'installIncompatible', 'installManagement', 'installNotBundle', 'installFailedWhy']
      const enInstallBundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
      const enInstallLiteral = enInstallBundle.match(/const LINES_EN = (\{[\s\S]*?\n {4}\})/)
      let enInstallPools = null
      try { enInstallPools = enInstallLiteral ? new Function('return ' + enInstallLiteral[1])() : null } catch (error) { enInstallPools = null }
      const enInstallMissing = enInstallKeys.filter((k) => !Array.isArray(enInstallPools?.[k]) || enInstallPools[k].length === 0)
      check(enInstallMissing.length === 0, 'every install line has an English pool',
        enInstallMissing.length ? 'missing ' + enInstallMissing.join(', ') : enInstallKeys.length + ' pools')
      const enInstallHan = []
      for (const key of enInstallKeys) {
        for (const line of (enInstallPools?.[key] ?? [])) if (/[\u4e00-\u9fff]/.test(line)) enInstallHan.push(key + ': ' + line)
      }
      check(enInstallHan.length === 0, 'and none of them contains a Han character', enInstallHan.join(' | ') || 'clean')
    }

    /* 失败时也要能追问：doctor() 必须留下**每个源各自的**原因，
       否则"没查成"就是一句没法追的话（这正是用户实际遇到的情形）。 */
    const diagHarness = mkChecker(async () => ({
      ok: false,
      reason: 'no-web-service',
      /* 宿主现在会一起带回"它看见了什么" —— 失败台词背后的细节靠这一段。 */
      diag: { via: 'none', how: 'none', why: 'ctx.get("web")→undefined; ctx.web→undefined', manager: 'no-plugin-manager' },
      sources: {
        npm: { ok: false, reason: 'no-web-service' },
        github: { ok: false, reason: 'fetch-failed', detail: 'getaddrinfo ENOTFOUND' },
      },
    }))
    const keepDiag = active
    active = diagHarness
    diagHarness.evaluate(clientSrc)
    diagHarness.module().default.apply(diagHarness.ctx, { reactions: false, wander: false, celebrate: false })
    diagHarness.advance(1300, 100)
    await diagHarness.win.__wisp.checkForUpdate()
    const diagLast = diagHarness.win.__wisp.doctor().update.lastCheck
    check(diagLast.state === 'failed' && diagLast.reason === 'no-web-service'
      && diagLast.sources && diagLast.sources.npm.reason === 'no-web-service'
      && diagLast.sources.github.detail === 'getaddrinfo ENOTFOUND',
    'a failed check keeps every source reason, so doctor() can say WHY it failed',
    JSON.stringify(diagLast))

    /* 台词是给人读的一句话，技术细节不进嘴；但细节必须看得见 —— 失败时排进弹窗。
       （真机上出现过台词后面挂一串 ctx.get(...)→undefined 的英文碎片。） */
    diagHarness.win.__wisp.showUpdate()
    await new Promise((resolve) => setImmediate(resolve))
    diagHarness.advance(200, 50)
    const failSaid = String(diagHarness.all('wisp-say').at(-1)?.textContent ?? '')
    check(!/[A-Za-z]{3,}/.test(failSaid),
      'the failure line stays human — no technical fragments in the spoken sentence', failSaid)
    const diagDialog = diagHarness.all('wisp-dialog-p').map((el) => el.textContent).join('\n')
    check(diagDialog.includes('看到的东西') && diagDialog.includes('取服务的方式'),
      'and the dialog spells out what the host actually saw',
      diagDialog.replace(/\n/g, ' | ').slice(0, 120))
    diagHarness.win.__wisp.destroy()
    active = keepDiag

    /* 失败要说清是**哪一种**失败 —— 用户看到的只有那一句话，含糊地说成"没查到更新"
       就等于让他去猜（"更新检查没成功"这次就是这么来的）。三条原因三条台词。 */
    const failedWith = async (reason) => {
      const hf = mkChecker(async () => ({
        ok: false,
        reason,
        sources: { npm: { ok: false, reason }, github: { ok: false, reason } },
      }))
      const keep = active
      active = hf
      hf.evaluate(clientSrc)
      hf.module().default.apply(hf.ctx, { reactions: false, wander: false, celebrate: false })
      hf.advance(1300, 100)
      await hf.win.__wisp.checkForUpdate()
      hf.win.__wisp.showUpdate()
      await new Promise((resolve) => setImmediate(resolve))
      const said = String(hf.all('wisp-say').at(-1)?.textContent ?? '')
      hf.win.__wisp.destroy()
      active = keep
      return said
    }
    const inPool = (pool, text) => (Array.isArray(pool) ? pool : []).some((line) => text.includes(line))

    const noChannelSaid = await failedWith('no-web-service')
    check(inPool(linesInBundle()?.updateNoChannel, noChannelSaid),
      'with no network channel she says THAT, not the generic failure', noChannelSaid)
    const noHostSaid = await failedWith('call-failed')
    check(inPool(linesInBundle()?.updateNoHost, noHostSaid),
      'a host that does not answer gets its own sentence', noHostSaid)
    const networkSaid = await failedWith('fetch-failed')
    check(inPool(linesInBundle()?.updateFailed, networkSaid),
      'and a plain network failure keeps the ordinary line', networkSaid)
    check(new Set([noChannelSaid, noHostSaid, networkSaid]).size === 3,
      'the three failure kinds really are three different sentences')

    /* "没接上宿主"和"宿主拿不到服务"是链路上**不同的一环**断了 —— 必须分开说，
       否则那句话永远说不清断在哪（1.43.3 之前两者共用同一句，真机上就卡在这）。 */
    const noSeat = createHarness({ timer: true, composerText: '' })   // 默认替身没有 host 座位
    const keepNoSeat = active
    active = noSeat
    noSeat.evaluate(clientSrc)
    noSeat.module().default.apply(noSeat.ctx, { reactions: false, wander: false, celebrate: false })
    noSeat.advance(1000, 100)
    const noSeatRes = await noSeat.win.__wisp.checkForUpdate()
    noSeat.win.__wisp.showUpdate()
    await new Promise((resolve) => setImmediate(resolve))
    noSeat.advance(200, 50)
    const noSeatSaid = String(noSeat.all('wisp-say').at(-1)?.textContent ?? '')
    check(noSeatRes.state === 'failed' && noSeatRes.reason === 'fetch-failed',
      'no host seat at all gets its OWN sentence — the first link in the chain',
      `${noSeatRes.state} ｜ ${noSeatSaid}`)
    check(noSeatSaid !== noChannelSaid,
      'and it is distinguishable from "the host ran but has no web service"', `${noSeatSaid} ≠ ${noChannelSaid}`)
    noSeat.win.__wisp.destroy()
    active = keepNoSeat

    /* ---- v1.49.7：客户端侧的第一条通道是**宿主半包的同源端点** ------------------
       页面自己不做任何外部请求，宿主用它自己的 web 服务（拿不到就退回问插件管理器）
       把两个源问出来。起因是一次实测：这台机器系统代理开着时，页面直连 registry 连 TLS
       都建不起来（窗口标题里那句 wisp-diag ... fetch-failed 就是它），而宿主直连是通的。 */
    {
      const routeCalls = []
      const viaRoute = createHarness({ timer: true, composerText: '' })
      const keepRoute = active
      active = viaRoute
      viaRoute.win.fetch = (url) => {
        routeCalls.push(String(url))
        if (String(url).indexOf('wisp-motion/__update') >= 0) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({
            ok: true, latest: '99.0.0', from: 'npm', via: 'host-route',
            sources: { npm: { ok: true, version: '99.0.0' }, github: { ok: false, reason: 'fetch-failed' } },
            diag: { via: 'web', how: 'ctx.get', why: 'ctx.get("web")->object' },
          }) })
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) })
      }
      viaRoute.evaluate(clientSrc)
      viaRoute.module().default.apply(viaRoute.ctx, { reactions: false, wander: false, celebrate: false })
      viaRoute.advance(1300, 100)
      const routeRes = await viaRoute.win.__wisp.checkForUpdate()
      check(routeRes.state === 'available' && routeRes.latest === '99.0.0' && routeRes.via === 'host-route',
        'the host half answers the check over its own same-origin endpoint',
        JSON.stringify(routeRes))
      check(routeCalls.length === 1 && routeCalls[0].indexOf('wisp-motion/__update') >= 0,
        'and the page made exactly one request: the same-origin one, never an external one',
        routeCalls.join(' | '))
      check(viaRoute.win.__wisp.doctor().update.lastCheck.via === 'host-route',
        'doctor() records which channel answered',
        String(viaRoute.win.__wisp.doctor().update.lastCheck.via))
      viaRoute.win.__wisp.destroy()
      active = keepRoute
    }

    /* 同源端点不在（旧宿主半包 / 路由没注册）时，页面直连两个源照旧可用 ——
       加了新通道不等于把老通道拆掉。 */
    {
      const fallbackCalls = []
      const fallbackHx = createHarness({ timer: true, composerText: '' })
      const keepFallback = active
      active = fallbackHx
      fallbackHx.win.fetch = (url) => {
        fallbackCalls.push(String(url))
        if (String(url).indexOf('wisp-motion/__update') >= 0) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '99.0.0' }) })
      }
      fallbackHx.evaluate(clientSrc)
      fallbackHx.module().default.apply(fallbackHx.ctx, { reactions: false, wander: false, celebrate: false })
      fallbackHx.advance(1300, 100)
      const fallbackRes = await fallbackHx.win.__wisp.checkForUpdate()
      check(fallbackRes.state === 'available' && fallbackRes.latest === '99.0.0' && fallbackRes.via === 'page-fetch',
        'without the host endpoint the page still fetches both sources itself',
        JSON.stringify(fallbackRes))
      check(fallbackCalls.length === 3
        && fallbackCalls.some((u) => u.indexOf('registry.npmjs.org') >= 0)
        && fallbackCalls.some((u) => u.indexOf('raw.githubusercontent.com') >= 0),
      'the fallback really is the two external sources, after the same-origin attempt',
      fallbackCalls.join(' | '))
      fallbackHx.win.__wisp.destroy()
      active = keepFallback
    }

    /* 两条都不通：失败里必须留下"宿主那条为什么没答" —— 否则下次还是只有一句"没查到"。 */
    {
      const deadHx = createHarness({ timer: true, composerText: '' })
      const keepDead = active
      active = deadHx
      deadHx.win.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) })
      deadHx.evaluate(clientSrc)
      deadHx.module().default.apply(deadHx.ctx, { reactions: false, wander: false, celebrate: false })
      deadHx.advance(1300, 100)
      const deadRes = await deadHx.win.__wisp.checkForUpdate()
      check(deadRes.state === 'failed' && deadRes.reason === 'fetch-failed' && deadRes.via === 'page-fetch'
        && deadRes.diag && String(deadRes.diag.why).indexOf('宿主') >= 0,
      'both channels dead keeps why the same-origin one did not answer',
      JSON.stringify(deadRes))
      deadHx.win.__wisp.destroy()
      active = keepDead
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
    check(noSeatRes.state === 'failed' && noSeatRes.reason === 'fetch-failed',
      'with no host seat the CLIENT half falls back to its own fetch (no more unsupported)',
      JSON.stringify(noSeatRes))
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

    /* ------------- 3d-sexdecies. she can look up your balance ----------------- */
    head('3d-sexdecies. she can look up your balance, and says which kind of "no" it is')

    /* 余额有两条通道，读的是**同一个**平台账户服务（凭据留在宿主手里）：
       ① 客户端 Remote（默认，bundle 形态只有这条真的通）；
       ② host 座位（动态插件形态才有），这边用 host.call 问宿主半包。
       本节先测 host 座位那条（假座位），再测 Remote 那条（下面 3d-septendecies）。
       四种"没读到"必须是四句不同的话 —— 全说成"查不到"就是在骗人。 */
    const balanceHarness = (reply) => createHarness({
      timer: true, composerText: '',
      hostCall: async (method, args) => {
        if (method !== 'checkBalance') throw new Error('unexpected method ' + method)
        return typeof reply === 'function' ? reply(args) : reply
      },
    })
    const spoken = async (hh) => {
      await new Promise((resolve) => setImmediate(resolve))
      return String(hh.all('wisp-say').at(-1)?.textContent ?? '')
    }
    const fromPool = (pool, text, n) => (Array.isArray(pool) ? pool : [])
      .some((line) => text.startsWith(line.split('{n}').join(n)))

    const bal = balanceHarness({ ok: true, status: 'ready', wallets: [{ currency: 'CNY', balance: '110.00' }], bonusWallets: [{ currency: 'CNY', balance: '10.00' }] })
    const keepBal = active
    active = bal
    bal.evaluate(clientSrc)
    bal.module().default.apply(bal.ctx, { reactions: true, wander: false, celebrate: false })
    bal.advance(1300, 100)
    const balApi = bal.win.__wisp
    const balState = await balApi.checkBalance()
    check(balState.state === 'ready' && balState.wallets[0].balance === '110.00',
      'a ready answer lands in the ready state', JSON.stringify(balState))
    const balLine = await spoken(bal)
    check(balLine.includes('¥110.00') && fromPool(linesInBundle()?.balance, balLine, '¥110.00'),
      'she says the amount, from the balance pool', balLine)
    check(balLine.includes('¥10.00'),
      'and mentions the credit part instead of hiding it', balLine)
    check(balApi.doctor().balance.state === 'ready' && balApi.doctor().balance.hostSeat === true,
      'doctor() reports the balance result and that a host seat exists',
      JSON.stringify(balApi.doctor().balance))

    /* 菜单里那一行：点一下就该出声（菜单点完就关，光返回状态等于没反应）。
       它在「行为」分组的子面板里 —— 主菜单上只有分组行，所以要先展开那一组。 */
    const balBody = bal.find('wisp-body')
    const balClick = { preventDefault() {}, stopPropagation() {} }
    /* 右键必须落在**她身上**（onContext 会先过命中蒙版），所以坐标取她的中心。 */
    const balPos = balApi.position
    balBody.dispatch('contextmenu', {
      clientX: balPos.x + 280, clientY: balPos.y + 420, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
    })
    const liveMenuItem = () => bal.all('wisp-menu-item').filter((el) => el.removed !== true)
    const behaviourRow = liveMenuItem().find((el) => el.dataset.group === '行为')
    check(behaviourRow !== undefined, 'the behaviour group is on the menu',
      liveMenuItem().map((el) => el.textContent).join(' | '))
    if (behaviourRow !== undefined) behaviourRow.dispatch('click', balClick)
    const balRow = liveMenuItem().find((el) => String(el.textContent).includes('看看余额'))
    check(balRow !== undefined, 'and it has a balance entry',
      liveMenuItem().map((el) => el.textContent).join(' | '))
    if (balRow !== undefined) {
      bal.all('wisp-say').forEach((el) => { el.textContent = '' })
      balRow.dispatch('click', balClick)
      const menuLine = await spoken(bal)
      check(menuLine.includes('¥110.00'), 'clicking it makes her speak the balance', menuLine)
    }
    bal.win.__wisp.destroy()
    active = keepBal

    const cases = [
      ['signed-out', { ok: true, status: 'signed-out', wallets: [], bonusWallets: [] }, linesInBundle()?.balanceSignedOut],
      ['unavailable', { ok: true, status: 'unavailable', wallets: [], bonusWallets: [] }, linesInBundle()?.balanceUnavailable],
      ['failed', { ok: false, reason: 'no-account-service' }, linesInBundle()?.balanceFailed],
    ]
    for (const [expected, reply, pool] of cases) {
      const hb = balanceHarness(reply)
      const keepHb = active
      active = hb
      hb.evaluate(clientSrc)
      hb.module().default.apply(hb.ctx, { reactions: true, wander: false, celebrate: false })
      hb.advance(1300, 100)
      const res = await hb.win.__wisp.checkBalance()
      const line = await spoken(hb)
      check(res.state === expected, `a "${expected}" answer lands in that state`, JSON.stringify(res))
      check(fromPool(pool, line, ''), `and she says it in that pool's words`, line)
      check(!/110\.00/.test(line), 'without inventing a number for a read that failed', line)
      hb.win.__wisp.destroy()
      active = keepHb
    }

    /* 没有 host 座位（默认替身）：如实说"这个壳里查不了"，不许抛 */
    const balNoHost = createHarness({ timer: true, composerText: '' })
    const keepBalNoHost = active
    active = balNoHost
    balNoHost.evaluate(clientSrc)
    balNoHost.module().default.apply(balNoHost.ctx, { reactions: true, wander: false, celebrate: false })
    balNoHost.advance(1300, 100)
    const unsupportedBalance = await balNoHost.win.__wisp.checkBalance()
    check(unsupportedBalance.state === 'unsupported',
      'with no host seat she reports that the balance cannot be read here',
      JSON.stringify(unsupportedBalance))
    check(fromPool(linesInBundle()?.balanceUnsupported, await spoken(balNoHost), ''),
      'and says it out loud instead of staying silent', await spoken(balNoHost))
    balNoHost.win.__wisp.destroy()
    active = keepBalNoHost

    /* 宿主调用炸了：不能变成未处理的 rejection */
    const balThrower = balanceHarness(async () => { throw new Error('boom') })
    const keepBalThrower = active
    active = balThrower
    balThrower.evaluate(clientSrc)
    balThrower.module().default.apply(balThrower.ctx, { reactions: true, wander: false, celebrate: false })
    balThrower.advance(1300, 100)
    const balThrew = await balThrower.win.__wisp.checkBalance()
    check(balThrew.state === 'failed' && balThrew.reason === 'call-failed' && balThrew.detail === 'boom',
      'a throwing host call is caught and reported', JSON.stringify(balThrew))
    balThrower.win.__wisp.destroy()
    active = keepBalThrower

    /* ------------- 3d-septendecies. the balance channel that really exists ------
       平台自己的「账户」设置页走的是 ctx.remote.account.*（Remote，信封 { ok, value }）。
       bundle 形态的客户端半包没有 host 座位，所以**这才**是真机上那条路 ——
       1.46.0 之前它根本没被走过，菜单里点一下永远回"这个壳里查不了余额"。 */
    const runRemote = async (account, hostCall) => {
      const hx = createHarness({
        timer: true, composerText: '',
        ...(hostCall ? { hostCall } : {}),
        services: { 'remote.account': account },
      })
      const keep = active
      active = hx
      hx.evaluate(clientSrc)
      hx.module().default.apply(hx.ctx, { reactions: true, wander: false, celebrate: false })
      hx.advance(1300, 100)
      const res = await hx.win.__wisp.checkBalance()
      const line = await spoken(hx)
      const doctor = hx.win.__wisp.doctor().balance
      hx.win.__wisp.destroy()
      active = keep
      return { res, line, doctor }
    }

    let seenClient = null
    const remoteReady = await runRemote({
      getBalance: async (client) => {
        seenClient = client
        return {
          ok: true,
          value: { status: 'ready', value: [{ currency: 'CNY', balance: '110.00' }], bonusWallets: [{ currency: 'CNY', balance: '10.00' }] },
        }
      },
      getState: async () => ({ ok: true, value: { status: 'credential-stored' } }),
    })
    check(remoteReady.res.state === 'ready' && remoteReady.res.wallets[0].balance === '110.00'
      && remoteReady.res.bonusWallets[0].balance === '10.00',
    'the account Remote is a real channel: a wrapped ready answer lands in the ready state',
    JSON.stringify(remoteReady.res))
    check(remoteReady.line.includes('¥110.00') && fromPool(linesInBundle()?.balance, remoteReady.line, '¥110.00')
      && remoteReady.line.includes('¥10.00'),
    'and she says the amount, credit part included', remoteReady.line)
    /* 服务端**没有**任何默认值：不传身份它直接 TypeError。这条因此必须钉住。 */
    check(seenClient !== null && seenClient.version === pkg.version
      && typeof seenClient.locale === 'string' && seenClient.locale !== ''
      && typeof seenClient.timezoneOffsetSeconds === 'number' && Number.isFinite(seenClient.timezoneOffsetSeconds),
    'the Remote call carries this call\'s own identity (version / locale / UTC offset)',
    JSON.stringify(seenClient))
    check(remoteReady.doctor.remoteSeat === true && remoteReady.doctor.via === 'remote',
      'doctor() reports the Remote seat and which channel this read took',
      JSON.stringify(remoteReady.doctor))

    /* 两条通道都在 → 走平台原生那条 Remote；host 座位只当兜底 */
    const bothSeats = await runRemote(
      {
        getBalance: async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '110.00' }], bonusWallets: [] } }),
        getState: async () => ({ ok: true, value: { status: 'credential-stored' } }),
      },
      async () => ({ ok: true, status: 'ready', wallets: [{ currency: 'CNY', balance: '999.00' }], bonusWallets: [] }),
    )
    check(bothSeats.res.state === 'ready' && bothSeats.res.wallets[0].balance === '110.00'
      && bothSeats.doctor.via === 'remote' && bothSeats.doctor.hostSeat === true,
    'with both seats live the platform Remote wins, and the host seat stays declared',
    JSON.stringify(bothSeats.doctor))

    const remoteSignedOut = await runRemote({
      getBalance: async () => ({ ok: true, value: null }),
      getState: async () => ({ ok: true, value: { status: 'signed-out' } }),
    })
    check(remoteSignedOut.res.state === 'signed-out'
      && fromPool(linesInBundle()?.balanceSignedOut, remoteSignedOut.line, ''),
    'a null balance while signed out is reported as signed out', remoteSignedOut.line)

    const remoteMoved = await runRemote({
      getBalance: async () => ({ ok: true, value: null }),
      getState: async () => ({ ok: true, value: { status: 'credential-stored' } }),
    })
    check(remoteMoved.res.state === 'unavailable'
      && fromPool(linesInBundle()?.balanceUnavailable, remoteMoved.line, ''),
    'a null balance while STILL signed in is "try again", not "log in"', remoteMoved.line)

    const remoteRefused = await runRemote({ getBalance: async () => ({ ok: false, reason: 'disconnected' }) })
    check(remoteRefused.res.state === 'failed' && remoteRefused.res.reason === 'disconnected'
      && fromPool(linesInBundle()?.balanceFailed, remoteRefused.line, ''),
    'a refused envelope is a failure and keeps the reason', JSON.stringify(remoteRefused.res))

    const remoteFailed = await runRemote({
      getBalance: async () => ({ ok: true, value: { status: 'failed' } }),
      getState: async () => ({ ok: true, value: { status: 'credential-stored' } }),
    })
    check(remoteFailed.res.state === 'failed' && remoteFailed.res.reason === 'service-failed'
      && !/110\.00/.test(remoteFailed.line),
    'a platform "failed" inside the envelope never becomes a zero balance', JSON.stringify(remoteFailed.res))

    const remoteThrew = await runRemote({ getBalance: async () => { throw new Error('boom') } })
    check(remoteThrew.res.state === 'failed' && remoteThrew.res.reason === 'call-failed'
      && remoteThrew.res.detail === 'boom',
    'a throwing Remote call is caught and reported', JSON.stringify(remoteThrew.res))

    /* 一个永远不回答的 Remote（连接断了但 promise 不落地）：不许让气泡停在"看一下……"。
       服务和宿主半包那条路一样不接受 AbortSignal，只能自己竞速 —— 8 秒。 */
    {
      const hung = createHarness({
        timer: true, composerText: '',
        services: { 'remote.account': { getBalance: () => new Promise(() => {}) } },
      })
      const keepHung = active
      active = hung
      hung.evaluate(clientSrc)
      hung.module().default.apply(hung.ctx, { reactions: true, wander: false, celebrate: false })
      hung.advance(1300, 100)
      const pending = hung.win.__wisp.checkBalance()
      hung.advance(9000, 250)
      const res = await pending
      check(res.state === 'failed' && res.reason === 'call-failed' && res.detail === 'timeout',
        'a Remote call that never answers is cut off instead of hanging the bubble',
        JSON.stringify(res))
      hung.win.__wisp.destroy()
      active = keepHung
    }

    /* 英文覆盖层：余额这几句也要有，而且一个汉字都不许有 —— 1.36 的英文是覆盖层，
       新加的池子漏翻就会让英文界面的人看到中文。 */
    const enBundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
    const enLiteral = enBundle.match(/const LINES_EN = (\{[\s\S]*?\n {4}\})/)
    let enPools = null
    try { enPools = enLiteral ? new Function('return ' + enLiteral[1])() : null } catch (error) { enPools = null }
    const enKeys = ['balanceChecking', 'balance', 'balanceBonus', 'balanceEmpty', 'balanceSignedOut',
      'balanceUnavailable', 'balanceFailed', 'balanceUnsupported']
    const enMissing = enKeys.filter((k) => !Array.isArray(enPools?.[k]) || enPools[k].length === 0)
    check(enMissing.length === 0, 'every new balance line has an English pool',
      enMissing.length ? 'missing ' + enMissing.join(', ') : `${enKeys.length} pools`)
    const enHan = []
    for (const key of enKeys) {
      for (const line of (enPools?.[key] ?? [])) if (/[\u4e00-\u9fff]/.test(line)) enHan.push(key + ': ' + line)
    }
    check(enHan.length === 0, 'and none of them contains a Han character', enHan.join(' | ') || 'clean')

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
    /* 注意这条**只能**证明"她没认领这次按下"。真正的"下面那个应用收到了点击"是浏览器
       的命中判定给的，假 DOM 里没有命中判定 —— 那一条在 tools/engine-probe.mjs 里
       用 elementFromPoint + 真 CDP 点击验。 */
    const edge = press(api.position.x + 4, api.position.y + BOX_H / 2)
    check(edge.defaultPrevented === false,
      'a press on her transparent margin is not claimed by her', `defaultPrevented=${edge.defaultPrevented}`)
    const stillHeld = api.position
    h.win.dispatch('pointermove', { clientX: 0, clientY: 0 })
    h.win.dispatch('pointerup', {})
    check(api.position.x === stillHeld.x && api.position.y === stillHeld.y,
      'a margin press does not start a drag', `${api.position.x},${api.position.y}`)

    /* ---- 命中层：让**浏览器**按她的轮廓做判定，而不是她那个 560x840 的盒子 ---
       背景：盒子以前是 pointer-events:auto 铺满的，透明处的点击虽然不触发拖动，
       但事件**已经被派给她了**，下面的应用什么也收不到（真引擎实测：透明处
       elementFromPoint 返回 wisp-body，下面的按钮 0 次点击）。现在是一个空盒子
       带 alpha 蒙版生成的 clip-path —— 透明处是真的穿透。 */
    const hitLayer = bodyWisp.querySelector('.wisp-hit')
    check(hitLayer !== null, 'there is a dedicated hit layer', hitLayer?.className)
    check(String(bodyWisp.style.pointerEvents) === 'none'
      && String(hitLayer?.style.pointerEvents) === 'auto',
    'the body takes no pointer events and the hit layer takes them all',
    `body=${bodyWisp.style.pointerEvents} hit=${hitLayer?.style.pointerEvents}`)
    const hitClip = String(hitLayer?.style.clipPath ?? '')
    check(hitClip.startsWith('path("M') && hitClip.endsWith('z")'),
      'the hit layer carries a clip path built from the alpha mask', hitClip.slice(0, 60) + '…')
    /* 替身的 canvas 假 alpha 是"中间一半不透明"（96 格里的 24..71），再经蒙版的
       3×3 膨胀各扩一格 → 23..72 共 50 列。默认盒子 560x840，所以每列 5.833px：
       x=23×5.833=134.2，w=50×5.833=291.7，整高 840。这条同时证明坐标系按**当前盒子**算。 */
    check(hitClip === 'path("M134.2 0.0h291.7v840.0h-291.7z")',
      'and the shape equals the dilated mask, scaled to her box', hitClip)
    /* 改尺寸必须重算：clip-path 里的坐标是 px，不是百分比。 */
    api.configure({ size: 2 })
    const resizedClip = String(hitLayer?.style.clipPath ?? '')
    check(resizedClip === 'path("M67.1 0.0h145.8v420.0h-145.8z")',
      'resizing her rebuilds the clip for the new box', resizedClip)
    api.configure({ size: 4 })
    check(String(hitLayer?.style.clipPath ?? '') === hitClip,
      'and going back restores the original shape', String(hitLayer?.style.clipPath))

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
    /* v1.49.2：夹取按**可见像素**算 —— 她的透明边可以探出屏幕，可见的边才停在屏幕上。
       替身假 alpha 左右各留 25% 的盒宽（底边不留），所以右边能多走那 25%。 */
    /* 可见范围：替身假 alpha 占中间 75% 的宽度、整列高度。所以她的**可见右边**能贴到
       屏幕右边（盒子右移 25% 的盒宽探出屏幕外），可见下边贴到屏幕下边。 */
    const visibleRight = BOX_W * 0.75
    const corner = api.position
    check(corner.x === h.win.innerWidth - visibleRight && corner.y === h.win.innerHeight - BOX_H,
      'the clamp lets the VISIBLE pixels reach the edge — the transparent margin hangs off screen',
      `x=${corner.x} (want ${h.win.innerWidth - visibleRight}), y=${corner.y} (want ${h.win.innerHeight - BOX_H})`)

    api.move(0, 300)
    const tr = boxAt(root.style.transform)
    check(tr !== null, 'the transform is a plain translate plus a mirror', String(root.style.transform))
    if (tr !== null) {
      check(tr.facing === -1, 'she turns to face left on the left half', `scaleX(${tr.facing})`)
      check(tr.x === 0 && tr.y === 300, 'turning around does not shift her box',
        `translate ${tr.x},${tr.y} for position 0,300`)
    }
    api.move(after.x, after.y)   // put her back for the teardown/persistence checks

    /* ------------------------- 3f-bis. the motion layer (v1.38) ------------ */
    head('3f-bis. she has a body: press, drag tilt, landing, and noticing you')

    /* 为什么单开一个替身：这一段要反复按下/拖动/推指针，如果借用上面那个 h，
       她已经在拖动测试里被挪来挪去，姿势和位置的断言会互相污染。
       sleepAfterMs 拉到一小时：这里测的是手势，不是打盹。 */
    const mo = createHarness({ timer: true, composerText: '' })
    const keepMo = active
    active = mo
    mo.evaluate(clientSrc)
    mo.module().default.apply(mo.ctx, {
      reactions: true, wander: false, celebrate: false, sleepAfterMs: 3600000,
    })
    mo.advance(1200, 100)
    const moApi = mo.win.__wisp
    const moRoot = mo.find('wisp-root')
    const moBody = mo.find('wisp-body')
    const moMotion = mo.find('wisp-motion')
    const moLean = mo.find('wisp-lean')
    const MO_W = 140 * 4
    const MO_H = 210 * 4
    const moCentre = () => ({ x: moApi.position.x + MO_W / 2, y: moApi.position.y + MO_H / 2 })
    const moTilt = () => moRoot.style.getPropertyValue('--wisp-tilt')
    const moTiltNum = () => Number.parseFloat(moTilt())
    const moPress = (x, y) => {
      const ev = {
        button: 0, clientX: x, clientY: y, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
      }
      moBody.dispatch('pointerdown', ev)
      return ev
    }

    /* 两层空盒子，各管一件事。CSS 的 transform 在同一个元素上是覆盖不是叠加，
       所以"姿势"和"一次性动作"必须落在不同的元素上 —— 结构塌了，动作就互相
       覆盖（先侧倾再压扁，其中一个会丢）。 */
    check(moMotion !== null && moLean !== null, 'two motion layers exist',
      `${moMotion?.className} / ${moLean?.className}`)
    check(moMotion !== null && moMotion.parentNode === moBody && moLean !== null && moLean.parentNode === moMotion,
      'accent wraps posture wraps the sprite (body > motion > lean)')
    check(moLean !== null && moLean.querySelectorAll('.wisp-img').length === 1,
      'the sprite lives inside the posture layer, so it tilts with her',
      `${moLean?.querySelectorAll('.wisp-img').length} sprite layer(s)`)

    /* CSS 契约：每个一次性动作都有自己的关键帧，而且 **reduced-motion 必须把它们
       一起关掉** —— 新加的动画漏在这个媒体查询外面，是这类改动最常见的半成品。 */
    const moCss = String(mo.styleInserts[0] ?? '')
    const missingKeyframes = ['wisp-press', 'wisp-land', 'wisp-pop-a', 'wisp-pop-b']
      .filter((name) => !moCss.includes('@keyframes ' + name + '{'))
    check(missingKeyframes.length === 0, 'every accent has its own keyframes',
      missingKeyframes.length ? 'missing ' + missingKeyframes.join(', ') : '4/4')

    /* v1.49.9：动效必须**丝滑极简**（用户原话："压一下的程序动画做复杂了，看着晕，
       我希望丝滑极简"）。这条断言直接读 CSS —— 改回"果冻"或加长就红：
         · 不许两参 `scale(x,y)`（各向异性挤压/拉伸）；
         · 不许过冲（放大系数里的常数项 > 0.02）；
         · 每个一次性动作的时长必须 ≤ 0.25 秒。 */
    {
      const frameBody = (name) => {
        const start = moCss.indexOf('@keyframes ' + name + '{')
        if (start < 0) return null
        let depth = 0
        for (let i = moCss.indexOf('{', start); i < moCss.length; i++) {
          if (moCss[i] === '{') depth++
          else if (moCss[i] === '}') { depth--; if (depth === 0) return moCss.slice(start, i + 1) }
        }
        return null
      }
      /* 只看 scale() 的**顶层**参数个数 —— var(--wisp-amp,1) 里那个逗号不算。 */
      const twoArgScale = (body) => {
        let i = body.indexOf('scale(')
        while (i >= 0) {
          let depth = 0
          for (let k = i + 6; k < body.length; k++) {
            const c = body[k]
            if (c === '(') depth++
            else if (c === ')') { if (depth === 0) break; depth-- }
            else if (c === ',' && depth === 0) return true
          }
          i = body.indexOf('scale(', i + 6)
        }
        return false
      }
      const squash = []
      const overshoot = []
      for (const name of ['wisp-press', 'wisp-land', 'wisp-pop-a', 'wisp-pop-b']) {
        const body = frameBody(name) ?? ''
        if (twoArgScale(body)) squash.push(name)
        for (const m of body.matchAll(/1\s*\+\s*\.(\d+)/g)) if (Number('0.' + m[1]) > 0.02) overshoot.push(name + ' +.' + m[1])
      }
      check(squash.length === 0, 'no accent squashes her: uniform scale only, never scale(x, y)',
        squash.join(', ') || 'press / land / pop-a / pop-b')
      check(overshoot.length === 0, 'and none of them overshoots — 极简 means no springy bounce',
        overshoot.join(', ') || 'no term above 1.02')
      const slow = []
      for (const name of ['press', 'land', 'pop-a', 'pop-b']) {
        const rule = new RegExp('\\[data-accent="' + name + '"\\] \\.wisp-motion\\{animation:[^}]*?([0-9.]+)s').exec(moCss)
        if (rule === null) slow.push(name + ': no rule')
        else if (Number(rule[1]) > 0.25) slow.push(name + ': ' + rule[1] + 's')
      }
      check(slow.length === 0, 'and every accent is short — a press is a press, not a performance',
        slow.join(', ') || 'all ≤ 0.25s')
    }
    const rmAt = moCss.indexOf('@media (prefers-reduced-motion:reduce)')
    const rmBlock = rmAt < 0 ? '' : moCss.slice(rmAt)
    check(rmAt >= 0 && rmBlock.includes('.wisp-motion{animation:none!important}')
      && rmBlock.includes('.wisp-lean{transform:none!important'),
    'reduced motion neutralises the accent and the posture, not just the breathing')
    check(moCss.includes('.wisp-root[data-motion="subtle"]{--wisp-amp:.5}')
      && moCss.includes('.wisp-root[data-motion="off"]{--wisp-amp:0}'),
    'the level variable drives every amplitude from one place')
    check(moCss.includes('.wisp-root[data-motion="off"] .wisp-body'),
      'the "still" level stops the idle breathing too, so she is genuinely still')

    /* ---- 按下 → 压一下；松手（没拖动）→ 由点击反应接管 ---- */
    check(moRoot.dataset.accent === undefined, 'nothing is running before she is touched',
      String(moRoot.dataset.accent))
    const moC1 = moCentre()
    const moDown = moPress(moC1.x, moC1.y)
    check(moDown.defaultPrevented === true, 'the press lands on her body', `${moC1.x},${moC1.y}`)
    check(moRoot.dataset.accent === 'press', 'pressing her runs the press accent immediately',
      String(moRoot.dataset.accent))
    check(moRoot.dataset.dragging === 'true', 'and she is marked as held', String(moRoot.dataset.dragging))
    mo.win.dispatch('pointerup', {})
    /* 一次轻点里有两个动作抢同一个通道（CSS 的一个元素一次只能跑一条动画）：
       按下那一下已经演完了，接着是**点击反应**（换表情 → 弹一下）。后到的赢 ——
       "她换了个表情"比"手指抬起来了"更值得一次动作，所以没有单独的 release 关键帧。 */
    const moTapAccent = String(moRoot.dataset.accent)
    check(moTapAccent === 'pop-a' || moTapAccent === 'pop-b',
      'a tap hands the accent over to the click reaction instead of a separate release',
      moTapAccent)
    mo.advance(600, 50)
    check(moRoot.dataset.accent === undefined,
      'the accent clears itself when it is over — no half-finished state is left on the element',
      String(moRoot.dataset.accent))

    /* ---- 拖动：朝运动的反方向倾，松手落地并回正 ---- */
    const moC2 = moCentre()
    moPress(moC2.x, moC2.y)
    mo.win.dispatch('pointermove', { clientX: moC2.x + 30, clientY: moC2.y })
    const moDragged = moTiltNum()
    check(moDragged < 0 && Math.abs(moDragged) >= 3,
      'dragging her to the right leans her top backwards — she lags the motion',
      `${moTilt()} for a 30px step`)
    mo.win.dispatch('pointerup', {})
    check(moRoot.dataset.accent === 'land', 'a real drag ends with a landing, not a spring',
      String(moRoot.dataset.accent))
    check(moTilt() === '0deg', 'and the posture goes back to upright on release', moTilt())
    mo.advance(700, 50)

    /* ---- 拖动时的抖（v1.53.1）--------------------------------------------------
       用户报的："拖动她时会抖"。两个来源，一个是几何、一个是信号：
         ① facingOf() 是纯函数，拖动时每个指针事件都重算 —— 指针停在中线附近时它会
            来回翻，而每翻一次都要镜像精灵、并把 --wisp-tilt 的符号一起翻；
         ② 侧倾直接取单次事件的位移，指针流里逐事件的噪声被原样画出来。
       这里用一串**带噪声的指针流**复现：中线抖动不许翻面，右拖的噪声不许让角度变号。 */
    const moVw = mo.win.innerWidth
    const moBoxW = 140 * 4
    moApi.move(Math.round(moVw / 2 - moBoxW / 2), 300)      // 让她正中间压在中线上
    const midPoint = moCentre()
    moPress(midPoint.x, midPoint.y)
    const midFacing = []
    let midAt = 0
    for (const d of [3, -3, 2, -2, 3, -1, 2, -3, 1]) {
      midAt += d                                        // 指针位置要累加，不能把增量当坐标
      mo.win.dispatch('pointermove', { clientX: midPoint.x + midAt, clientY: midPoint.y })
      const box = boxAt(moRoot.style.transform)
      midFacing.push(box === null ? 0 : box.facing)
    }
    const midFlips = midFacing.filter((f, i) => i > 0 && f !== midFacing[i - 1]).length
    check(midFlips === 0,
      'jittering the pointer across the screen midline never flips her facing back and forth',
      `${midFlips} flip(s): ${midFacing.join(',')}`)
    mo.win.dispatch('pointerup', {})
    mo.advance(700, 50)

    /* 右拖 + 逐事件噪声：角度必须一直是**同一个方向**（她朝运动反方向倒），
       而且相邻两次的差值不能大 —— 大了就是噪声被画到画面上。
       注意要**离开中线**做这一条：--wisp-tilt 写出去的是乘过镜像的值，
       站在中线上时镜像本身还在跳，那测的是另一件事（上面那条）。 */
    moApi.move(200, 300)
    const noisePoint = moCentre()
    moPress(noisePoint.x, noisePoint.y)
    const noiseTilt = []
    let noiseAt = 0
    for (const d of [8, -1, 9, 1, -2, 8, 1, -1, 7]) {   // 每次事件的位移 = d
      noiseAt += d
      mo.win.dispatch('pointermove', { clientX: noisePoint.x + noiseAt, clientY: noisePoint.y })
      noiseTilt.push(moTiltNum())
    }
    const noiseSign = noiseTilt.filter((v) => v !== 0).map((v) => Math.sign(v))
    check(noiseSign.length > 0 && noiseSign.every((s) => s === noiseSign[0]),
      'a noisy rightward drag leans her one way — the per-event jitter is smoothed out',
      noiseTilt.map((v) => v.toFixed(2)).join(', '))
    const noiseJump = Math.max(...noiseTilt.map((v, i) => (i === 0 ? 0 : Math.abs(v - noiseTilt[i - 1]))))
    check(noiseJump <= 2,
      'and no single event swings her more than two degrees — that swing was the shaking',
      'max step ' + noiseJump.toFixed(2) + '°')
    check(Math.max(...noiseTilt.map((v) => Math.abs(v))) <= 6,
      'and the drag lean stays inside its own limit',
      'max ' + Math.max(...noiseTilt.map((v) => Math.abs(v))).toFixed(2) + '°')
    /* 手停下来：不会再有点事件来把角度收回去，必须自己回正。 */
    mo.advance(300, 50)
    check(moTilt() === '0deg', 'and it eases back to upright when the pointer stops moving', moTilt())
    mo.win.dispatch('pointerup', {})
    mo.advance(700, 50)

    /* 契约：这两个常数是上面两条行为的一半（另一半在 CSS 里）。 */
    /* 把位置交还给下面的测试：它们假设她站**右半边**（镜像 +1）。 */
    moApi.move(mo.win.innerWidth - 700, 300)
    check(/const TILT_DRAG_EMA = [0-9.]+/.test(String(clientSrc))
      && /const TILT_DRAG_SETTLE_MS = \d+/.test(String(clientSrc))
      && /\[data-dragging="true"\] \.wisp-lean\{transition:transform \.\d+s/.test(String(clientSrc)),
      'the drag lean is smoothed by an EMA, settles on its own, and keeps a short transition while dragging')

    /* ---- 指针靠近：她朝指针侧身；出圈归零 ----
       注意：v1.50.0 起「左右晃动」是四选一，**默认那档（微摆）不读指针** ——
       这一段测的是「跟着鼠标」那一档，所以先拨过去。 */
    moApi.configure({ sway: true })
    const moC3 = moCentre()
    mo.win.dispatch('pointermove', { clientX: moC3.x + 60, clientY: moC3.y })
    const moNearRight = moTiltNum()
    mo.win.dispatch('pointermove', { clientX: moC3.x - 60, clientY: moC3.y })
    const moNearLeft = moTiltNum()
    check(moNearRight > 0 && moNearLeft < 0 && Math.abs(moNearRight + moNearLeft) <= 0.2,
      'a pointer to her right leans her right, and to her left leans her left',
      `${moNearRight}° vs ${moNearLeft}°`)
    mo.win.dispatch('pointermove', { clientX: moC3.x + 900, clientY: moC3.y })
    check(moTilt() === '0deg', 'a pointer out of range leaves her upright', moTilt())

    /* ---- 镜像：同一侧倾在左半边必须写反号，否则"只在半张屏幕上错" ---- */
    moApi.move(0, 300)
    const moFace = boxAt(moRoot.style.transform)
    check(moFace !== null && moFace.facing === -1, 'she is mirrored on the left half',
      `scaleX(${moFace?.facing})`)
    const moC4 = moCentre()
    mo.win.dispatch('pointermove', { clientX: moC4.x + 60, clientY: moC4.y })
    check(moTiltNum() < 0,
      'the mirrored half gets the opposite sign, so the lean still points at the pointer',
      moTilt())
    const moFullTilt = Math.abs(moTiltNum())

    /* ---- 克制档 = 半幅 ---- */
    moApi.configure({ motion: 'subtle' })
    check(moRoot.dataset.motion === 'subtle', 'the level is applied to the element at once',
      String(moRoot.dataset.motion))
    mo.win.dispatch('pointermove', { clientX: moC4.x + 60, clientY: moC4.y })
    const moHalfTilt = Math.abs(moTiltNum())
    check(Math.abs(moHalfTilt * 2 - moFullTilt) <= 0.2,
      '"restrained" really halves the amplitude instead of merely looking calmer',
      `${moHalfTilt}° vs ${moFullTilt}°`)

    /* ---- v1.49.0：这一档不只管手势与侧倾，还管她多久溜达一次、一次走多远 ----
       手势的半幅在 560px 上就是十几像素、一闪而过（用户报过"动作幅度好像没用"），
       而"她走得少了、也走得更近了"过一会儿一定看得出来。 */
    const moFx = moApi.doctor().motion.effects
    check(moFx.gesture === 0.5 && moFx.lean === 0.5
      && moFx.wanderRange === Math.round(260 * 0.4) && moFx.wanderEvery === Math.round(45000 * 2.5),
      'doctor() spells out what the level changes: gesture, lean, and how far/often she strolls',
      JSON.stringify(moFx))

    /* ---- 左右晃动（v1.50.1：只做跟随指针）-------------------------------------
       v1.50.0 曾把它拆成四档（关 / 微摆 / 漂移 / 跟着鼠标）—— 那是把用户那句
       "我需要更好的可选方案"读成了"加个四档菜单"，其实他是在**要方案**（由他挑），
       而他挑的就是这一条。四档撤掉、回到一个开关；留下 1.50.0 里真正有用的手感：
       最大角 3.5° → 1.5°、过渡 0.5s 带过冲 → 0.45s 平滑。 */
    const moSwayAt = moCentre()
    check(moRoot.dataset.sway === 'on' && moApi.doctor().motion.sway.enabled === true,
      'the pointer-follow sway is on by default', String(moRoot.dataset.sway))
    check(Math.abs(moApi.doctor().motion.sway.maxDeg - moApi.doctor().motion.amp * 1.5) < 0.01,
      'and it is softer than the behaviour it replaces: 1.5° instead of 3.5°',
      String(moApi.doctor().motion.sway.maxDeg))
    mo.win.dispatch('pointermove', { clientX: moSwayAt.x + 60, clientY: moSwayAt.y })
    check(moTiltNum() !== 0, 'a pointer moving past her leans her toward it', moTilt())
    /* 关掉的那一刻她可能正歪着 —— 开关必须当场把姿势归零，不能留个半截状态。 */
    const moLeaning = moTilt()
    moApi.configure({ sway: false })
    mo.win.dispatch('pointermove', { clientX: moSwayAt.x + 60, clientY: moSwayAt.y })
    check(moLeaning !== '0deg' && moTilt() === '0deg' && moRoot.dataset.sway === 'off'
      && moApi.doctor().motion.sway.enabled === false,
    'switching it off mid-lean resets the posture instead of freezing her crooked',
    `${moLeaning} -> ${moTilt()}`)
    moApi.configure({ sway: true })
    mo.win.dispatch('pointermove', { clientX: moSwayAt.x + 60, clientY: moSwayAt.y })
    check(moTiltNum() !== 0, 'and switching it back on restores the follow at once', moTilt())
    /* 1.50.0 短暂地写出去过字符串（off / calm / drift / pointer）：不能被卡住。 */
    moApi.configure({ sway: 'off' })
    check(moRoot.dataset.sway === 'off', "a 1.50.0 'off' still reads as off", String(moRoot.dataset.sway))
    moApi.configure({ sway: 'calm' })
    check(moRoot.dataset.sway === 'on', "and a 1.50.0 'calm' reads as on — the follow is back",
      String(moRoot.dataset.sway))
    moApi.configure({ sway: true })
    /* 丝滑：没有过冲、没有自主动画偷偷回来（四档撤掉了，关键帧也必须一起走）。 */
    check(moCss.includes('transition:transform .45s cubic-bezier(.22,.61,.36,1)')
      && !moCss.includes('wisp-sway-calm') && !moCss.includes('wisp-sway-drift'),
    'the hover lean is a smooth ease-out with no overshoot, and no self-driven sway keyframes remain',
    moCss.includes('wisp-sway-calm') ? 'self-driven keyframes are still in the CSS' : 'lean only')
    const moHome = moApi.position
    moApi.configure({ wander: true, motion: 'subtle' })
    mo.advance(46000, 500)
    check(moApi.position.x === moHome.x && moApi.position.y === moHome.y,
      'in the restrained level she does not stroll when the old 45s interval is up',
      `${moApi.position.x},${moApi.position.y}`)
    mo.advance(70000, 500)          // 累计 116s > 45s × 2.5 = 112.5s
    const moStroll = Math.hypot(moApi.position.x - moHome.x, moApi.position.y - moHome.y)
    check(moStroll > 0 && moStroll <= Math.round(260 * 0.4) + 1,
      'but she does stroll once her longer interval is up — and never past the halved range',
      `${Math.round(moStroll)}px in one stroll, halved range would be 104px`)
    /* 把她放回原处、并恢复全幅：后面几节共用这个 harness，不该被这段挪走的位置污染。 */
    moApi.move(moHome.x, moHome.y)
    moApi.configure({ motion: 'full', wander: false })

    /* ---- 表情变化：弹一下，而且连着的两次都要能弹 ---- */
    moApi.configure({ motion: 'full' })
    moApi.mood('happy')
    const moPop1 = String(moRoot.dataset.accent)
    moApi.mood('poked')
    const moPop2 = String(moRoot.dataset.accent)
    check(moPop1 === 'pop-a' || moPop1 === 'pop-b',
      'a mood change pops instead of only cross-fading', moPop1)
    check(moPop2 === 'pop-a' || moPop2 === 'pop-b', 'and so does the next one', moPop2)
    /* 同一个 data-accent 值再写一次，浏览器**不会**重播动画 —— 连戳两下要看到
       两次弹，就必须换名字。这条断言盯的正是那个"第二次没动"的退化。 */
    check(moPop1 !== moPop2,
      'back-to-back pops alternate their keyframe names, so the second one really plays',
      `${moPop1} -> ${moPop2}`)
    mo.advance(600, 50)
    moApi.mood('idle')
    check(moRoot.dataset.accent === undefined,
      'returning to idle is not an accent — steady states must not twitch',
      String(moRoot.dataset.accent))

    /* 已经是这个表情时，再来一次**也要弹** —— 但这条只对**手势**成立。
       setMood 的弹一下挂在"真的换了表情"之后（否则轮询每 1.2 秒重算的 attn 会变成
       抽搐，见 3d-ter 那两条），"连戳两下"由 flashHappy/flashPoked 自己补。
       所以这里走真实的点击路径，而不是直接调 mood()。 */
    const moTapOnce = () => {
      const c = moCentre()
      moPress(c.x, c.y)
      mo.win.dispatch('pointerup', {})
      const accent = String(moRoot.dataset.accent)
      mo.advance(600, 50)
      return accent
    }
    const moTap1 = moTapOnce()
    const moTap2 = moTapOnce()
    check(/^pop-/.test(moTap1) && /^pop-/.test(moTap2) && moTap1 !== moTap2,
      'two taps in a row both pop, with alternating names — a silent second poke reads as "stuck"',
      `${moTap1} -> ${moTap2}`)
    moApi.mood('happy')          // 已经是 happy：这条路不该弹
    check(moRoot.dataset.accent === undefined,
      'but re-asserting the same mood programmatically stays silent — that is the path attn takes',
      String(moRoot.dataset.accent))

    /* ---- 静止档：不做动作、不侧身、呼吸也停 ---- */
    /* 先让上一个动作自己收尾：属性是**异步**清掉的，不等它，"静止档没放动作"
       会被残留的旧值顶掉 —— 这条假警报在真引擎探针里也出现过一次。 */
    mo.advance(600, 50)
    check(moRoot.dataset.accent === undefined, 'the accent from before has cleared by now',
      String(moRoot.dataset.accent))
    moApi.configure({ motion: 'off' })
    check(moRoot.dataset.motion === 'off', 'the "still" level reaches the element',
      String(moRoot.dataset.motion))
    const moC5 = moCentre()
    moPress(moC5.x, moC5.y)
    check(moRoot.dataset.accent === undefined, 'on "still" a press runs no accent',
      String(moRoot.dataset.accent))
    mo.win.dispatch('pointermove', { clientX: moC5.x + 60, clientY: moC5.y })
    check(moTilt() === '0deg', 'and the pointer posture stays at zero', moTilt())
    mo.win.dispatch('pointerup', {})
    check(moRoot.dataset.accent === undefined, 'nor does letting go', String(moRoot.dataset.accent))
    moApi.configure({ motion: 'full' })

    /* 写坏的档位名不该让她变成"不动也不报错"的坏状态 —— 一律退回默认档。 */
    moApi.configure({ motion: 'zoom' })
    check(moRoot.dataset.motion === 'full' && moApi.config.motion === 'full',
      'an unknown level falls back to the default instead of landing in the config',
      String(moApi.config.motion))

    /* ---- 零动画帧：整套动作都是"事件写一次属性，浏览器自己算" ---- */
    check(mo.frames.length === 0,
      'the whole motion layer runs without arming a single animation frame',
      `${mo.frames.length} frame(s)`)

    const moDoc = moApi.doctor().motion
    check(moDoc && typeof moDoc.level === 'string' && typeof moDoc.tilt === 'number',
      'doctor() reports the motion state, so "why is she leaning" is answerable',
      JSON.stringify(moDoc))

    /* ---- 系统要求别动时：CSS 关掉动画，JS 那边姿势也不写 ---- */
    const rmh = createHarness({ timer: true, composerText: '', reducedMotion: true })
    const keepRm = active
    active = rmh
    rmh.evaluate(clientSrc)
    rmh.module().default.apply(rmh.ctx, {
      reactions: true, wander: false, celebrate: false, sleepAfterMs: 3600000,
    })
    rmh.advance(1200, 100)
    const rmApi = rmh.win.__wisp
    const rmRoot = rmh.find('wisp-root')
    const rmBody = rmh.find('wisp-body')
    const rmCentre = { x: rmApi.position.x + MO_W / 2, y: rmApi.position.y + MO_H / 2 }
    rmh.win.dispatch('pointermove', { clientX: rmCentre.x + 60, clientY: rmCentre.y })
    check(rmRoot.style.getPropertyValue('--wisp-tilt') === '0deg',
      'under prefers-reduced-motion the pointer never moves her posture — the CSS media query cannot reach a JS-written variable, so this is a real second guard',
      rmRoot.style.getPropertyValue('--wisp-tilt'))
    rmBody.dispatch('pointerdown', {
      button: 0, clientX: rmCentre.x, clientY: rmCentre.y, preventDefault() {}, stopPropagation() {},
    })
    check(rmRoot.dataset.accent === undefined, 'and no accent runs either', String(rmRoot.dataset.accent))
    rmh.win.dispatch('pointerup', {})
    check(rmApi.doctor().motion.reduced === true, 'doctor() says the system asked for less motion',
      JSON.stringify(rmApi.doctor().motion))
    rmApi.destroy()
    active = keepRm

    moApi.destroy()
    check(mo.win.listenerCount('pointermove') === 0 && mo.win.listenerCount('blur') === 0,
      'the posture listeners are removed on destroy',
      `pointermove=${mo.win.listenerCount('pointermove')} blur=${mo.win.listenerCount('blur')}`)
    active = keepMo

    /* ---------------- 3f-ter. 帧动画（v1.45.0；v1.46.1 起是动图 <img>；v1.46.5 起两条）-- */
    head('3f-ter. the frame animations: animated WebPs that step aside to freeze')

    /* 这一段测的是"叠加在立绘上的那层动图"，而它有四个**只有行为能证明**的点：
       与立绘同一格、不吃指针、显示时立绘退场（v1.45.2）、以及"该冻结时它藏起来、
       画面回到立绘"（v1.46.1：<img> 上的动图停不下来，藏起来是唯一的冻结方式）。
       单开一个替身：这里要真的睡着（sleepAfterMs 在别的替身里是一小时，
       而直接 mood('sleep') 更直接，也不会打乱别人的时间轴）。 */
    const mv = createHarness({ timer: true, composerText: '' })
    const keepMv = active
    active = mv
    mv.evaluate(clientSrc)
    mv.module().default.apply(mv.ctx, {
      reactions: false, wander: false, celebrate: false, sleepAfterMs: 3600000,
    })
    mv.advance(1200, 100)
    const mvApi = mv.win.__wisp
    const mvRoot = mv.find('wisp-root')
    const mvLean = mv.find('wisp-lean')
    const mvLive = () => mv.all('wisp-video').find((el) => el.removed !== true) ?? null

    /* 静态立绘"看不看得见"（v1.45.2）在替身里由**两件事**共同决定：
       ① 根上的 data-frame —— 行为，syncMotion() 写的那个属性；属性不写 = 退场没发生。
       ② 样式表里把属性翻译成 visibility:hidden 的那条规则 —— 映射；规则没了，
          属性写了也白写（画面照旧两层）。
       行内那一份是样式表缺失时的兜底，也是同一件事的第二个落点。
       替身没有级联引擎，所以这个 helper 把三者合成"浏览器会算出来的值"，
       而每一条断言仍然把三者**分开点名** —— 合成值对了、其中一条断了，一样要红。 */
    const mvFrameRule = (String(mv.styleInserts[0] ?? '').match(/\.wisp-root\[data-frame="on"\][^{]*\{[^}]*\}/) ?? [''])[0]
    const mvVis = (el) => (
      String(el?.style?.visibility ?? '') === 'hidden'
      || (mvRoot.dataset.frame === 'on' && mvFrameRule.includes('visibility:hidden'))
        ? 'hidden'
        : 'visible'
    )

    /* ---- idle 也接上了（v1.46.5）：它是**默认**状态，所以动作层从挂载那一刻就在 ----
       这一段同时证明三件事：素材真的在包里、MOTION_OF 里接上了、syncMotion() 在挂载
       那一刻真的跑过（在那之前这一层只在进入 sleep 时才建元素）。
       **默认皮肤是 canon**（v1.48.2 起），所以这里点名的素材是 `canon_idle` ——
       v1.49.0 删掉通用兜底之后，"默认那一档能播"这件事只能由 canon 自己那一段成立。 */
    const mvIdle = mvLive()
    const mvIdleImgs = mvRoot.querySelectorAll('.wisp-img')
    check(mvIdle !== null && mvIdle.tagName === 'IMG' && mvIdle.dataset.clip === 'canon_idle',
      'the idle state builds the motion layer at mount — the standing loop is wired in, not merely shipped (v1.46.5)',
      mvIdle ? `${mvIdle.tagName} clip=${String(mvIdle.dataset.clip)}` : 'no motion layer built while idle')
    check(mvIdle !== null && mvIdle.style.display !== 'none' && mvIdleImgs.length === 1
      && mvVis(mvIdleImgs[0]) === 'hidden' && mvRoot.dataset.frame === 'on',
      'and it owns the picture from the first frame — the sprite is out of the way, never double-exposed (v1.45.2 rules, idle edition)',
      `display=${mvIdle?.style.display} sprites=${mvIdleImgs.length} sprite=${mvVis(mvIdleImgs[0])} data-frame=${String(mvRoot.dataset.frame)}`)
    /* idle **不带**尺寸校正（差 1.0~1.6%，小于 2% 那条线）：行内必须是 none。
       这一条和下面 deepsea_sleepy 那条 1.186 是**分开点名**的 —— 只查一条的话，
       "那条 1.186 落到 idle 头上"（她会被放大 18.6%）这种错会整段漏过去。
       v1.49.0 起这条换成 canon_idle：**默认皮肤**的站立段照样不许被放大。 */
    check(mvIdle !== null && mvIdle.style.transform === 'none',
      'the idle clip carries NO size correction — she fills 97.2% of that frame vs 98.2% of the sprite, under the 2% line (v1.46.5)',
      `inline transform=${JSON.stringify(mvIdle?.style.transform)}`)

    /* 没有动作素材的皮肤**连元素都不建**（v1.49.0：这是删掉通用兜底之后的核心行为）。
       这条用的是**真皮肤**而不是"把清单里一行抠掉"：藏蓝西装（office）一条动图素材都没有，
       她挂上去就该是一个纯静态立绘 —— 没有 <img class="wisp-video">、没有 data-frame、
       doctor() 两个字段都报空。通用兜底还在的时候，这里会建出一个播着**深海女仆**动作的
       元素（画面上是当场换装），所以这一条正是那一版的墓碑。

       **v1.52.0 换过一次示例皮肤。** 这条原来用的是宵蓝礼服（night）—— 而那一版给 night 做了
       整套八条帧动画，"没有动作素材的皮肤"这个前提在它身上当场不成立，两条断言一起变红。
       这不是坏事：它说明**"某套皮肤没有动图"是会被时间作废的样本**，不是恒定属性。
       下次再给哪套皮肤做动图，就顺手把这两处换到另一套还没做动图的皮肤上（见下面那条
       "没有动作素材的状态"用的又是另一种构造）。 */
    const ni = createHarness({ timer: true, composerText: '' })
    const keepNi = active
    active = ni
    ni.evaluate(clientSrc)
    ni.module().default.apply(ni.ctx, {
      skin: 'office', reactions: false, wander: false, celebrate: false, sleepAfterMs: 3600000,
    })
    ni.advance(1200, 100)
    const niApi = ni.win.__wisp
    const niRoot = ni.find('wisp-root')
    const niClips = []
    for (const state of ['idle', 'sleep', 'happy', 'attn', 'alert', 'proud', 'eat', 'poked', 'worried']) {
      niApi.mood(state)
      ni.advance(300, 100)
      const m = ni.all('wisp-video').find((el) => el.removed !== true) ?? null
      if (m !== null && m.style.display !== 'none') niClips.push(`${state}:${String(m.dataset.clip)}`)
    }
    check(niApi.skin === 'office' && niClips.length === 0
      && niRoot.querySelectorAll('.wisp-video').length === 0 && niRoot.querySelectorAll('video').length === 0
      && niRoot.dataset.frame === undefined,
      'a skin with NO clips never builds a motion layer in ANY state — with the shared fallback gone, "no clip" means no element, no decode, no data-frame (v1.49.0)',
      niClips.length ? niClips.join(' | ') : `${niRoot.querySelectorAll('.wisp-video').length} motion layer(s) across 9 states; sprite=${String(ni.all('wisp-img').find((el) => el.removed !== true)?.style?.visibility ?? '') || '(unset)'}`)
    niApi.mood('sleep')
    ni.advance(300, 100)
    check(niApi.doctor().motion.frame.asset === null && niApi.doctor().motion.frame.built === false
      && niApi.doctor().motion.frame.showing === false,
      'and doctor() reports it as "no clip for this skin+state" rather than a broken layer — the silent-degradation contract, now per skin (v1.49.0)',
      JSON.stringify(niApi.doctor().motion.frame))
    niApi.destroy()
    active = keepNi

    /* 没有动作素材的状态**连元素都不建**：摆一个永远不动、还要白解 3 MB 的空盒子，
       代价是真的，收益是零。（上面那条用的是"整套皮肤都没有"，这一条用的是
       "同一套皮肤里少了一段" —— 两件事都要成立。）把 MOTION 表里 `canon_idle`
       那一条**删掉**再挂一次：那才是真的"这个状态没有素材"。
       判据在 syncMotion() 里（查不到 key 就不建元素），不是"素材恰好缺失"。
       v1.47.0 起表里那条长这样：`"canon_idle": 'canon_idle.webp',` —— 删的是**清单里的一行**，
       不是一段 base64（投递改了，这一段测试的意图没变）。 */
    const noIdleSrc = String(clientSrc).replace(/^\s*"canon_idle": '[^']*',$/m, '')
    const mvNone = createHarness({ timer: true, composerText: '' })
    active = mvNone
    mvNone.evaluate(noIdleSrc)
    mvNone.module().default.apply(mvNone.ctx, {
      reactions: false, wander: false, celebrate: false, sleepAfterMs: 3600000,
    })
    mvNone.advance(1200, 100)
    const mvNoneRoot = mvNone.find('wisp-root')
    check(noIdleSrc !== clientSrc
      && mvNoneRoot.querySelectorAll('.wisp-video').length === 0 && mvNoneRoot.querySelectorAll('video').length === 0,
      'a mood with no clip does not even build the motion layer — no element, no base64 decode',
      `${mvNoneRoot.querySelectorAll('.wisp-video').length} motion layer(s) with the clip removed from the table`)
    /* 没有素材的状态：立绘就是画面里的那个人，而且**没有第二个"她"** —— 动图不建、属性不挂。 */
    const mvNoneImgs = mvNoneRoot.querySelectorAll('.wisp-img')
    check(mvNoneImgs.length === 1 && String(mvNoneImgs[0]?.style?.visibility ?? '') !== 'hidden'
      && mvNoneRoot.dataset.frame === undefined,
    'with no clip the frame never takes the picture: one visible sprite, no "frame owns it" attribute (v1.45.2)',
    `sprites=${mvNoneImgs.length} inline=${String(mvNoneImgs[0]?.style?.visibility ?? '') || '(unset)'} data-frame=${String(mvNoneRoot.dataset.frame)}`)
    const mvNoneApi = mvNone.win.__wisp
    check(mvNoneApi.doctor().motion.frame.built === false && mvNoneApi.doctor().motion.frame.asset === null,
      'and doctor() says so: nothing built, no clip for this state',
      JSON.stringify(mvNoneApi.doctor().motion.frame))
    mvNoneApi.destroy()
    active = mv

    /* ---- 换状态 = 换素材源，同一个元素（v1.46.5）----
       两段素材都进包之后，这条才有内容：一次性实现的陷阱是"只在第一次建元素、
       之后再也不改 src" —— 那样她睡着以后还在放站着的循环，而画面上看不出错。 */
    const mvIdleSrc = String(mvIdle.src)
    mvApi.mood('sleep')
    mv.advance(400, 100)
    check(mvLive() === mvIdle && mvIdle.dataset.clip === 'canon_sleepy'
      && String(mvIdle.src) !== mvIdleSrc && String(mvIdle.src) === 'http://127.0.0.1:19387/wisp-motion/canon_sleepy.webp',
      'switching state re-points the SAME element at the other clip — the layer is not a one-shot build (v1.46.5)',
      `reused=${mvLive() === mvIdle} clip=${String(mvIdle.dataset.clip)} srcChanged=${String(mvIdle.src) !== mvIdleSrc} src=${String(mvIdle.src)}`)
    mvApi.mood('idle')
    mv.advance(400, 100)
    check(mvLive() === mvIdle && mvIdle.dataset.clip === 'canon_idle' && String(mvIdle.src) === mvIdleSrc,
      'and switching back re-points it at the standing loop again — the source follows every transition, not just the first',
      `reused=${mvLive() === mvIdle} clip=${String(mvIdle.dataset.clip)} srcBack=${String(mvIdle.src) === mvIdleSrc}`)
    mvApi.mood('sleep')
    mv.advance(400, 100)
    check(mvIdle.style.display !== 'none' && mvIdle.dataset.clip === 'canon_sleepy',
      'and the sleeping loop is what is on screen after the round trip',
      `display=${mvIdle.style.display || '(default)'} clip=${String(mvIdle.dataset.clip)}`)

    const mvMotion = mvLive()
    const mvImgs = mvLean.querySelectorAll('.wisp-img')
    const mvImg = mvImgs[0] ?? null
    check(mvMotion !== null && mvMotion.tagName === 'IMG',
      'a mood that HAS a clip builds an <img> overlay — the picture pipeline, not a media pipeline',
      String(mvMotion?.tagName))
    /* v1.46.1 的核心：**一个 <video> 都不该存在**。这个壳不还原 VP9 的 alpha，
       而图片路径的 alpha 是硬的（见 build.mjs 的 motion 段与 WHATS_NEW）。 */
    check(mvRoot.querySelectorAll('video').length === 0,
      'and not a single <video> is built anywhere in the tree — the alpha has to come from the image path',
      `${mvRoot.querySelectorAll('video').length} video element(s)`)
    check(mvMotion !== null && mvMotion.parentNode === mvLean && mvImgs.length === 1,
      'it sits in the same layer as the sprite, next to it — so it tilts and squashes with her',
      `motion in ${String(mvMotion?.parentNode?.className)}, ${mvImgs.length} sprite layer(s)`)
    /* 与立绘**逐条同款**的行内盒模型：另起一套定位，就会出现"动起来时她跳了一下"
       —— 那是只有真机上才看得见的错位。 */
    const inlineBoxOf = (el) => ['position', 'top', 'left', 'width', 'height', 'objectFit', 'objectPosition']
      .map((k) => String(el?.style?.[k] ?? ''))
    const spriteBox = inlineBoxOf(mvImg)
    const motionBox = inlineBoxOf(mvMotion)
    check(mvImg !== null && motionBox.join('|') === spriteBox.join('|')
      && motionBox[0] === 'absolute' && motionBox[3] === '100%' && motionBox[5] === 'contain'
      && motionBox[6] === 'bottom center',
    'and it is laid out exactly like the sprite it overlays (inset 0 / 100% / contain / bottom center)',
    `motion[${motionBox.join(',')}] vs sprite[${spriteBox.join(',')}]`)

    check(mvMotion !== null && mvMotion.getAttribute('alt') === '' && mvMotion.getAttribute('aria-hidden') === 'true'
      && mvMotion.draggable === false,
    'and it is marked as decoration: empty alt, aria-hidden, not draggable',
    `alt=${JSON.stringify(mvMotion?.getAttribute('alt'))} aria-hidden=${JSON.stringify(mvMotion?.getAttribute('aria-hidden'))} draggable=${String(mvMotion?.draggable)}`)

    const mvCss = String(mv.styleInserts[0] ?? '')
    const mvRule = (mvCss.match(/\.wisp-video\{[^}]*\}/) ?? [''])[0]
    check(mvMotion !== null && mvMotion.style.pointerEvents === 'none' && mvRule.includes('pointer-events:none'),
      'the motion layer never takes a pointer event — her silhouette hit layer still owns every click',
      `inline=${mvMotion?.style.pointerEvents} rule=${mvRule.slice(0, 60)}…`)
    /* 尺寸校正（v1.46.4；**v1.49.3 起一条都不补**）：动作层这一格**不许**再缩放。
       1.46.4~1.49.2 之间 base 那条 `scale(1.186) translateY(7.84%)` 是给
       `deepsea_sleepy` 的（她那版素材只占 0.8352 个盒高 vs 立绘 0.9883，差 15.7%）；
       那一版素材退役之后三条深海女仆素材都只差 0.89%~1.09%，`MOTION_FIT` 成了空表，
       base 也跟着归零 —— 所以这里查的是**否定式**：不许有 scale、不许有 translate。
       为什么这一条比原来的 1.186 更要紧：`deepsea_happy` 是**新素材**，没有人为它写过
       [data-clip] 规则；base 里只要还剩那条 1.186，它落到新素材头上就是凭空放大 18.6%。
       transform-origin 仍然必须钉在**脚底**（50% 100%）—— 将来真有素材超过 2% 那条线，
       补上去的变换还是绕脚底做，"她落地"才对得上（详见 client.template.js 那段推导）。 */
    const mvZoomRule = !/scale\(/.test(mvRule) && !/translate/.test(mvRule) && /transform:none/.test(mvRule)
    const mvZoomOrigin = /transform-origin:50% 100%/.test(mvRule)
    check(mvZoomRule && mvZoomOrigin,
      'the stylesheet applies NO size correction to the motion layer — no scale, no translate, origin still pinned to her feet: every clip is inside the 2% line again (v1.49.3)',
      mvRule ? `.wisp-video{…} unscaled=${mvZoomRule} origin=${mvZoomOrigin}` : 'no .wisp-video rule in the stylesheet')
    /* 尺寸校正（v1.46.4 / v1.49.0 / v1.49.3）：那条 1.186 **只属于一段素材**
       （`deepsea_sleepy`，旧名 `sleepy`），而那一版素材已经不在了。行内那份由
       applyClipGeometry 按素材名写；默认皮肤是 canon（v1.48.2）之后，这条必须
       **点名切到 deepsea** 去验。 */
    mvApi.setSkin('deepsea')
    mvApi.mood('sleep')
    mv.advance(400, 100)
    check(mvLive() === mvIdle && mvIdle.dataset.clip === 'deepsea_sleepy'
      && String(mvIdle.src) === 'http://127.0.0.1:19387/wisp-motion/deepsea_sleepy.webp'
      && mvIdle.style.transform === 'none'
      && mvIdle.style.transformOrigin === '50% 100%',
      'the sleeping deep-sea clip carries NO correction any more — the 1.186 retired with the clip it was measured on, and the table it came from is empty (v1.49.3)',
      `clip=${String(mvIdle.dataset.clip)} src=${String(mvIdle.src)} inline transform=${String(mvIdle.style.transform)} origin=${String(mvIdle.style.transformOrigin)}`)
    /* **深海女仆的 `happy` 这一格是本轮新建的**（v1.49.3）：在那之前 `MOTION_OF` 里
       没有 `'deepsea:happy'` 这个键，戳她一下只有静态立绘。素材在清单里、指纹表里
       都查得到（4b 那两条），但那都是**声明**；这一条查的是行为 —— 同一个元素真的
       被指向 `deepsea_happy.webp`，而且几何与其它素材一致（none）。
       它和 `idle` / `sleepy` 那两条一起，才是"深海女仆现在有三条"。 */
    mvApi.mood('happy')
    mv.advance(400, 100)
    check(mvLive() === mvIdle && mvIdle.dataset.clip === 'deepsea_happy'
      && String(mvIdle.src) === 'http://127.0.0.1:19387/wisp-motion/deepsea_happy.webp'
      && mvIdle.style.transform === 'none'
      && mvVis(mvRoot.querySelectorAll('.wisp-img')[0]) === 'hidden',
      'the deep-sea happy state now builds its OWN clip — it was the one skin+state with no animation at all before this version (v1.49.3)',
      `clip=${String(mvIdle.dataset.clip)} src=${String(mvIdle.src)} transform=${String(mvIdle.style.transform)} sprite=${mvVis(mvRoot.querySelectorAll('.wisp-img')[0])}`)
    mvApi.setSkin('canon')
    mvApi.mood('sleep')
    mv.advance(400, 100)
    check(mvLive() === mvIdle && mvIdle.dataset.clip === 'canon_sleepy'
      && mvIdle.style.transform === 'none' && mvIdle.style.transformOrigin === '50% 100%',
      'and coming back to canon the SAME element re-points at canon_sleepy with the same "no correction" — picture and geometry are chosen together, per skin (v1.49.0 / v1.49.3)',
      `clip=${String(mvIdle.dataset.clip)} transform=${String(mvIdle.style.transform)}`)
    check(mvMotion !== null && mvMotion.style.transformOrigin === '50% 100%',
      'and the inline mirror always pins the transform origin to her feet, for shells where the stylesheet never arrives',
      `inline transform=${mvMotion?.style.transform} origin=${mvMotion?.style.transformOrigin}`)
    /* v1.46.5 / v1.49.0：**样式表那一份**也要把"不补"的那几条显式排除掉 ——
       base 那条 1.186 是给 deepsea_sleepy 的，落到别的素材头上就是放大 18.6%
       （而页面上只会看起来"她今天有点大"）。行内那份上面单独点了名，
       这里点样式表那份：两个落点各查各的，缺一个就有一个壳是错的。
       两条各点各的名字：deepsea_idle / canon_*（泳装那条在下面 3f-quater 里点）。 */
    const mvIdleRule = (String(clientSrc).match(/\.wisp-video\[data-clip="deepsea_idle"\]\{[^}]*\}/) ?? [''])[0]
    check(/transform:none/.test(mvIdleRule) && !/scale\(/.test(mvIdleRule),
      'the stylesheet names the standing deep-sea clip by its NEW name, so the sleeping 1.186 can never land on it (v1.46.5 / v1.49.0)',
      mvIdleRule || 'no .wisp-video[data-clip="deepsea_idle"] rule in the bundle')
    const mvStaleIdleRule = /\.wisp-video\[data-clip="idle"\]/.test(String(clientSrc))
    check(!mvStaleIdleRule,
      'and no rule still speaks the retired shared clip name `idle` — a half-done rename is a silently upscaled companion',
      mvStaleIdleRule ? 'found .wisp-video[data-clip="idle"]' : 'no [data-clip="idle"] rule left')
    /* reduced-motion 那条兜底：媒体查询够不着 JS 的显隐状态，但它至少能让这层不出现在
       画面上（JS 拿不到 matchMedia 的壳里，冻结就只剩这一道）。 */
    const mvRmAt = mvCss.indexOf('@media (prefers-reduced-motion:reduce)')
    /* 媒体查询是第二道闸：JS 拿不到 matchMedia 的壳里，冻结就只剩这一条 —— 它必须
       仍然能把动作层从画面上拿掉（v1.46.1 之后这层是 <img>，display:none 照旧管用）。 */
    check(mvRmAt >= 0 && mvCss.slice(mvRmAt).includes('.wisp-video{display:none!important}'),
      'the reduced-motion block still hides the motion layer in CSS — the JS gate is not the only one',
      mvRmAt >= 0 ? 'found in the stylesheet insert' : 'no @media (prefers-reduced-motion:reduce) block')
    /* 动作层**不许有 CSS filter**（v1.45.3 立的规矩，v1.46.1 照旧）：滤镜会给这一层
       再插一次栅格化，alpha 剪影被重新合成一遍 —— 那正是"她整个人变黑"那次的成因；
       阴影与调色只属于静态立绘。
       所以这条断言盯的必须是结构，而不是某一行的字面量：
       ① 睡眠那档只许改 --wisp-sprite；② 只有 .wisp-img 去读它；③ 动作层一个字都不许碰。 */
    const sleepGrade = /\[data-mood="sleep"\]\{[^}]*--wisp-sprite\s*:/.test(String(clientSrc))
    const spriteTakesGrade = /\.wisp-img\{[^}]*filter:var\(--wisp-glow\)\s*var\(--wisp-sprite\)/.test(String(clientSrc))
    check(!/\.wisp-video\{[^}]*filter\s*:/.test(String(clientSrc))
      && sleepGrade && spriteTakesGrade
      && !/\[data-mood="sleep"\]\s*\.wisp-video\{[^}]*--wisp-sprite/.test(String(clientSrc)),
      'the sleeping colour grade stays on the STATIC sprite only - the motion layer carries no filter at all',
      (sleepGrade ? '' : 'no [data-mood="sleep"]{--wisp-sprite:…} rule; ')
        + (spriteTakesGrade ? '' : 'the sprite does not compose var(--wisp-glow) var(--wisp-sprite); '))
    /* 属性 -> 画面的**映射**：属性在、规则在，退场才真的发生。
       用 visibility 而不是 display:none —— 盒子留着，布局不动，退场/回场不跳。 */
    check(mvFrameRule.includes('visibility:hidden') && !mvFrameRule.includes('display:none'),
      'the stylesheet takes the sprite out through visibility, never display — the box stays, so handing the picture over does not make her jump (v1.45.2)',
      mvFrameRule || 'no .wisp-root[data-frame="on"] .wisp-img rule in the stylesheet')

    /* 素材字节走哪条路（v1.47.0 换了）：**不再经过 Blob**。动图是宿主半包用
       `/wisp-motion/` 发出来的文件，客户端只把 URL 指给 <img>；base 取页面自己的
       （替身给的是真实的 Web 载体地址，见 documentShim.baseURI）。
       两个方向都要点名：
         ① 这一层的 src 必须是那条路由下的，**不是** data: URI（这个壳把 data: 当坏图，
            1.44 那次碎图就是这么来的）；
         ② 包里**一个** MB 级 clip blob 都不该有 —— 有就说明构建又把素材内联回来了，
            而那正是这一版要修的那件事（八条泳装 +30 MB ⇒ 单文件 ~45 MB）。 */
    const mvClipBlobs = mv.blobs.filter((b) => String(b.type) === 'image/webp' && b.size > 1024 * 1024)
    check(mvMotion !== null && String(mvMotion.src) === 'http://127.0.0.1:19387/wisp-motion/canon_sleepy.webp'
      && mvClipBlobs.length === 0,
      'the clip is fetched from the host route the page can resolve — and NOTHING multi-megabyte is inlined or blob-decoded any more (v1.47.0)',
      `src=${String(mvMotion?.src)} · ${mvClipBlobs.length} MB-scale clip blob(s)`)
    check(mvMotion !== null && mvMotion.style.display !== 'none',
      'the animation is on screen at the default level', `display=${mvMotion?.style.display || '(default)'}`)
    /* 需求的那一格：**动图在画面上的时候立绘必须不在场**（动图那一列由上面那条钉住）。
       两层同时可见就是重影 —— 动图的透明处挡不住下面那张静帧。 */
    check(mvMotion.style.display !== 'none'
      && mvVis(mvImg) === 'hidden' && mvRoot.dataset.frame === 'on'
      && mvImg.style.visibility === 'hidden' && mvApi.doctor().motion.frame.spriteHidden === true
      && mvApi.doctor().motion.frame.showing === true,
    'and while the animation is on screen the static sprite is GONE — two visible layers is a double image, not a fallback (v1.45.2)',
    `display=${mvMotion.style.display} sprite=${mvVis(mvImg)} inline=${mvImg?.style.visibility || '(unset)'} data-frame=${String(mvRoot.dataset.frame)} doctor=${JSON.stringify(mvApi.doctor().motion.frame.spriteHidden)}`)

    /* ---- 冻结规则之一：静止档 ---- */
    /* 动图没有"暂停"可以喊（<img> 上没有 pause()，也没有 currentTime 可以写回 0），
       所以冻结的唯一正确行为是**把它藏起来、把画面交回立绘** —— 下面这几条盯的就是
       这件事：看不见动图 + 看得见立绘，两者缺一不可。 */
    mvApi.configure({ motion: 'off' })
    check(mvMotion.style.display === 'none',
      'motion: off takes the animation off screen — an animated <img> cannot be paused, so hiding it IS the freeze',
      `display=${mvMotion.style.display}`)
    check(mvImg !== null && mvImg.removed !== true
      && String(mvImg.style.opacity) !== '0' && String(mvImg.style.display) !== 'none',
    'and the static sprite is what is left on screen — the fallback is the point of freezing',
    `sprite opacity=${mvImg?.style.opacity || '(default)'} display=${mvImg?.style.display || '(default)'}`)
    check(mvMotion.style.display === 'none' && mvVis(mvImg) === 'visible'
      && mvRoot.dataset.frame === undefined && mvImg.style.visibility !== 'hidden'
      && mvApi.doctor().motion.frame.showing === false && mvApi.doctor().motion.frame.frozen === true,
    'and it is actually VISIBLE again, not merely present: the freeze hands the picture back to the sprite (v1.45.2)',
    `motion=${mvMotion.style.display} sprite=${mvVis(mvImg)} inline=${mvImg?.style.visibility || '(unset)'} data-frame=${String(mvRoot.dataset.frame)}`)

    /* ---- 恢复：同一个元素接着动，不重建 ---- */
    mvApi.configure({ motion: 'full' })
    check(mvMotion.style.display !== 'none' && mvLive() === mvMotion,
      'putting the level back shows that same element instead of rebuilding it',
      `display=${mvMotion.style.display || '(default)'}`)
    /* 来回切：可见性必须跟着**每一次**切换走。只切一次的实现在这里就露馅了。 */
    check(mvVis(mvImg) === 'hidden' && mvRoot.dataset.frame === 'on',
      'and resuming takes the sprite out of the picture again — the switch follows every transition, not just the first one (v1.45.2)',
      `sprite=${mvVis(mvImg)} data-frame=${String(mvRoot.dataset.frame)}`)

    /* ---- 躲起来（display:none）也不该占着解码器 ---- */
    mvApi.hide()
    check(mvMotion.style.display === 'none',
      'hiding her away takes the animation off screen too — an invisible 1.9 MB loop must not keep decoding',
      `display=${mvMotion.style.display}`)
    /* "被躲起来"也是冻结规则的一条：动图退场、画面归立绘 —— 她回来时看到的该是那张立绘。 */
    check(mvMotion.style.display === 'none'
      && mvVis(mvImg) === 'visible' && mvRoot.dataset.frame === undefined,
    'and while she is hidden away the frame gives the picture back as well (v1.45.2)',
    `motion=${mvMotion.style.display} sprite=${mvVis(mvImg)} data-frame=${String(mvRoot.dataset.frame)}`)
    mvApi.show()
    check(mvMotion.style.display !== 'none', 'and calling her back shows it again', `display=${mvMotion.style.display || '(default)'}`)
    check(mvMotion.style.display !== 'none' && mvVis(mvImg) === 'hidden'
      && mvRoot.dataset.frame === 'on',
    'and the animation takes the picture again the moment she is back (v1.45.2)',
    `motion=${mvMotion.style.display || '(default)'} sprite=${mvVis(mvImg)} data-frame=${String(mvRoot.dataset.frame)}`)

    /* ---- 冻结规则之二：系统要求减少动态效果 ---- */
    const mvr = createHarness({ timer: true, composerText: '', reducedMotion: true })
    active = mvr
    mvr.evaluate(clientSrc)
    mvr.module().default.apply(mvr.ctx, {
      reactions: false, wander: false, celebrate: false, sleepAfterMs: 3600000,
    })
    mvr.advance(1200, 100)
    const mvrApi = mvr.win.__wisp
    mvrApi.mood('sleep')
    mvr.advance(400, 100)
    const mvrRoot = mvr.find('wisp-root')
    const mvrMotion = mvr.all('wisp-video').find((el) => el.removed !== true) ?? null
    check(mvrMotion !== null && mvrMotion.tagName === 'IMG' && mvrMotion.style.display === 'none',
      'under prefers-reduced-motion the motion layer never goes on screen (an <img> has no other way to be frozen)',
      `${String(mvrMotion?.tagName)} display=${mvrMotion?.style.display}`)
    check(mvrRoot.querySelectorAll('.wisp-img').length === 1 && mvrApi.doctor().motion.frame.frozen === true,
      'and the static sprite is the whole picture, with doctor() saying why',
      `sprites=${mvrRoot.querySelectorAll('.wisp-img').length} doctor.frozen=${mvrApi.doctor().motion.frame.frozen}`)
    check(mvrRoot.dataset.frame === undefined
      && String(mvrRoot.querySelector('.wisp-img')?.style?.visibility ?? '') !== 'hidden',
    'and under reduced motion the sprite is visible — the animation never takes the picture (v1.45.2)',
    `inline=${String(mvrRoot.querySelector('.wisp-img')?.style?.visibility ?? '') || '(unset)'} data-frame=${String(mvrRoot.dataset.frame)}`)
    mvrApi.destroy()
    active = mv

    /* ---- 加载失败：静默降级，不冒泡、不留一个空盒子 ---- */
    let mvErrThrow = null
    try { mvMotion.dispatch('error', {}) } catch (error) { mvErrThrow = error }
    check(mvErrThrow === null && mvMotion.style.display === 'none'
      && mvRoot.querySelectorAll('.wisp-img').length === 1,
    'a clip that fails to load degrades silently: the motion layer hides, the sprite stays, nothing throws',
    `threw=${mvErrThrow === null ? 'no' : String(mvErrThrow.message)} display=${mvMotion.style.display}`)
    /* 失败是**静默**的，所以"兜底真的看得见"必须是个断言：动图这一层退场之后，
       立绘要回到画面上（visibility 回 visible），而不是留下一个空盒子。 */
    check(mvMotion.style.display === 'none' && mvVis(mvImg) === 'visible'
      && mvRoot.dataset.frame === undefined && mvImg.style.visibility !== 'hidden',
    'and the failed clip hands the picture back: the motion layer is gone and the sprite is visible again, silently (v1.45.2)',
    `motion=${mvMotion.style.display} sprite=${mvVis(mvImg)} inline=${mvImg?.style.visibility || '(unset)'} data-frame=${String(mvRoot.dataset.frame)}`)
    check(mvApi.doctor().motion.frame.spriteHidden === false,
      'and doctor() says the sprite owns the picture again, not just that the motion layer is gone (v1.45.2)',
      JSON.stringify(mvApi.doctor().motion.frame))
    check(mvApi.doctor().motion.frame.failed === true,
      'and doctor() reports the degraded frame animation instead of leaving it a mystery',
      JSON.stringify(mvApi.doctor().motion.frame))
    /* 失败之后不再反复重试：重试一个已经坏掉的源只会每 1.2 秒烧一次解码。 */
    mvApi.mood('idle')
    mvApi.mood('sleep')
    mv.advance(200, 100)
    check(mvMotion.style.display === 'none' && mvLive() === mvMotion,
      'and it is not re-created or retried on the next nap', `display=${mvMotion.style.display}`)
    /* 失败是**按素材**记的（v1.46.5）：坏掉的是睡着那一段，站着那段没坏 —— 她醒着的时候
       照常动。把"失败"做成一个全局开关的实现在这里会露出来（她会从此一辈子不动）。 */
    mvApi.mood('idle')
    mv.advance(200, 100)
    check(mvLive() === mvMotion && mvMotion.dataset.clip === 'canon_idle'
      && mvMotion.style.display !== 'none' && mvApi.doctor().motion.frame.failed === false,
      'the failure belongs to the clip, not to the layer: the standing loop still plays after the sleeping one died (v1.46.5)',
      `clip=${String(mvMotion.dataset.clip)} display=${mvMotion.style.display || '(default)'} doctor.failed=${mvApi.doctor().motion.frame.failed}`)
    /* 动图这一层**一次 play()/pause() 都不该出现**：那是媒体通道的 API，图片路径上没有它，
       也不该有人偷偷搭一条回来。替身把每一次 play/pause 记在 harness 上，所以"一次都没有"
       在这里是能数出来的事实，而不是从源码里读出来的一句话。 */
    check(mv.videoPlays.length === 0 && mv.videoPauses.length === 0,
      'the motion layer never calls play()/pause() — the media pipeline is gone, not merely unused',
      `${mv.videoPlays.length} play(s), ${mv.videoPauses.length} pause(s) across the whole section`)
    mvApi.destroy()
    active = keepMv

    /* ------------------------------------------------------ 3g. teardown --- */
    /* ---- 冻结规则之三（v1.47.0）：独立的「帧动画」开关 ----------------------
       动图是画面里唯一会自己动的东西，所以它有一个**只管画面**的开关。关掉之后
       画面交给静态立绘，而呼吸 / 一次性动作照旧（幅度档一个字没动）—— 这正是它
       和「动作幅度 → 静止」的分工。四个冻结来源共用 motionFrozen() 那一处判断。 */
    {
      const fv = createHarness({ timer: true, composerText: '' })
      const keepFv = active
      active = fv
      fv.evaluate(clientSrc)
      fv.module().default.apply(fv.ctx, { reactions: false, wander: false, celebrate: false })
      fv.advance(1200, 100)
      const fvApi = fv.win.__wisp
      const fvRoot = fv.find('wisp-root')
      const fvMotion = () => fv.all('wisp-video').find((el) => el.removed !== true) ?? null
      const fvImg = () => fv.all('wisp-img').find((el) => el.removed !== true) ?? null

      check(fvApi.doctor().motion.frame.enabled === true && fvApi.doctor().motion.frame.showing === true,
        'the frame animation is on by default', JSON.stringify(fvApi.doctor().motion.frame))

      fvApi.configure({ frame: false })
      const fvOff = fvApi.doctor().motion
      check(fvOff.frame.enabled === false && fvOff.frame.showing === false
        && fvOff.frame.frozen === true
        && fvMotion() !== null && fvMotion().style.display === 'none',
      'switching the frame animation off takes it off screen at once — no reload needed',
      'enabled=' + fvOff.frame.enabled + ' showing=' + fvOff.frame.showing + ' display=' + (fvMotion() && fvMotion().style.display))
      check(mvVis(fvImg()) === 'visible' && fvRoot.dataset.frame === undefined,
        'and the static sprite is what is left on screen — the same hand-over as any other freeze',
        'sprite=' + mvVis(fvImg()) + ' data-frame=' + String(fvRoot.dataset.frame))
      check(fvOff.level === 'full' && fvOff.amp === 1,
        'while the amplitude level is untouched: this switch only takes the animated frames away',
        'level=' + fvOff.level + ' amp=' + fvOff.amp)

      fvApi.configure({ frame: true })
      check(fvApi.doctor().motion.frame.enabled === true && fvApi.doctor().motion.frame.showing === true
        && mvVis(fvImg()) === 'hidden' && fvRoot.dataset.frame === 'on',
      'switching it back on resumes the same element and hands it the picture again',
      'showing=' + fvApi.doctor().motion.frame.showing + ' sprite=' + mvVis(fvImg()) + ' data-frame=' + String(fvRoot.dataset.frame))

      fv.win.__wisp.destroy()
      active = keepFv
    }

    /* ---- 3f-quater. 泳装：素材按**皮肤+状态**点（v1.47.0）------------------------
       这一版最容易错的不是"素材没生成"，而是**接错了**：泳装立绘配通用那段循环
       （穿着泳装播别的皮肤的动作），或者换了皮肤只换了图、没换动图那一层。
       两条都在画面上不报错，所以这里逐个状态点一遍，而且查的是"图 + 几何"两样。 */
    {
      const sw = createHarness({ timer: true, composerText: '' })
      const keepSw = active
      active = sw
      sw.evaluate(clientSrc)
      sw.module().default.apply(sw.ctx, { skin: 'swim', reactions: false, wander: false, celebrate: false })
      sw.advance(1200, 100)
      const swApi = sw.win.__wisp
      const swRoot = sw.find('wisp-root')
      const swMotion = () => sw.all('wisp-video').find((el) => el.removed !== true) ?? null
      const swSprite = () => sw.all('wisp-img').find((el) => el.removed !== true) ?? null
      const fitMap = (() => {
        const src = (/const MOTION_FIT = (\{[^}]*\})/.exec(clientSrc) ?? [])[1]
        try { return src ? new Function(`return ${src}`)() : {} } catch (error) { return {} }
      })()
      check(swApi.skin === 'swim' && swRoot.dataset.mood === 'idle',
        'a companion can start on the swimsuit skin and land in the idle state',
        `skin=${String(swApi.skin)} mood=${String(swRoot.dataset.mood)}`)

      /* 素材在不在，决定这一段**查什么**（见文件上方 SHIPPED_SWIM）：
         八条都在 -> 逐条查"图 + 几何"；
         一条都没有 -> 查她**静默降级**，而且**不许**退回通用那段循环（穿着泳装播别的
                       皮肤的动作，比不动更糟）。两条路都是真的断言，没有空过的一档。 */
      const SWIM = [
        ['idle', 'swim_idle'], ['attn', 'swim_attn'], ['happy', 'swim_happy'],
        ['sleep', 'swim_sleepy'], ['alert', 'swim_work'], ['proud', 'swim_proud'],
        ['eat', 'swim_eat'], ['poked', 'swim_poked'],
      ]
      if (SHIPPED_SWIM.length === 8) {
      const wrongClip = []
      const wrongSrc = []
      const wrongFit = []
      const wrongOwner = []
      for (const [state, clip] of SWIM) {
        swApi.mood(state)
        sw.advance(300, 100)
        const m = swMotion()
        if (String(m?.dataset?.clip ?? '') !== clip) wrongClip.push(`${state}→${String(m?.dataset?.clip)}`)
        const wantSrc = `http://127.0.0.1:19387/wisp-motion/${clip}.webp`
        if (String(m?.src ?? '') !== wantSrc) wrongSrc.push(`${state}→${String(m?.src)}`)
        /* 几何跟着**素材**走：MOTION_FIT 里有就用它，没有就是 none（"不校正"是
           显式规则，不是"忘了写"）—— 换源不换几何就是 v1.46.5 抓到过的那条。 */
        if (String(m?.style?.transform ?? '') !== (fitMap[clip] ?? 'none')) {
          wrongFit.push(`${state}: ${String(m?.style?.transform)} vs ${fitMap[clip] ?? 'none'}`)
        }
        if (m === null || m.style.display === 'none' || mvVis(swSprite()) !== 'hidden') {
          wrongOwner.push(`${state}: display=${String(m?.style?.display)} sprite=${mvVis(swSprite())}`)
        }
      }
      check(wrongClip.length === 0,
        'all eight swimsuit states build THEIR OWN clip — the layer names the clip the skin+state maps to',
        wrongClip.length ? wrongClip.join(' | ') : SWIM.map(([s, c]) => `${s}=${c}`).join(', '))
      check(wrongSrc.length === 0,
        'and each one loads it from the host route, resolved from the page base — no inlined bytes, no stale source',
        wrongSrc.length ? wrongSrc.join(' | ') : `e.g. ${String(swMotion()?.src)}`)
      check(wrongFit.length === 0,
        'and the geometry is chosen PER CLIP — switching the source rewrites the transform with it (v1.46.5 rule, swimsuit edition)',
        wrongFit.length ? wrongFit.join(' | ') : `fit=${JSON.stringify(fitMap)}`)
      check(wrongOwner.length === 0,
        'and while a swimsuit clip plays, the static swimsuit sprite is out of the picture — one of her, never two',
        wrongOwner.length ? wrongOwner.join(' | ') : `sprite=hidden · data-frame=${String(swRoot.dataset.frame)}`)
      check(swApi.doctor().motion.frame.asset === 'swim_poked'
        && String(swApi.doctor().motion.frame.src).endsWith('/wisp-motion/swim_poked.webp'),
        'and doctor() reports both the clip name and where it came from, so "why is she still" is answerable',
        JSON.stringify(swApi.doctor().motion.frame))

      /* 没有素材的状态：worried 在这个皮肤上也没有动作段（它有自己的抖动）——
         这一层必须**藏起来**、立绘回到画面，而不是留一个空盒子。 */
      swApi.mood('worried')
      sw.advance(300, 100)
      check(swMotion() === null || swMotion().style.display === 'none',
        'a swimsuit state with no clip takes the frame layer off screen and hands the picture back',
        `display=${String(swMotion()?.style?.display)} sprite=${mvVis(swSprite())}`)

      /* 换皮肤 = 换一整套**动图**（v1.47.0）：只换图不换动图层，是这一版最容易漏的一处。
         两个方向一起点：泳装 → 深海女仆（回到 deepsea_idle / deepsea_sleepy）。
         1.47.0~1.49.2 之间这一对还能顺便证明"几何也跟着换"（deepsea_sleepy 补 1.186、
         泳装那八条都不补）；**v1.49.3 起两条素材的几何都是 none**（空表），所以这里
         改成查"几何**始终**是 none，而图确实换了" —— 别把"几何一起换"这句话留成
         一条已经不可能失败的断言。 */
      swApi.mood('sleep')
      sw.advance(300, 100)
      const swimSleepTransform = String(swMotion()?.style?.transform ?? '')
      const beforeSkinClip = String(swMotion()?.dataset?.clip ?? '')
      swApi.setSkin('deepsea')
      sw.advance(300, 100)
      check(String(swMotion()?.dataset?.clip ?? '') === 'deepsea_sleepy'
        && String(swMotion()?.src ?? '') === 'http://127.0.0.1:19387/wisp-motion/deepsea_sleepy.webp'
        && String(swMotion()?.style?.transform ?? '') === 'none'
        && swimSleepTransform === 'none',
        'switching the skin re-points the SAME frame layer at that skin’s clip — and the geometry stays identity for both, because the correction table is empty (v1.47.0 / v1.49.3)',
        `${beforeSkinClip} ${swimSleepTransform} → ${String(swMotion()?.dataset?.clip)} ${String(swMotion()?.style?.transform)}`)
      check(swApi.setSkin('swim') === true && String(swMotion()?.dataset?.clip ?? '') === 'swim_sleepy',
        'and switching back returns the swimsuit loop, not another skin’s clip',
        String(swMotion()?.dataset?.clip))
      /* 泳装那八条的"不补"要在**样式表**里也点名（行内那份上面已经按素材逐条对过）。
         v1.49.3 起 base 已经是 none，这条家族规则不再"挡"什么，但它是这一族量过包围盒
         之后的落点（README 1.47.1 那张表），所以断言照旧。 */
      const swimNoneRule = (String(clientSrc).match(/\.wisp-video\[data-clip\^="swim_"\]\{[^}]*\}/) ?? [''])[0]
      check(/transform:none/.test(swimNoneRule) && !/scale\(/.test(swimNoneRule),
        'the stylesheet still carries the explicit "no correction" for the whole swimsuit family — the family-level record of a measured 0.2%~1.6% (v1.47.1 / v1.49.3)',
        swimNoneRule || 'no .wisp-video[data-clip^="swim_"] rule in the bundle')
      } else {
        /* 素材还没生成（0/8）：泳装那一档**一条动图都不该建**，而且**不许**退回通用
           那段循环 —— 她是穿着泳装的人，播别的皮肤的动作比不动更糟。这一条查的就是
           "按皮肤点素材"这件事本身：换一套皮肤，同一个元素该出现/消失。 */
        const leaked = []
        const silent = []
        for (const [state] of SWIM) {
          swApi.mood(state)
          sw.advance(300, 100)
          const m = swMotion()
          if (m !== null && m.style.display !== 'none') leaked.push(`${state}:${String(m.dataset.clip)}`)
          if (mvVis(swSprite()) !== 'visible' || swRoot.dataset.frame === 'on') {
            silent.push(`${state}: sprite=${mvVis(swSprite())} frame=${String(swRoot.dataset.frame)}`)
          }
        }
        check(leaked.length === 0,
          'with no swimsuit clips shipped, NONE of the eight states plays a clip — no other skin’s loop leaks onto the swimsuit skin (v1.47.0)',
          leaked.length ? leaked.join(' | ') : `0/8 clips built across ${SWIM.length} states`)
        check(silent.length === 0 && swApi.doctor().motion.frame.asset === null,
          'and the static swimsuit sprite keeps the picture the whole time — the documented silent degradation, not an empty box',
          silent.length ? silent.join(' | ') : `sprite visible, data-frame=${String(swRoot.dataset.frame)}, doctor.asset=null`)
        /* 反面：同一套素材在**别的皮肤**上照旧播 —— 上一条若是"动图整个坏了"，
           这里会红。两件事必须分得开："这个皮肤没有素材"和"帧动画坏了"。 */
        swApi.mood('sleep')
        sw.advance(300, 100)
        const swimSleepQuiet = swMotion() === null || swMotion().style.display === 'none'
        swApi.setSkin('deepsea')
        sw.advance(300, 100)
        check(swimSleepQuiet && String(swMotion()?.dataset?.clip ?? '') === 'deepsea_sleepy'
          && String(swMotion()?.src ?? '') === 'http://127.0.0.1:19387/wisp-motion/deepsea_sleepy.webp',
          'and switching to a skin WITH clips brings the frame animation straight back — missing swimsuit art is not a broken frame layer',
          `swim/sleep -> ${swimSleepQuiet ? 'no clip' : String(swMotion()?.dataset?.clip)}; deepsea/sleep -> clip=${String(swMotion()?.dataset?.clip)}`)
      }

      sw.win.__wisp.destroy()
      active = keepSw
    }

    /* ---- 3f-quinquies. 原版（canon）：八条按**皮肤+状态**点（v1.49.0）-----------
       这一版做两件互为因果的事：给**默认皮肤** canon 补八条帧动画，并把"通用兜底"
       删掉。两者必须一起成立 —— 兜底还在的时候，canon 有没有自己的素材在画面上
       分辨不出来（她会照常播深海女仆那一段）；兜底删了而 canon 没有素材，默认皮肤
       就**永远不动**。所以这里逐个状态点一遍，查的是"图 + 几何"两样，并且把
       "换皮肤 + 换状态时两层一起换"点成一条断言。 */
    {
      const cn = createHarness({ timer: true, composerText: '' })
      const keepCn = active
      active = cn
      cn.evaluate(clientSrc)
      cn.module().default.apply(cn.ctx, { skin: 'canon', reactions: false, wander: false, celebrate: false })
      cn.advance(1200, 100)
      const cnApi = cn.win.__wisp
      const cnRoot = cn.find('wisp-root')
      const cnMotion = () => cn.all('wisp-video').find((el) => el.removed !== true) ?? null
      const cnSprite = () => cn.all('wisp-img').find((el) => el.removed !== true) ?? null
      const fitMap = (() => {
        const src = (/const MOTION_FIT = (\{[^}]*\})/.exec(clientSrc) ?? [])[1]
        try { return src ? new Function(`return ${src}`)() : {} } catch (error) { return {} }
      })()
      check(cnApi.skin === 'canon' && cnRoot.dataset.mood === 'idle',
        'the original maid is a skin a companion can start on — and it lands in the idle state',
        `skin=${String(cnApi.skin)} mood=${String(cnRoot.dataset.mood)}`)

      const CANON = [
        ['idle', 'canon_idle'], ['attn', 'canon_attn'], ['happy', 'canon_happy'],
        ['sleep', 'canon_sleepy'], ['alert', 'canon_work'], ['proud', 'canon_proud'],
        ['eat', 'canon_eat'], ['poked', 'canon_poked'],
      ]
      if (SHIPPED_CANON.length === 8) {
        const wrongClip = []
        const wrongSrc = []
        const wrongFit = []
        const wrongOwner = []
        const sameClip = []
        const seen = new Set()
        for (const [state, clip] of CANON) {
          cnApi.mood(state)
          cn.advance(300, 100)
          const m = cnMotion()
          if (String(m?.dataset?.clip ?? '') !== clip) wrongClip.push(`${state}→${String(m?.dataset?.clip)}`)
          if (seen.has(clip)) sameClip.push(clip)
          seen.add(clip)
          const wantSrc = `http://127.0.0.1:19387/wisp-motion/${clip}.webp`
          if (String(m?.src ?? '') !== wantSrc) wrongSrc.push(`${state}→${String(m?.src)}`)
          /* 几何跟着**素材**走：MOTION_FIT 里有就用它，没有就是 none（"不校正"是
             显式规则，不是"忘了写"）—— 换源不换几何就是 v1.46.5 抓到过的那条。 */
          if (String(m?.style?.transform ?? '') !== (fitMap[clip] ?? 'none')) {
            wrongFit.push(`${state}: ${String(m?.style?.transform)} vs ${fitMap[clip] ?? 'none'}`)
          }
          if (m === null || m.style.display === 'none' || mvVis(cnSprite()) !== 'hidden') {
            wrongOwner.push(`${state}: display=${String(m?.style?.display)} sprite=${mvVis(cnSprite())}`)
          }
        }
        check(wrongClip.length === 0 && sameClip.length === 0,
          'all eight original-maid states build THEIR OWN clip — one clip per state, none shared, none borrowed from another skin (v1.49.0)',
          wrongClip.length || sameClip.length ? `${wrongClip.join(' | ')}${sameClip.length ? ` · repeated: ${sameClip.join(', ')}` : ''}` : CANON.map(([s, c]) => `${s}=${c}`).join(', '))
        check(wrongSrc.length === 0,
          'and each one loads it from the host route, resolved from the page base — no inlined bytes, no stale source',
          wrongSrc.length ? wrongSrc.join(' | ') : `e.g. ${String(cnMotion()?.src)}`)
        check(wrongFit.length === 0,
          'and the geometry is chosen PER CLIP — switching the source rewrites the transform with it (v1.46.5 rule, original-maid edition)',
          wrongFit.length ? wrongFit.join(' | ') : `fit=${JSON.stringify(fitMap)}`)
        check(wrongOwner.length === 0,
          'and while an original-maid clip plays, the static sprite is out of the picture — one of her, never two',
          wrongOwner.length ? wrongOwner.join(' | ') : `sprite=hidden · data-frame=${String(cnRoot.dataset.frame)}`)
        check(cnApi.doctor().motion.frame.asset === 'canon_poked'
          && String(cnApi.doctor().motion.frame.src).endsWith('/wisp-motion/canon_poked.webp'),
          'and doctor() reports both the clip name and where it came from, so "why is she still" is answerable',
          JSON.stringify(cnApi.doctor().motion.frame))
        /* 样式表那份"不补"要按 canon_ 前缀点名 —— base 那条 1.186 落上来就是放大 18.6%。 */
        const canonNoneRule = (String(clientSrc).match(/\.wisp-video\[data-clip\^="canon_"\]\{[^}]*\}/) ?? [''])[0]
        check(/transform:none/.test(canonNoneRule) && !/scale\(/.test(canonNoneRule),
          'the stylesheet still carries the explicit "no correction" for the whole original-maid family — the family-level record of a measured 0.0%~1.6% (v1.49.0 / v1.49.3)',
          canonNoneRule || 'no .wisp-video[data-clip^="canon_"] rule in the bundle')

        /* 没有素材的状态：worried 在 canon 上也没有动作段（它有自己的抖动）——
           这一层必须**藏起来**、立绘回到画面，而不是留一个空盒子。 */
        cnApi.mood('worried')
        cn.advance(300, 100)
        check(cnMotion() === null || cnMotion().style.display === 'none',
          'an original-maid state with no clip takes the frame layer off screen and hands the picture back',
          `display=${String(cnMotion()?.style?.display)} sprite=${mvVis(cnSprite())}`)

        /* 换皮肤 = 换一整套**动图**（v1.47.0），而且**同一状态**下两套皮肤的素材不同：
           canon/sleep → canon_sleepy，swim/sleep → swim_sleepy，deepsea/sleep →
           deepsea_sleepy。1.47.0~1.49.2 之间这三条的几何是**不一样**的
           （只有 deepsea_sleepy 补 1.186）；v1.49.3 起表空了，三条都是 none ——
           所以这条现在查"同一个元素换的是**图**，几何始终是 identity"。 */
        cnApi.mood('sleep')
        cn.advance(300, 100)
        const canonSleepTransform = String(cnMotion()?.style?.transform ?? '')
        const canonSleepClip = String(cnMotion()?.dataset?.clip ?? '')
        cnApi.setSkin('deepsea')
        cn.advance(300, 100)
        check(String(cnMotion()?.dataset?.clip ?? '') === 'deepsea_sleepy'
          && String(cnMotion()?.src ?? '') === 'http://127.0.0.1:19387/wisp-motion/deepsea_sleepy.webp'
          && String(cnMotion()?.style?.transform ?? '') === 'none'
          && canonSleepTransform === 'none',
          'canon/sleep → deepsea/sleep re-points the SAME element at a different clip — and with an empty correction table the geometry is identity on both sides (v1.47.0 / v1.49.3)',
          `${canonSleepClip} ${canonSleepTransform} → ${String(cnMotion()?.dataset?.clip)} ${String(cnMotion()?.style?.transform)}`)
        cnApi.setSkin('office')          // 一套没有动图素材的皮肤（v1.52.0 起不能用 night —— 它有了）
        cn.advance(300, 100)
        check(cnMotion() === null || cnMotion().style.display === 'none',
          'and switching to a skin with no clips at all takes the layer off screen — the element is not left showing a foreign loop (v1.49.0)',
          `skin=${String(cnApi.skin)} display=${String(cnMotion()?.style?.display)} sprite=${mvVis(cnSprite())}`)
        check(cnApi.doctor().motion.frame.asset === null && cnApi.doctor().motion.frame.showing === false
          && cnApi.doctor().motion.frame.spriteHidden === false
          && String(cnMotion()?.style?.display ?? '') === 'none',
          'and doctor() reports "no clip for this skin+state" with the layer off screen — the element may still exist (it is reused and hidden, never a second grid), but it owns nothing (v1.49.0)',
          JSON.stringify(cnApi.doctor().motion.frame))
        cnApi.setSkin('canon')
        cn.advance(300, 100)
        check(String(cnMotion()?.dataset?.clip ?? '') === 'canon_sleepy'
          && String(cnMotion()?.style?.transform ?? '') === canonSleepTransform
          && cnMotion() !== null && cnMotion().style.display !== 'none',
          'and coming back re-uses the SAME element with canon’s own clip and geometry — no re-build, no stale transform',
          `clip=${String(cnMotion()?.dataset?.clip)} transform=${String(cnMotion()?.style?.transform)}`)
      } else {
        /* 素材还没生成（0/8）：原版那一档**一条动图都不该建**，而且**不许**退回
           别的皮肤那段循环 —— 兜底已经删了，这里查的就是"删干净了没有"。
           这一档本身也是"默认皮肤不动"的诚实记录，不是空过。 */
        const leaked = []
        const silent = []
        for (const [state] of CANON) {
          cnApi.mood(state)
          cn.advance(300, 100)
          const m = cnMotion()
          if (m !== null && m.style.display !== 'none') leaked.push(`${state}:${String(m.dataset.clip)}`)
          if (mvVis(cnSprite()) !== 'visible' || cnRoot.dataset.frame === 'on') {
            silent.push(`${state}: sprite=${mvVis(cnSprite())} frame=${String(cnRoot.dataset.frame)}`)
          }
        }
        check(leaked.length === 0,
          'with no original-maid clips shipped, NONE of the eight states plays a clip — the deleted shared fallback does not leak in (v1.49.0)',
          leaked.length ? leaked.join(' | ') : `0/8 clips built across ${CANON.length} states`)
        check(silent.length === 0 && cnApi.doctor().motion.frame.asset === null,
          'and the static original-maid sprite keeps the picture the whole time — the documented silent degradation, not an empty box',
          silent.length ? silent.join(' | ') : `sprite visible, data-frame=${String(cnRoot.dataset.frame)}, doctor.asset=null`)
      }

      cn.win.__wisp.destroy()
      active = keepCn
    }

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
    /* v1.47.0：挂载时最后写的一次 src 是**动图**那条路由（idle 有素材），所以这里
       要看的是立绘那一串 —— 这条断言问的是"新实例有没有拿到被吊销的 blob"。 */
    const freshSrcs = spriteSrcs().slice(-1)
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
    /* v1.53.0：滑行时长不再是 1700ms 常数，而是**整数个步态周期** —— 所以不能
       推进 6 秒再问她在不在滑行（那时候早走完了）。5200ms 落在 5000ms 那一拍之后。 */
    h.advance(5200, 200)
    const strolled = fifth.position
    check(strolled.x !== 200 || strolled.y !== 200, 'she strolls on her own while idle',
      `200,200 -> ${strolled.x},${strolled.y}`)
    check(Math.abs(strolled.x - 200) <= 200 && Math.abs(strolled.y - 200) <= 200,
      'a stroll stays inside the configured range', `${strolled.x},${strolled.y}`)
    check(fifth.element.dataset.gliding === 'true', 'the stroll is a glide, not a teleport')
    const glideWritten = String(fifth.element.style.getPropertyValue('--wisp-glide-ms'))
    const glideMs = Number(glideWritten.replace('ms', ''))
    check(Number.isFinite(glideMs) && glideMs > 0 && glideMs % 850 === 0,
      'and its length is a whole number of walk cycles — she can never stop mid-stride',
      glideWritten)
    h.advance(2000, 200)
    check(fifth.element.dataset.gliding === undefined, 'the glide class is cleared afterwards')
    check(JSON.parse(h.win.localStorage.getItem('dsh-wisp:position:v1') || '{}').x !== strolled.x,
      'a stroll does not overwrite the position the user chose', h.win.localStorage.getItem('dsh-wisp:position:v1'))

    /* ---- 走路接线（v1.53.0）：素材还没生成，契约先立住 -------------------------
       素材契约在 docs/walk-action-prep.md。这一节钉的是「素材到位那天必须已经成立」的
       四件事：时序（整数个周期）、朝向（按行进方向）、心情（walk）、静默降级（退回 idle）。
       素材不存在时它们照样全部可测 —— 这正是「接线先就位」的意义。 */
    const walkSrc = String(clientSrc)
    const walkCycleMs = Number((/const WALK_CYCLE_MS = (\d+)/.exec(walkSrc) ?? [])[1])
    const walkFrames = Number((/const WALK_FRAMES_PER_CYCLE = (\d+)/.exec(walkSrc) ?? [])[1])
    const walkPerCyclePx = Number((/const WALK_PER_CYCLE_PX = (\d+)/.exec(walkSrc) ?? [])[1])
    check(walkCycleMs === 850 && walkFrames === 25 && walkPerCyclePx === 130,
      'the walk contract lives in one place: 850ms per cycle, 25 frames, 130px of travel',
      `${walkCycleMs}ms / ${walkFrames} frames / ${walkPerCyclePx}px`)
    check(/\[data-gliding="true"\]\{transition:transform var\(--wisp-glide-ms/.test(walkSrc),
      'and the CSS transition reads that same variable, so the two can never disagree')
    check(/const SPRITE_FALLBACK = \{[^}]*walk: 'idle'/.test(walkSrc)
      && /const SPRITE_OF = \{[^}]*walk: 'walk'/.test(walkSrc),
      'and a skin without the walk sprite degrades to idle instead of showing an empty box')
    check(/\|\| mood === 'walk'\) return/.test(walkSrc),
      'while she is walking the steady poll does not yank the mood back mid-stride')
    check(/\{ key: 'walk', mood: 'walk'/.test(walkSrc), 'and the action preview can try it on its own')

    /* 真跑一次：溜达期间应当同时是「滑行中 / walk / 按行进方向镜像」。 */
    const walkFrom = { x: fifth.position.x, y: fifth.position.y }
    h.advance(2900, 100)                       // 越过 wanderMs=5000 那一拍，落在滑行窗口里
    const walkDx = fifth.position.x - walkFrom.x
    check(fifth.element.dataset.mood === 'walk' && fifth.element.dataset.gliding === 'true',
      'a stroll puts her in the walk state for exactly as long as it lasts',
      `mood=${String(fifth.element.dataset.mood)} gliding=${String(fifth.element.dataset.gliding)}`)
    const walkFacing = boxAt(fifth.element.style.transform)
    check(walkDx === 0 || (walkFacing !== null && walkFacing.facing === (walkDx < 0 ? -1 : 1)),
      'and she faces the way she is travelling — otherwise the mirrored sprite walks backwards',
      `dx=${Math.round(walkDx)} facing=${String(walkFacing?.facing)}`)
    h.advance(1600, 200)
    check(fifth.element.dataset.gliding === undefined && fifth.element.dataset.mood === 'idle',
      'when the stroll ends the glide clears and the mood goes back to idle at once',
      `mood=${String(fifth.element.dataset.mood)} gliding=${String(fifth.element.dataset.gliding)}`)

    // 右键：弹出菜单（归位只是其中一项）
    const ctxEvent = (x, y) => ({
      clientX: x, clientY: y, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
    })
    const itemEvent = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} })
    // 菜单挂在 layer 上（与气泡同一层，屏幕坐标系），不是挂在会被镜像/缩放的 root 上
    const menuHost = () => fifth.element.parentNode
    const menuOf = () => menuHost().querySelector('.wisp-menu')
/* itemsOf() 会把**已移除的旧菜单**也返回（替身的既定行为），
       所以凡是数数的地方都先滤掉 removed —— 这个坑在菜单测试里踩过不止一次。
       名字不能用 liveItems：上面的标签菜单那节已经用过（同一作用域）。 */
    const liveMenuItems = () => menuHost().querySelectorAll('.wisp-menu-item').filter((el) => el.removed !== true)
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
      /* v1.49.2："右下角"离边的 26/46 现在量的是**可见像素** —— 替身的假 alpha 左右各留
         25% 盒宽，上下不留，所以 x 要多让出那一块。 */
      const homeX = Math.round(h.win.innerWidth - 26 - b.w * 0.75)
      return { ev, homeX, homeY: h.win.innerHeight - 46 - b.h }
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
    /* ---- 结构：顶层只放动作，其余收进可折叠分组 ----------------------------
       原来 19 个条目全平铺、只靠三行不可点的头部标签分区 —— 那不是结构，是排版。
       现在顶层 7 项，外观 / 行为 / 位置 三组各自折叠。 */
    const topLevel = itemsOf()
    check(topLevel.length === 8, 'the top level stays short',
      `${topLevel.length} 项：${topLevel.map((i) => i.textContent).join(' | ')}`)
    const groupRow = (name) => itemsOf().find((i) => i.dataset && i.dataset.group === name)
    const groupNames = ['外观', '行为', '位置']
    check(groupNames.every((n) => groupRow(n) !== undefined), 'the three groups are there',
      groupNames.map((n) => `${n}=${groupRow(n) ? '有' : '无'}`).join(' '))
    check(groupNames.every((n) => groupRow(n).dataset.open === 'false'),
      'and they start collapsed', groupNames.map((n) => groupRow(n).dataset.open).join(','))
    check(groupNames.every((n) => groupRow(n).getAttribute('aria-expanded') === 'false'),
      'with aria-expanded telling assistive tech the same thing')
    /* 展开一个分组：点它一下，菜单在原地重开，条目多出这一组的孩子 */
    /* 展开/收起**只从 DOM 判断**：分组行自己带着 data-open 与 aria-expanded，
       而 api 这个绑定是第一个替身的（728 行），不是这一节的实例 —— 拿它读菜单状态
       会得到"菜单明明开着、API 却说没开"的假失败（踩过）。 */
    const expand = (name) => {
      const row = groupRow(name)
      if (!row) return false
      row.dispatch('click', itemEvent())
      return groupRow(name) !== undefined && groupRow(name).dataset.open === 'true'
    }
    const collapse = (name) => {
      const row = groupRow(name)
      if (!row) return false
      row.dispatch('click', itemEvent())
      return groupRow(name) !== undefined && groupRow(name).dataset.open === 'false'
    }
    check(expand('外观'), 'clicking a group expands it in place',
      `row=${JSON.stringify(groupRow('外观') ? groupRow('外观').dataset : null)} 项=${itemsOf().length}`)
    check(liveMenuItems().length > 8 && liveMenuItems().length >= skinCount,
      'opening the group adds its entries (大小不再是条目，改成了滑块)',
      `展开后 ${liveMenuItems().length} 项（收起时 8）`)
    check(collapse('外观'), 'clicking it again collapses it')
    check(liveMenuItems().length === 8, 'and the menu is back to its top level', String(liveMenuItems().length))
    const byText = (t) => itemsOf().filter((i) => i.textContent.includes(t))
    expand('外观')
    check(groupRow('外观').getAttribute('aria-expanded') === 'true',
      'and aria-expanded follows the expansion')
    /* 皮肤现在在「外观」组里 —— 上一步已经把该组展开了。 */
    /* 从 API 派生，**不写死皮肤名**。写死过「初版女仆」，改名成「素绘女仆」之后
       三条断言当场全炸，其中一条 undefined.dispatch 还把整个套件截断了。 */
    /* 既有 API 的形状是**有序数组** [{id,label}]，不是 id→label 的对象。 */
    const skinNames = api.skinLabels.map((s) => s.label)
    const plainSkinLabel = (el) => el.textContent.replace(/^[✓　]\s*/, '')
    const skinItems = itemsOf().filter((i) => skinNames.includes(plainSkinLabel(i)))
    check(skinItems.length === skinCount,
      'every shipped skin is offered',
      `${skinItems.length} 项 / ${skinCount} 套；名字表=${JSON.stringify(skinNames)}`)
    check(skinItems.filter((i) => i.textContent.startsWith('✓')).length === 1,
      'exactly one skin is ticked as current',
      skinItems.map((i) => i.textContent).join(' / '))
    check(body5.querySelectorAll('.wisp-menu').length === 0,
      'the menu lives beside her body, not inside it', 'inside it would be mirrored and scale with her')

    /* ---- 重做之后的结构：头部 / 分隔线 / 摘要 / 键盘提示 --------------------
       这一节盯着"交互设计"本身，而不只是"条目在不在"。 */
    const liveMenu = () => menuOf()
    check(liveMenu().querySelectorAll('.wisp-menu-title').length === 1,
      'the menu opens with a header that says who it is',
      liveMenu().querySelectorAll('.wisp-menu-title').map((e) => e.textContent).join(''))
    const headerTitle = liveMenu().querySelector('.wisp-menu-title')
    const headerSub = liveMenu().querySelector('.wisp-menu-sub')
    check(headerTitle !== null && headerTitle.textContent === 'DeepSeek娘',
      'and the name is hers', headerTitle ? headerTitle.textContent : '(没有)')
    check(headerSub !== null && String(headerSub.textContent).includes('v'),
      'the version is visible without opening anything', headerSub ? headerSub.textContent : '(没有)')
    check(liveMenu().querySelectorAll('.wisp-menu-sep').length >= 3,
      'sections are separated instead of stacked flat',
      String(liveMenu().querySelectorAll('.wisp-menu-sep').length))
    check(liveMenu().querySelectorAll('.wisp-menu-hint').length === 1,
      'and the menu tells you how to drive it from the keyboard')

    /* ---- 摘要行：收起时也知道里面是什么 ---- */
    const summaryOf = (name) => {
      const row = groupRow(name)
      if (!row) return null
      const sum = row.querySelector ? row.querySelector('.wisp-menu-sum') : null
      return sum ? String(sum.textContent) : null
    }
    check(summaryOf('外观') === api.skinLabels.find((s) => s.id === fifth.skin).label,
      'the appearance row shows which skin is on', String(summaryOf('外观')))
    check(/^\d+\/\d+ 开$/.test(String(summaryOf('行为'))),
      'the behaviour row counts how many switches are on', String(summaryOf('行为')))
    check(typeof summaryOf('位置') === 'string' && summaryOf('位置').length > 0,
      'the position row says where she is', String(summaryOf('位置')))

    /* ---- 开关：真开关控件，而且点完不关菜单 ---- */
    check(collapse('外观'), 'close the skin group again')
    check(expand('行为'), 'the behaviour group opens')   /* 开关都在这一组里 */
    const switchOf = (key) => itemsOf().find((i) => i.dataset && i.dataset.switchKey === key)
    const switchKeys = ['frame', 'wander', 'reactions', 'celebrate', 'hungry', 'night']
    check(switchKeys.every((k) => switchOf(k) !== undefined), 'every behaviour has a switch row',
      switchKeys.map((k) => k + '=' + (switchOf(k) ? '有' : '无')).join(' '))
    const wanderSwitch = switchOf('wander')
    check(wanderSwitch.getAttribute('role') === 'menuitemcheckbox'
      && wanderSwitch.getAttribute('aria-checked') === 'true',
      'a switch is a checkbox that says whether it is on',
      `role=${wanderSwitch.getAttribute('role')} aria-checked=${wanderSwitch.getAttribute('aria-checked')}`)
    check(wanderSwitch.querySelector('.wisp-switch') !== null
      && wanderSwitch.querySelector('.wisp-switch').dataset.on === 'true',
      'and it has a visible on/off control, not a ✓ in the text')
    const wanderBefore = fifth.config.wander
    wanderSwitch.dispatch('click', itemEvent())
    check(fifth.config.wander === !wanderBefore, 'clicking a switch really flips the config',
      `${wanderBefore} -> ${fifth.config.wander}`)
    check(menuOf() !== null, 'and the menu stays open while you flick switches')
    check(groupRow('行为') && groupRow('行为').dataset.open === 'true',
      'with the group still expanded')
    const flipped = switchOf('wander')
    check(flipped && flipped.getAttribute('aria-checked') === 'false'
      && flipped.querySelector('.wisp-switch').dataset.on === 'false',
      'and the control redraws in its new state',
      flipped ? flipped.getAttribute('aria-checked') : '(没了)')
    flipped.dispatch('click', itemEvent())
    check(fifth.config.wander === wanderBefore, 'toggling back restores it', String(fifth.config.wander))

    /* 帧动画那一格（v1.47.0）：点一下 config 翻面，画面**当场**跟着走（不用刷新）。 */
    const frameSwitch = switchOf('frame')
    const frameBefore = fifth.config.frame
    frameSwitch.dispatch('click', itemEvent())
    check(fifth.config.frame === !frameBefore
      && fifth.doctor().motion.frame.enabled === (fifth.config.frame !== false)
      && fifth.doctor().motion.frame.showing === (fifth.config.frame !== false),
    'the frame-animation switch flips its own config, and the picture follows immediately',
    frameBefore + ' -> ' + fifth.config.frame + ' / enabled=' + fifth.doctor().motion.frame.enabled)
    switchOf('frame').dispatch('click', itemEvent())
    check(fifth.config.frame === frameBefore
      && fifth.doctor().motion.frame.showing === true,
    'and toggling it back hands the picture back to the animation', String(fifth.config.frame))

    /* ---- 滑块：连续量直接调，键盘也能调，而且不关菜单 ---- */
    const sliderEl = menuOf().querySelector ? menuOf().querySelector('.wisp-slider') : null
    check(sliderEl !== null && sliderEl.getAttribute('role') === 'slider',
      'size is a slider, not a pair of nudge buttons',
      sliderEl ? sliderEl.getAttribute('role') : '(没有)')
    const sizeBefore = fifth.config.size
    check(Number(sliderEl.getAttribute('aria-valuenow')) === sizeBefore,
      'and it reports the current size', sliderEl.getAttribute('aria-valuenow'))
    /* 用真实键盘走到滑块：它前面还有 5 个可聚焦项（两个专注 + 三个分组）。
       不调用内部函数 —— 那不是公开面，测它就等于测实现。 */
    const pressKey = (key, shift) => h.win.dispatch('keydown', { key, shiftKey: shift === true, preventDefault() {}, stopPropagation() {} })
    /* 先把两个展开过的分组收起来：展开的组会把子项插进可聚焦序列，
       焦点顺序就不确定了 —— 不依赖"第几次方向键刚好落在滑块上"这种脆弱假设。 */
    /* 那时它们本来就是收起的 —— 断言"collapse 成功"会假失败，改成"确保是收起的"。 */
    const ensureCollapsed = (name) => {
      const row = groupRow(name)
      if (row && row.dataset.open === 'true') collapse(name)
      return groupRow(name) !== undefined && groupRow(name).dataset.open === 'false'
    }
    check(ensureCollapsed('外观') && ensureCollapsed('行为'),
      'both groups are collapsed, so the focus order is stable')
    /* 判断"焦点在滑块上"要看**当前**那个元素：菜单每次重画都会换新元素，
       用之前抓到的 sliderEl 做同一性比较会假失败（收起分组就重画过）。 */
    const focusedIsSlider = () => {
      const el = h.document.activeElement
      return Boolean(el && el.dataset && el.dataset.slider === '1')
    }
    /* 走到滑块：Home 回到第一项，然后一直往下，直到焦点真的落在滑块上。
       不数"第几次" —— 可聚焦项的数量会随分组展开变化，数次数是脆的。 */
    const focusSlider = () => {
      h.win.dispatch('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} })
      for (let i = 0; i < 16; i++) {
        if (focusedIsSlider()) return true
        pressKey('ArrowDown')
      }
      return focusedIsSlider()
    }
    check(focusSlider(), 'the slider is reachable with the arrow keys',
      h.document.activeElement ? String(h.document.activeElement.className) : '(没有焦点)')
    pressKey('ArrowRight')
    check(Math.abs(fifth.config.size - (sizeBefore + 0.1)) < 1e-9,
      'ArrowRight grows her by exactly one step', `${sizeBefore} -> ${fifth.config.size}`)
    check(menuOf() !== null && focusedIsSlider(),
      'and it neither closes the menu nor steals focus from the slider',
      menuOf() === null ? '菜单关了' : String(h.document.activeElement && h.document.activeElement.className))
    pressKey('ArrowLeft')
    check(Math.abs(fifth.config.size - sizeBefore) < 1e-9, 'ArrowLeft shrinks it back', String(fifth.config.size))
    const valueLabel = menuOf().querySelector('.wisp-slider-value')
    check(valueLabel !== null && valueLabel.textContent === Math.round(fifth.config.size * 100) + '%',
      'and the percentage label follows', valueLabel ? valueLabel.textContent : '(没有)')

    /* ---- 位置：2×2 的方位控件 ---- */
    check(expand('位置'), 'the position group opens')
    /* 角落按钮现在在「位置」的子面板里 —— 面板是菜单的兄弟节点，所以查询落在 layer 上 */
    const gridButtons = menuHost().querySelectorAll('.wisp-corner').filter((el) => el.removed !== true)
    check(gridButtons.length === 4, 'the four corners are a 2×2 compass, not four text rows',
      String(gridButtons.length) + ' 个')
    /* 她此刻并不在任何角落（位置是拖出来的），所以先点一个角落归位，再看标记。 */
    const toTopLeft = gridButtons.find((b) => b.dataset && b.dataset.corner === '左上角')
    toTopLeft.dispatch('click', itemEvent())
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(expand('位置'), 'reopen the position group')
    const marked = menuHost().querySelectorAll('.wisp-corner')
      .filter((b) => b.removed !== true && b.dataset && b.dataset.current === 'true')
    check(marked.length === 1 && marked[0].dataset.corner === '左上角',
      'and the corner she is actually in is marked',
      menuHost().querySelectorAll('.wisp-corner').filter((b) => b.removed !== true)
        .map((b) => b.textContent + (b.dataset.current ? '*' : '')).join(' '))

    /* ---- 级联子菜单：悬停展开、移开收起 --------------------------------------
       这是**菜单栏**的形状：悬停一行，在它**旁边**开一个独立面板，而不是把下面的内容推下去。
       替身里没有真鼠标，但它有事件派发 + 虚拟时钟，所以状态机能被完整测到：
       派 pointerenter/pointerleave、推进时钟、看面板有没有出现、出现在哪一侧。
       测不到的是浏览器的命中测试本身（"指针真的在这一行上"）—— 那由冒烟里的真 Chromium 兜着。 */
    const flyoutOf = (name) => menuHost().querySelectorAll('.wisp-submenu')
      .find((el) => el.dataset && el.dataset.submenu === name && el.removed !== true) ?? null
    const rowOf = (name) => groupRow(name)
    const hoverIn = (name, pointerType) => rowOf(name).dispatch('pointerenter', { pointerType })
    const hoverOut = (name, pointerType) => rowOf(name).dispatch('pointerleave', { pointerType })
    const isOpen = (name) => {
      const row = rowOf(name)
      return row !== undefined && row.dataset.open === 'true'
    }

    groupRow('外观').dispatch('click', itemEvent()); groupRow('外观').dispatch('click', itemEvent())
    check(!isOpen('外观') && flyoutOf('外观') === null, 'no submenu is open at the start')

    /* 悬停要**有延迟**：鼠标只是路过就弹出面板会抖 —— 这是 hover intent */
    hoverIn('外观', 'mouse')
    check(flyoutOf('外观') === null && !isOpen('外观'),
      'hovering does not pop a submenu instantly (a passing mouse would twitch it)')
    h.advance(200, 40)
    check(flyoutOf('外观') !== null && isOpen('外观'), 'after the intent delay the submenu appears')
    check(rowOf('外观').getAttribute('aria-haspopup') === 'true'
      && rowOf('外观').getAttribute('aria-expanded') === 'true',
      'and the row says it has a submenu and that it is open',
      `haspopup=${rowOf('外观').getAttribute('aria-haspopup')} expanded=${rowOf('外观').getAttribute('aria-expanded')}`)

    /* 关键：面板是**菜单的兄弟**（浮在旁边），不是菜单里把内容推下去的块 */
    const panel = flyoutOf('外观')
    check(panel.parentNode === menuHost(),
      'the submenu is a sibling of the menu, floating beside it')
    check(String(panel.style.left) !== '' && String(panel.style.top) !== '',
      'and it is positioned', `left=${panel.style.left} top=${panel.style.top}`)
    check(String(panel.style.left) !== String(menuOf().style.left),
      'not stacked on top of the menu', `panel=${panel.style.left} menu=${menuOf().style.left}`)

    /* 移开：延迟后收起 */
    hoverOut('外观', 'mouse')
    h.advance(80, 40)
    check(flyoutOf('外观') !== null, 'leaving the row does not close it instantly')
    h.advance(400, 40)
    check(flyoutOf('外观') === null && !isOpen('外观'), 'after the grace period it closes')

    /* 指针移进**面板**本身：算同一区域，不能关 */
    hoverIn('外观', 'mouse')
    h.advance(200, 40)
    const panel2 = flyoutOf('外观')
    /* 顺序要照真实浏览器：指针从行移到面板，先触发行的 leave、再触发面板的 enter。
       写反了的话"面板 enter 取消关闭"就被后面的 leave 又覆盖掉了。 */
    hoverOut('外观', 'mouse')
    panel2.dispatch('pointerenter', { pointerType: 'mouse' })
    h.advance(600, 40)
    check(flyoutOf('外观') !== null,
      'moving the pointer onto the panel keeps it open (row and panel are one region)')
    panel2.dispatch('pointerleave', { pointerType: 'mouse' })
    h.advance(600, 40)
    check(flyoutOf('外观') === null, 'leaving the panel closes it')

    /* 路过不弹出 */
    hoverIn('行为', 'mouse')
    hoverOut('行为', 'mouse')
    h.advance(800, 40)
    check(flyoutOf('行为') === null, 'a mouse that just passes over never pops a submenu')

    /* 触屏：不判 pointerType 的话，手指一碰就会弹面板 */
    hoverIn('外观', 'touch')
    h.advance(600, 40)
    check(flyoutOf('外观') === null, 'a touch pointer never opens a submenu by hovering')
    groupRow('外观').dispatch('click', itemEvent())
    check(flyoutOf('外观') !== null, 'but tapping the row still works')

    /* 点击 = 钉住：移开也不关；再点一次收起 */
    hoverOut('外观', 'mouse')
    h.advance(800, 40)
    check(flyoutOf('外观') !== null, 'a submenu you clicked stays open when the mouse leaves')
    groupRow('外观').dispatch('click', itemEvent())
    check(flyoutOf('外观') === null, 'clicking the row again closes it')

    /* 手风琴：悬停到另一行时，上一个面板让位 */
    groupRow('外观').dispatch('click', itemEvent())
    check(flyoutOf('外观') !== null, 'pin one open again')
    hoverIn('行为', 'mouse')
    h.advance(200, 40)
    check(flyoutOf('行为') !== null && flyoutOf('外观') === null,
      'hovering another row opens its submenu and closes the previous one',
      `外观=${flyoutOf('外观') !== null} 行为=${flyoutOf('行为') !== null}`)

    /* 键盘：→ 进子菜单、← 回父行、Esc 逐层退出 */
    const focusedIs = (pred) => {
      const el = h.document.activeElement
      return Boolean(el && pred(el))
    }
    const focusRow = (name) => {
      pressKey('Home')
      for (let i = 0; i < 16; i++) {
        if (focusedIs((el) => el.dataset && el.dataset.group === name)) return true
        pressKey('ArrowDown')
      }
      return false
    }
    check(focusRow('位置'), 'keyboard focus can land on a group row')
    pressKey('ArrowRight')
    check(flyoutOf('位置') !== null, 'ArrowRight opens the submenu beside it')
    check(focusedIs((el) => el.className.indexOf('wisp-corner') >= 0),
      'and focus moves into it', String(h.document.activeElement && h.document.activeElement.className))
    pressKey('ArrowLeft')
    check(flyoutOf('位置') === null, 'ArrowLeft closes it')
    check(focusedIs((el) => el.dataset && el.dataset.group === '位置'),
      'and hands focus back to the row',
      String(h.document.activeElement && h.document.activeElement.dataset && h.document.activeElement.dataset.group))
    pressKey('ArrowRight')
    check(flyoutOf('位置') !== null, 'open it again for the Escape check')
    pressKey('Escape')
    check(flyoutOf('位置') === null && menuOf() !== null,
      'Escape closes the submenu first and leaves the menu open (one layer at a time)',
      `面板=${flyoutOf('位置') === null ? '关了' : '还开着'} 菜单=${menuOf() === null ? '被关了' : '还开着'}`)
    pressKey('Escape')
    check(menuOf() === null, 'and a second Escape closes the menu')
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu reopens for the remaining structure checks')

    /* ---- 菜单里不该再有"版本与更新"：版本号在头部，检查更新在弹窗里 ---- */
    check(!itemsOf().some((i) => i.textContent.includes('版本与更新')),
      'the version entry is gone from the menu (the header shows it now)')
    check(itemsOf().some((i) => i.textContent.includes('关于她')),
      'but 关于她 is still reachable')

    check(body5.querySelectorAll('.wisp-menu').length === 0,
      'the menu lives beside her body, not inside it', 'inside it would be mirrored and scale with her')

    // 换皮肤：精灵图必须真的换掉，位置和情绪不能动。
    // 自己开菜单，不依赖上一节留下的状态 —— 隐含的跨节状态是测试脆弱性的常见来源。
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu opens for the skin checks')
    check(expand('外观'), 'and the skins group can be opened')
    const skinBefore = fifth.skin
    const posBefore = fifth.position
    const padBeforeSkin = fifth.doctor().bounds.visible.left   // 盒左 → 可见左边
    const srcBeforeSkin = spriteSrcs().at(-1)
    /* 同样不写死名字：挑一套「和当前不同」的皮肤，用它的显示名去点菜单 */
    const targetSkin = fifth.skins.find((id) => id !== skinBefore)
    const targetLabel = fifth.skinLabels.find((s) => s.id === targetSkin).label
    const targetEl = itemsOf().filter((i) => i.textContent.replace(/^[✓　]\s*/, '') === targetLabel)[0]
    check(targetEl !== undefined, 'the other skin has a menu entry', String(targetSkin))
    targetEl.dispatch('click', itemEvent())
    check(fifth.skin === targetSkin, 'choosing a skin switches to it', String(fifth.skin))
    check(fifth.skin !== skinBefore, 'and it is a different skin than before', `${skinBefore} -> ${fifth.skin}`)
    check(spriteSrcs().at(-1) !== srcBeforeSkin, 'the sprite is swapped for the new skin',
      `${String(srcBeforeSkin).slice(0, 22)} -> ${String(spriteSrcs().at(-1)).slice(0, 22)}`)
    /* v1.49.2：换皮肤 = 换一张留白不同的图。贴着边的换完还贴着边（位置数值会变，但
       **可见像素到屏幕边的距离**不变）；本来不在边上的，原地不动。 */
    const visibleLeftBefore = posBefore.x + padBeforeSkin
    const visibleLeftAfter = fifth.position.x + fifth.doctor().bounds.visible.left
    const wasGlued = Math.abs(visibleLeftBefore) <= 1
    check(wasGlued ? Math.abs(visibleLeftAfter) <= 1 : fifth.position.x === posBefore.x,
      'switching skins keeps a glued edge glued and a free position untouched',
      `glued=${wasGlued} visibleLeft ${visibleLeftBefore} -> ${visibleLeftAfter}, x ${posBefore.x} -> ${fifth.position.x}`)
    check(JSON.parse(h.win.localStorage.getItem('dsh-wisp:skin:v1') || 'null')?.id === targetSkin,
      'the choice is remembered', h.win.localStorage.getItem('dsh-wisp:skin:v1'))
    check(fifth.setSkin('no-such-skin') === false && fifth.skin === targetSkin,
      'an unknown skin name is refused rather than blanking her', String(fifth.skin))
    check(fifth.configure({ skin: 'deepsea' }) && fifth.skin === 'deepsea',
      'configure({skin}) goes through the same path as the menu', String(fifth.skin))

    /* v1.48.2：默认皮肤 = 列表**第一位** = canon（原版女仆）。
       默认值由 build.mjs 的 SKIN_PRIORITY 决定（首位即默认），所以这一条同时钉住两件事。 */
    check(fifth.skins[0] === 'canon',
      'the default skin is 原版女仆 (canon) and it leads the skin list',
      fifth.skins.slice(0, 4).join(', '))

    // 大小现在是滑块：用键盘调（不关菜单），再用菜单动作验证"选了就关"
    body5.dispatch('contextmenu', rightClickOnHer().ev)
    check(menuOf() !== null, 'the menu opens for the size check')
    const sizeSlider = menuOf().querySelector('.wisp-slider')
    check(sizeSlider !== null, 'the slider is there')
    h.win.dispatch('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} })
    for (let i = 0; i < 5; i++) {
      h.win.dispatch('keydown', { key: 'ArrowDown', preventDefault() {}, stopPropagation() {} })
    }
    h.win.dispatch('keydown', { key: 'ArrowRight', preventDefault() {}, stopPropagation() {} })
    h.win.dispatch('keydown', { key: 'ArrowRight', preventDefault() {}, stopPropagation() {} })
    check(fifth.element.style.width === '588px' && fifth.element.style.height === '882px',
      'the slider really resized her (two steps up)', `${fifth.element.style.width}x${fifth.element.style.height}`)
    check(menuOf() !== null, 'and the slider keeps the menu open, unlike an action row')
    h.win.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
    check(menuOf() === null, 'Escape closes it when you are done')

    // 再右键一次，用「回到右下角」归位（此时她已经被放大了，兜底尺寸要跟着变）
    const secondClick = rightClickOnHer()
    body5.dispatch('contextmenu', secondClick.ev)
    check(menuOf() !== null, 'the menu reopens')
    check(expand('位置'), 'the corners live in the position group')
    const homeBtn = menuHost().querySelectorAll('.wisp-corner')
      .find((b) => b.removed !== true && b.dataset && b.dataset.corner === '右下角')
    check(Boolean(homeBtn), 'the corner button is there')
    homeBtn.dispatch('click', itemEvent())
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
    check(kbd().at?.className === 'wisp-menu-item' && /^专注 /.test(String(kbd().label)),
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
    /* ---- 焦点环：不能是浏览器默认那个矩形 ------------------------------------
       用户报的"有时会出现素材的矩形边界线"就是它：默认焦点环画在 .wisp-body 这个
       560×840 的盒子上，而盒子里大部分是透明的 —— 屏幕上于是浮着一个套住素材的
       矩形线框。修法是两半，缺一不可：默认环关掉（样式表 + 行内各一份），键盘焦点
       改用**贴着剪影**的辉光表达（drop-shadow 跟的是 alpha 剪影，任何尺寸都不是矩形）。 */
    const ringCss = String(h.styleInserts[0] ?? '')
    check(/\.wisp-body:focus[^{]*\{[^}]*outline\s*:\s*(none|0)/.test(ringCss),
      'the browser default focus ring is switched off for her box (it draws a rectangle around the sprite)',
      (ringCss.match(/[^{}]*\.wisp-body:focus[^{]*\{[^}]*\}/) ?? ['(no such rule)'])[0].slice(0, 96))
    check(body5.style.outline === 'none',
      'and the inline mirror says the same, so a shell without the stylesheet does not get the box back',
      String(body5.style.outline))
    check(/\[data-focus="key"\]\{[^}]*--wisp-glow\s*:[^}]*drop-shadow\([^)]*var\(--wisp-accent\)/.test(ringCss)
      && /\.wisp-img\{[^}]*filter:var\(--wisp-glow\)\s*var\(--wisp-sprite\)/.test(ringCss),
      'keyboard focus stays visible: an accent halo that follows her silhouette instead of a box',
      (ringCss.match(/\[data-focus="key"\]\{[^}]*\}/) ?? ['(no such rule)'])[0].slice(0, 96))
    /* Esc 关掉菜单 = 键盘路径：焦点交还给她，指示必须亮（上面刚走完这条路）。 */
    check(fifth.element.dataset.focus === 'key',
      'focus handed back by the keyboard lights the halo',
      String(fifth.element.dataset.focus))
    /* 鼠标点她也会把焦点交给她（onDown 里的 focusHer）—— 那一下**什么都不该画**，
       否则就退回用户看到的那条矩形边界线。 */
    body5.blur()
    h.win.dispatch('pointerdown', { clientX: 400, clientY: 300 })
    body5.focus()
    check(fifth.element.dataset.focus === undefined,
      'a pointer-driven focus paints nothing at all — no box, no halo',
      String(fifth.element.dataset.focus))
    /* 反过来也必须成立：关掉默认环**不能**变成"键盘用户什么都看不见"。 */
    body5.blur()
    h.win.dispatch('keydown', { key: 'Tab' })
    body5.focus()
    check(fifth.element.dataset.focus === 'key',
      'and keyboard focus lights it again — switching the default ring off must not blind keyboard users',
      String(fifth.element.dataset.focus))
    body5.blur()
    check(fifth.element.dataset.focus === undefined,
      'the halo is gone the moment focus leaves her',
      String(fifth.element.dataset.focus))

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
    /* 四个角落现在是 2×2 罗盘里的按钮（不是 .wisp-menu-item），所以单独一个选择器。 */
    const pickCorner = (inst, text) => {
      const found = inst.element.parentNode.querySelectorAll('.wisp-corner')
        .filter((i) => i.dataset && i.dataset.corner === text)
      if (found.length !== 1) return false
      found[0].dispatch('click', itemEvent())
      return true
    }
    /* 菜单改成分组之后，组里的条目要先把组展开才看得见。
       这个 helper 让"点某个分组里的东西"是一次调用，而不是每处各写一遍。 */
    const openGroupOn = (inst, name) => {
      const host = inst.element.parentNode
      const row = host.querySelectorAll('.wisp-menu-item').find((i) => i.dataset && i.dataset.group === name)
      if (!row) return false
      row.dispatch('click', itemEvent())
      return host.querySelectorAll('.wisp-menu-item')
        .some((i) => i.dataset && i.dataset.group === name && i.dataset.open === 'true')
    }
    // 四个角落。期望值按【当前】尺寸算 —— 写死尺寸的话，一旦尺寸变了断言会
    // 指着正确的实现说它错。
    const cur = boxOf(pinned)
    /* v1.49.2：角落的"距边 26 / 46"量的是**可见像素**的边。替身的假 alpha 左右各留 25%
       盒宽、每一行都不透明（上下不留白），所以左右要多让出 25%，上下照旧。 */
    const visibleLeftEdge = Math.round(cur.w * 0.25)     // 盒左 → 可见左边
    const visibleRightEdge = Math.round(cur.w * 0.75)    // 盒左 → 可见右边
    const EXPECT = {
      '左上角': { x: 26 - visibleLeftEdge, y: 46 },
      '左下角': { x: 26 - visibleLeftEdge, y: h.win.innerHeight - 46 - cur.h },
      '右上角': { x: h.win.innerWidth - 26 - visibleRightEdge, y: 46 },
      '右下角': { x: h.win.innerWidth - 26 - visibleRightEdge, y: h.win.innerHeight - 46 - cur.h },
    }
    for (const [label, want] of Object.entries(EXPECT)) {
      openMenuOn(pinned)
      openGroupOn(pinned, '位置')     // 四个角落现在收在「位置」组里，而且是罗盘按钮
      const hit = pickCorner(pinned, label)
      check(hit && pinned.position.x === want.x && pinned.position.y === want.y,
        `the ${label} item puts her there`, `${pinned.position.x},${pinned.position.y} (want ${want.x},${want.y})`)
    }
    /* v1.49.2：**留白不同的图必须落在同一个地方**（可见的像素不动，留白由坐标吸收）。
       单开一个 harness：它的蒙版留白按 maskMargins 轮换，于是"换一套皮肤"就等于
       "换一张留白不同的图"，而别的 section 的蒙版形状断言仍然按固定的 25% 写。 */
    const mm = createHarness({ timer: true, composerText: '', maskMargins: [0.25, 0.4] })
    const mmKeep = active
    active = mm
    mm.evaluate(clientSrc)
    mm.module().default.apply(mm.ctx, { reactions: false, wander: false })
    mm.advance(60, 10)
    const mmApi = mm.win.__wisp
    const mmVisible = () => mmApi.doctor().bounds.visible
    /* "离屏幕边多远"是**屏幕坐标**里的事，所以断言也写在屏幕坐标里。 */
    const mmGaps = () => {
      const v = mmVisible()
      return {
        right: Math.round(mm.win.innerWidth - (mmApi.position.x + v.right)),
        left: Math.round(mmApi.position.x + v.left),
        bottom: Math.round(mm.win.innerHeight - (mmApi.position.y + v.bottom)),
      }
    }
    /* 把她放到靠近右下角的位置：这时她"更靠近的边"就是右边和底边。 */
    mmApi.move(mm.win.innerWidth - 700, mm.win.innerHeight - 900)
    mm.advance(20, 10)
    const marginBefore = mmVisible().right
    const gapsBefore = mmGaps()
    const mmOther = mmApi.skins.find((id) => id !== mmApi.skin)
    mmApi.configure({ skin: mmOther })
    mm.advance(80, 10)
    const marginAfter = mmVisible().right
    const gapsAfter = mmGaps()
    check(marginAfter !== marginBefore
      && Math.abs(gapsAfter.right - gapsBefore.right) <= 1
      && Math.abs(gapsAfter.bottom - gapsBefore.bottom) <= 1,
      'a figure with a DIFFERENT transparent margin keeps the same distance from the screen edge she sits against',
      `margin ${marginBefore}->${marginAfter}, right gap ${gapsBefore.right}->${gapsAfter.right}, bottom gap ${gapsBefore.bottom}->${gapsAfter.bottom}`)
    mmApi.destroy()
    active = mmKeep

    pinned.destroy()

    /* v1.48.3：菜单里调过的**每一项**都要活过刷新，不只尺寸。
       「动作幅度」是最容易被当成"没实现"的那一个 —— 点完当场生效、刷新回默认，
       用户看到的就是"拨了半天她还是那样动"。 */
    plugin.apply(h.ctx, { reactions: false, wander: false })
    const lvl = h.win.__wisp
    lvl.configure({ motion: 'off', frame: false, sway: false })
    check(lvl.doctor().motion.level === 'off' && lvl.doctor().motion.frame.enabled === false
      && lvl.doctor().motion.sway.enabled === false,
      'the level, the frame switch and the sway switch all apply at once',
      JSON.stringify({ level: lvl.doctor().motion.level, frame: lvl.doctor().motion.frame.enabled, sway: lvl.doctor().motion.sway.enabled }))
    lvl.destroy()
    plugin.apply(h.ctx, { reactions: false, wander: false })
    const lvlBack = h.win.__wisp
    check(lvlBack.doctor().motion.level === 'off' && lvlBack.doctor().motion.frame.enabled === false
      && lvlBack.doctor().motion.sway.enabled === false,
      'and they survive a remount — every menu choice is remembered, not just the size',
      JSON.stringify({ level: lvlBack.doctor().motion.level, frame: lvlBack.doctor().motion.frame.enabled, sway: lvlBack.doctor().motion.sway.enabled }))
    lvlBack.destroy()
    plugin.apply(h.ctx, { reactions: false, wander: false, motion: 'full' })
    const lvlPinned = h.win.__wisp
    check(lvlPinned.doctor().motion.level === 'full',
      'while an explicit config value still beats the remembered choice', lvlPinned.doctor().motion.level)
    lvlPinned.destroy()

    /* v1.49.0：选完档位**当场演一遍**。不演的话用户只能看到两个标签 ——
       "灵动 / 克制"的差别本来就细，这正是"拨了好像没用"的来源。 */
    plugin.apply(h.ctx, { reactions: false, wander: false })
    const demo = h.win.__wisp
    const pickLevel = (text) => {
      const btns = demo.element.parentNode.querySelectorAll('.wisp-choice-opt')
        .filter((b) => b.textContent === text)
      if (btns.length !== 1) return false
      btns[0].dispatch('click', itemEvent())
      return true
    }
    openMenuOn(demo)
    check(openGroupOn(demo, '行为') !== false, 'the behaviour group opens for the amplitude row')
    /* 分组子菜单里**每一个** choice 行都必须真的渲染出胶囊（v1.49.0 修）。
       分组改版时子菜单那条路自己抄了一份渲染循环、漏了 choice —— 于是「台词语言」
       和「动作幅度」变成一个点了没反应的普通行（没有 run，异常被吞），
       "这个功能好像没实现"就是这么来的。 */
    const demoPills = demo.element.parentNode.querySelectorAll('.wisp-choice-opt')
      .map((b) => String(b.textContent))
    check(demoPills.indexOf('克制') >= 0 && demoPills.indexOf('灵动') >= 0
      && demoPills.indexOf('静止') >= 0 && demoPills.indexOf('中文') >= 0,
      'every choice row inside a group flyout really renders its pills, not a dead plain row',
      demoPills.join('|'))
    check(pickLevel('克制') === true, 'the amplitude row offers 「克制」')
    const demoRestrained = demo.doctor()
    check(demoRestrained.motion.level === 'subtle' && demoRestrained.motion.accent !== null
      && Math.abs(demoRestrained.motion.tilt) > 0,
      'picking a level demonstrates it on the spot — a pop and a lean, at that level',
      JSON.stringify({ level: demoRestrained.motion.level, amp: demoRestrained.motion.amp, accent: demoRestrained.motion.accent, tilt: demoRestrained.motion.tilt, tiltLocal: demoRestrained.motion.tiltLocal, css: demo.element.style.getPropertyValue('--wisp-tilt') }))
    h.advance(1000, 50)
    check(demo.doctor().motion.tilt === 0, 'and the demo lean settles back on its own',
      String(demo.doctor().motion.tilt))
    pickLevel('静止')
    const demoStill = demo.doctor()
    check(demoStill.motion.level === 'off' && demoStill.motion.accent === null && demoStill.motion.tilt === 0,
      'while the still level demonstrates nothing at all — no gesture, no lean',
      JSON.stringify({ level: demoStill.motion.level, accent: demoStill.motion.accent, tilt: demoStill.motion.tilt }))
    demo.destroy()

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
      soakApi.setSkin(i % 2 === 0 ? 'lab' : 'deepsea')
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

    /* 皮肤来回换 120 次，如果 blob URL 每轮都新建，这里会是 120+ —— 缓存命中应该是常数。
       上限 12 -> 13：v1.45.0 起那段帧动画素材也走同一条 Blob 通道，它**只该解一次**
       （这一轮里她睡着了 60 次）。v1.46.5 再 +1 = 14：idle 也接上了素材（挂载时解一次，
       120 轮里她醒着 60 次，一次都不该重解）。
       **v1.47.0 起动图不再走 Blob**（它是宿主路由下的文件 URL），所以这个数只数立绘。
       **v1.48.2 再 +1 = 15**：默认皮肤从 deepsea 换成 canon，而这一轮 soak 只在
       classic / deepsea 之间来回切 —— 挂载时多出来的 canon 那一张是**新的第三套**，
       所以上界跟着 +1（仍然与切换次数无关，120 次切换一个都不多）。 */
    check(soak.urLs.length <= 15,
      'switching skins reuses cached blob URLs instead of minting new ones',
      `${soak.urLs.length} object URLs ever created across ${Array.isArray(api.skins) ? api.skins.length : 0} skins and ${CYCLES} switches`)
    /* 反过来钉"没有被内联回来"：只要有一份 MB 级的 image/webp blob，就说明构建又把
       素材塞进单文件了 —— 那正是 1.47.0 要修的那件事（八条泳装 +30 MB ⇒ ~45 MB）。
       同时要求这一轮里动图的 src **一直是那条路由**：换皮肤、换状态都不许退回 data:。 */
    const soakClipBlobs = soak.blobs.filter((b) => String(b.type) === 'image/webp' && b.size > 1024 * 1024)
    const soakMotion = soak.srcs.filter((s) => typeof s === 'string' && s.indexOf('/wisp-motion/') >= 0)
    check(soakClipBlobs.length === 0 && soakMotion.length > 0
      && soakMotion.every((s) => /^http:\/\/127\.0\.0\.1:19387\/wisp-motion\/[A-Za-z0-9._-]+\.webp$/.test(s)),
      'every frame-animation source stays on the host route across the whole soak - nothing multi-megabyte is decoded or inlined (v1.47.0)',
      `${soakClipBlobs.length} MB-scale clip blob(s); ${soakMotion.length} route src(s)`)

    soakApi.destroy()
    check(soak.pendingTimers().length === 0 && soak.revoked.length === soak.urLs.length,
      'teardown still releases everything after the soak',
      `timers=${soak.pendingTimers().length}, revoked ${soak.revoked.length}/${soak.urLs.length}`)
    active = keepSoak
  } catch (error) {
    bad('browser half executes', `${error.constructor.name}: ${error.message}`)
    if (error && error.stack) console.log(String(error.stack).split('\n').slice(0, 6).map((l) => '        ' + l.trim()).join('\n'))
    console.log(error.stack)
  } finally {
    active = null
    for (const [key, value] of Object.entries(savedGlobals)) globalThis[key] = value
  }
}

/* ================================================== 3y. dialogs ============ */
head('3y. dialogs: about her, and the action preview')

/* 菜单顶层只留动作，"她是谁"和"她有哪些动作"放进弹窗。这里测的就是这两个弹窗：
   能不能开、内容对不对、三种关法，以及**反复开合不会把文档级监听越堆越多**
   （那是真写进去过的 bug：清理函数是个空壳）。 */
{
  const dlg = createHarness({ timer: true, composerText: '' })
  const keepDlg = active
  active = dlg
  dlg.evaluate(clientSrc)
  dlg.module().default.apply(dlg.ctx, { reactions: true, wander: false, celebrate: false })
  dlg.advance(1300, 100)
  const dlgApi = dlg.win.__wisp
  const bundleVersion = /const VERSION = '([^']+)'/.exec(clientSrc)?.[1] ?? null

  /* 替身的 find() 会把已移除的节点也返回（它自己的约定），所以要显式认 removed。 */
  const dialogGone = () => {
    const el = dlg.find('wisp-dialog')
    return el === null || el.removed === true
  }
  /* 按段落/页脚类读文本：简化 DOM 不会汇总子节点 textContent，读卡片本身只会得到空串。 */
  const dialogText = () => [].concat(
    dlg.all('wisp-dialog-p').filter((el) => el.removed !== true).map((el) => String(el.textContent)),
    dlg.all('wisp-dialog-foot-l').filter((el) => el.removed !== true).map((el) => String(el.textContent)),
    dlg.all('wisp-dialog-foot-r').filter((el) => el.removed !== true).map((el) => String(el.textContent)),
  ).join('\n')

  check(dlgApi.dialog === null, 'nothing is open at the start', String(dlgApi.dialog))
  check(dialogGone(), 'and no dialog sits in the DOM before it is asked for')

  dlgApi.openAbout()
  check(dlgApi.dialog === 'about', 'asking about her opens the about dialog', String(dlgApi.dialog))
  const card = dlg.find('wisp-dialog')
  check(card !== null, 'the dialog card is in the DOM')
  check(dlg.find('wisp-dialog-backdrop') !== null, 'with a backdrop behind it')
  const aboutText = dialogText()
  check(aboutText.includes('DeepSeek娘'), 'it says who she is')
  check(bundleVersion !== null && aboutText.includes(bundleVersion),
    'and which version this is', `${bundleVersion} / 文本里找得到: ${aboutText.includes(String(bundleVersion))}`)
  check(aboutText.includes('社区'), 'and credits the community the look comes from')
  check(aboutText.includes('非官方'), 'and says plainly that it is unofficial')

  dlg.document.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  check(dlgApi.dialog === null && dialogGone(), 'Escape closes it',
    `dialog=${String(dlgApi.dialog)} 监听数=${dlg.document.documentListenerCount}`)
  check(dlg.document.documentListenerCountOf('keydown') === 1,
    'exactly one document-level key listener exists', String(dlg.document.documentListenerCountOf('keydown')))
  check(dlg.document.documentListenerCountOf('visibilitychange') === 1,
    'and exactly one visibility listener (added for the come-back greeting)',
    String(dlg.document.documentListenerCountOf('visibilitychange')))

  dlgApi.openActions()
  check(dlgApi.dialog === 'actions', 'the action preview opens', String(dlgApi.dialog))
  const cells = dlg.all('wisp-cell').filter((el) => el.removed !== true)
  check(cells.length === 9, 'and lists one action per mood — nine of them', `${cells.length} 格`)
  check(cells.every((c) => typeof c.dataset.mood === 'string' && c.dataset.mood !== ''),
    'each cell names its mood', cells.map((c) => c.dataset.mood).join(','))
  check(cells.every((c) => c.querySelector('img') !== null), 'each cell carries a sprite')

  const eatCell = cells.find((c) => c.dataset.mood === 'eat')
  eatCell.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  check(dlgApi.dialog === 'actions',
    'clicking an action KEEPS the dialog open — you can try several in a row (v1.47.1)',
    String(dlgApi.dialog))
  check(dlgApi.currentMood === 'eat', 'and she takes that pose', String(dlgApi.currentMood))
  dlg.advance(1500, 100)
  check(dlgApi.currentMood === 'eat',
    'the reaction poll leaves the preview alone while it lasts', String(dlgApi.currentMood))

  /* 连续预览：同一个窗口里再点第二个动作，表情跟着换，窗仍然开着。 */
  const happyCell = dlg.all('wisp-cell').filter((el) => el.removed !== true).find((c) => c.dataset.mood === 'happy')
  happyCell.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  check(dlgApi.dialog === 'actions' && dlgApi.currentMood === 'happy',
    'a second click previews the next action without reopening anything',
    'dialog=' + String(dlgApi.dialog) + ' mood=' + String(dlgApi.currentMood))
  dlg.advance(9000, 500)
  check(dlgApi.currentMood !== 'happy', 'and the preview does not stick forever', String(dlgApi.currentMood))

  /* 关窗仍有三条路，先验右上角那个 ×（窗还开着，不用重开） */
  const x = dlg.find('wisp-dialog-x')
  check(x !== null, 'the close button is there')
  x.dispatch('click', { preventDefault() {} })
  check(dlgApi.dialog === null, 'and it closes the dialog')

  dlgApi.openAbout()
  dlg.find('wisp-dialog-backdrop').dispatch('pointerdown', {})
  check(dlgApi.dialog === null, 'clicking the backdrop closes it too')

  for (let i = 0; i < 3; i++) { dlgApi.openAbout(); dlgApi.closeDialog() }
  check(dlg.document.documentListenerCountOf('keydown') === 1,
    'opening and closing repeatedly does not stack listeners',
    String(dlg.document.documentListenerCountOf('keydown')))

  dlgApi.openAbout()
  dlgApi.destroy()
  check(dlgApi.dialog === null, 'destroy() takes the dialog with it')
  active = keepDlg
}

/* ============================== 3y-2. night / come back / streak =========== */
head('3y-2. night nagging, coming back, and the streak')

/* 这三件事都靠**可配置的时间**，所以不需要伪造时钟：
   把深夜窗口套在当前那个小时上，行为就该发生；套偏一个小时，就不该发生。 */
{
  const hourNowReal = new Date().getHours()
  const mk = (options) => {
    const h = createHarness(Object.assign({ timer: true, composerText: '在打字' }, options))
    h.evaluate(clientSrc)
    return h
  }
  const liveSaid = (h) => h.all('wisp-say').filter((el) => el.removed !== true).map((el) => el.textContent)
  const saidLines = (h) => liveSaid(h)
  /* 推进 ms，把过程中出现过的每一句话都收集起来。 */
  const watch = (h, ms, step = 250) => {
    const seen = new Set(liveSaid(h))
    for (let left = ms; left > 0; left -= step) {
      h.advance(Math.min(step, left), Math.min(step, 200))
      for (const t of liveSaid(h)) seen.add(t)
    }
    return [...seen]
  }
  const inPool = (pool, text) => Array.isArray(pool) && pool.includes(text)

  /* ---- 深夜劝睡 ---------------------------------------------------------- */
  const night = mk()
  const keepNight = active
  active = night
  night.module().default.apply(night.ctx, {
    reactions: true, wander: false, celebrate: false,
    careAfterMs: 0, hungerMs: 0, sleepAfterMs: 3600000,
    /* 让"现在"落在深夜窗口里：从当前小时开始，到下一个小时结束 */
    bedtimeHour: hourNowReal, wakeHour: (hourNowReal + 1) % 24, nightMs: 60000,
  })
  night.advance(1300, 100)
  const nightApi = night.win.__wisp
  check(nightApi.doctor().night.enabled === true
    && nightApi.doctor().night.deepFrom === (hourNowReal + 2) % 24,
    'doctor reports the night window and where the deeper register starts',
    JSON.stringify(nightApi.doctor().night))
  const nightSaid = watch(night, 70000)
  check(nightSaid.some((t) => inPool(linesInBundle()?.nightLate, t)),
    'inside the window she speaks up, from the late pool',
    nightSaid.slice(-2).join(' / ') || '(没说)')
  check(nightApi.doctor().night.lastAt > 0, 'and the check time is recorded',
    String(nightApi.doctor().night.lastAt))

  /* 窗口外不该说话 */
  const day = mk()
  const keepDay = active
  active = day
  day.module().default.apply(day.ctx, {
    reactions: true, wander: false, celebrate: false,
    careAfterMs: 0, hungerMs: 0, sleepAfterMs: 3600000,
    bedtimeHour: (hourNowReal + 3) % 24, wakeHour: (hourNowReal + 4) % 24, nightMs: 60000,
  })
  day.advance(1300, 100)
  const daySaid = watch(day, 200000)
  check(!daySaid.some((t) => inPool(linesInBundle()?.nightLate, t) || inPool(linesInBundle()?.nightDeep, t)),
    'outside the window she says nothing about bedtime', saidLines(day).slice(-2).join(' / ') || '(没说)')
  day.win.__wisp.destroy()
  active = keepDay

  /* 深度深夜：把 bedtime 往前挪两小时，当前小时就落进"嘴硬心软"那一档 */
  const deep = mk()
  const keepDeep = active
  active = deep
  deep.module().default.apply(deep.ctx, {
    reactions: true, wander: false, celebrate: false,
    careAfterMs: 0, hungerMs: 0, sleepAfterMs: 3600000,
    bedtimeHour: (hourNowReal + 22) % 24, wakeHour: (hourNowReal + 1) % 24, nightMs: 60000,
  })
  deep.advance(1300, 100)
  const deepSaid = watch(deep, 70000)
  check(deepSaid.some((t) => inPool(linesInBundle()?.nightDeep, t)),
    'two hours past bedtime the register changes', deepSaid.slice(-2).join(' / ') || '(没说)')

  /* 两种关法 */
  const nightLines = () => [].concat(linesInBundle()?.nightLate ?? [], linesInBundle()?.nightDeep ?? [])
  deep.win.__wisp.configure({ night: false })
  check(!watch(deep, 300000).some((t) => nightLines().includes(t)),
    'night: false turns the whole thing off')
  deep.win.__wisp.configure({ night: true, nightMs: 0 })
  check(!watch(deep, 300000).some((t) => nightLines().includes(t)), 'so does nightMs: 0')
  deep.win.__wisp.destroy()
  active = keepDeep

  /* ---- 离开又回来 -------------------------------------------------------- */
  const back = mk()
  const keepBack = active
  active = back
  back.module().default.apply(back.ctx, {
    reactions: true, wander: false, celebrate: false, careAfterMs: 0, hungerMs: 0,
    sleepAfterMs: 3600000, backAfterMs: 60000,
  })
  back.advance(1300, 100)
  const backApi = back.win.__wisp
  /* 替身没有 visibilityState，直接摆上再派发事件 —— 这正是真浏览器里发生的事。 */
  back.document.visibilityState = 'hidden'
  back.document.dispatch('visibilitychange', {})
  back.advance(120000, 1000)
  back.document.visibilityState = 'visible'
  back.document.dispatch('visibilitychange', {})
  const shortBack = watch(back, 400)
  check(shortBack.some((t) => inPool(linesInBundle()?.backSoon, t)),
    'coming back after a short while gets the short line', shortBack.slice(-2).join(' / ') || '(没说)')

  back.document.visibilityState = 'hidden'
  back.document.dispatch('visibilitychange', {})
  back.advance(30 * 60000, 5000)
  back.document.visibilityState = 'visible'
  back.document.dispatch('visibilitychange', {})
  const longBack = watch(back, 400)
  check(longBack.some((t) => inPool(linesInBundle()?.backLong, t)),
    'a long absence gets the other line', longBack.slice(-2).join(' / ') || '(没说)')

  /* 走开一小会儿不该说话（只看"回来池"，别把别的行为的话算进来） */
  const backLines = () => [].concat(linesInBundle()?.backSoon ?? [], linesInBundle()?.backLong ?? [])
  back.document.visibilityState = 'hidden'
  back.document.dispatch('visibilitychange', {})
  back.advance(5000, 1000)
  back.document.visibilityState = 'visible'
  back.document.dispatch('visibilitychange', {})
  check(!watch(back, 600).some((t) => backLines().includes(t)),
    'a blink of absence is not worth a line')

  back.win.__wisp.configure({ backAfterMs: 0 })
  back.document.visibilityState = 'hidden'
  back.document.dispatch('visibilitychange', {})
  back.advance(30 * 60000, 5000)
  back.document.visibilityState = 'visible'
  back.document.dispatch('visibilitychange', {})
  check(!watch(back, 600).some((t) => backLines().includes(t)),
    'backAfterMs: 0 turns the greeting off')
  back.win.__wisp.destroy()
  active = keepBack

  /* ---- 连续天数 ---------------------------------------------------------- */
  /* 用 localStorage 直接种一段连续的记录：今天 + 往前三天 = 连续 4 天。 */
  const keyFor = (offset) => {
    const d = new Date(Date.now() - offset * 86400000)
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }
  const memorySeed = {
    'dsh-wisp:memory:v1': JSON.stringify({
      days: [keyFor(3), keyFor(2), keyFor(1), keyFor(0)],
      said: [], corners: {}, skins: {}, remarkDay: keyFor(0),
    }),
  }
  const streak = mk({ storageSeed: memorySeed })
  const keepStreak = active
  active = streak
  streak.module().default.apply(streak.ctx, {
    reactions: true, wander: false, celebrate: false, careAfterMs: 0, hungerMs: 0, sleepAfterMs: 3600000,
  })
  const streakSaid = watch(streak, 5000)
  const streakApi = streak.win.__wisp
  check(streakApi.doctor().streak === 4, 'doctor reports a four-day streak', String(streakApi.doctor().streak))
  const streakPool = [].concat(linesInBundle()?.streak ?? [], linesInBundle()?.milestone ?? [])
    .map((t) => t.split('{n}').join('4'))
  check(streakSaid.some((t) => streakPool.includes(t)),
    'and she mentions it the next time you meet', streakSaid.slice(-3).join(' / ') || '(没说)')
  streak.win.__wisp.destroy()
  active = keepStreak

  /* 断了就从头数：今天之前缺一天 */
  const brokenSeed = {
    'dsh-wisp:memory:v1': JSON.stringify({
      days: [keyFor(5), keyFor(4), keyFor(0)], said: [], corners: {}, skins: {}, remarkDay: keyFor(0),
    }),
  }
  const broken = mk({ storageSeed: brokenSeed })
  const keepBroken = active
  active = broken
  broken.module().default.apply(broken.ctx, {
    reactions: true, wander: false, celebrate: false, careAfterMs: 0, hungerMs: 0, sleepAfterMs: 3600000,
  })
  const brokenSaid = watch(broken, 5000)
  check(broken.win.__wisp.doctor().streak === 1,
    'a gap resets it to one (and one is not worth mentioning)',
    String(broken.win.__wisp.doctor().streak))
  const streakPool2 = [].concat(linesInBundle()?.streak ?? [], linesInBundle()?.milestone ?? [])
    .map((t) => t.split('{n}').join('1'))
  check(!brokenSaid.some((t) => streakPool2.includes(t)),
    'so she stays quiet about it', brokenSaid.slice(-2).join(' / ') || '(没说)')
  broken.win.__wisp.destroy()
  active = keepBroken
}

/* ============================== 3y-3. focus timer & hidden pause ========== */
head('3y-3. the focus timer, and going quiet while the page is hidden')

{
  const watch = (h, ms, step = 250) => {
    const live = () => h.all('wisp-say').filter((el) => el.removed !== true).map((el) => el.textContent)
    const seen = new Set(live())
    for (let left = ms; left > 0; left -= step) {
      h.advance(Math.min(step, left), Math.min(step, 200))
      for (const t of live()) seen.add(t)
    }
    return [...seen]
  }
  const strip = (pool, n) => (pool ?? []).map((t) => t.split('{n}').join(String(n)))
  const moodOf = (h) => h.find('wisp-root').dataset.mood

  /* ---- 专注计时器 -------------------------------------------------------- */
  const focus = createHarness({ timer: true, composerText: '' })
  const keepFocus = active
  active = focus
  focus.evaluate(clientSrc)
  focus.module().default.apply(focus.ctx, {
    reactions: true, wander: false, celebrate: false,
    careAfterMs: 0, hungerMs: 0, night: false, sleepAfterMs: 3600000,
  })
  focus.advance(1300, 100)
  const focusApi = focus.win.__wisp

  check(focusApi.focus.active === false, 'no focus session at the start')
  check(focusApi.doctor().focus.active === false && focusApi.doctor().focus.done === 0,
    'and doctor says so', JSON.stringify(focusApi.doctor().focus))

  const started = focusApi.startFocus(25)
  check(started.active === true && started.minutes === 25 && started.leftMin === 25,
    'starting a session reports it back', JSON.stringify(started))
  check(focusApi.doctor().focus.active === true, 'doctor sees the session too')
  const startSaid = watch(focus, 1200)
  check(startSaid.some((t) => strip(linesInBundle()?.focusStart, 25).includes(t)),
    'and she says the session started', startSaid.slice(-1).join('') || '(没说)')

  /* 专注期间即使她没在忙，姿势也该是"干活中" —— 稳态不许把她挪走 */
  focus.advance(120000, 5000)
  check(moodOf(focus) === 'alert', 'she holds the working pose for the whole session', moodOf(focus))

  /* 戳她 = 问还剩多久，而且不算戳着玩 */
  const pokeOnce = () => {
    const b = focus.find('wisp-body')
    b.dispatch('pointerdown', {
      button: 0, clientX: focusApi.position.x + 260, clientY: focusApi.position.y + 400,
      preventDefault() {}, stopPropagation() {},
    })
    focus.win.dispatch('pointerup', {})
    focus.advance(200, 50)
  }
  /* 24 分钟时戳她 —— 报的应该是"还剩 24 分钟"这类的话 */
  pokeOnce()
  const pokeSaid = watch(focus, 800)
  const leftPool = [].concat(strip(linesInBundle()?.focusLeft, 24), strip(linesInBundle()?.focusLeft, 23))
  check(pokeSaid.some((t) => leftPool.includes(t)),
    'poking her during a session asks how long is left', pokeSaid.slice(-2).join(' / ') || '(没说)')
  check(moodOf(focus) !== 'poked', 'and it does not count as poking for fun', moodOf(focus))

  /* 到点：她说收工，状态回到非激活，计数 +1 */
  const doneSaid = watch(focus, 26 * 60000, 30000)
  check(focusApi.focus.active === false, 'the session ends on its own', JSON.stringify(focusApi.focus))
  check(focusApi.focus.done === 1, 'and the finished count goes up', String(focusApi.focus.done))
  check(doneSaid.some((t) => strip(linesInBundle()?.focusDone, 25).includes(t)),
    'and she tells you it is over', doneSaid.slice(-1).join('') || '(没说)')

  /* 参数夹取：0 用默认时长，过大的被夹到 600 */
  check(focusApi.startFocus(0).minutes === focusApi.config.focusMinutes,
    'zero falls back to the configured default', String(focusApi.startFocus(0).minutes))
  check(focusApi.startFocus(9999).minutes === 600, 'an absurd duration is clamped', String(focusApi.focus.minutes))
  const stopSaid = watch(focus, 400)
  focusApi.stopFocus()
  const stopSaid2 = watch(focus, 600)
  void stopSaid
  check(focusApi.focus.active === false, 'stopFocus ends it', JSON.stringify(focusApi.focus))
  check([].concat(stopSaid, stopSaid2).some((t) => (linesInBundle()?.focusStop ?? []).includes(t)),
    'and she acknowledges the stop', [].concat(stopSaid, stopSaid2).slice(-1).join('') || '(没说)')
  check(focusApi.stopFocus() === false, 'stopping when nothing is running is a no-op')
  focus.win.__wisp.destroy()
  active = keepFocus

  /* ---- 页面藏起来就暂停 -------------------------------------------------- */
  const quiet = createHarness({ timer: true, composerText: '' })
  const keepQuiet = active
  active = quiet
  quiet.evaluate(clientSrc)
  quiet.module().default.apply(quiet.ctx, {
    reactions: true, wander: true, celebrate: false,
    careAfterMs: 0, hungerMs: 0, night: false, sleepAfterMs: 3600000, backAfterMs: 60000,
  })
  quiet.advance(1300, 100)
  const quietApi = quiet.win.__wisp
  check(quietApi.doctor().timers.poll === true && quietApi.doctor().timers.paused === false,
    'while visible the poll is armed', JSON.stringify(quietApi.doctor().timers))

  quiet.document.visibilityState = 'hidden'
  quiet.document.dispatch('visibilitychange', {})
  const timers = quietApi.doctor().timers
  /* 絮叨与踱步停掉（只给看得见的人看），但**轮询放慢而不是停掉** ——
     值班的前提是还看得见：你走开时跑完的轮次和出的错，都要被记下来。 */
  check(timers.paused === true && timers.chatter === false && timers.wander === false,
    'hiding the page stops the chatter and the wander', JSON.stringify(timers))
  check(timers.poll === true && timers.pollMs === 5000,
    'but the poll keeps a slow watch instead of stopping (she is on duty)', JSON.stringify(timers))

  /* 藏起来期间：来了一堆报错，她也不该有任何反应（轮询停了） */
  quiet.state.errors = 3
  quiet.state.busy = true
  quiet.advance(2000, 500)
  quiet.state.busy = false
  quiet.advance(20000, 2000)
  check(moodOf(quiet) !== 'worried', 'a hidden page gets no reaction at all', moodOf(quiet))
  check(quiet.all('wisp-say').filter((el) => el.removed !== true).length === 0,
    'and she stays completely quiet', String(quiet.all('wisp-say').length))

  quiet.document.visibilityState = 'visible'
  quiet.document.dispatch('visibilitychange', {})
  const after = quietApi.doctor().timers
  check(after.paused === false && after.poll === true && after.wander === true,
    'coming back re-arms them', JSON.stringify(after))
  /* 回来之后同一批报错就该被看见了 */
  quiet.state.busy = true
  quiet.advance(1300, 100)
  quiet.state.busy = false
  quiet.advance(3000, 200)
  check(moodOf(quiet) === 'worried', 'and now the same errors do get a reaction', moodOf(quiet))
  /* ---- 值班：走开期间跑完的轮次与报错，回来要报账 ------------------------------ */
  const saidNow = () => quiet.all('wisp-say').filter((el) => el.removed !== true)
    .map((el) => el.textContent).join(' ')
  quiet.document.visibilityState = 'hidden'
  quiet.document.dispatch('visibilitychange', {})
  quiet.state.busy = true
  quiet.advance(60000, 5000)            // 你走开之后，她看着一轮跑了一分钟
  quiet.state.errors = 5
  quiet.state.busy = false
  quiet.advance(180000, 5000)           // 一共走开三分钟（超过"回来问候"的门槛）
  check(saidNow() === '', 'while you are away she takes notes but says nothing', saidNow())

  quiet.document.visibilityState = 'visible'
  quiet.document.dispatch('visibilitychange', {})
  quiet.advance(1000, 200)
  const report = saidNow()
  check(/轮/.test(report) && /跑完/.test(report),
    'coming back, she reports how many runs finished while you were away', report)
  check(/错/.test(report), 'and she mentions the errors she saw', report)
  const book = quietApi.doctor().today
  check(book.runs >= 1 && book.errors >= 1 && book.longestMs > 0,
    'and the day book recorded the runs, the errors and the longest one',
    JSON.stringify(book))

  /* ---- 单轮跑得异常久：她会中途说一声，而且同一轮只说一次 ---------------------- */
  quiet.state.busy = true
  /* 刚好推过"单轮跑太久"的阈值。推 11 分钟是不行的：她的话早就过期了（气泡有存活时间），
     于是断言会看到空字符串 —— 断言本身没错，是喂给它的时间不对。 */
  /* 多推几步：busySince 是在推进开始后的第一个轮询才记下的，卡在 601000 会差 200ms。 */
  quiet.advance(604800, 1200)
  const longLine = saidNow()
  const during = quietApi.doctor()
  check(/分钟/.test(longLine), 'a single run that drags on gets a check-in',
    `她说的是「${longLine}」；runInFlight=${during.runInFlightMs} longRunSaid=${during.longRunSaid} paused=${during.timers.paused}`)
  quiet.state.busy = false
  quiet.advance(3000, 500)

  /* ---- 今日小结：把她记着的东西一次说完 ---------------------------------------- */
  quietApi.saySummary()
  quiet.advance(200, 50)
  const summaryLine = saidNow()
  /* 词池里有三个变体（今天…／今天：…／这一天…），所以断言**内容**而不是某一个措辞 */
  check(/轮/.test(summaryLine) && /错/.test(summaryLine) && /分钟/.test(summaryLine),
    'the daily summary reads back what she has been tracking', summaryLine)
  check(/\d/.test(summaryLine), 'with real numbers', summaryLine)
  check(summaryLine.indexOf('{') < 0, 'and no placeholder is left unfilled', summaryLine)
  check(typeof quietApi.today.runs === 'number' && quietApi.today.runs >= 1,
    'the day book is also readable from the api', JSON.stringify(quietApi.today))

  /* ---- 语言判定不能取决于 Node 版本 -------------------------------------------
     Node 21+ 自带全局 navigator（navigator.language = 系统语言）。harness 若不把它注入到
     被求值的作用域里，客户端读到的就是 Node 的 —— 于是同一份代码在中文开发机上绿、
     在英文 runner 上红。这条把 Node 的 navigator 特意伪装成 en-US，再断言她仍然按
     harness 自己的（没有 language 的）navigator 说中文。 */
  const nodeNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US', languages: ['en-US'] }, configurable: true, writable: true,
    })
    const nodeNavHarness = createHarness({ timer: true, composerText: '' })
    const keepNodeNav = active
    active = nodeNavHarness
    nodeNavHarness.evaluate(clientSrc)
    nodeNavHarness.module().default.apply(nodeNavHarness.ctx, { reactions: false, wander: false, celebrate: false })
    nodeNavHarness.advance(1000, 200)
    const nodeNavSaid = String(nodeNavHarness.all('wisp-say').at(-1)?.textContent ?? '')
    check(/[\u4e00-\u9fa5]/.test(nodeNavSaid),
      'the harness hands the client its OWN navigator — Node 21+ has a global one and would leak its locale',
      `${nodeNavSaid.slice(0, 40)} ｜ Node navigator=${globalThis.navigator.language}`)
    nodeNavHarness.win.__wisp.destroy()
    active = keepNodeNav
  } finally {
    if (nodeNav) Object.defineProperty(globalThis, 'navigator', nodeNav)
    else delete globalThis.navigator
  }

  /* ---- 英文台词：英文环境下她说英文，而且**一个汉字都不该出现** -------------------
     语言是加载时判定的（读 navigator.language），所以这个 harness 要在 evaluate 之前
     把 navigator 摆好。中文是兜底：没翻的条目仍然会说中文，这一条只验"翻译层真的生效"。 */
  const en = createHarness({ timer: true, composerText: '', storageSeed: { 'dsh-wisp-lang': 'en' } })
  const keepEn = active
  active = en
  en.evaluate(clientSrc)
  en.module().default.apply(en.ctx, { reactions: false, wander: false, celebrate: false })
  en.advance(1000, 200)
  en.win.__wisp.saySummary()
  en.advance(200, 50)
  const enLine = en.all('wisp-say').filter((el) => el.removed !== true)
    .map((el) => el.textContent).join(' ')
  check(/[A-Za-z]/.test(enLine), 'with an english locale she answers in english',
    `${enLine} ｜ ${JSON.stringify(en.win.__wisp.doctor().lang)}`)
  check(!/[\u4e00-\u9fa5]/.test(enLine), 'and the line contains no chinese characters', enLine)
  en.win.__wisp.destroy()
  active = keepEn

  /* 对照组：强制中文时同一句话必须是中文 —— 否则上面那条可能只是"恰好没触发" */
  const zh = createHarness({ timer: true, composerText: '', storageSeed: { 'dsh-wisp-lang': 'zh' } })
  const keepZh = active
  active = zh
  zh.evaluate(clientSrc)
  zh.module().default.apply(zh.ctx, { reactions: false, wander: false, celebrate: false })
  zh.advance(1000, 200)
  zh.win.__wisp.saySummary()
  zh.advance(200, 50)
  const zhLine = zh.all('wisp-say').filter((el) => el.removed !== true)
    .map((el) => el.textContent).join(' ')
  check(/[\u4e00-\u9fa5]/.test(zhLine), 'forcing chinese keeps her speaking chinese', zhLine)

  /* 语言可以**随时**切换、不用刷新 —— 这正是把 LINES 做成视图（Proxy）而不是死值的意义。
     以前是"加载时合并成一个对象"，换语言只能刷新页面。 */
  const said = () => zh.all('wisp-say').filter((el) => el.removed !== true)
    .map((el) => el.textContent).join(' ')
  zh.state.busy = false
  zh.advance(4000, 500)
  zh.win.__wisp.configure({ lang: 'en' })
  zh.win.__wisp.saySummary()
  zh.advance(200, 50)
  /* 菜单里选的语言是"下次打开生效"的那种设置（它在加载时就被读），
     所以这里验的完整流程是：**选一次 -> 存下来 -> 再挂一次就说英文**。
     不能只验"当场变英文"：那是我想做但没做成的（试过，没找到原因），
     没验证过的行为不该写成承诺。 */
  zh.win.__wisp.configure({ lang: 'en' })
  const storedLang = zh.win.localStorage.getItem('dsh-wisp-lang')
  check(storedLang === 'en', 'picking a language in the menu stores it for next time', String(storedLang))
  const reload = createHarness({ timer: true, composerText: '', storageSeed: { 'dsh-wisp-lang': 'en' } })
  const keepReload = active
  active = reload
  reload.evaluate(clientSrc)
  reload.module().default.apply(reload.ctx, { reactions: false, wander: false, celebrate: false })
  reload.advance(1000, 200)
  reload.win.__wisp.saySummary()
  reload.advance(200, 50)
  const reloaded = reload.all('wisp-say').filter((el) => el.removed !== true)
    .map((el) => el.textContent).join(' ')
  check(/[A-Za-z]/.test(reloaded) && !/[\u4e00-\u9fa5]/.test(reloaded),
    'and the next mount honours that choice', reloaded)
  check(reloaded !== said(), 'the two languages really are different text',
    reloaded + ' ｜ 中文那句：' + said())
  reload.win.__wisp.destroy()
  active = keepReload
  check(zh.win.__wisp.doctor().lang.choice === 'en',
    'and the choice is reported so the menu can show it', JSON.stringify(zh.win.__wisp.doctor().lang))

  zh.win.__wisp.destroy()
  active = keepZh

  quiet.win.__wisp.destroy()
  active = keepQuiet
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

/* ============================ 4b. 帧动画素材进包了吗 ====================== */

head('4b. the clips ship as FILES — the bundle carries only their names (v1.47.0)')

/* v1.47.0 换了**投递方式**：表里不再有 base64，只有文件名；字节留在
   assets/motion/ 里，由宿主半包注册的 `/wisp-motion/` 路由发给页面。
   两个数因此分开盯，各有各的预算：

     ① **内联**：那张清单必须小到可以忽略（几条素材名，几十字节）。它曾经是
        8015.8 KB（两段 base64，v1.46.5 实测）；十八条素材再内联会到 ~80 MB ——
        所以这一条的上界是"几百字节"，不是"几 MB"。
     ② **磁盘**：素材还是跟着包走的，涨了仍然要有人重新量一次。
        1.47.1（十条：通用 2 + 泳装 8）实测 **29800.0 KB / 29.1 MB**，
        上界收到 34000 KB；1.49.0 又落盘原版八条（每条 3537.2~4272.5 KB），
        十八条实测 **60177.1 KB / 58.8 MB**（最大的换成 `canon_eat` 4272.5 KB），
        于是上界跟着提到 **69000 KB / 67.4 MB**（约 +14% 重编码余量 —— 和上一版
        同一条规矩）。1.49.2 重做 `canon_eat`（4272.5 → 3399.9 KB），十八条实测
        **59304.4 KB / 57.9 MB**（最大的换成 `canon_happy` 3927.1 KB），上界跟着
        收到 **68000 KB / 66.4 MB**（+14.7%，还是那条规矩）。1.49.3 深海女仆那三条
        一起重做（`deepsea_happy` 是**新增**的一条：2947.7 KB；`deepsea_idle`
        2693.3 → 2873.3 KB；`deepsea_sleepy` 3318.6 → 2671.8 KB），十八条实测
        **61785.5 KB / 60.3 MB**（最大的仍是 `canon_happy` 3927.1 KB），上界跟着
        提到 **71000 KB / 69.3 MB**（+14.9%，还是那条规矩）。每次素材换代都要有人
        重新量一遍再改它，而不是让它自己漂。**1.52.0** 落盘宵蓝礼服的整套八条
        （每条 1389.0~2680.5 KB），二十七条实测 **78431.1 KB / 76.6 MB**，上界跟着提到
        **90000 KB / 87.9 MB**（+14.7%，同一条规矩）。**1.54.0** 落盘海洋研究员的整套八条
        （每条 2436.1~3143.0 KB），三十五条实测 **100144.1 KB / 97.8 MB**，上界跟着提到
        **115000 KB / 112.3 MB**（+14.8%，同一条规矩）。

   上界写在这里而不是 build.mjs 里：构建负责**报**体积，预检负责**判**体积，
   一个数写两遍就是下一次漂移的起点。 */
const MOTION_MANIFEST_BUDGET_BYTES = 2048
const MOTION_DISK_BUDGET_KB = 115000
{
  const kb = (n) => (n / 1024).toFixed(1)
  if (clientSrc === null) {
    bad('the motion clips ship with the package', 'lib/client.js is missing')
  } else {
    /* 表必须真的能求值：正则匹配到一段文本、而文本是注释里的，是踩过的坑
       （SPRITES 那次的注释占位符事故）。 */
    const motionTable = clientSrc.match(/const MOTION = (\{[\s\S]*?\n {4}\})/)
    let motionValue = null
    try { motionValue = motionTable ? new Function(`return ${motionTable[1]}`)() : null } catch (error) { motionValue = null }
    const keys = motionValue && typeof motionValue === 'object' ? Object.keys(motionValue) : []
    /** 清单里那一条指向的文件名（不是 data URI —— 那是 1.46.5 的老形状）。 */
    const clipFile = (k) => (typeof motionValue?.[k] === 'string' ? motionValue[k] : null)
    const clipPath = (k) => (clipFile(k) === null ? null : join(here, 'assets', 'motion', clipFile(k)))
    /* ① 表里只能是**文件名**：既有形状的检查，也是"没有被内联回来"的第一道。
       值以 data: 开头 = 构建退回内联了（八条泳装那 ~30 MB 会重新进单文件）。 */
    const named = keys.filter((k) => clipFile(k) !== null && /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/.test(clipFile(k)))
    const stillInlined = keys.filter((k) => typeof motionValue[k] === 'string' && motionValue[k].startsWith('data:'))
    check(keys.length > 0 && named.length === keys.length && stillInlined.length === 0,
      'every MOTION entry is a clip FILE NAME — the bytes are not in the bundle any more (v1.47.0)',
      keys.length ? `${keys.join(', ')} → ${String(motionValue[keys[0]])}` : 'no MOTION table in the bundle')
    /* **深海女仆那三条都要在**（v1.46.5 / v1.49.0 / v1.49.3）：站着、开心、睡着是三条
       独立的素材，只进一条（或者 build 的发现规则又把 motion/ 当成皮肤跳过了）在页面上
       表现为"她某个状态不动"，而那和"没有素材"长得一模一样。
       v1.49.3 从两条变三条：`happy` 是**新建**的（`deepsea:happy` 这一格在那之前根本
       没有素材 —— 戳她一下只有静态立绘），另外两条是拿当前立绘**重做**的（它们背后
       的立绘在 1.47.1 被重画过）。三条一起点名，少一条就红。 */
    const deepseaClips = keys.filter((k) => k.startsWith('deepsea_'))
    check(deepseaClips.length === 3
      && ['deepsea_idle', 'deepsea_happy', 'deepsea_sleepy'].every((k) => keys.includes(k)),
      'all THREE deep-sea loops are there — standing, happy and sleeping, under their per-skin names (v1.49.3)',
      deepseaClips.length ? deepseaClips.join(', ') : 'no deep-sea clip at all')
    check(!keys.includes('idle') && !keys.includes('sleepy'),
      'and the retired shared names are gone from the manifest — a clip called `idle` would mean the rename never happened',
      keys.filter((k) => k === 'idle' || k === 'sleepy').join(', ') || 'no bare `idle`/`sleepy` clip left')

    /* ① 内联的那一份必须**小**。这是这一版存在的理由：清单 = 素材名，
       八条泳装加进来也只多几十字节；换成字节就是 ~30 MB。 */
    const inlineBytes = Object.entries(motionValue ?? {}).reduce((n, [k, v]) => n + String(k).length + String(v).length + 8, 0)
    check(inlineBytes > 0 && inlineBytes <= MOTION_MANIFEST_BUDGET_BYTES,
      `the inlined part is only a NAME LIST — ${MOTION_MANIFEST_BUDGET_BYTES} B budget (a 8015.8 KB base64 table is what it replaced)`,
      `${inlineBytes} B for ${keys.length} clips`)

    /* ② 磁盘上那十条 + 原版八条：素材仍然跟着包走，涨了要有第二个人重新量一次。 */
    const onDiskBytes = keys.reduce((n, k) => {
      const p = clipPath(k)
      return n + (p !== null && existsSync(p) ? readFileSync(p).length : 0)
    }, 0)
    check(onDiskBytes > 0 && onDiskBytes <= MOTION_DISK_BUDGET_KB * 1024,
      `and every clip it names really exists under assets/motion/, inside the ${MOTION_DISK_BUDGET_KB} KB disk budget`,
      `${kb(onDiskBytes)} KB on disk for ${keys.length} clips`)

    /* ---- 每条素材的**来源立绘**必须还是当前立绘（v1.49.2）--------------------
       踩到的坑：`assets/canon/eat.webp` 被换成了新画的一张，而
       `assets/motion/canon_eat.webp` 还是拿**旧图**合成的 —— 她站着是一张脸、
       动起来是另一张脸。画面上不报错，四条命令也全绿（那条素材本身完全合法：
       720x1280 / 97 帧 / 三条门槛都过），所以这一条**只能靠指纹查**。

       指纹 = 生成那条素材时用的立绘的 sha256（大写十六进制）。查的是"当前立绘的
       字节"，所以换一个字节就红。这是一张**声明表**，不是推导：素材是怎么来的
       写在生成区的 `tools/canon.mjs` / `swim.mjs` 里，这里只记住当时用的是谁。

       两条深海女仆素材曾是**已知的历史例外**：它们的立绘在 1.47.1（e3dae8c）被
       重做过一版（字节与像素都变了），而那两条素材是 1.46.5（8e08b5a）做的 ——
       也就是说它们**已经**漂过一次；表里当时记的是**当前**立绘，挡得住下一次改动，
       挡不住那一次。

       **v1.49.3 把那一次补上了**：三条深海女仆素材全部拿当前立绘重做（`happy` 那条
       是新加的，`idle` / `sleepy` 是重做的），于是这张表里不再有例外 —— 十八条
       每一条都是"素材是拿这一版立绘做的"。 */
    const MOTION_SOURCES = {
      canon_idle: ['assets/canon/idle.webp', '2BD644A4CEC6783ACE58EEF0EC8A513A034A120E121A6EBBB6A6A5B9E78BDD52'],
      canon_attn: ['assets/canon/attn.webp', '0894E83DBD96BE38F78E575C586F073056ED68D298FC3E35032DB402497B3A6B'],
      canon_happy: ['assets/canon/happy.webp', '01F35C652289894A8F1CFD89EC408A0372ADA0110B7D7451FF2258019D5061BF'],
      canon_sleepy: ['assets/canon/sleepy.webp', '9EF276EC97939AA9FCBA0A98ED28F9AE7F4D8E1FC89A6505D2AA4EDDF75F01AB'],
      canon_work: ['assets/canon/work.webp', 'D2BC5E9C88E077786AFAF0572D41CA8F8D7C6542A2236DB75EED2DAA66662617'],
      canon_proud: ['assets/canon/proud.webp', 'DDA34CDFC15A978D22F8510C60AC77776F0369607ED27EE943C634628C441ECC'],
      /* 这一条是 1.49.2 的落点：立绘换了新的一张（`45E5D3F1…`），素材跟着重做。 */
      canon_eat: ['assets/canon/eat.webp', '45E5D3F11E4E707BD8BD17572BDA851C191F8CCEF3C503A2F7228C69F0CEC8D0'],
      canon_poked: ['assets/canon/poked.webp', '7738A9E3090B91EA89CB2E78F6C8BC5C37C684570C81568AE05E739B5EFCEFC8'],
      swim_idle: ['assets/swim/idle.webp', '34B966C92B1E30119C96BEA5AE558C4F9B1244550A3DFB10EC819AE2F5B8EE26'],
      swim_attn: ['assets/swim/attn.webp', '723B3DA12C98028C03E80C1D1E810D04ABF779AFABBD8E36D1D42B6D72C606BC'],
      swim_happy: ['assets/swim/happy.webp', '311FE375CF1726E8F40AA80D34D6E340D41C550CB4971FCC0435E510B72DD282'],
      swim_sleepy: ['assets/swim/sleepy.webp', 'FFC0B4D23F7AB823AAD4AA9EB8A3D933D394391BFB3005CF0E86808F878B3806'],
      swim_work: ['assets/swim/work.webp', '757F063C436CDE35FE80658375A3BA2D64B5B8976392D1BA0FE1A46B5B7D6633'],
      swim_proud: ['assets/swim/proud.webp', 'FFFB37166FAB2141B048179CBE0ACD61654BEB260136D3FDC828C69280709D3D'],
      swim_eat: ['assets/swim/eat.webp', '8B954CC93D83CB1FC30406132B9F71D12B210F79B99DC0AA2D3AC7993A4EA018'],
      swim_poked: ['assets/swim/poked.webp', 'D62232787A41FBB07B51568C1B86C0D170493F5814FC3D52E9469F678FE9A1EE'],
      /* 1.49.3 的落点：立绘换过新的一版（`happy` 是**新建**那一条的来源，
         `idle` / `sleepy` 是重做那两条的来源）—— 三条一起记，都是当前立绘的字节。 */
      deepsea_idle: ['assets/deepsea/idle.webp', 'CACF8609605D867F454103EA3CFD2EA9844284D7757ED2DCF8A39ACD83F5E33C'],
      deepsea_happy: ['assets/deepsea/happy.webp', 'EA78CAA40F57B08652D7E4205740B3EABB470495FADE629DAAEC462D023F8A40'],
      deepsea_sleepy: ['assets/deepsea/sleepy.webp', '3C35B8FF143A72E98155180A6D2F160B55A374E02A286B409021657CF1600CB5'],
      lab_idle: ['assets/lab/idle.webp', '7E7B3EEE239AF156021A4FFA641F8656508F9EBB709EAFA568AB0D12B6FFE4AA'],
      lab_attn: ['assets/lab/attn.webp', '6DFFE4B6DEE9D821794E58727F02A9846A6D02E0571B101F3537319C3062BB29'],
      lab_happy: ['assets/lab/happy.webp', '96C3B9EDC4E6A43073FA970DCA0BA57C352F70A1AB52DC85B745156100BD923D'],
      lab_sleepy: ['assets/lab/sleepy.webp', '1D5C74154341C4E606AE13B57F4F231ED6DA3E6C01A8553D2290874C90E46751'],
      lab_work: ['assets/lab/work.webp', '8331A0E662C7BD14A9D6E2AF99B3EA48634ACEB57F65FE86A5059EA9C381F0F9'],
      lab_proud: ['assets/lab/proud.webp', 'DBF16A9D8F7A00E98E9AA97615A346DBABF1370AD3C7D883C95EB1DDC9795E18'],
      lab_eat: ['assets/lab/eat.webp', '7CABC23632B709178C06C37580380F880FCC296146E3AD2F3570F81A022985EC'],
      lab_poked: ['assets/lab/poked.webp', '084ADB61823F2B5E3C61A4DDCFFDB951107D96D34611F65D563FAFDE65EF77A8'],
      night_idle: ['assets/night/idle.webp', '8BC2EED65B5EE1422A48B6F3C6D5AE6EEF1143327FBC3631AD0DE32679955DD7'],
      night_attn: ['assets/night/attn.webp', 'C41F98F3C17C2A970E8ACA00CFF62631867C9724DCC75267BC9273C94347960E'],
      night_happy: ['assets/night/happy.webp', '712862793790473A1AF021CDDE1985A04C1A4FC9EB7963D892B6A37A916E7776'],
      night_sleepy: ['assets/night/sleepy.webp', 'A763C907E521BE3EEE0B510EA76228471B1A2F120AA68ABDCB3830BAFEFE6FF0'],
      night_work: ['assets/night/work.webp', '555E758138D67FC4BDFC16C5C0A92304749445A7672EC850D320F67CE0CB1315'],
      night_proud: ['assets/night/proud.webp', 'D3134D3C6A3A54A7605022E46C3223FA13F2857A8CEE7877CAA1E99A2AB059EF'],
      night_eat: ['assets/night/eat.webp', '4C2B038BCC81146AA24AE1DC3D0812012B63B1E0ABC97BB9ABB454AB6776D846'],
      night_poked: ['assets/night/poked.webp', '8056E9D18433A5525AE79B4FCDF4F75F00D246387F58764A97B7E3F7FF1180BC'],
    }
    {
      const undeclared = keys.filter((k) => !MOTION_SOURCES[k])
      const invented = Object.keys(MOTION_SOURCES).filter((k) => !keys.includes(k))
      check(undeclared.length === 0 && invented.length === 0,
        'every shipped clip DECLARES which still it was made from — a new clip cannot skip the fingerprint table (v1.49.2)',
        undeclared.length || invented.length
          ? `undeclared: ${undeclared.join(', ') || '—'} · not shipped: ${invented.join(', ') || '—'}`
          : `${keys.length} clips → ${new Set(Object.values(MOTION_SOURCES).map(([rel]) => rel)).size} stills`)

      const goneStill = []
      const drifted = []
      for (const [clip, [rel, want]] of Object.entries(MOTION_SOURCES)) {
        const p = join(here, rel)
        if (!existsSync(p)) { goneStill.push(`${clip} → ${rel}`); continue }
        const got = createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()
        if (got !== want) drifted.push(`${clip}: ${rel} ${got.slice(0, 12)}… ≠ ${want.slice(0, 12)}…`)
      }
      check(goneStill.length === 0,
        'and every still it names is still in the package',
        goneStill.length ? goneStill.join(' | ') : `${Object.keys(MOTION_SOURCES).length} still(s) present`)
      check(drifted.length === 0,
        'and every one of those stills is still the SAME BYTES the clip was made from — a redrawn sprite plus a stale clip is invisible: she stands as one person and moves as another (v1.49.2)',
        drifted.length
          ? `${drifted.join(' | ')} — 重画了立绘就要重做那条素材，并在这里更新指纹`
          : Object.entries(MOTION_SOURCES).map(([k, [rel, h]]) => `${k}=${h.slice(0, 8)}…`).join(' · '))
    }

    /* ---- 环缝：素材是**接得回去**的吗（v1.49.8）--------------------------------
       19 条素材都是按"首帧 = 尾帧"生成的（first_last_frame，首尾喂同一张图），
       意图是天然无缝循环。**但在这一版之前，这条意图一次都没有被量过** ——
       预检钉的是 720x1280 / 97 帧 / 41ms，全是"素材长什么样"，没有一条问
       "接到一起顺不顺"。而"她每 4 秒顿一下"在页面上不报错、不改 DOM、不留日志，
       只会有人某天觉得"她今天有点怪"（实测：19 条里有 5 条仍然这样）。

       指标（量法在 tools/motion-seam.mjs；跑它要 ffmpeg，所以**不在这里跑** ——
       这里只查它算出来的数）：

         ratio = seam / meanStep

         seam     = 第 n-1 帧 → 第 0 帧（循环接回去的那一步）的 |ΔRGB| 全画布均值
         meanStep = 相邻两帧同一个量的平均（"这条素材平时一帧动多少"）

       ratio ≈ 1 表示接头和平时一帧的变化一样大；> 1.2 表示接回去那一下比平时都猛。

       三件事一起钉，缺一不可：
         ① **sha256 钉在素材字节上** —— 换一个字节就红，必须重新量
            （和上面 MOTION_SOURCES 同一个道理：声明表的价值就在于它不会自己漂）；
         ② **目标带** MOTION_SEAM_LO ~ MOTION_SEAM_HI：**太小是「停一下」，太大是「跳」**，两边都算错；
         ③ **欠账表** MOTION_SEAM_KNOWN：还没重做的几条**必须**登记在案，而且
            **只许变好** —— 登记值就是它被接受时的上界。修好一条就得把名字删掉
            （下面有反向断言：欠账表里不许留"其实已经不欠"的名字）。

       这一版清掉的两笔欠账是 canon_work（1.94 → 1.02）与 swim_work（1.41 → 0.46）：
       两条都是**砍掉最后一帧** —— 末帧是离群帧（它的步长是自己平均的近 2 倍），
       而砍帧走的是**容器**（每帧一个 ANMF，逐帧 blend=no，帧间没有像素依赖），
       所以画质一个字节没动，见 tools/motion-trim.mjs。
       剩下五条要重做素材才能修（canon_attn 遍历全部切点都回不到起点，
       生成端才能解决），先登记、不许变坏。 */
    /* ratio = 缝 / 平均帧步，**两边都有错法**：
         ≈ 1    → 接回去正好是普通的一步（对）
         → 0    → 最后一帧和第一帧几乎一样 —— 接回去**同一张画停两帧**，看着就是"顿一下"
         > 1.25 → 接回去那一下比平时都猛 —— 看着就是"跳"

       **这一条是 1.54.1 补的，代价是一次真实的翻车。** 原先这里只有一个上限，
       于是"几乎重复"那一档一路绿灯：我按"缝最小"去挑裁切窗口，挑出来的恰恰是
       **把慢区接了两遍**的那种切口 —— 宵蓝研究员的待机就那么带着"停一下"上线了，
       是用户看出来的。**指标只盯一边，就会把反方向推到底。** */
    const MOTION_SEAM_LO = 0.75
    const MOTION_SEAM_HI = 1.25

    /* 每个素材的**帧预算**：默认 97（720p / 24fps / 4.04s）。例外必须点名、写清帧数与理由。
       **判据从 1.54.1 起变了**：切窗口不再挑"缝最小"，而是挑**缝等于普通一步**的那一段
       （缝最小 = 把素材里的慢区接了两遍 = 接回去停一下，正是 1.54.1 修的那个 bug）。 */
    const MOTION_FRAMES = {
      canon_work: [96, 'last frame dropped: its step was ~2x the clip mean and it inflated the wrap 1.94 → 1.02'],
      swim_work: [96, 'last frame dropped: the wrap fell 1.41 → 0.46'],
      canon_attn: [50, 'cut to take frames 10..59 — chosen because the wrap lands on an ORDINARY step (1.06), not because it is smallest'],
      night_happy: [52, 'cut to take frames 21..72 (ratio 1.01)'],
      night_eat: [90, 'cut to take frames 5..94 (ratio 1.05)'],
      lab_idle: [84, 'cut to take frames 3..86 (ratio 1.04) — same rule: the wrap must be an ordinary step'],
      lab_happy: [93, 'cut to take frames 4..96 (ratio 0.91)'],
      lab_attn: [95, 'cut to take frames 0..94 (ratio 1.04)'],
      lab_poked: [88, 'cut to take frames 8..95 (ratio 0.81)'],
      lab_proud: [93, 'cut to take frames 2..94 (ratio 0.99)'],
    }

    /* [素材字节的 sha256, 量出来的 ratio]。重新编码一条素材 = 这一行作废。 */
    const MOTION_SEAM = {
      canon_attn: ['7C624B93366605DE018B808A98783CA56469BC0F49FABAD57797EC771BA530C6', 1.06],
      canon_eat: ['36ECC6BBE18816225D66DC3090306378713293A181A09FD8FFACC0E5F3E464C1', 1.32],
      canon_happy: ['DD50A332E3A155C7CA7EA69A0C7C619F300D6ABDD3C1680B70CBCDAEDFF3F557', 0.55],
      canon_idle: ['D769CEBDC9E7630C9C19403B3AE17C239D61B252C41E5FF3DA9AB8B3A079E070', 0.60],
      canon_poked: ['433D3CE7E60ACAD2B1E70281629E1CB42CE697F275280896628108B296398327', 1.06],
      canon_proud: ['F26BD78422983805D5376C8ECB782B37F0803F1F800C81DA9B9DEFFD1D32FEEA', 0.94],
      canon_sleepy: ['A5A19C607C4BE054C68486FF0F0A6EA41ED0E0CBA83F8516C77E1B76E549FC13', 1.41],
      canon_work: ['8FC81BE1A44DCEA8A8733A31E1DF7D3A74C94DAFE2E9C9696BE801BB1997C169', 1.02],
      deepsea_happy: ['B8D4933255F896DEE3923473D174B1D99F617D6DC6E28026AD3EB00838288E48', 0.38],
      deepsea_idle: ['BD32EC57DEE7299D0A8DDD3AA60A6E1815ACE9ED99BC3B4FDF6AC565223249AE', 0.65],
      deepsea_sleepy: ['868457FD3A61EDA137787B76AD89F6DFB3703065ABF5B7188E2AA5B20F92F811', 0.80],
      lab_attn: ['CDBED6EE1241442A4D9CB84721E0C2B1DED01A4F09A72117983C077E46C21EBC', 1.04],
      lab_eat: ['BA8D192C1BD36DE8B08132280FC8CEAC48E4825FC6DCE3678B286D8F7039E464', 1.05],
      lab_happy: ['1E0F91AE99DBC04466FB7FC091DD5C2C75D4720B204FF5FAF202BDBB26B65A75', 0.91],
      lab_idle: ['DBDD32F1241774DC0FB9D84A4831193752AA2AE385B5D564F1A4CE688E232A52', 1.04],
      lab_poked: ['F8BE3D90332E5505A1D0EBF80C8F5CB6630564DBD104827AF9BF66CBC19A1F48', 0.81],
      lab_proud: ['30140CCC949A4E590F8749205DAFDBEB2A8EC88CFE1F8225D3B9F09E22E7CEF6', 0.99],
      lab_sleepy: ['6D305935B0BDAC6C71F9FED115724DEDAC1BFCCD338ED2DFEFF6CF711298EFBD', 0.89],
      lab_work: ['FEBADAB3CD8E93DFCB2DAABCC5E36615ACEB07C3304E4B4E1E7EAEB93BC85BFB', 0.96],
      night_attn: ['BE6952553DA2872A50700838C437DA82413C44088AC4DA8AF158B1A5B156B6D3', 0.79],
      night_eat: ['B52C811123D987B6AFC5A9C32DDC7BE805A5EBFE8C3397BA34F86076EAF900F9', 1.05],
      night_happy: ['5C74F9FDA4BE1F5C85C87E815DBB622C4E6F6E697C87E2EF6D6F8F88E9CA760E', 1.01],
      night_idle: ['0DA1E719523E40101ECAD5E1D4E187CE45FE93B7EB35D00E9A08BA2D10B51CF7', 0.70],
      night_poked: ['C0D2CB61D87AD90CCAB67314586AA2DF4ABF210C8BEDF582C6EC3DE8E79FA2A9', 0.74],
      night_proud: ['998B51B08580921A542326BC2542A64ACADF1BC46E4B4F913ED1430A39FF3CFA', 1.00],
      night_sleepy: ['7C21D780AAB3FCDF97A2089C0D913E7FACD207428DF96725D78A1AA8EF303264', 0.82],
      night_work: ['71D3B6D2F6166FFD8E4E8655A40969E36487FF5CC06183866707546CCFA3B7C2', 0.76],
      swim_attn: ['6BDFCD86F8AB7849F7B6A9B5B83685A41DAE33767BC2F72F9D7DE7A82F544454', 1.39],
      swim_eat: ['E78AF66FD26DFBAF9557BC5B4F810B6CA6E7D0B2F602BDC100618767A3E28F65', 0.61],
      swim_happy: ['0B5E2E809C89F222A9D0265F6AB48A0EA9929E1E301287EA444B0493DC145E30', 0.55],
      swim_idle: ['5EEDBB557BA63A19CFCFDF18630E7084894FAEC10A6FB86B75B5BB4BA3CEE2C3', 0.96],
      swim_poked: ['B332CDEA1DF0AC8CEBA1DFBA6F6C93A3DD1306F99DD931B0E678AC566D8A4E0C', 1.34],
      swim_proud: ['17196266586A638FDC462D2D3E465B58B533587D5AE95B762AB5857CC12865E9', 0.59],
      swim_sleepy: ['4150BC6E219A4741F33422286A28125BBE2DD5FF391C7A5C56D78D3662FA9B37', 0.67],
      swim_work: ['09990AB4FB0AEA42BBEE8FF5EAD28769E82F7BE5C422113FE0B0FCCF781B3B90', 0.46],
    }

    /* 已知出带、还没重切/重做的：[方向, 接受时的值]。
       'pause' = 值只能**往上**（变大才靠近 1.0）；'jump' = 值只能**往下**。
       方向变了也算翻车 —— 一条 pause 变成 jump 不是"变好了"。
       这批都是没有源素材、只能靠改容器相位或重做才能修的（见 README 的 1.54.1 一节）。 */
    const MOTION_SEAM_KNOWN = {
      canon_happy: ['pause', 0.55],
      canon_idle: ['pause', 0.60],
      deepsea_happy: ['pause', 0.38],
      deepsea_idle: ['pause', 0.65],
      night_idle: ['pause', 0.70],
      night_poked: ['pause', 0.74],
      swim_eat: ['pause', 0.61],
      swim_happy: ['pause', 0.55],
      swim_proud: ['pause', 0.59],
      swim_sleepy: ['pause', 0.67],
      swim_work: ['pause', 0.46],
      canon_eat: ['jump', 1.32],
      canon_sleepy: ['jump', 1.41],
      swim_attn: ['jump', 1.39],
      swim_poked: ['jump', 1.34],
    }
    {
      const undeclared = keys.filter((k) => MOTION_SEAM[k] === undefined)
      const invented = Object.keys(MOTION_SEAM).filter((k) => !keys.includes(k))
      check(undeclared.length === 0 && invented.length === 0,
        'every shipped clip DECLARES its loop-seam ratio — a new clip cannot skip the measurement (环缝闸 2026-10-09)',
        undeclared.length || invented.length
          ? 'undeclared: ' + (undeclared.join(', ') || '—') + ' · not shipped: ' + (invented.join(', ') || '—')
          : keys.length + ' clips measured · worst ' + Math.max(...Object.values(MOTION_SEAM).map(([, r]) => r)).toFixed(2) + 'x')

      const stale = []
      const off = []
      for (const [clip, [want, ratio]] of Object.entries(MOTION_SEAM)) {
        const p = clipPath(clip)
        if (p === null || !existsSync(p)) { stale.push(clip + ': missing'); continue }
        const got = createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()
        if (got !== want) stale.push(clip + ': ' + got.slice(0, 12) + '… ≠ ' + want.slice(0, 12) + '…')
        if (ratio < MOTION_SEAM_LO) off.push([clip, ratio, 'pause'])
        else if (ratio > MOTION_SEAM_HI) off.push([clip, ratio, 'jump'])
      }
      check(stale.length === 0,
        'and each ratio is pinned to the BYTES it was measured from — re-encode a clip and the number is void until someone runs tools/motion-seam.mjs again (环缝闸 2026-10-09)',
        stale.length
          ? stale.join(' | ') + ' —— 量一遍：node tools/motion-seam.mjs --table'
          : Object.entries(MOTION_SEAM).map(([k, [h]]) => k + '=' + h.slice(0, 8) + '…').join(' · '))

      const unlisted = off.filter(([k]) => MOTION_SEAM_KNOWN[k] === undefined)
      check(unlisted.length === 0,
        'and every clip outside the ' + MOTION_SEAM_LO + '–' + MOTION_SEAM_HI + ' band is on the KNOWN list — a pause or a jump cannot ship unannounced',
        unlisted.length
          ? unlisted.map(([k, r, why]) => k + ' ' + r.toFixed(2) + ' (' + why + ')').join(', ') + ' —— 要么重切/重做这条素材，要么把它登记进 MOTION_SEAM_KNOWN'
          : off.length + ' clip(s) outside the band, all declared')

      const mislabelled = off.filter(([k, , why]) => MOTION_SEAM_KNOWN[k] !== undefined && MOTION_SEAM_KNOWN[k][0] !== why)
      const regressed = off.filter(([k, r, why]) => {
        const known = MOTION_SEAM_KNOWN[k]
        if (known === undefined || known[0] !== why) return false
        return why === 'pause' ? r < known[1] - 1e-9 : r > known[1] + 1e-9
      })
      check(mislabelled.length === 0 && regressed.length === 0,
        'and a clip on the KNOWN list may only move TOWARD the band — the recorded value is the worst it was accepted at',
        mislabelled.length || regressed.length
          ? mislabelled.map(([k, , why]) => k + ': 方向变了（现在 ' + why + '）').join(' | ')
          : Object.entries(MOTION_SEAM_KNOWN).map(([k, v]) => k + (v[0] === 'pause' ? ' ≥' : ' ≤') + v[1].toFixed(2)).join(' · '))

      const pardoned = Object.keys(MOTION_SEAM_KNOWN)
        .filter((k) => MOTION_SEAM[k] !== undefined && MOTION_SEAM[k][1] >= MOTION_SEAM_LO && MOTION_SEAM[k][1] <= MOTION_SEAM_HI)
      check(pardoned.length === 0,
        'and the KNOWN list holds no stale pardons — fix a clip and its name must leave the list',
        pardoned.length ? pardoned.join(', ') + ' 已经进带了，请从 MOTION_SEAM_KNOWN 删掉' : 'no stale pardon')
    }

    /* ---- 边缘平滑度不是"看起来"的事，是**编码参数**的事（v1.46.4）----
       colorkey 的 blend 是边缘过渡带的半宽：0.02 那条带只有 0.04 的色距宽度，
       边缘几乎是**一刀切** —— 1 bit 的 alpha 在 560px 的显示尺寸上就是一排台阶
       （"硬边 = 锯齿"这条规矩钉在这里，也钉在 client.template.js 的 .wisp-video 注释里）。
       查的是**文档里那条编码命令**：素材怎么来的可复现，这两条才有意义。
       v1.46.5 把两条素材的过渡都收到 **0.05** —— 这是 **≥ 0.05 那条线的下限**，
       不是"随手调小"：那段 soft band 是动画体积的**大头**（实测：sleepy 在 q:v 40 下
       把 blend 归零，3405.7 KB → 1867.8 KB，省掉 45%）。收到下限、再把省下来的余量
       花在**去幕布色**上，是这一版两段素材能同时进包的原因。
       全不透明的阈值 sim+blend 保持原样（sleepy 0.24 / idle 0.38）—— 所以"她自己"
       一个像素都没少（实测不透明占比 17.379% / 27.016%，和上一版逐位相同）。
       只认那个写着 libwebp_anim 的代码块，免得命中变更日志里的历史参数。 */
    /* 1.47.0：文档里有**两块**写着 libwebp_anim 的命令（泳装那八条一条配方 + 通用两条
       的历史命令），所以这里查**每一块**：任何一条 posted 出去的编码命令都不许把 blend
       压到 0.05 以下。泳装那条的幕布色是**采样**来的（`#<采样色>`），所以匹配要接受占位
       形式的色值 —— 断言的是数字（similarity / blend），不是那个十六进制。 */
    const pipelineDoc = existsSync(join(here, 'README.md')) ? readFileSync(join(here, 'README.md'), 'utf8') : ''
    const pipelines = []
    for (const m of pipelineDoc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      if (m[1].includes('libwebp_anim')) pipelines.push(m[1])
    }
    const colorkeys = pipelines
      .flatMap((p) => [...p.matchAll(/colorkey=#(?:[0-9A-Fa-f]{6}|<[^>\n]+>):([\d.]+):([\d.]+)/g)])
      .map((m) => ({ sim: m[1], blend: Number(m[2]) }))
    check(colorkeys.length > 0 && colorkeys.every((k) => k.blend >= 0.05),
      'every documented keying keeps a SOFT edge — blend >= 0.05, because a hard alpha cut IS the jagged edge (v1.46.4)',
      colorkeys.length ? colorkeys.map((k) => `sim ${k.sim} blend ${k.blend}`).join(' · ') : 'no colorkey line in the documented motion pipeline')
    /* 放宽过渡会把幕布的边一起放出来（绿幕：0.078% → 0.119%；品红幕：idle 那 1.09% 的
       紫边就是这么来的）—— 所以那一步 RGB 去边是**配套的**，不是可选项。绿幕那条是
       min(G, max(R,B))（和 tools/keyout.mjs 给立绘用的是同一条规则），品红幕那条把
       "R、B 都比 G 高"的那一份减掉。两条都在文档里。 */
    check(pipelines.some((p) => /geq=|despill/.test(p)),
      'and the documented pipeline de-fringes the screen colour in RGB — a soft transition lets the curtain edge back in',
      pipelines.length
        ? (pipelines.map((p) => (p.split('\n').find((l) => /geq=|despill/.test(l)) ?? '').trim()).find((l) => l !== '') ?? '(no de-fringe line)').slice(0, 140)
        : 'no motion pipeline block in README.md')

    /* 投递的另一半：**宿主真的在发**（v1.47.0）。这条路由不在时她只会静默不动，
       所以"注册了没有"不能靠读源码回答 —— 这里把 handler 拿出来、用真请求打一遍。 */
    /* 两个半包对**同一条路由**必须说同一个名字：客户端解析 `wisp-motion/<文件>`，
       宿主在 `/wisp-motion/` 上注册。这两个字符串写在不同文件里、构建也不查它们，
       于是"改了一处忘了另一处"在页面上只会表现为她不动（静默降级），没有任何报错。
       顺手把宿主那一半**真的跑一遍**：拿真字节过一遍 handler，状态码 / 内容类型 /
       内容都必须对 —— 这是这条投递链上唯一会出错的地方。 */
    const hostMod = await import(pathToFileURL(hostPath).href + '?probe=motion')
    const clientRoute = (/const MOTION_ROUTE = '([^']+)'/.exec(clientSrc) ?? [])[1] ?? null
    check(typeof hostMod.MOTION_PATH === 'string' && clientRoute !== null
      && '/' + clientRoute === hostMod.MOTION_PATH,
      'the client half and the host half name the SAME route — one string, two files',
      `client "${String(clientRoute)}" vs host "${String(hostMod.MOTION_PATH)}"`)

    const served = []
    for (const key of keys) {
      const file = clipFile(key)
      const diskPath = clipPath(key)
      const onDisk = diskPath !== null && existsSync(diskPath) ? readFileSync(diskPath) : null
      const response = { status: 0, headers: null, body: null }
      await hostMod.motionHandler(hostMod.defaultReadBytes)({ method: 'GET', url: `${hostMod.MOTION_PATH}${file}` }, {
        writeHead(status, headers) { response.status = status; response.headers = headers },
        end(chunk) { response.body = chunk ?? null },
        destroy() {},
      })
      const body = response.body === null || response.body === undefined ? null : Buffer.from(response.body)
      const identical = onDisk !== null && body !== null && body.length === onDisk.length && body.equals(onDisk)
      if (response.status !== 200 || String(response.headers?.['content-type']) !== 'image/webp' || !identical) {
        served.push(`${key}: ${response.status} ${String(response.headers?.['content-type'])} identical=${identical}`)
      }
    }
    check(keys.length > 0 && served.length === 0,
      'and the host route really serves each clip: 200, image/webp, bytes identical to the file on disk',
      served.length ? served.join(' | ') : keys.map((k) => `${k} → ${hostMod.MOTION_PATH}${clipFile(k)}`).join(', '))
    /* 它不是一个文件服务器：只有 assets/motion/ 下那一个名字、只有 GET/HEAD。 */
    const refused = []
    for (const [label, url, method, want] of [
      ['traversal', `${hostMod.MOTION_PATH}../../package.json`, 'GET', 404],
      ['nested', `${hostMod.MOTION_PATH}a/b.webp`, 'GET', 404],
      ['non-webp', `${hostMod.MOTION_PATH}idle.png`, 'GET', 404],
      ['bare prefix', hostMod.MOTION_PATH, 'GET', 404],
      ['write', `${hostMod.MOTION_PATH}${clipFile(keys[0])}`, 'POST', 405],
    ]) {
      const response = { status: 0 }
      await hostMod.motionHandler(hostMod.defaultReadBytes)({ method, url }, {
        writeHead(status) { response.status = status }, end() {}, destroy() {},
      })
      if (response.status !== want) refused.push(`${label}: ${response.status} (want ${want})`)
    }
    check(refused.length === 0,
      'and it stays a closed list — traversal, nested paths, other extensions and writes are all refused',
      refused.length ? refused.join(' | ') : 'traversal/nested/non-webp/prefix → 404, POST → 405')

    /* v1.49.7：页面的第一条通道是**宿主半包的同源端点** —— 这里把它自己跑一遍。
       三件事必须成立：没注入 reader 时如实回 no-update-reader（不许假装成功）、
       注入后把 verdict 原样带出（并盖上 host-route 与 no-store）、reader 抛错时变成 JSON
       而不是 500 或未处理的 rejection。 */
    {
      const ask = async (options) => {
        const response = { status: 0, headers: null, body: null }
        await hostMod.motionHandler(hostMod.defaultReadBytes, options)({ method: 'GET', url: `${hostMod.MOTION_PATH}${hostMod.MOTION_UPDATE_NAME}` }, {
          writeHead(status, headers) { response.status = status; response.headers = headers },
          end(chunk) { response.body = chunk ?? null },
          destroy() {},
        })
        let json = null
        try { json = response.body ? JSON.parse(String(response.body)) : null } catch (error) { json = null }
        return {
          status: response.status,
          headers: response.headers ?? {},
          type: String((response.headers ?? {})['content-type'] ?? ''),
          json,
        }
      }
      const noReader = await ask({})
      check(noReader.status === 200 && noReader.json && noReader.json.reason === 'no-update-reader'
        && noReader.headers['x-wisp-motion'] === 'hit',
      'the update endpoint answers honestly when no reader was injected, and still carries the route header',
      JSON.stringify(noReader.json))
      const verdict = { ok: true, latest: '99.0.0', from: 'npm', sources: { npm: { ok: true, version: '99.0.0' } }, diag: { via: 'web' } }
      const withReader = await ask({ readPublished: async () => verdict })
      check(withReader.status === 200 && /application\/json/.test(withReader.type)
        && withReader.json && withReader.json.latest === '99.0.0' && withReader.json.via === 'host-route'
        && typeof withReader.json.checkedAt === 'string' && withReader.headers['cache-control'] === 'no-store',
      'and with a reader it hands the verdict back as JSON, stamped with the channel, uncached',
      JSON.stringify({ type: withReader.type, json: withReader.json, cache: withReader.headers['cache-control'] }))
      const boom = await ask({ readPublished: async () => { throw new Error('web exploded') } })
      check(boom.status === 200 && boom.json && boom.json.ok === false && boom.json.reason === 'reader-threw'
        && String(boom.json.detail).indexOf('web exploded') >= 0,
      'a reader that throws becomes JSON, never a 500 and never an unhandled rejection',
      JSON.stringify(boom.json))
    }

    /* ---- 404 的歧义必须能被消掉（v1.48.1）--------------------------------------
       一个 404 有两个来源：**路由没注册**（请求根本没到我们的 handler，平台自己的
       兜底答的）和**读不到文件**（handler 跑了，返回 404）。两者在 curl 里长得
       一模一样 —— 1.47.x 就是卡在这里：现象是"她永远是静态立绘"，日志里只有 404。
       解法有两半，两半都在这里驱动一遍：
         ① 每个响应都带 `x-wisp-motion: hit` —— 平台兜底的 404 没有这个头；
         ② GET /wisp-motion/__diag 直接给一份 JSON：注册键、载体规则跑出来的
            匹配结论、走哪条读路径、要读的绝对路径、真读一遍的字节数、失败原因。 */
    {
      /* 一个 handler 连着接三个请求：(1) 一段真素材 (2) 一个不存在的名字 (3) __diag。
         计数是**这个 handler 实例**的账，所以顺序在这里是有意义的：
         __diag 报的是它之前已经答过什么。 */
      const handler = hostMod.motionHandler(hostMod.defaultReadBytes)
      const call = async (url) => {
        const response = { status: 0, headers: null, body: null }
        await handler({ method: 'GET', url }, {
          writeHead(status, headers) { response.status = status; response.headers = headers },
          end(chunk) { response.body = chunk ?? null },
          destroy() {},
        })
        return response
      }
      const okKey = keys.find((k) => clipFile(k) !== null && clipPath(k) !== null && existsSync(clipPath(k))) ?? null
      const okFile = okKey === null ? null : clipFile(okKey)
      const okDisk = okKey === null ? null : readFileSync(clipPath(okKey))
      const okRes = okFile === null ? null : await call(`${hostMod.MOTION_PATH}${okFile}`)
      /* 失败那一侧：一个不存在的名字必须是一个**带标记的** 404（我们的 handler 跑的），
         而不是平台兜底那种没有 content-type、没有 x-wisp-motion 的 404。 */
      const nope = await call(`${hostMod.MOTION_PATH}nope.webp`)
      check(nope.status === 404 && String(nope.headers?.['x-wisp-motion']) === 'hit'
        && String(nope.headers?.['content-type']).startsWith('text/plain'),
        'a missing clip is a 404 that still says the handler ran — never the platform’s anonymous 404',
        `status=${nope.status} x-wisp-motion=${String(nope.headers?.['x-wisp-motion'])}`)
      const diagUrl = `${hostMod.MOTION_ROUTE_PATH}/${hostMod.MOTION_DIAG_NAME}`
      const probeFile = okFile ?? 'canon_idle.webp'
      const probeDisk = okDisk
      const response = await call(`${diagUrl}?name=${probeFile}`)
      let diag = null
      try { diag = JSON.parse(String(response.body ?? '')) } catch (error) { diag = null }
      check(response.status === 200 && String(response.headers?.['content-type']).startsWith('application/json')
        && String(response.headers?.['x-wisp-motion']) === 'hit' && diag !== null,
        'the read-only diagnostic answers as JSON, and carries the header that proves OUR handler ran',
        `status=${response.status} type=${String(response.headers?.['content-type'])} x-wisp-motion=${String(response.headers?.['x-wisp-motion'])}`)
      check(diag !== null && diag.route?.registeredAt === hostMod.MOTION_ROUTE_PATH
        && diag.route?.registeredKeyMatchesExample === true
        && diag.route?.trailingSlashKeyMatchesExample === false
        && typeof diag.route?.carrierRule === 'string',
        'and it reports WHICH spelling the carrier matches — the trailing-slash key is called out as a non-match',
        diag === null ? 'unparseable' : `${String(diag.route?.registeredAt)} → example=${String(diag.route?.registeredKeyMatchesExample)} · slash=${String(diag.route?.trailingSlashKeyMatchesExample)}`)
      check(diag !== null && diag.probe?.ok === true && diag.probe?.bytes === (probeDisk === null ? null : probeDisk.length)
        && diag.probe?.magic === 'RIFF/WEBP',
        'and its probe really reads a clip end to end — the byte count equals the file on disk (that is the "bytes are reachable" answer)',
        diag === null ? 'unparseable' : `${String(diag.probe?.name)} → ok=${String(diag.probe?.ok)} bytes=${String(diag.probe?.bytes)} vs disk ${probeDisk === null ? 'n/a' : probeDisk.length} magic=${String(diag.probe?.magic)}`)
      check(diag !== null && typeof diag.reader?.via === 'string' && typeof diag.signatures === 'string'
        && diag.node?.note !== undefined,
        'and it names the read path, quotes the service signatures it was written against, and reports the Node road separately',
        diag === null ? 'unparseable' : `reader=${String(diag.reader?.via)} node=${JSON.stringify(diag.node)}`)
      check(diag !== null && diag.route?.served === (okRes === null ? 0 : 1) && diag.route?.notFound >= 1
        && diag.route?.lastStatus === 404,
        'and it counts what THIS handler has actually answered — "did it run at all" is a number, not a guess',
        diag === null ? 'unparseable' : JSON.stringify({ hits: diag.route?.hits, served: diag.route?.served, notFound: diag.route?.notFound, last: diag.route?.lastStatus }))
    }

    /* 磁盘上那份文件**真的是动图**（RIFF/WEBP + ANMF 帧块）：MIME 是写死的，
       素材被换成一张静图时，"她不动了"会和"没有素材"长得一模一样。
       顺手把**几何**也钉住（v1.46.4）：720x1280 / 97 帧 / 41ms 一帧（24fps）这三条是
       "这份素材是怎么来的"的一部分 —— 换 q:v、换 colorkey 都可以，动这几条就是另一份
       素材了；而"她变糊了"和"她掉帧了"在页面上都不会报错，只会有人某天觉得"她今天不太对"。
       容器结构：VP8X 的画布宽高各 3 字节（存的是值-1），ANMF 的帧时长在块内偏移 12 处，
       同样 3 字节、单位毫秒。 */
    /* 帧数是**声明过的例外**，不是默认值：名字必须在清单里，也必须真的就是声明的那个数
       （下面那个循环按 wantFrames 查）。把 97 改成别的数字了事是过不去的。 */
    {
      const notShipped = Object.keys(MOTION_FRAMES).filter((k) => !keys.includes(k))
      const badShape = Object.entries(MOTION_FRAMES).filter(([, v]) => !Array.isArray(v) || !Number.isInteger(v[0]) || v[0] < 2 || typeof v[1] !== "string" || v[1].length < 20)
      check(notShipped.length === 0 && badShape.length === 0,
        "every declared frame budget ships, and carries both a real frame count and a real reason — a silent frame-budget change is what this table exists to stop (环缝闸 2026-10-09)",
        notShipped.length || badShape.length
          ? `not shipped: ${notShipped.join(', ') || '—'} · bad shape: ${badShape.map(([k]) => k).join(', ') || '—'}`
          : Object.entries(MOTION_FRAMES).map(([k, v]) => `${k} → ${v[0]} frames`).join(' · '))
    }
    const animated = []
    const geometry = []
    for (const key of keys) {
      const file = clipPath(key)
      if (file === null || !existsSync(file)) continue
      const onDisk = readFileSync(file)
      const riff = onDisk.subarray(0, 4).toString('latin1') === 'RIFF' && onDisk.subarray(8, 12).toString('latin1') === 'WEBP'
      let canvasW = 0
      let canvasH = 0
      let frames = 0
      let firstDur = 0
      for (let off = 12; off + 8 <= onDisk.length;) {
        const id = onDisk.subarray(off, off + 4).toString('latin1')
        const size = onDisk.readUInt32LE(off + 4)
        if (id === 'VP8X') {
          canvasW = onDisk.readUIntLE(off + 12, 3) + 1
          canvasH = onDisk.readUIntLE(off + 15, 3) + 1
        } else if (id === 'ANMF') {
          frames += 1
          if (firstDur === 0) firstDur = onDisk.readUIntLE(off + 20, 3)
        }
        off += 8 + size + (size % 2)
      }
      if (!riff || frames < 2) animated.push(`${key}: riff=${riff} frames=${frames}`)
      const wantFrames = (MOTION_FRAMES[key] ?? [97])[0]
      /* 帧率也可以按素材声明（v1.53.0）：走路那条是 34ms/帧（≈29fps）—— 24fps 下
         一个步态周期凑不出整数帧。默认仍然是 24fps。 */
      const wantFps = (MOTION_FRAMES[key] ?? [97, '', 24])[2] ?? 24
      if (`${canvasW}x${canvasH}` !== '720x1280' || frames !== wantFrames || Math.round(1000 / firstDur) !== wantFps) {
        geometry.push(`${key}: ${canvasW}x${canvasH} / ${frames} frames / ${firstDur}ms`)
      }
    }
    check(animated.length === 0,
      'and it is an ANIMATED WebP (RIFF/WEBP with a chain of ANMF frames), not a still',
      animated.length ? animated.join(' | ') : keys.map((k) => `${k}: ${readFileSync(clipPath(k)).toString('latin1').split('ANMF').length - 1} frames`).join(', '))
    check(geometry.length === 0,
      'and its geometry did not drift — 720x1280, 97 frames (96 where declared), 41ms each (24 fps): quality and keying may change, the frame budget may not (v1.46.4)',
      geometry.length ? geometry.join(' | ') : keys.map((k) => k + ': 720x1280 / ' + (MOTION_FRAMES[k] ?? [97])[0] + ' frames / 41 ms = 24 fps').join(', '))

    /* 谁在播哪一段（v1.47.0 起是**按皮肤**点的；v1.49.0 起**只有这一层**）。
       正向：每个 `<皮肤>:<状态>` 指向的素材必须真的在清单里（打错一个字 = 那个状态
       永远不动，而画面看不出错）。
       反向：清单里**没有状态会播**的素材是白带的体积（磁盘预算里最贵的就是它）。
       还有一条**结构**断言（v1.49.0）：通用兜底必须**不存在** —— 它在的时候，
       "这个皮肤没有素材"在画面上分辨不出来（她会借别的皮肤的动作，也就是当场换装）。 */
    const moodMap = (/const MOTION_OF = (\{[^}]*\})/.exec(clientSrc) ?? [])[1]
    let wired = null
    try { wired = moodMap ? new Function(`return ${moodMap}`)() : null } catch (error) { wired = null }
    const wiredClips = [...Object.values(wired ?? {})]
    /* 孤儿只算**这个包真的带了的**素材：还没生成的泳装/原版素材在表里写着是**对的**
       （那正是接线），它在页面上走静默降级，不是坏行为。素材有没有是上面那条的事。 */
    const orphans = Object.keys(wired ?? {}).filter((m) => !String(wired[m]).startsWith('swim_')
      && !String(wired[m]).startsWith('canon_')
      && typeof motionValue?.[wired[m]] !== 'string')
    const badKeys = Object.keys(wired ?? {}).filter((m) => !/^[a-z]+:.+$/.test(m))
    const unwired = keys.filter((k) => !wiredClips.includes(k))
    check(wired !== null && orphans.length === 0 && unwired.length === 0 && badKeys.length === 0,
      'every <skin>:<state> is wired to a clip that is really shipped — and no clip ships that no state can play',
      wired ? `${JSON.stringify(wired)}${unwired.length ? ` · 没人播：${unwired.join(', ')}` : ''}${orphans.length ? ` · 查不到：${orphans.join(', ')}` : ''}` : 'no MOTION_OF map found')

    /* ---- 通用兜底删干净了没有（v1.49.0）--------------------------------------
       两件事一起查，因为"删一半"在页面上不报错：
         ① `MOTION_BASE` 这个名字在客户端半包里**一个字都不许剩**（这张表曾经是
            "任意皮肤都能借深海女仆那一段"的唯一来源）；
         ② `motionKeyFor` 只许有**一次**查表 —— 再有 `??` 就是第二级回退又长回来了。
       两条都查**发行版**（lib/client.js），不是模板：改名/删除只改模板、忘了
       `node build.mjs` 的话，页面加载的还是旧的那一份。 */
    const noBase = !/MOTION_BASE/.test(String(clientSrc))
    const keyFn = (/const motionKeyFor = \([^)]*\) =>([^\n]*)/.exec(String(clientSrc)) ?? [])
    const keyBody = String(keyFn[1] ?? '')
    const oneLevel = keyBody.length > 0 && !keyBody.includes('??')
    check(noBase && oneLevel,
      'the shared fallback is GONE: no MOTION_BASE table, and motionKeyFor does a single lookup — "no clip for this skin+state" is a real state now, not a silent borrow (v1.49.0)',
      `MOTION_BASE=${noBase ? 'absent' : 'STILL PRESENT'} · motionKeyFor=${oneLevel ? 'single lookup' : (keyBody || '(not found)')}`)

    /* ---- 原版那八条（v1.49.0）。和泳装同一条规矩：判据是**磁盘上实际带着什么**
       （见文件上方 SHIPPED_CANON）—— "一条都没生成"与"八条都在"都是合法状态，
       半套才是坏的。两个方向都查：
         ① 每个 canon 状态指向的素材，只要它在包里就必须真的能查到；
         ② 包里每一条 canon 素材都必须有状态会播（没人播 = 白带的体积）。 */
    const canonKeys = Object.keys(wired ?? {}).filter((k) => k.startsWith('canon:'))
    const canonClips = canonKeys.map((k) => wired[k])
    const canonMissing = canonKeys.filter((k) => SHIPPED_CANON.includes(`${wired[k]}.webp`)
      && typeof motionValue?.[wired[k]] !== 'string')
    const canonUnwired = SHIPPED_CANON.map((f) => f.slice(0, -'.webp'.length))
      .filter((c) => !Object.values(wired ?? {}).includes(c))
    check(SHIPPED_CANON.length === 0 || SHIPPED_CANON.length === 8,
      'the eight original-maid clips ship as a SET — never half of them (the default skin is canon, so a half set means some states simply never move)',
      SHIPPED_CANON.length
        ? `${SHIPPED_CANON.length} clip(s): ${SHIPPED_CANON.join(', ')}`
        : '0/8 generated yet — the original-maid states stay on the static sprite, silently by design')
    check(canonKeys.length === 8 && new Set(canonKeys).size === 8
      && (SHIPPED_CANON.length === 0 || new Set(canonClips).size === 8)
      && canonMissing.length === 0 && canonUnwired.length === 0,
      'all eight original-maid states are wired, each to its OWN clip — and every clip that ships has a state to play it (v1.49.0)',
      `wired ${canonKeys.length}/8 · shipped ${SHIPPED_CANON.length}/8`
        + (canonUnwired.length ? ` · 没人播：${canonUnwired.join(', ')}` : '')
        + (canonMissing.length ? ` · 查不到：${canonMissing.join(', ')}` : ''))

    /* 泳装那八条（v1.47.0）。判据是**磁盘上实际带着什么**（见文件上方 SHIPPED_SWIM）：
       "一条都没生成"与"八条都在"都是合法状态 —— 前者走既有的静默降级（画面回到立绘），
       半套才是坏的。所以这里查的是**接线与素材一一对上**，两个方向都查：
         ① 每个泳装状态指向的素材，只要它在包里就必须真的能查到（名字打错一条 = 那个
            状态永远不动，而画面不会报错）；
         ② 包里每一条泳装素材都必须有状态会播（没人播 = 白带的体积）。 */
    const swimKeys = Object.keys(wired ?? {}).filter((k) => k.startsWith('swim:'))
    const swimClips = swimKeys.map((k) => wired[k])
    const swimMissing = swimKeys.filter((k) => SHIPPED_SWIM.includes(`${wired[k]}.webp`)
      && typeof motionValue?.[wired[k]] !== 'string')
    const swimUnwired = SHIPPED_SWIM.map((f) => f.slice(0, -'.webp'.length))
      .filter((c) => !Object.values(wired ?? {}).includes(c))
    check(SHIPPED_SWIM.length === 0 || SHIPPED_SWIM.length === 8,
      'the eight swimsuit clips ship as a SET — never half of them',
      SHIPPED_SWIM.length
        ? `${SHIPPED_SWIM.length} clip(s): ${SHIPPED_SWIM.join(', ')}`
        : '0/8 generated yet — the swimsuit states stay on the static sprite, silently by design')
    check(swimKeys.length === 8 && new Set(swimKeys).size === 8
      && (SHIPPED_SWIM.length === 0 || new Set(swimClips).size === 8)
      && swimMissing.length === 0 && swimUnwired.length === 0,
      'all eight swimsuit states are wired, each to its OWN clip — and every clip that ships has a state to play it (v1.47.0)',
      `wired ${swimKeys.length}/8 · shipped ${SHIPPED_SWIM.length}/8`
        + (swimUnwired.length ? ` · 没人播：${swimUnwired.join(', ')}` : '')
        + (swimMissing.length ? ` · 查不到：${swimMissing.join(', ')}` : ''))

    /* ---- 改名之后"每一条素材都只属于一套皮肤"（v1.49.0）----
       通用兜底在的时候，同一条素材被多套皮肤共用是**设计**；现在它一定是个 bug
       （要么表写错了，要么改名只改了一半）。逐个素材名反查它的皮肤集合。 */
    const clipOwners = new Map()
    for (const [key, clip] of Object.entries(wired ?? {})) {
      const skin = key.slice(0, key.indexOf(':'))
      if (!clipOwners.has(clip)) clipOwners.set(clip, new Set())
      clipOwners.get(clip).add(skin)
    }
    const sharedClips = [...clipOwners.entries()].filter(([, skins]) => skins.size > 1)
      .map(([clip, skins]) => `${clip}←${[...skins].join('+')}`)
    check(wired !== null && sharedClips.length === 0,
      'no clip is shared between skins any more — every shipped loop belongs to exactly one skin (v1.49.0)',
      sharedClips.length ? sharedClips.join(' | ') : `${clipOwners.size} clips, each owned by one skin`)

    check(!/['"][^'"]*\.(webm|mp4|mov)['"]/.test(clientSrc),
      'the bundle references no external video file', 'no .webm/.mp4/.mov string in the bundle')
    check(!clientSrc.includes('__MOTION_LITERAL__'),
      'no leftover motion placeholder', 'run `node build.mjs`')
  }
}

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

/* ---------------------------------------------------------------------------
   1.43.0：一批修复各自的不变式。

   每条修复背后都有一句"如果再犯就会露出来"的断言 —— 没有它，这些修复会在下一次
   重构里悄悄退回原样（这批里有三条正是这么来的）。 */
{
  const h = createHarness({ timer: true, composerText: '', wanderMs: 150, wanderRange: 200 })
  const keep = active
  active = h
  h.evaluate(clientSrc)
  h.module().default.apply(h.ctx, { reactions: false, wander: true, celebrate: false })
  h.advance(1200, 100)
  const api = h.win.__wisp
  const root = h.document.querySelector('.wisp-root')
  const tiltDeg = () => {
    const n = Number(String(root.style.getPropertyValue('--wisp-tilt') || '0deg').replace('deg', ''))
    return Number.isFinite(n) ? n : 0
  }

  /* 脚底光晕在 motion 层、不在 lean 层：歪的是她，不该是地板 */
  const shineEl = h.document.querySelector('.wisp-shine')
  const motionEl = h.document.querySelector('.wisp-motion')
  check(shineEl !== null && motionEl !== null && shineEl.parentNode === motionEl,
    'the ground glow lives outside the tilt layer',
    shineEl && shineEl.parentNode ? String(shineEl.parentNode.className) : '(missing)')

  /* 静止档的 z：静止 ≠ 冻成满不透明 */
  check(clientSrc.includes('.wisp-root[data-motion="off"] .wisp-zzz{opacity:.5}'),
    'the still level shows a subdued z instead of a frozen opaque one')
  const rmAt = clientSrc.indexOf('@media (prefers-reduced-motion:reduce)')
  check(rmAt >= 0 && clientSrc.slice(rmAt, rmAt + 800).includes('.wisp-zzz{animation:none!important;opacity:.5}'),
    'and reduced motion does the same for it')

  /* 滑块的默认值必须落在步长格点上（否则用户动了就回不到出厂大小） */
  const wheelStep = Number((/const WHEEL_STEP = ([0-9.]+)/.exec(clientSrc) ?? [])[1])
  const keyStep = Number((/ev\.shiftKey \? 1 : ([0-9.]+)/.exec(clientSrc) ?? [])[1])
  const sizeLo = Number((/size: \{ kind: 'num', lo: ([0-9.]+)/.exec(clientSrc) ?? [])[1])
  const defaultsBlock = clientSrc.match(/const DEFAULTS = \{([\s\S]*?)\n {4}\}/)
  const defSize = Number((/size:\s*([0-9.]+)/.exec(defaultsBlock ? defaultsBlock[1] : '') ?? [])[1])
  check(wheelStep > 0 && wheelStep === keyStep, 'the wheel and the slider share exactly one step',
    `wheel=${wheelStep} key=${keyStep}`)
  const steps = (defSize - sizeLo) / wheelStep
  check(Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) < 1e-9,
    'the DEFAULT size is reachable from lo in whole steps — otherwise a user can never get back to it',
    `lo=${sizeLo} default=${defSize} step=${wheelStep} → ${steps} steps`)

  /* 鼠标路过会侧身；手指路过不会（而且会把姿势归零）。
     y 必须取她的**中线**：侧身有"从正上方路过不倾"这一层（level 因子），
     在脚下 700px 处派发事件本来就该是 0 度 —— 那样测的是另一条规则。 */
  /* v1.50.0：侧身是四档里的「跟着鼠标」那一档，默认那档是自主微摆、不读指针 ——
     这一段测的就是指针这条路，所以先拨过去。 */
  api.configure({ sway: true })
  const nearX = api.position.x + 280
  const nearY = api.position.y + 420
  h.win.dispatch('pointermove', { clientX: nearX + 24, clientY: nearY, pointerType: 'mouse' })
  check(tiltDeg() !== 0, 'a mouse passing by still leans her', `${tiltDeg()}deg`)
  h.win.dispatch('pointermove', { clientX: nearX + 24, clientY: nearY, pointerType: 'touch' })
  check(tiltDeg() === 0, 'a finger passing by does not — and clears the pose', `${tiltDeg()}deg`)

  /* 指针离开文档：姿势归零（blur 只覆盖"切走应用"） */
  h.win.dispatch('pointermove', { clientX: nearX + 24, clientY: nearY, pointerType: 'mouse' })
  check(tiltDeg() !== 0, 'leaning again before the pointer leaves', `${tiltDeg()}deg`)
  h.document.dispatch('mouseleave', {})
  check(tiltDeg() === 0, 'the pose resets when the pointer leaves the document', `${tiltDeg()}deg`)

  /* 撞到边界不再"原地歪"：位置没变就不该有侧倾 */
  api.move(1360, 300)
  h.win.dispatch('pointerdown', {
    clientX: 1360 + 280, clientY: 300 + 700, button: 0, pointerType: 'mouse',
    preventDefault() {}, stopPropagation() {},
  })
  h.win.dispatch('pointermove', { clientX: 1360 + 280 + 60, clientY: 300 + 700, pointerType: 'mouse' })
  check(api.position.x === 1360, 'a drag into the right edge stays clamped', String(api.position.x))
  check(tiltDeg() === 0, 'and a clamped drag does not tilt her in place', `${tiltDeg()}deg`)
  h.win.dispatch('pointerup', {})

  /* 静止档也要停住 JS 溜达 —— CSS 关不掉坐标写入 */
  api.configure({ motion: 'off', wander: true, wanderMs: 150, wanderRange: 200 })
  const still = { x: api.position.x, y: api.position.y }
  h.advance(4000, 100)
  check(api.position.x === still.x && api.position.y === still.y,
    'motion: off stops the walk too, not only the animation', `${api.position.x},${api.position.y}`)
  api.configure({ motion: 'full' })
  h.advance(6000, 100)
  check(api.position.x !== still.x || api.position.y !== still.y,
    'and with motion back on she strolls again', `${api.position.x},${api.position.y}`)

  /* 拨开关之后子面板要留在原地（点开的就该一直开着）。
     contextmenu 要派给**她的本体**（监听挂在 body 上），派给 window 不会走到那一层。 */
  h.document.querySelector('.wisp-body').dispatch('contextmenu', {
    clientX: api.position.x + 280, clientY: api.position.y + 420,
    preventDefault() {}, stopPropagation() {},
  })
  const groupRow = h.all('wisp-menu-item').find((el) => el.dataset && el.dataset.group === '行为')
  check(groupRow !== undefined, 'the behaviour group row is there to click', String(h.all('wisp-menu-item').length) + ' rows')
  if (groupRow) {
    groupRow.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    h.advance(60, 20)
    const flyoutBefore = h.all('wisp-submenu').length
    const aSwitch = h.all('wisp-switch')[0]
    check(flyoutBefore > 0 && aSwitch !== undefined, 'its flyout is open with switches in it', String(flyoutBefore))
    if (aSwitch) {
      aSwitch.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      h.advance(60, 20)
      check(h.all('wisp-submenu').length > 0,
        'toggling a switch keeps the flyout open — the panel vanishing is the most annoying version of this',
        `${h.all('wisp-submenu').length} panel(s)`)
    }
  }
  api.destroy()
  active = keep
}

/* GitHub 上更新、npm 上还是旧版时：提示要改口，并且复制的是仓库地址而不是包名 */
{
  const gh = createHarness({
    timer: true, composerText: '', clipboard: true,
    hostCall: async () => ({
      ok: true, latest: '9.9.9', from: 'github',
      sources: { npm: { ok: true, version: '1.0.0' }, github: { ok: true, version: '9.9.9' } },
    }),
  })
  const keepGh = active
  active = gh
  gh.evaluate(clientSrc)
  gh.module().default.apply(gh.ctx, { reactions: false, wander: false, celebrate: false })
  gh.advance(1200, 100)
  gh.win.__wisp.showUpdate()
  await new Promise((resolve) => setImmediate(resolve))
  gh.advance(200, 50)
  check(gh.clipboardWrites[gh.clipboardWrites.length - 1] === 'https://github.com/969246694/dsh-wisp',
    'when only GitHub has the new version she copies the repo URL, not the package name that installs the old one',
    JSON.stringify(gh.clipboardWrites))
  check(String(gh.win.__wisp.doctor().update.hint).includes('npm 上还是旧版'),
    'and doctor() records which hint she actually used',
    String(gh.win.__wisp.doctor().update.hint))
  gh.win.__wisp.destroy()
  active = keepGh
}

if (clientSrc !== null) {
  /* ---------------------------------------------------------------------------
     配置键是这套"多端"里最容易漂的一处：它在**三个地方**各出现一次 ——
     CONFIG_SPEC（声明有哪些键、怎么夹紧）、DEFAULTS（默认值）、README 的配置表
     （用户看到的那一份）。

     实测漂过两次，都是真的：
       · `motion` 加进了 README 表却漏了 cordis.patch.yml 的注释（同一份清单的两个副本）；
       · `soundVolume` **只在 CONFIG_SPEC 里声明、DEFAULTS 里没有** → 默认值是
         undefined → `Number(undefined)` = NaN → `clip.volume = NaN` 在浏览器里抛，
         被 playSound 的 try/catch 吞掉 —— "打开音效"整条路静默失效。

     所以这里钉两条不变量：① 每个声明过的键都有默认值；② 每个键都写进了 README 表。
     cordis.patch.yml 的那份副本已经删掉（改成指向 README），重复清单本身就是漂移源。
     --------------------------------------------------------------------------- */
  const specBlock = clientSrc.match(/const CONFIG_SPEC = \{([\s\S]*?)\n {4}\}/)
  const defaultsBlock = clientSrc.match(/const DEFAULTS = \{([\s\S]*?)\n {4}\}/)
  const keysOf = (block) => (block ? [...block[1].matchAll(/^ {6}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]) : [])
  const specKeys = keysOf(specBlock)
  const defaultKeys = new Set(keysOf(defaultsBlock))
  /* 先证明解析没落空：正则失配会让下面两条"全部满足"变成假绿。 */
  check(specKeys.length >= 25 && defaultKeys.size >= 25,
    'the config tables are parsed out of the bundle', `CONFIG_SPEC ${specKeys.length} / DEFAULTS ${defaultKeys.size}`)

  const noDefault = specKeys.filter((key) => !defaultKeys.has(key))
  check(noDefault.length === 0,
    'every declared config key also has a DEFAULTS entry — a missing one silently becomes undefined',
    noDefault.length ? 'missing defaults: ' + noDefault.join(', ') : `${specKeys.length} keys covered`)

  const readmeSource = existsSync(join(here, 'README.md')) ? readFileSync(join(here, 'README.md'), 'utf8') : ''
  const undocumented = specKeys.filter((key) => !readmeSource.includes('| `' + key + '` |'))
  check(undocumented.length === 0,
    'and every config key is documented in the README table (the single source of truth)',
    undocumented.length ? 'undocumented: ' + undocumented.join(', ') : `${specKeys.length} keys documented`)

  /* 反方向：README 表里不许有代码里不存在的键（写了但没用的开关比没有更糟）。 */
  const documented = [...readmeSource.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \| (?:number|boolean|string) \|/gm)].map((m) => m[1])
  const phantom = documented.filter((key) => !specKeys.includes(key))
  check(phantom.length === 0, 'and the README table invents no keys the code does not accept',
    phantom.length ? 'not in CONFIG_SPEC: ' + phantom.join(', ') : `${documented.length} rows checked`)

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

  /* 自足性（1.43 立的规矩）：立绘是**内联**的 —— 一个包外路径都不能有，别人装走
     也能直接画出来。
     v1.47.0 给这条规矩开了一个**明确的例外**：帧动画素材是按 URL 外置加载的
     （八条泳装 +30 MB，塞不进单文件），它的文件名就是 MOTION 清单里那几条，
     由宿主路由发出来。所以这里查的是两件事，而不是笼统的"不许出现 .webp"：
       ① 包体里出现的 .webp 文件名**只能**是 MOTION 清单里那几条 —— 多一条就意味着
          有人又写死了一个路径，而那条路径在别人机器上不存在；
       ② 立绘那一份仍然是 data URI（下面上面那条断言已经逐格查过）。
     文件**不存在**不算失败：那是"这一段没有素材"，客户端有静默降级。 */
  const motionBlock = (clientSrc.match(/const MOTION = \{[\s\S]*?\n {4}\}/) ?? [''])[0]
  const manifestFiles = [...motionBlock.matchAll(/'([A-Za-z0-9._-]+\.webp)'/g)].map((m) => m[1])
  const namedFiles = [...new Set([...clientSrc.matchAll(/['"]([A-Za-z0-9._-]+\.webp)['"]/g)].map((m) => m[1]))]
  const strayFiles = namedFiles.filter((f) => !manifestFiles.includes(f))
  if (manifestFiles.length > 0 && strayFiles.length === 0) {
    ok('the bundle names no image file outside the MOTION manifest', `${manifestFiles.length} clip name(s): ${manifestFiles.join(', ')}`)
  } else {
    bad('the bundle names no image file outside the MOTION manifest',
      strayFiles.length ? `stray: ${strayFiles.join(', ')}` : 'no MOTION manifest found')
  }

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

/* 最后一条，也是"多端"里最不起眼的一端：README 里那个**项数**。
   它每加一条检查就该动一次，而它没有任何守卫 —— 实测漂过（544/546/588/631…），
   读者看到的是一个没人核对过的数字。这里让它等于**真实项数**（含这一条自己）。
   注意：它必须放在所有检查之后，且用 ok()/bad() 自己计数，所以比较时 +1。 */
if (existsSync(join(here, 'README.md'))) {
  const readmeText = readFileSync(join(here, 'README.md'), 'utf8')
  /* README 顶部那个版本号同样必须等于 package.json。它刚漂过一次：package 已经是
     1.40.0，README 还写着 1.39.0 —— 而此前没有任何检查盯着它（只有 WHATS_NEW 那条）。 */
  const readmeVersion = (/当前版本 `([^`]+)`/.exec(readmeText) ?? [])[1]
  check(readmeVersion === pkg.version, 'the README header quotes the packaged version',
    `README ${readmeVersion ?? '(没写)'} vs package ${pkg.version}`)

  /* 客户端自己抓的那条路必须真的能成：给它一个可用的 window.fetch，她要报出版本。
     这就是 1.44.0 的全部要点 —— bundle 客户端半包是普通页面脚本，fetch 可用。 */
  {
    const fetched = createHarness({ timer: true, composerText: '' })
    const keepFetched = active
    active = fetched
    fetched.win.fetch = (url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).indexOf('raw.githubusercontent') >= 0 ? { version: '1.0.0' } : { version: '9.9.9' }),
    })
    fetched.evaluate(clientSrc)
    fetched.module().default.apply(fetched.ctx, { reactions: false, wander: false, celebrate: false })
    fetched.advance(1000, 100)
    const clientRes = await fetched.win.__wisp.checkForUpdate()
    check(clientRes.state === 'available' && clientRes.latest === '9.9.9' && clientRes.from === 'npm',
      'with a usable window.fetch the CLIENT half does the whole check itself — no host RPC involved',
      JSON.stringify(clientRes))
    fetched.win.__wisp.destroy()
    active = keepFetched
  }
  /* 动作层**绝不许吃 CSS filter**（v1.45.3 立的规矩，v1.46.1 换成动图 <img> 之后照旧）：
     滤镜会给这一层再插一次栅格化，alpha 剪影被重新合成一遍就是"她整个人变黑"的成因。
     阴影与调色只属于静态立绘。 */
  {
    const css = String(clientSrc)
    const motionRule = (css.match(/\.wisp-video\{[^}]*\}/g) || []).join(' ')
    check(motionRule.length > 0 && !/filter\s*:/.test(motionRule),
      'no CSS filter is applied to the motion layer (a filter re-rasterises the alpha cutout)',
      motionRule.slice(0, 160))
    check(!/\[data-mood="[a-z]+"\]\s*\.wisp-video\{[^}]*filter\s*:/.test(css),
      'and no mood rule re-adds a filter to the motion layer either')
  }
  const quoted = Number((/当前 \*\*(\d+) 项全 PASS/.exec(readmeText) ?? [])[1])
  const total = checks + 1
  if (quoted === total) {
    ok('the README quotes the real check count', `${total} 项`)
  } else {
    bad('the README quotes the real check count',
      `README 写着 ${Number.isFinite(quoted) ? quoted : '(没写)'}，实际 ${total} —— 改了检查就顺手改那一行`)
  }
}

head(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
console.log(failures === 0
  ? '  Both halves match their contracts. A remaining failure would be outside\n  this package: restart the app to rebuild its loader graph.\n'
  : '  Fix the FAIL lines above before reloading the app.\n')
process.exit(failures === 0 ? 0 : 1)
