/* ============================================================================
   dsh-wisp — browser half.  GENERATED FILE — edit lib/client.template.js then
   run `node build.mjs`. The build injects one object of data URIs (see the SPRITES const).

   A CLASSIC browser script that registers itself with the web shell's module
   loader. Not an ES module: no import, no export.

       window.__ModuleLoader__.load({ id, factory: (require) => { … } })

   The companion is DeepSeek娘 — the community's personification of DeepSeek.
   Four AI-generated sprites are embedded as data URIs so the plugin stays a
   single self-contained file with no asset paths to resolve. See NOTICE.md for
   the character and image provenance.

   Moods map to sprites:
       idle   -> idle    (default)
       alert  -> work    (agent is busy, or the composer has text)
       happy  -> happy   (you clicked her, or a run just finished)
       sleep  -> sleepy  (left alone for a while)

   FOUR PLATFORM FACTS THIS FILE IS BUILT AROUND (each one cost a debugging
   session — the traps are documented in NOTICE.md):

   1. setTimeout / setInterval / clearTimeout / clearInterval / fetch / require
      are THROWING TRAPS inside a client half evaluated by the dynamic runner.
      All timing here comes from the Client `timer` service (ctx.get('timer')),
      with a requestAnimationFrame deadline table as the fallback for a shell
      that does not provide it. Neither path ever touches a trapped global.

   2. The rAF fallback is armed ONLY while jobs are pending. An always-on frame
      loop would keep a desktop GUI process waking sixty times a second to do
      nothing — and pointermove fires often enough that re-arming a job per
      event is its own small leak.

   3. Sprite bytes reach <img> through a blob: object URL, never as the raw
      `data:` URI: this shell serves its UI from a custom origin and renders a
      data: image source as a broken-image icon.

   4. The bubble and text colors come from the app's own theme tokens
      (--dsw-alias-*) with hard-coded fallbacks, and the light/dark fallback is
      keyed off `body[data-ds-dark-theme]` — the attribute the shell's theme
      presenter actually writes.
   ========================================================================== */
