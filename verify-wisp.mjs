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
  }

  const created = []
  const frames = []
  const rafSlots = new Map()
  let rafSeq = 0
  const timers = []
  const store = new Map()

  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [], parentNode: null, dataset: {}, attrs: {},
      style: { setProperty(k, v) { this[k] = v }, getPropertyValue(k) { return this[k] ?? '' } },
      className: '', textContent: '', id: '', value: '',
      listeners: Object.create(null),
      _src: '',
      get firstChild() { return this.children[0] ?? null },
      get src() { return this._src },
      set src(v) { this._src = v; if (this.tagName === 'IMG') harness.srcs.push(v) },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null },
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
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c },
      remove() { if (this.parentNode) this.parentNode.removeChild(this) },
      descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]) },
      querySelector(sel) {
        const cls = typeof sel === 'string' && sel.startsWith('.') ? sel.slice(1) : null
        return cls === null ? null : this.descendants().find((d) => d.className === cls) ?? null
      },
      querySelectorAll(sel) {
        const cls = typeof sel === 'string' && sel.startsWith('.') ? sel.slice(1) : null
        return cls === null ? [] : this.descendants().filter((d) => d.className === cls)
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
  const queries = { stop: 0, composer: 0, all: 0 }
  const COMPOSER_HOOKS = ['[data-composer-input]', 'textarea', '[contenteditable="true"]']
  const documentShim = {
    body: bodyEl,
    head: headEl,
    createElement: (t) => makeEl(t),
    getElementById: (id) => created.find((e) => e.id === id) ?? null,
    querySelector: (sel) => {
      if (typeof sel !== 'string') return null
      if (sel.startsWith('button[')) { queries.stop++; return state.busy ? {} : null }
      if (COMPOSER_HOOKS.includes(sel)) {
        queries.composer++
        return state.composerText === null ? null : composerNode
      }
      return null
    },
    querySelectorAll: (sel) => { queries.all++; return [] },
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
  let teardown = null
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
    effect: (fn) => { teardown = fn; return () => {} },
  }

  const harness = {
    state, ctx, win, document: documentShim, bodyEl, created, frames, timers, queries,
    srcs: [], urLs: [], revoked: [], blobs: [], styleInserts,
    loaded: null,
    timerService,
    get teardown() { return teardown },
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
    find: (className) => created.find((e) => e.className === className) ?? null,
    all: (className) => created.filter((e) => e.className === className),
    /** Evaluate lib/client.js the way the shell does, with every trap armed. */
    evaluate(src) {
      const traps = {}
      for (const name of TRAPPED) traps[name] = () => { throw new Error(`${name} is not available in a dynamic client half`) }
      // eslint-disable-next-line no-new-func
      new Function('window', 'document', ...TRAPPED, src)(
        win, documentShim, ...TRAPPED.map((name) => traps[name]),
      )
    },
    module() {
      if (!harness.loaded) throw new Error('load() was never called')
      return harness.loaded.factory(() => ({}))
    },
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
    check(said !== null && ['跑完了。', '收了。', '这一轮结束。', '去看看？'].includes(said.textContent),
      'the celebration says something', said?.textContent)
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
    check(placed !== null && placed.x === after.x && placed.y === after.y,
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
    const undestroyed = h.teardown
    check(typeof undestroyed === 'function', 'ctx.effect teardown registered')
    const disposal = undestroyed()
    check(typeof disposal === 'function', 'ctx.effect returns a disposer')
    check(liveBefore > 0, 'timers were live before teardown', `${liveBefore}`)
    disposal()

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
    modF.apply(hf.ctx, { reactions: false, chatterMs: 0, sleepAfterMs: 5000 })
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
  } catch (error) {
    bad('browser half executes', `${error.constructor.name}: ${error.message}`)
    console.log(error.stack)
  } finally {
    active = null
    for (const [key, value] of Object.entries(savedGlobals)) globalThis[key] = value
  }
}

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

if (clientSrc !== null) {
  const uris = (clientSrc.match(/data:image\/(?:webp|png);base64,/g) || []).length
  if (uris === 4) ok('all four sprites inlined as data URIs')
  else bad('all four sprites inlined as data URIs', `found ${uris}, expected 4`)

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