window.__ModuleLoader__.load({
  id: 'dsh-wisp/client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const VERSION = '0.6.0'

    /* ---- sprites: 256x384 WebP, transparent, inlined by build.mjs ---- */
    const SPRITES = __SPRITES_LITERAL__

    /* ---------------------------------------------------------------------
       SPRITE URL RESOLUTION — why this is not simply `img.src = dataUri`.

       The first shipped build set `img.src` to the base64 data URI directly.
       The plugin loaded (console showed "[wisp] mounted"), the DOM was correct
       and the ground glow rendered — but the sprite box showed a broken-image
       icon. The embedded bytes were verified good (RIFF/WEBP magic, 256x384
       RGBA), so the failure was the page refusing a `data:` URI as an image
       source. This shell serves its UI over a custom `dsh-app://` protocol,
       which appears to intercept resource loads.

       So the data URI is decoded into a Blob and an object URL is used instead,
       which is what the page accepts. Blob URLs are revoked on teardown.
       --------------------------------------------------------------------- */
    const blobUrls = Object.create(null)

    const resolveSprite = (dataUri) => {
      if (blobUrls[dataUri]) return blobUrls[dataUri]
      try {
        const comma = dataUri.indexOf(',')
        const meta = dataUri.slice(0, comma)
        const body = dataUri.slice(comma + 1)
        const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/webp'
        const bin = atob(body)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
        blobUrls[dataUri] = url
        return url
      } catch (error) {
        // Blob unavailable for some reason — fall back to the raw data URI.
        blobUrls[dataUri] = dataUri
        return dataUri
      }
    }

    /* Revoking is not enough: this cache is per MODULE, while a mount is per
       apply, so a second apply in the same module (HMR, or the singleton
       replacement below) would otherwise hand the new <img> a revoked blob URL
       and render the sprite as a broken image. Dropping the entries makes the
       next mount rebuild them. */
    const revokeSprites = () => {
      for (const key in blobUrls) {
        const url = blobUrls[key]
        if (typeof url === 'string' && url.indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(url) } catch (e) { /* ignore */ }
        }
        delete blobUrls[key]
      }
    }

    /* ---- geometry: one box per mood so she never jumps ---- */
    const BOX_W = 140
    const BOX_H = 210
    const GROUND = 46          // px from the bottom edge to her feet
    const SAY_MS = 4400        // bubble lifetime
    const SAY_MAX_W = 210      // must match .wisp-say max-width in the CSS
    const SAY_CLEARANCE = 84   // room the bubble needs above its anchor
    const POLL_MS = 1200       // reaction poll
    const WAKE_THROTTLE_MS = 1000

    const DEFAULTS = {
      bottom: GROUND,
      right: 26,
      sleepAfterMs: 90000,
      reactions: true,
      size: 4,                  // 560x840 CSS px, drawn from the 2048x3072 tier
      persist: true,            // remember where she was dragged to
      celebrate: true,          // cheer when a run finishes
      celebrateAfterMs: 2500,   // ...but only for runs that lasted this long
      chatterMs: 0,             // 0 = she stays quiet when idle
      happyMs: 1100,
      wander: true,             // stroll around on her own while idle
      wanderMs: 45000,          // how often she considers moving
      wanderRange: 260,         // furthest a single stroll may travel
    }

    const LINES = {
      hello: ['我在这儿。', '灯亮着，你忙你的。', '需要我就戳一下。'],
      click: ['嗯？', '在的。', '别戳啦。', '……痒。', '有事说，没事也成。', '我一直看着屏幕呢。'],
      happy: ['叮——', '这个我喜欢。', '再来一次？'],
      sleep: ['呼……', '我眯一会儿。'],
      wake: ['醒了醒了。', '嗯，我在。'],
      done: ['跑完了。', '收了。', '这一轮结束。', '去看看？'],
      chatter: ['……', '有点安静。', '我在数窗外的光。'],
      move: ['这儿也行。', '我挪个位置。', '让让，我站这儿。'],
      home: ['回来了。', '还是老地方。', '嗯，归位。'],
    }
    const pick = (a) => a[Math.floor(Math.random() * a.length)]
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

    /* Read the clock through `window` only. The obvious `window.performance &&
       performance.now()` mixes two references: in a page they are the same
       object, but under a shell that supplies its own `window` the bare
       `performance` global can be a different — or absent — one, and then every
       deadline is computed on one time base and compared against another, so
       nothing ever comes due. */
    const nowMs = () => {
      const perf = window.performance
      return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
    }

    /* ---------------------------------------------------------------------
       CONFIG — normalized and clamped on the way in.

       The config arrives from a profile YAML patch, so nothing about it is
       guaranteed: a typo yields a string where a number belongs, and an
       extreme value yields a companion nobody can find or click. Clamping
       here means a bad patch degrades into a usable wisp instead of a bug
       report.
       --------------------------------------------------------------------- */
    const num = (value, lo, hi, fallback) => {
      const n = typeof value === 'number' && isFinite(value) ? value : fallback
      return clamp(n, lo, hi)
    }
    const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

    /* One table drives both the initial normalization and the partial merge a
       runtime `configure({…})` performs, so a key can never be clamped one way
       at mount and another way later. */
    const CONFIG_SPEC = {
      bottom: { kind: 'num', lo: 0, hi: 4000 },
      right: { kind: 'num', lo: 0, hi: 4000 },
      size: { kind: 'num', lo: 0.4, hi: 8 },
      sleepAfterMs: { kind: 'num', lo: 5000, hi: 3600000 },
      celebrateAfterMs: { kind: 'num', lo: 0, hi: 600000 },
      chatterMs: { kind: 'num', lo: 0, hi: 3600000 },
      happyMs: { kind: 'num', lo: 200, hi: 10000 },
      wanderMs: { kind: 'num', lo: 5000, hi: 3600000 },
      wanderRange: { kind: 'num', lo: 0, hi: 2000 },
      reactions: { kind: 'bool' },
      persist: { kind: 'bool' },
      celebrate: { kind: 'bool' },
      wander: { kind: 'bool' },
    }

    const coerce = (key, value, fallback) => {
      const spec = CONFIG_SPEC[key]
      return spec.kind === 'num' ? num(value, spec.lo, spec.hi, fallback) : bool(value, fallback)
    }

    const normalizeConfig = (config) => {
      const src = config && typeof config === 'object' ? config : {}
      const cfg = {}
      for (const key in CONFIG_SPEC) cfg[key] = coerce(key, src[key], DEFAULTS[key])
      return cfg
    }

    /* Merge only the keys the caller actually sent: `configure({size: 2})` must
       not silently reset every other preference to its default. */
    const mergeConfig = (cfg, partial) => {
      if (!partial || typeof partial !== 'object') return cfg
      for (const key in CONFIG_SPEC) {
        if (!Object.prototype.hasOwnProperty.call(partial, key)) continue
        cfg[key] = coerce(key, partial[key], cfg[key])
      }
      return cfg
    }

    /* ---------------------------------------------------------------------
       CLOCK — one scheduling surface, two implementations.

       `mode` is reported on the handle and in the mount log so a bug report can
       say which path this page took without a debugger.
       --------------------------------------------------------------------- */
    const createServiceClock = (timer) => {
      const live = []
      const track = (handle) => { live.push(handle); return handle }
      const release = (handle) => {
        const at = live.indexOf(handle)
        if (at >= 0) live.splice(at, 1)
      }
      return {
        mode: 'timer-service',
        after(ms, fn) {
          const handle = { cancelled: false, release: null }
          handle.release = timer.timeout(() => {
            handle.cancelled = true
            release(handle)
            fn()
          }, ms)
          return track(handle)
        },
        every(ms, fn) {
          const handle = { cancelled: false, release: null }
          handle.release = timer.interval(() => {
            if (!handle.cancelled) fn()
          }, ms)
          return track(handle)
        },
        cancel(handle) {
          if (!handle || handle.cancelled) return
          handle.cancelled = true
          release(handle)
          try { handle.release() } catch (e) { /* already fired */ }
        },
        dispose() {
          const pending = live.splice(0, live.length)
          for (const handle of pending) {
            handle.cancelled = true
            try { handle.release() } catch (e) { /* already fired */ }
          }
        },
      }
    }

    const createFrameClock = (win) => {
      const jobs = []
      let frame = 0

      const arm = () => {
        if (frame === 0 && jobs.length > 0) frame = win.requestAnimationFrame(tick)
      }
      const tick = () => {
        frame = 0
        const now = nowMs()
        for (let i = jobs.length - 1; i >= 0; i--) {
          const job = jobs[i]
          if (now < job.at) continue
          if (job.every > 0) job.at = now + job.every
          else { job.cancelled = true; jobs.splice(i, 1) }
          try { job.fn() } catch (e) { /* one failing job must not stop the clock */ }
        }
        arm()   // stop the loop entirely once nothing is pending
      }
      const push = (ms, fn, every) => {
        const handle = { cancelled: false, at: nowMs() + ms, fn, every: every ? ms : 0 }
        jobs.push(handle)
        arm()
        return handle
      }

      return {
        mode: 'animation-frame',
        after: (ms, fn) => push(ms, fn, false),
        every: (ms, fn) => push(ms, fn, true),
        cancel(handle) {
          if (!handle || handle.cancelled) return
          handle.cancelled = true
          const at = jobs.indexOf(handle)
          if (at >= 0) jobs.splice(at, 1)
        },
        dispose() {
          for (const job of jobs) job.cancelled = true
          jobs.length = 0
          if (frame !== 0) {
            try { win.cancelAnimationFrame(frame) } catch (e) { /* ignore */ }
            frame = 0
          }
        },
      }
    }

    const createClock = (ctx) => {
      const timer = ctx && typeof ctx.get === 'function' ? ctx.get('timer') : undefined
      if (timer && typeof timer.timeout === 'function' && typeof timer.interval === 'function') {
        return createServiceClock(timer)
      }
      return createFrameClock(window)
    }

    /* ---------------------------------------------------------------------
       STORAGE — best effort, never fatal.

       Reading `window.localStorage` itself throws on an opaque origin, which is
       exactly what the desktop shell can be: the same plugin has to survive a
       page that has no storage at all, so every access is guarded and a miss
       just means "no remembered position".
       --------------------------------------------------------------------- */
    const POSITION_KEY = 'dsh-wisp:position:v1'

    const readStored = (key) => {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? null : JSON.parse(raw)
      } catch (e) {
        return null
      }
    }
    const writeStored = (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
        return true
      } catch (e) {
        return false
      }
    }

    /* ---------------------------------------------------------------------
       THE CSS. Three things are deliberate:

       * Colors prefer the app's own alias tokens, so the companion inherits
         whatever theme is active (including a third-party one) instead of
         hard-coding a white bubble that looks wrong in one palette. The
         token-free fallbacks are the hand-tuned pair, and
         `body[data-ds-dark-theme]` is the shell's real dark switch.

       * The bubble lives in `.wisp-layer`, NOT inside `.wisp-root`. It used to
         be a child of the root, which mirrored its text whenever she faced left
         (the root carries `scaleX(-1)`) and scaled its font with `size`. In
         screen space it stays readable and unmirrored at any size.

       * `--wisp-scale` carries the render scale for the few decorations that
         should grow with her even though the root is laid out at its final
         size rather than transform-scaled.
       --------------------------------------------------------------------- */
    const CSS = `.wisp-layer{position:fixed;inset:0;z-index:2147482000;pointer-events:none;overflow:hidden;font-family:inherit;--wisp-scale:1;--wisp-say-fg:#0d1a22;--wisp-say-bg:rgba(255,255,255,.93);--wisp-say-line:rgba(15,30,40,.10);--wisp-ink:#3b5a70}
.wisp-root{position:absolute;width:${BOX_W}px;height:${BOX_H}px;pointer-events:none;transform-origin:top center;--wisp-aura:rgba(110,200,255,.42)}
.wisp-root[data-dragging="true"]{will-change:transform}
.wisp-root[data-gliding="true"]{transition:transform 1.6s cubic-bezier(.4,0,.2,1)}
.wisp-body{position:absolute;inset:0;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;animation:wisp-bob 5.6s ease-in-out infinite}
.wisp-body:active{cursor:grabbing}
.wisp-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:bottom center;filter:drop-shadow(0 6px 14px rgba(0,0,0,.30));transition:opacity .28s ease,filter .5s ease}
.wisp-shine{position:absolute;left:50%;bottom:-8px;width:68%;height:16px;margin-left:-34%;border-radius:50%;background:radial-gradient(ellipse at center,var(--wisp-aura) 0%,transparent 70%);filter:blur(4px);pointer-events:none;transition:background .5s ease}
.wisp-zzz{position:absolute;right:6px;top:8px;font-size:calc(13px * var(--wisp-scale));font-weight:600;color:var(--wisp-ink);text-shadow:0 0 8px var(--wisp-aura);animation:wisp-zzz 2.6s ease-out infinite;pointer-events:none}
.wisp-say{position:absolute;max-width:210px;width:max-content;padding:7px 11px;border-radius:12px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,var(--wisp-say-fg));background:var(--dsw-alias-bg-overlay,var(--wisp-say-bg));border:1px solid var(--dsw-alias-border-l1,var(--wisp-say-line));box-shadow:0 6px 24px rgba(0,0,0,.22);-webkit-backdrop-filter:blur(14px) saturate(160%);backdrop-filter:blur(14px) saturate(160%);animation:wisp-say 4.2s ease forwards;pointer-events:none;white-space:pre-wrap}
.wisp-root[data-mood="alert"]{--wisp-aura:rgba(255,196,92,.50)}
.wisp-root[data-mood="happy"]{--wisp-aura:rgba(255,132,206,.50)}
.wisp-root[data-mood="sleep"]{--wisp-aura:rgba(140,152,215,.30)}
body[data-ds-dark-theme] .wisp-layer{--wisp-say-fg:#eaf2f8;--wisp-say-bg:rgba(20,24,32,.88);--wisp-say-line:rgba(255,255,255,.14);--wisp-ink:#cfe6ff}
.wisp-root[data-mood="sleep"] .wisp-body{animation-duration:9s}
.wisp-root[data-mood="alert"] .wisp-body{animation-duration:4.6s}
.wisp-root[data-mood="happy"] .wisp-body{animation-name:wisp-hop;animation-duration:1.15s;animation-timing-function:ease-in-out}
.wisp-root[data-mood="sleep"] .wisp-img{filter:drop-shadow(0 6px 14px rgba(0,0,0,.25)) saturate(.82) brightness(.96)}
@keyframes wisp-bob{0%{transform:translate3d(0,0,0)}50%{transform:translate3d(0,-9px,0)}100%{transform:translate3d(0,0,0)}}
@keyframes wisp-zzz{0%{opacity:0;transform:translate(0,0) scale(.6)}30%{opacity:.9}100%{opacity:0;transform:translate(14px,-30px) scale(1.15)}}
@keyframes wisp-hop{0%,100%{transform:translate3d(0,0,0)}45%{transform:translate3d(0,-16px,0)}}
@keyframes wisp-say{0%{opacity:0;transform:translate(-50%,-100%) translateY(6px) scale(.94)}12%{opacity:1;transform:translate(-50%,-100%) translateY(0) scale(1)}82%{opacity:1;transform:translate(-50%,-100%) translateY(0) scale(1)}100%{opacity:0;transform:translate(-50%,-100%) translateY(-6px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.wisp-body{animation:none!important}}`

    const installStyles = (styles) => {
      if (styles && typeof styles.insert === 'function') {
        try {
          const dispose = styles.insert(CSS)
          if (typeof dispose === 'function') return dispose
          return null
        } catch (e) { /* fall through to the owned <style> tag */ }
      }
      const head = document.head || document.documentElement
      if (!head) return null
      if (!document.getElementById('dsh-wisp-css')) {
        const tag = document.createElement('style')
        tag.id = 'dsh-wisp-css'
        tag.textContent = CSS
        head.appendChild(tag)
        return () => { if (tag.parentNode) tag.remove() }
      }
      return null
    }

    /* ---- hit testing: only her own pixels may take the pointer ----
       `.wisp-body` has to cover a whole box to be draggable, and that box is
       mostly empty: a standing figure in a 2:3 frame only fills 55-87% of the
       width (measured), and the rest is transparent margin. At the shipped size
       that margin sits over the composer, so a click aimed at Send would be
       swallowed by nothing. Sampling the sprite's alpha channel is what makes a
       large companion harmless. */
    const MASK_W = 96
    const MASK_H = 144
    const MASK_MIN_ALPHA = 16
    const masks = Object.create(null)

    /** 3x3 grow, so the hit area is never tighter than the eye expects. */
    const dilate = (src) => {
      const out = new Uint8Array(src.length)
      for (let y = 0; y < MASK_H; y++) {
        for (let x = 0; x < MASK_W; x++) {
          if (src[y * MASK_W + x] <= MASK_MIN_ALPHA) continue
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy
            if (ny < 0 || ny >= MASK_H) continue
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx
              if (nx < 0 || nx >= MASK_W) continue
              out[ny * MASK_W + nx] = 255
            }
          }
        }
      }
      return out
    }

    const buildMask = (key, url) => {
      if (masks[key]) return
      try {
        const canvas = document.createElement('canvas')
        if (!canvas || typeof canvas.getContext !== 'function') return
        const ctx = canvas.getContext('2d')
        if (!ctx || typeof ctx.drawImage !== 'function' || typeof ctx.getImageData !== 'function') return
        canvas.width = MASK_W
        canvas.height = MASK_H
        const probe = new Image()
        probe.onload = () => {
          try {
            ctx.drawImage(probe, 0, 0, MASK_W, MASK_H)
            const data = ctx.getImageData(0, 0, MASK_W, MASK_H).data
            const raw = new Uint8Array(MASK_W * MASK_H)
            let anyOpaque = false
            for (let i = 0; i < raw.length; i++) {
              raw[i] = data[i * 4 + 3]
              if (raw[i] > MASK_MIN_ALPHA) anyOpaque = true
            }
            // A mask with no opaque pixel at all means the draw or the read did
            // not do what we think (a cleared canvas, an unexpected format).
            // Falling back to the whole box keeps her grabbable; the alternative
            // is a companion that ignores every click.
            if (!anyOpaque) return
            // One cell of dilation: the mask is coarser than the sprite (each
            // cell is ~3.6 CSS px at the shipped size) and her widest pixels are
            // the aura, so without this a click that looks like it is on her
            // edge falls into the pass-through margin.
            masks[key] = dilate(raw)
          } catch (e) { /* tainted or unsupported: the full box stays hittable */ }
        }
        probe.src = url
      } catch (e) { /* no canvas: the full box stays hittable */ }
    }

    /* ---------------------------------------------------------------------
       WHAT THE APP IS DOING — read from the DOM, deliberately.

       These are facts the shell renders for its own users, so they survive DSH
       version upgrades the way an internal service contract does not.

       Cost matters here because this runs on a timer for as long as the app is
       open, and both arms were measured in Chromium on a 10k-node transcript
       (40k in brackets):

         querySelectorAll('[data-composer-input],[contenteditable="true"],textarea')
             0.33 ms (1.42 ms)   full-document COLLECTION, every tick
         querySelector('button[aria-label="…"]') x4 exact
             0.45 ms (1.86 ms)   four full traversals to find nothing, which is
                                 the usual case: the button is absent when idle
         querySelector('button[aria-label*="停止"],…*="Stop"]')
             0.27 ms (1.10 ms)   two traversals, and it also matches a label we
                                 have not seen yet — the label is localized

       So: the composer is resolved ONCE and cached, re-resolved only when the
       element leaves the document, and busy detection uses the two substring
       arms. Same reaction, roughly a third of the cost.
       --------------------------------------------------------------------- */
    const STOP_SELECTOR = 'button[aria-label*="停止"],button[aria-label*="Stop"]'

    /* Most specific hook first; the older shapes are only tried when it is
       missing, and only on the cold path. */
    const COMPOSER_HOOKS = ['[data-composer-input]', 'textarea', '[contenteditable="true"]']
    const MISS_RETRY_POLLS = 4

    const agentIsBusy = () => !!document.querySelector(STOP_SELECTOR)

    let composerEl = null
    let composerMisses = 0

    const composerHasText = () => {
      if (composerEl === null || composerEl.isConnected === false) {
        // The precise hook is probed every tick while unresolved — it is one
        // early-exit query, and a composer that has just appeared (a session was
        // opened) must not wait seconds to be noticed.
        composerEl = document.querySelector(COMPOSER_HOOKS[0])
        if (composerEl === null && composerMisses++ % MISS_RETRY_POLLS === 0) {
          // The pre-`data-composer-input` shapes match any rich-text editor on
          // the page, so they are only worth probing occasionally.
          for (let i = 1; i < COMPOSER_HOOKS.length && composerEl === null; i++) {
            composerEl = document.querySelector(COMPOSER_HOOKS[i])
          }
        }
      }
      if (composerEl === null) return false
      composerMisses = 0
      const text = composerEl.tagName === 'TEXTAREA' ? composerEl.value : composerEl.textContent
      return !!(text && text.trim().length > 0)
    }

    const mount = (config, ctx) => {
      const cfg = normalizeConfig(config)
      const clock = createClock(ctx)
      const styleDispose = installStyles(ctx && typeof ctx.get === 'function' ? ctx.get('styles') : undefined)

      const vw = () => window.innerWidth || 1400
      const vh = () => window.innerHeight || 900
      /* The box she OCCUPIES is the base box times the render scale, and every
         clamp and placement below goes through these two. Clamping against the
         unscaled box let a scaled wisp hang off the edge with her drag area in
         the wrong place — invisible at size 1, obvious at any other. */
      const boxW = () => BOX_W * cfg.size
      const boxH = () => BOX_H * cfg.size
      const maxX = () => Math.max(0, vw() - boxW())
      const maxY = () => Math.max(0, vh() - boxH())
      const halfSay = () => Math.min(SAY_MAX_W / 2, Math.max(0, (vw() - 20) / 2))

      const layer = document.createElement('div')
      layer.className = 'wisp-layer'
      /* Critical layout is written INLINE as well as in the stylesheet.
         A `position: static` div appended to <body> is an in-flow block, and a
         non-absolute <img> is an in-flow replaced element — either one can make
         the whole page scrollable if the stylesheet is not applied yet (or at
         all) when this mounts, which is exactly what boot-time mounting risks.
         Inline styles cannot be missing. */
      layer.style.position = 'fixed'
      layer.style.top = '0'
      layer.style.left = '0'
      layer.style.right = '0'
      layer.style.bottom = '0'
      layer.style.overflow = 'hidden'
      layer.style.pointerEvents = 'none'
      layer.style.zIndex = '2147482000'

      const root = document.createElement('div')
      root.className = 'wisp-root'
      root.dataset.mood = 'idle'
      root.style.position = 'absolute'
      root.style.pointerEvents = 'none'
      root.style.transformOrigin = 'top center'

      /* Restore where she was left, clamped into the current viewport: the
         window may well have been resized (or moved to another monitor) since
         the position was written. */
      const stored = cfg.persist ? readStored(POSITION_KEY) : null
      const coords = { x: 0, y: 0 }
      if (stored && isFinite(stored.x) && isFinite(stored.y)) {
        coords.x = clamp(stored.x, 0, maxX())
        coords.y = clamp(stored.y, 0, maxY())
      } else {
        coords.x = clamp(vw() - cfg.right - boxW(), 0, maxX())
        coords.y = clamp(vh() - cfg.bottom - boxH(), 0, maxY())
      }

      /* The root is LAID OUT at its final size rather than transform-scaled:
         a scaled layer is rasterized once and then stretched, so an enlarged
         sprite goes soft, whereas a laid-out box rasterizes the 512px source at
         the size it is actually drawn at. Only the left/right mirror stays a
         transform. `transform-origin` is the top CENTRE so mirroring happens in
         place — with the old `top left` origin she jumped a full box width to
         the left the moment she crossed the midline. */
      root.style.width = Math.round(boxW()) + 'px'
      root.style.height = Math.round(boxH()) + 'px'
      layer.style.setProperty('--wisp-scale', String(cfg.size))

      /* ---- the speech bubble lives in screen space (see the CSS note) ---- */
      let sayEl = null
      const placeSay = () => {
        if (sayEl === null) return
        const half = halfSay()
        const centre = coords.x + boxW() / 2
        const upper = Math.max(half + 10, vw() - half - 10)
        sayEl.style.left = Math.round(Math.min(Math.max(centre, half + 10), upper)) + 'px'
        // The bubble hangs ABOVE this anchor, so it needs clearance: at a size
        // where she is pinned to the top of the viewport the anchor would sit at
        // y=0 and the bubble would render entirely off-screen.
        sayEl.style.top = Math.round(Math.max(coords.y, SAY_CLEARANCE)) + 'px'
      }

      const paint = () => {
        const facing = coords.x + boxW() / 2 < vw() / 2 ? -1 : 1
        // The translate places the box's TOP-LEFT corner, so it is `coords.x`,
        // NOT `coords.x + boxW()/2`: a translation is origin-independent, and
        // feeding it a centre offset put the whole box half a box-width to the
        // right, off the edge of the viewport. The mirror still pivots in place
        // because `transform-origin` is the top CENTRE.
        root.style.transform = 'translate3d(' + coords.x + 'px,' + coords.y + 'px,0) scaleX(' + facing + ')'
        placeSay()
      }
      paint()

      const bodyEl = document.createElement('div')
      bodyEl.className = 'wisp-body'
      bodyEl.style.position = 'absolute'
      bodyEl.style.top = '0'
      bodyEl.style.left = '0'
      bodyEl.style.right = '0'
      bodyEl.style.bottom = '0'
      bodyEl.style.pointerEvents = 'auto'
      bodyEl.setAttribute('role', 'button')
      bodyEl.setAttribute('tabindex', '-1')
      bodyEl.setAttribute('aria-label', 'DeepSeek娘')

      const shine = document.createElement('div')
      shine.className = 'wisp-shine'

      const img = document.createElement('img')
      img.className = 'wisp-img'
      img.style.position = 'absolute'
      img.style.top = '0'
      img.style.left = '0'
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.objectFit = 'contain'
      img.style.objectPosition = 'bottom center'
      img.alt = ''
      img.draggable = false
      img.decoding = 'async'
      img.onerror = () => {
        if (typeof console !== 'undefined' && console.error) console.error('[wisp] sprite failed to load')
      }
      let currentSprite = 'idle'

      const setSprite = (key) => {
        const url = resolveSprite(SPRITES[key])
        buildMask(key, url)
        currentSprite = key
        /* Cross-fade rather than swapping `src` outright: a hard swap makes every
           mood change read as a glitch. The outgoing sprite keeps its own layer
           for the length of the fade, then is removed. */
        const previous = img.src
        if (!previous || previous === url) {
          img.src = url
          img.style.opacity = '1'
          return
        }
        const outgoing = document.createElement('img')
        outgoing.className = 'wisp-img'
        outgoing.style.position = 'absolute'
        outgoing.style.top = '0'
        outgoing.style.left = '0'
        outgoing.style.width = '100%'
        outgoing.style.height = '100%'
        outgoing.style.objectFit = 'contain'
        outgoing.style.objectPosition = 'bottom center'
        outgoing.style.opacity = '1'
        outgoing.draggable = false
        outgoing.setAttribute('aria-hidden', 'true')
        outgoing.src = previous
        bodyEl.insertBefore(outgoing, img)
        img.src = url
        img.style.opacity = '0'
        clock.after(16, () => {
          if (destroyed) return
          img.style.opacity = '1'
          outgoing.style.opacity = '0'
        })
        clock.after(340, () => { if (outgoing.parentNode) outgoing.parentNode.removeChild(outgoing) })
      }

      bodyEl.appendChild(shine)
      bodyEl.appendChild(img)
      root.appendChild(bodyEl)
      layer.appendChild(root)
      setSprite('idle')

      let destroyed = false
      let attached = false
      let attachAttempts = 0

      const attach = () => {
        if (destroyed || attached) return
        if (!document.body) {
          // The client half can in principle run before <body> exists; a bounded
          // retry beats both a crash and an unbounded poll.
          if (attachAttempts++ < 60) clock.after(50, attach)
          else if (console && console.error) console.error('[wisp] document.body never appeared')
          return
        }
        document.body.appendChild(layer)
        attached = true
      }

      /* ---- mood -> sprite ---- */
      const SPRITE_OF = { idle: 'idle', alert: 'work', happy: 'happy', sleep: 'sleepy' }
      let mood = 'idle'

      const setMood = (next) => {
        if (destroyed || mood === next) return
        mood = next
        root.dataset.mood = next
        const want = SPRITE_OF[next] || 'idle'
        if (want !== currentSprite) setSprite(want)
        const zs = root.querySelectorAll('.wisp-zzz')
        for (let i = zs.length - 1; i >= 0; i--) zs[i].remove()
        if (next === 'sleep') {
          const z1 = document.createElement('div'); z1.className = 'wisp-zzz'; z1.textContent = 'z'
          const z2 = document.createElement('div'); z2.className = 'wisp-zzz'; z2.textContent = 'z'
          z2.style.right = '24px'; z2.style.top = '-2px'; z2.style.animationDelay = '1.1s'
          root.appendChild(z1); root.appendChild(z2)
        }
      }

      let sayHandle = null
      const say = (text) => {
        if (destroyed) return
        if (sayEl !== null && sayEl.parentNode) sayEl.remove()
        const el = document.createElement('div')
        el.className = 'wisp-say'
        el.style.position = 'absolute'
        el.textContent = text
        // Into the LAYER, not the root: a child of the root would be mirrored
        // with her and scaled by `size`.
        layer.appendChild(el)
        sayEl = el
        placeSay()
        if (sayHandle) clock.cancel(sayHandle)
        sayHandle = clock.after(SAY_MS, () => {
          if (sayEl === el) sayEl = null
          if (el.parentNode) el.remove()
        })
      }

      /* ---- idle / wake ----
         The sleep deadline is re-armed at most once a second. pointermove can
         fire over a hundred times a second, and cancelling plus recreating a
         timer for each of those is pure overhead for a decision whose real
         resolution is ninety seconds. */
      let sleepHandle = null
      let lastWakeAt = 0
      const armSleep = () => {
        if (sleepHandle) clock.cancel(sleepHandle)
        sleepHandle = clock.after(cfg.sleepAfterMs, () => {
          sleepHandle = null
          if (destroyed) return
          setMood('sleep')
          if (Math.random() < 0.6) say(pick(LINES.sleep))
        })
      }
      const wake = (force) => {
        if (destroyed) return
        const now = nowMs()
        if (!force && now - lastWakeAt < WAKE_THROTTLE_MS) return
        lastWakeAt = now
        if (mood === 'sleep') {
          setMood('idle')
          if (Math.random() < 0.5) say(pick(LINES.wake))
        }
        armSleep()
      }
      const WAKE_EVENTS = ['pointerdown', 'keydown', 'wheel', 'pointermove']
      for (const ev of WAKE_EVENTS) window.addEventListener(ev, wake, { passive: true })

      /* ---- theme: follow the shell's own light/dark decision ---- */
      const themeService = ctx && typeof ctx.get === 'function' ? ctx.get('theme') : undefined
      let offTheme = null
      const applyTheme = (snapshot) => {
        const scheme = snapshot && snapshot.active && snapshot.active.colorScheme === 'dark' ? 'dark' : 'light'
        root.dataset.wispTheme = scheme
      }
      if (themeService && typeof themeService.getTheme === 'function') {
        try { applyTheme(themeService.getTheme()) } catch (e) { /* the CSS fallback still applies */ }
      }
      if (ctx && typeof ctx.on === 'function') {
        try {
          offTheme = ctx.on('theme/change', (snapshot) => {
            try { applyTheme(snapshot) } catch (e) { /* ignore a malformed snapshot */ }
          })
        } catch (e) { offTheme = null }
      }

      /* ---- react to what the app is doing ---- */
      let lastBusy = false
      let busySince = 0
      let happyHandle = null

      const flashHappy = (text) => {
        setMood('happy')
        say(text)
        if (happyHandle) clock.cancel(happyHandle)
        happyHandle = clock.after(cfg.happyMs, () => { if (mood === 'happy') setMood('idle') })
      }

      const poll = () => {
        if (destroyed) return
        let busy = false
        try { busy = agentIsBusy() } catch (e) { busy = false }
        if (busy && !lastBusy) busySince = nowMs()
        if (!busy && lastBusy && cfg.celebrate && nowMs() - busySince >= cfg.celebrateAfterMs) {
          flashHappy(pick(LINES.done))
        }
        lastBusy = busy
        if (mood === 'sleep' || mood === 'happy') return
        let typing = false
        try { typing = composerHasText() } catch (e) { typing = false }
        setMood((busy || typing) ? 'alert' : 'idle')
      }

      let chatterHandle = null
      const syncChatter = () => {
        if (chatterHandle) { clock.cancel(chatterHandle); chatterHandle = null }
        if (cfg.chatterMs <= 0) return
        chatterHandle = clock.every(cfg.chatterMs, () => {
          if (destroyed || mood !== 'idle') return
          if (agentIsBusy()) return
          say(pick(LINES.chatter))
        })
      }

      let pollHandle = null
      const syncPoll = () => {
        if (pollHandle) { clock.cancel(pollHandle); pollHandle = null }
        if (cfg.reactions) pollHandle = clock.every(POLL_MS, poll)
      }
      syncPoll()
      syncChatter()

      /* ---- 自己踱步 ----
         只在真正空闲时发生，并且是一段可见的滑行而不是瞬移。滑行期间挂
         `data-gliding`，由 CSS 过渡接管 transform；一旦按下就立刻摘掉，
         否则拖动会被过渡拖后腿。 */
      let glideHandle = null
      const glideTo = () => {
        root.dataset.gliding = 'true'
        paint()
        if (glideHandle) clock.cancel(glideHandle)
        glideHandle = clock.after(1700, () => {
          glideHandle = null
          delete root.dataset.gliding
        })
      }
      const stopGlide = () => {
        if (glideHandle) { clock.cancel(glideHandle); glideHandle = null }
        delete root.dataset.gliding
      }

      let wanderHandle = null
      const syncWander = () => {
        if (wanderHandle) { clock.cancel(wanderHandle); wanderHandle = null }
        if (!cfg.wander || cfg.wanderRange <= 0) return
        wanderHandle = clock.every(cfg.wanderMs, () => {
          if (destroyed || mood !== 'idle' || start !== null) return
          if (agentIsBusy()) return
          // A random bearing with a floor on the distance, so a stroll is always
          // a real stroll rather than a rounding error in a random direction.
          const angle = Math.random() * Math.PI * 2
          const dist = cfg.wanderRange * (0.45 + Math.random() * 0.55)
          coords.x = clamp(coords.x + Math.cos(angle) * dist, 0, maxX())
          coords.y = clamp(coords.y + Math.sin(angle) * dist * 0.6, 0, maxY())
          glideTo()
          // 故意不 rememberPosition()：记忆的是"用户把她放在哪"，她自己的溜达
          // 不该覆盖那个意图，否则刷新后她会出现在一个用户从没选过的位置。
        })
      }
      syncWander()

      /* ---- drag & click ---- */
      let start = null, origin = null, moved = false, lastClick = 0

      const rememberPosition = () => {
        if (!cfg.persist) return
        writeStored(POSITION_KEY, { x: Math.round(coords.x), y: Math.round(coords.y) })
      }

      /** Whether this pointer is over an opaque pixel of the current sprite. */
      const hitsBody = (e) => {
        const mask = masks[currentSprite]
        if (!mask) return true            // no mask yet: stay grabbable rather than vanish
        const boxw = boxW()
        const boxh = boxH()
        let mx = (e.clientX - coords.x) / boxw
        const my = (e.clientY - coords.y) / boxh
        if (mx < 0 || mx >= 1 || my < 0 || my >= 1) return false
        // The root mirrors about its centre, so sample the un-mirrored pixel.
        if (coords.x + boxw / 2 < vw() / 2) mx = 1 - mx
        const col = Math.min(MASK_W - 1, Math.floor(mx * MASK_W))
        const row = Math.min(MASK_H - 1, Math.floor(my * MASK_H))
        return mask[row * MASK_W + col] > MASK_MIN_ALPHA
      }

      const onMove = (e) => {
        if (!start) return
        const dx = e.clientX - start.x, dy = e.clientY - start.y
        if (!moved && Math.sqrt(dx * dx + dy * dy) > 4) moved = true
        if (!moved) return
        coords.x = clamp(origin.x + dx, 0, maxX())
        coords.y = clamp(origin.y + dy, 0, maxY())
        paint()
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        delete root.dataset.dragging
        start = null
        if (moved) {
          rememberPosition()
          if (Math.random() < 0.35) say(pick(LINES.move))
          return
        }
        if (destroyed) return
        const now = Date.now()
        const dbl = now - lastClick < 420
        lastClick = now
        wake(true)
        flashHappy(dbl ? pick(LINES.happy) : pick(LINES.click))
      }
      const onDown = (e) => {
        if (e.button !== 0) return
        // Only her own pixels grab the pointer. Her transparent margins pass the
        // click through, but anywhere she is actually drawn she is grabbable —
        // including over the composer: she can be moved, so she does not have to
        // yield to whatever she is standing on.
        if (!hitsBody(e)) return
        stopGlide()          // a stroll must not fight the drag
        e.preventDefault(); e.stopPropagation()
        start = { x: e.clientX, y: e.clientY }
        origin = { x: coords.x, y: coords.y }
        moved = false
        root.dataset.dragging = 'true'
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      bodyEl.addEventListener('pointerdown', onDown)

      /* ---- 右键 = 叫回原位 ----
         她大了之后很容易被拖到看不见的地方，而"恢复位置"原先只能开 Console。
         右键她本体即可归位。 */
      const onContext = (e) => {
        if (!hitsBody(e)) return
        e.preventDefault(); e.stopPropagation()
        stopGlide()
        // 默认落点（右下角），并把记忆的位置一起抹掉，避免下次刷新又跑回去
        try { window.localStorage.removeItem(POSITION_KEY) } catch (err) { /* 存储不可用 */ }
        coords.x = clamp(vw() - cfg.right - boxW(), 0, maxX())
        coords.y = clamp(vh() - cfg.bottom - boxH(), 0, maxY())
        paint()
        rememberPosition()
        say(pick(LINES.home))
      }
      bodyEl.addEventListener('contextmenu', onContext)

      const onResize = () => {
        coords.x = clamp(coords.x, 0, maxX())
        coords.y = clamp(coords.y, 0, maxY())
        paint()
      }
      window.addEventListener('resize', onResize)

      attach()
      clock.after(800, () => say(pick(LINES.hello)))
      wake(true)

      /* warm the other sprites after the first frame so mood changes never blink */
      clock.after(1500, () => {
        if (destroyed) return
        for (const key in SPRITES) {
          if (key === currentSprite) continue
          const pre = new Image()
          pre.src = resolveSprite(SPRITES[key])
        }
      })

      const applyConfig = (partial) => {
        mergeConfig(cfg, partial)
        // A bigger companion occupies a bigger box, so the stored position has
        // to be re-clamped or she would grow off the edge.
        root.style.width = Math.round(boxW()) + 'px'
        root.style.height = Math.round(boxH()) + 'px'
        layer.style.setProperty('--wisp-scale', String(cfg.size))
        coords.x = clamp(coords.x, 0, maxX())
        coords.y = clamp(coords.y, 0, maxY())
        paint()
        armSleep()
        syncPoll()
        syncChatter()
        syncWander()
        return api
      }

      const api = {
        version: VERSION,
        clock: clock.mode,
        say,
        mood: setMood,
        move(x, y) { coords.x = x; coords.y = y; paint() },
        configure: applyConfig,
        resetPosition() {
          try { window.localStorage.removeItem(POSITION_KEY) } catch (e) { /* ignore */ }
          coords.x = clamp(vw() - cfg.right - boxW(), 0, maxX())
          coords.y = clamp(vh() - cfg.bottom - boxH(), 0, maxY())
          paint()
        },
        get element() { return root },
        get sprites() { return Object.keys(SPRITES) },
        get position() { return { x: Math.round(coords.x), y: Math.round(coords.y) } },
        get currentMood() { return mood },
        destroy() {
          if (destroyed) return
          destroyed = true
          rememberPosition()
          clock.dispose()
          for (const ev of WAKE_EVENTS) window.removeEventListener(ev, wake)
          window.removeEventListener('resize', onResize)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          bodyEl.removeEventListener('pointerdown', onDown)
          bodyEl.removeEventListener('contextmenu', onContext)
          if (typeof offTheme === 'function') {
            try { offTheme() } catch (e) { /* ignore */ }
            offTheme = null
          }
          if (typeof styleDispose === 'function') {
            try { styleDispose() } catch (e) { /* ignore */ }
          }
          if (layer.parentNode) layer.remove()
          revokeSprites()
          if (window.__wisp === api) delete window.__wisp
        },
      }
      window.__wisp = api
      return api
    }

    const plugin = {
      name: 'wisp',
      apply(ctx, config) {
        try {
          /* Single instance, always. A re-apply (HMR, a duplicate row, or the
             console-injection build) must replace the companion rather than
             stack a second one on top of it. */
          const previous = window.__wisp
          if (previous && typeof previous.destroy === 'function') {
            try { previous.destroy() } catch (e) { /* never let a dead instance block a live one */ }
          }
          const instance = mount(config, ctx)
          if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(() => () => instance.destroy(), 'dsh-wisp: teardown')
          }
          if (typeof console !== 'undefined' && console.log) {
            console.log('[wisp] mounted — DeepSeek娘 v' + VERSION + ' (timers: ' + instance.clock + ')')
          }
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[wisp] mount failed', error && error.message)
          }
        }
      },
    }

    exports.default = plugin
    exports.plugin = plugin
    exports.apply = plugin.apply
    exports.name = plugin.name
    exports.version = VERSION

    return module.exports
  },
})
