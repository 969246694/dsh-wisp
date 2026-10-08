// Host half of dsh-wisp.
//
// Two jobs, both small:
//
//   1. Answer the browser half's `host.call('checkUpdate')` — the ONE thing the
//      companion cannot do on its own: the browser half's `fetch` is a teaching
//      trap, and this half runs in a vm sandbox whose Node APIs are trapped too.
//      The platform's answer to that is a *service*: `ctx.web.fetch(...)`, the
//      same seam DSH's own `web_fetch` tool uses. Services are the sanctioned way
//      for a sandboxed half to reach a real capability, so the update check goes
//      through it — nothing is bypassed.
//
//   2. Answer `host.call('checkBalance')` — the account balance, through the
//      `deepseekAccount` service. NOT through our own HTTP call with an API key:
//      that service is documented as "only Host consumers can obtain a request
//      credential", which is exactly the right shape — the platform owns the
//      login, the plugin never sees a token, and there is nothing to leak into
//      the page (the browser half could not read a key even if we had one).
//      Neither service is declared in `inject`, and that is not an oversight —
//      it is the v1.48.3 fix. Cordis's static `inject` waits for EVERY name it
//      lists, and a `{ required: [], optional: [...] }` literal lists two
//      services named `required` and `optional`, which no composition provides.
//      That parked this fiber in PENDING forever: `apply()` never ran, so the
//      route, checkUpdate and checkBalance never existed. Both services are
//      resolved AT CALL TIME with `ctx.get(name)` instead (see the block above
//      the `inject` export, and resolveWebService / resolveAccountService).
//
// WHY TWO SOURCES. npm's registry is the authoritative one, but a publish can sit
// in npm's staging queue for a long time (observed: `PUT 202`, still 404 after 18
// minutes, and re-publishing the same version is refused with 409). GitHub's raw
// manifest updated immediately in the same situation. So the check reads BOTH and
// reports the HIGHER version — which is correct whether or not npm has caught up.
// "npm first, GitHub as fallback" would read the stale npm number and claim you
// were up to date.

/* `node:url` / `node:module` are imported statically: this file is loaded by
   the Loader as an ordinary ES module, and both are needed on the module's
   first line of work (resolving the package's own asset directory). */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/* ---------------------------------------------------------------------------
   MOTION CLIPS OVER HTTP (v1.47.0) — the delivery seam for the frame
   animations.

   WHY THIS EXISTS. Until 1.46.5 the animated WebPs were base64-inlined into
   lib/client.js by build.mjs. Two 720p clips already cost 7.83 MB of base64;
   the eight swimsuit clips would have added ~30 MB and taken the browser half
   to roughly 45 MB. That is not a budget problem that can be squeezed — it is
   the wrong place to put multi-megabyte video-ish assets.

   HOW THE PACKAGE CAN STILL DELIVER THEM. A browser half that inlines nothing
   has exactly two documented ways to reach bytes: `@deepseek-ai/dsh-client-
   resources` (a `dsh-resource://` live-VALUE model for slot components — it
   needs a React provider and yields values, not an image URL, so it is not an
   asset route), and the platform's own HTTP carrier. `dsh-host-webserver` is
   documented as "let the feature plugins claim their routes", `ctx.webServer`
   and `ctx.fs` are both live Host services, and the Loader imports THIS file
   as an ES module — so `import.meta.url` resolves the package directory. That
   is a complete path from the package's own files to an `<img src>`:

     <pkg>/assets/motion/<clip>.webp
       -> GET <origin>/wisp-motion/<clip>.webp   (this route)
       -> new URL('wisp-motion/<clip>.webp', document.baseURI)   (client half)

   The browser half never calls `fetch` (it is a trapped global) and never
   learns a filesystem path: it only asks the page's own origin for a URL.

   WHAT HAPPENS WHEN IT IS NOT THERE. Every failure is silent and already
   specified elsewhere in this plugin: an unregistered route (the Desktop
   carrier serves the shell without an HTTP server), a 404, a decode error —
   the `<img>` fires `error`, the client half hides the motion layer and hands
   the picture back to the static sprite. Nothing throws, nothing is logged,
   and there is still exactly one of her on screen. `__wisp.doctor().motion.
   frame` reports it.

   SCOPE. The handler is deliberately a closed list, not a file server: one
   path segment, `<name>.webp`, no separators, no percent-decoding games,
   nothing outside <pkg>/assets/motion/. Anything else is a 404.

   ---------------------------------------------------------------------------
   WHY v1.47.x SERVED NOTHING — AND WHY "404" COULD NOT SAY WHICH HALF BROKE.

   The route was registered, and every clip 404'd anyway. Two different faults
   produce exactly the same 404 with exactly the same (empty) body:

     (a) the route was never claimed — nothing ran, the platform's own
         not-found fallback answered; or
     (b) the route ran and could not read the file.

   With one indistinguishable 404 in the log, "she is standing still again" had
   no diagnosis at all. So this half now answers three questions separately,
   and the third one is the one that was missing:

     1. DID MY HANDLER RUN?   Every response from here carries
        `x-wisp-motion: hit`; the platform's fallback 404 carries no
        content-type and no such header. `GET /wisp-motion/__diag` returns the
        same verdict as JSON, plus the counters.

     2. WAS THE ROUTE MATCHED? The carrier's prefix table is NOT
        `pathname.startsWith(prefix)`. `@deepseek-ai/dsh-host-webserver`'s
        `match()` is:

            pathname === prefix || pathname.startsWith(`${prefix}/`)

        — it appends the separator itself. A route registered at
        `'/wisp-motion/'` therefore matches only `'/wisp-motion'` and
        `'/wisp-motion//…'`, and NEVER `'/wisp-motion/idle.webp'`, which is the
        only URL the browser half asks for. 1.47.0/1.47.1 registered the
        trailing-slash form: the registration succeeded, the fiber owned it,
        disposal worked — and not one request ever reached the handler. The
        platform answered every one of them with its own 404.

        So there are two names, and they are not the same string:

          MOTION_ROUTE_PATH  '/wisp-motion'   the registration key (no slash —
                                              the matcher adds the separator)
          MOTION_PATH        '/wisp-motion/'  the URL prefix everything else
                                              uses (the client half, the tests)

     3. CAN THE FILE BE READ — AND THROUGH WHAT? Through the platform's `fs`
        service, never through a Node module. Method signatures were read from
        the live registry (`cordis_inspect_query` -> Host `Service.listService`,
        service `fs`) rather than guessed:

            ctx.get('fs').resolve(path, opts?)            -> Promise<FsTarget>
            ctx.get('fs').contains(parent, child)         -> boolean
            ctx.get('fs').stat(target, signal?)           -> Promise<FsInfo|undefined>
            ctx.get('fs').readBytes(target, signal, cap)  -> Promise<Uint8Array>

        `resolve` is documented as "normalizes + realpaths" for the local
        backend and `contains` as "canonical containment", so the name check
        (no separator, no `..`) is backed by a REAL-PATH prefix check: a
        symlink inside assets/motion/ that points out of the package resolves
        outside the directory and is refused by `contains`.

        `defaultReadBytes` (node:fs) stays exported because the preflight runs
        this module in plain Node with no ctx, and because __diag reports
        whether that road is even open in this shell. The RUNTIME never picks
        it: `registerMotionRoute` builds the service reader from `ctx`.
   --------------------------------------------------------------------------- */

/** URL prefix the browser half asks for. Kept in sync with MOTION_ROUTE in lib/client.template.js. */
export const MOTION_PATH = '/wisp-motion/'

/**
 * The key this route is REGISTERED under — deliberately NOT {@link MOTION_PATH}.
 *
 * The web server's prefix matcher compares `pathname === prefix` or
 * `pathname.startsWith(prefix + '/')`, so the registration key must not carry a
 * trailing slash. Registering `'/wisp-motion/'` matches nothing a page ever
 * requests. See the block above for the full story.
 */
export const MOTION_ROUTE_PATH = '/wisp-motion'

/** The one read-only diagnostic endpoint, under the same prefix. */
export const MOTION_DIAG_NAME = '__diag'

/**
 * The second read-only endpoint under the same prefix: **the published versions**,
 * read by the HOST half through the platform's `web` service (v1.49.7).
 *
 * 它存在的理由是一次实测：这台机器的系统代理开着（`127.0.0.1:7897`），**经它访问
 * registry.npmjs.org 连 TLS 都建不起来**，而宿主（Node，直连）是通的 —— 于是
 * "检查更新"在页面上永远只会是 `fetch-failed`（窗口标题里那句
 * `wisp-diag failed fetch-failed via=- how=- why=- mgr=-` 就是这么来的），
 * 尽管这个插件本来就有一条能用的路。
 *
 * 页面对本端点的请求是**同源**的（和素材共用 `/wisp-motion/`），不经过页面那一侧的
 * 系统代理、也不涉及 CORS —— 所以它现在排在客户端侧的第一位：宿主先把两个源问出来，
 * 页面只负责读。
 */
export const MOTION_UPDATE_NAME = '__update'

/** Only these names are servable. A clip name never contains a separator. */
const MOTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/

/** Refuse to serve anything larger than this even if it lands in assets/motion/. */
export const MOTION_MAX_BYTES = 12 * 1024 * 1024

/** Where the signature list above came from — quoted in __diag so it can be re-checked. */
export const FS_SERVICE_SIGNATURES = 'Service.listService: fs.resolve(path, opts?) / fs.contains(parent, child) / '
  + 'fs.stat(target, signal?) / fs.readBytes(target, signal, maxBytes)'

/**
 * Absolute path of one shipped clip, or null when the name is not servable.
 *
 * `import.meta.url` is the installed lib/index.js, so `../assets/motion/` is
 * the package's own asset directory whether the profile installed this from
 * npm or linked it from a checkout.
 *
 * @param name - the requested file name (already stripped of the route prefix).
 * @returns the host path, or null when the name must not be served.
 */
export function motionFile(name) {
  if (typeof name !== 'string' || !MOTION_NAME.test(name)) return null
  try {
    return fileURLToPath(new URL(`../assets/motion/${name}`, import.meta.url))
  } catch (error) {
    return null
  }
}

/**
 * Absolute path of the package's own clip directory — the containment root.
 * @returns the host path of <pkg>/assets/motion/, or null when unresolvable.
 */
export function motionDir() {
  try {
    return fileURLToPath(new URL('../assets/motion/', import.meta.url))
  } catch (error) {
    return null
  }
}

/** One short, stable name for a failure — the thing a diagnosis can quote. */
export function describeError(error) {
  if (error === null || error === undefined) return null
  if (typeof error === 'string') return error.slice(0, 160)
  const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
  const message = typeof error.message === 'string' ? error.message : String(error)
  const code = typeof error.code === 'string' && error.code !== '' ? ` [${error.code}]` : ''
  return `${name}${code}: ${message}`.slice(0, 200)
}

/** Read-only probe: is the Node-module road even open in this shell? Never used to serve. */
export function nodeFsProbe(absolutePath) {
  try {
    const require = createRequire(import.meta.url)
    const fs = require('node:fs')
    const stat = fs.statSync(absolutePath)
    return { available: true, bytes: stat.size, error: null }
  } catch (error) {
    return { available: false, bytes: null, error: describeError(error) }
  }
}

/**
 * The runtime reader: the platform's `fs` service, resolved at call time.
 *
 * Resolution is lazy for the same reason the `web` service is (see
 * resolveWebService): this half can materialize before `fs` is provided, and an
 * optional dependency that was absent at start would otherwise disable the
 * route forever. Nothing here falls back to a Node module — the sanctioned
 * service is the only road this reader takes.
 *
 * @param ctx - the plugin context.
 * @param dir - the containment root (<pkg>/assets/motion/).
 * @param options - `maxBytes` cap; defaults to MOTION_MAX_BYTES.
 * @returns `{ read, state }` — `read` never throws and resolves to bytes or null.
 */
export function createServiceReader(ctx, dir, options = {}) {
  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : MOTION_MAX_BYTES
  const state = {
    via: 'fs-service',
    why: 'fs 服务尚未查询',
    reads: 0,
    misses: 0,
    lastError: null,
    lastPath: null,
    lastBytes: null,
    resolvedDir: null,
  }
  let service
  let dirTarget = null
  const lookup = () => {
    /* 只在**拿到**时缓存：拿不到就下次再查。这条和 web 服务那处同一个理由 ——
       这个半包可能在 fs 服务注册之前就起来了，一次失败的查询不该把路由永久钉死。 */
    if (service) return service
    let value
    let getThrew = null
    try {
      value = ctx && typeof ctx.get === 'function' ? ctx.get('fs') : undefined
    } catch (error) { getThrew = describeError(error) }
    if (value === undefined || value === null) {
      try { value = ctx && ctx.fs } catch (error) { /* ctx.fs is a plain property; ignore */ }
    }
    if (value && typeof value.resolve === 'function' && typeof value.readBytes === 'function') {
      service = value
      state.via = 'fs-service'
      state.why = 'ctx.get("fs") 可用（' + FS_SERVICE_SIGNATURES + '）'
      return service
    }
    state.via = 'none'
    state.why = getThrew !== null
      ? 'ctx.get("fs") 抛错：' + getThrew
      : 'ctx.get("fs") 拿不到带 resolve/readBytes 的服务（拿到的是 ' + typeof value + '）'
    return null
  }
  return {
    state,
    async read(absolutePath) {
      const fs = lookup()
      if (fs === null) { state.misses++; state.lastError = 'no-fs-service'; return null }
      state.reads++
      state.lastPath = absolutePath
      try {
        if (dirTarget === null) {
          dirTarget = await fs.resolve(dir)
          state.resolvedDir = typeof fs.processPath === 'function' ? fs.processPath(dirTarget) : dir
        }
        const target = await fs.resolve(absolutePath)
        /* REAL-PATH containment: `resolve` realpaths, so a symlink that escapes
           the package resolves outside and is refused here — the name regex
           alone would have allowed it. */
        if (typeof fs.contains === 'function' && fs.contains(dirTarget, target) !== true) {
          state.misses++
          state.lastError = 'outside-motion-dir'
          return null
        }
        if (typeof fs.stat === 'function') {
          const info = await fs.stat(target)
          if (info === undefined || info === null) { state.misses++; state.lastError = 'ENOENT'; return null }
          if (info.type !== 'file') { state.misses++; state.lastError = 'not-a-file:' + String(info.type); return null }
          if (typeof info.size === 'number' && info.size > maxBytes) {
            state.misses++
            state.lastError = 'FS_TOO_LARGE:' + info.size
            return null
          }
        }
        const bytes = await fs.readBytes(target, undefined, maxBytes)
        if (bytes === undefined || bytes === null) { state.misses++; state.lastError = 'empty-read'; return null }
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        state.lastBytes = view.byteLength
        state.lastError = null
        return view
      } catch (error) {
        state.misses++
        state.lastError = describeError(error)
        return null
      }
    },
  }
}

/**
 * Build the route handler.
 *
 * Async on purpose: the reader may be the `fs` service (a promise) or the
 * plain-Node preflight reader (a value), and the handler is the seam both go
 * through. It never throws — a broken read is a 404, which the browser half
 * already turns into the static sprite.
 *
 * @param readBytes - `(absolutePath) => Uint8Array | null`, sync or async, never throws.
 * @param options - `reader` (its `state` is reported by __diag), `packageDir`, `nodeProbe`.
 * @returns a `node:http`-shaped handler that also answers /wisp-motion/__diag.
 */
export function motionHandler(readBytes, options = {}) {
  const readerState = options.reader && typeof options.reader === 'object' ? options.reader : null
  /* v1.48.3: `__diag` also answers "did the host half's apply() actually run,
     and which handlers did it register?" — the one question a PENDING fiber
     made unanswerable, because a parked fiber looks exactly like a missing
     route from the outside. Null when no state was handed in (unit drivers). */
  const hostState = typeof options.host === 'function' ? options.host : null
  const stats = {
    hits: 0,
    served: 0,
    notFound: 0,
    refused: 0,
    diag: 0,
    update: 0,
    lastStatus: null,
    lastPath: null,
    firstHitAt: null,
    lastHitAt: null,
  }
  return async function handleMotion(req, res) {
    const send = (status, headers, body) => {
      stats.hits++
      stats.lastStatus = status
      if (status === 200) stats.served++
      else if (status === 404) stats.notFound++
      else stats.refused++
      const stamp = new Date().toISOString()
      if (stats.firstHitAt === null) stats.firstHitAt = stamp
      stats.lastHitAt = stamp
      /* This header is the whole point of the diagnostic: it says "MY handler
         ran" even when the answer is a 404. The platform's fallback 404 carries
         no content-type and no such header. */
      const all = { 'x-wisp-motion': 'hit', ...headers }
      try { res.writeHead(status, all) } catch (error) { /* headers already out */ }
      try { res.end(body) } catch (error) { /* client vanished */ }
    }
    const text = (status) => send(status, { 'content-type': 'text/plain; charset=utf-8' })
    let url = null
    try { url = new URL(String(req && req.url ? req.url : '/'), 'http://wisp.invalid') } catch (error) { url = null }
    const pathname = url === null ? '/' : url.pathname
    const method = String((req && req.method) || 'GET').toUpperCase()
    stats.lastPath = pathname

    /* ---- 已发布版本（v1.49.7）------------------------------------------------
       宿主半包替页面去问两个源。为什么不让页面自己问：系统代理一旦指向一个连不上
       registry 的代理，页面的 fetch 就永远是 fetch-failed，而宿主（Node，直连）
       是通的。这条路是**同源**的，页面那一侧不需要任何外部网络。

       reader 由 registerMotionRoute 注入（它手里有 ctx 与 config.urls）；没有
       reader 时如实回 503，绝不假装成功。这个分支**不读文件**，所以也不会因为
       fs 服务缺失而失败。 */
    if (pathname === `${MOTION_ROUTE_PATH}/${MOTION_UPDATE_NAME}`) {
      stats.update++
      const readPublished = typeof options.readPublished === 'function' ? options.readPublished : null
      let payload
      if (readPublished === null) {
        payload = { ok: false, reason: 'no-update-reader' }
      } else {
        try {
          const verdict = await readPublished()
          payload = verdict && typeof verdict === 'object' ? verdict : { ok: false, reason: 'bad-verdict' }
        } catch (error) {
          payload = { ok: false, reason: 'reader-threw', detail: describeError(error) }
        }
      }
      return send(200, {
        'content-type': 'application/json; charset=utf-8',
        /* 版本信息一秒都别缓存：这条端点存在的意义就是"现在到底是哪一版"。 */
        'cache-control': 'no-store',
      }, JSON.stringify({ ...payload, via: 'host-route', checkedAt: new Date().toISOString() }))
    }

    if (pathname === `${MOTION_ROUTE_PATH}/${MOTION_DIAG_NAME}`) {
      stats.diag++
      /* 默认探哪一条：**必须是包里真有的**（v1.49.0 起是 `canon_idle.webp`），
         否则 __diag 的默认输出永远是一句"读不到"，而那不是路由的实情。 */
      const probeName = (url && url.searchParams.get('name')) || 'canon_idle.webp'
      const probePath = motionFile(probeName)
      const started = Date.now()
      let probe = { name: probeName, path: probePath, ok: false, bytes: null, ms: null, error: null, magic: null }
      if (probePath === null) {
        probe.error = 'name-not-servable'
      } else {
        try {
          const bytes = await readBytes(probePath)
          probe.ms = Date.now() - started
          if (bytes === undefined || bytes === null || bytes.byteLength === 0) {
            probe.error = readerState !== null && readerState.lastError ? readerState.lastError : 'read-returned-nothing'
          } else {
            probe.ok = true
            probe.bytes = bytes.byteLength
            const head = bytes.subarray(0, 12)
            probe.magic = String.fromCharCode(head[0], head[1], head[2], head[3]) + '/'
              + String.fromCharCode(head[8], head[9], head[10], head[11])
          }
        } catch (error) {
          probe.ms = Date.now() - started
          probe.error = describeError(error)
        }
      }
      const node = options.nodeProbe === false || probePath === null
        ? { available: null, bytes: null, error: null, note: 'skipped' }
        : { ...nodeFsProbe(probePath), note: '只读诊断；发送素材**不**走这条路' }
      /* 用一个**包里真有的**名字当例子（v1.49.0 起是 canon_idle.webp）：这条
         example 是给"注册键匹配不匹配页面要的 URL"这条自查用的，用一个不存在的
         名字演示只会让人以为路由有问题。 */
      const example = `${MOTION_ROUTE_PATH}/canon_idle.webp`
      const matcher = (prefix) => example === prefix || example.startsWith(`${prefix}/`)
      const body = JSON.stringify({
        ok: true,
        route: {
          registeredAt: typeof options.path === 'string' ? options.path : MOTION_ROUTE_PATH,
          urlPrefix: MOTION_PATH,
          kind: 'prefix',
          /* 载体那条规则原样抄在这里，连同"尾斜杠注册键匹配不上"的实测结论 ——
             这条 404 曾经无法追问，现在它自己会说话。 */
          carrierRule: 'pathname === prefix || pathname.startsWith(prefix + \'/\')',
          registeredKeyMatchesExample: matcher(MOTION_ROUTE_PATH),
          trailingSlashKeyMatchesExample: matcher(MOTION_PATH),
          /* v1.49.7: 页面读"已发布版本"的端点也在这条前缀下，所以把它的地址与
             调用次数一并报出来 —— "检查更新用的是哪条路"必须一眼可见。 */
          updateEndpoint: `${MOTION_ROUTE_PATH}/${MOTION_UPDATE_NAME}`,
          updateReader: typeof options.readPublished === 'function' ? 'host' : null,
          ...stats,
        },
        module: {
          url: import.meta.url,
          packageDir: options.packageDir ?? null,
          motionDir: motionDir(),
        },
        reader: readerState === null
          ? { via: 'injected', why: '测试注入的读取器（预检驱动 handler 时走这条）', reads: null, misses: null, lastError: null, lastPath: null, lastBytes: null }
          : { ...readerState },
        /* "宿主半包跑没跑" —— 这一行就是那次 pending 事故留下的现场检查口。 */
        host: hostState === null ? null : hostState(),
        probe,
        node,
        signatures: FS_SERVICE_SIGNATURES,
        at: new Date().toISOString(),
      })
      send(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body)
      return
    }
    if (pathname === MOTION_ROUTE_PATH || pathname === MOTION_PATH) {
      /* The bare prefix is not a list endpoint — there is nothing to enumerate. */
      text(404)
      return
    }
    if (!pathname.startsWith(MOTION_PATH)) {
      text(404)
      return
    }
    const file = motionFile(pathname.slice(MOTION_PATH.length))
    if (file === null) {
      text(404)
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      return
    }
    let bytes = null
    try { bytes = await readBytes(file) } catch (error) { bytes = null }
    if (bytes === null || bytes === undefined || bytes.byteLength === 0) {
      text(404)
      return
    }
    if (bytes.byteLength > MOTION_MAX_BYTES) {
      text(413)
      return
    }
    const headers = {
      'content-type': 'image/webp',
      'content-length': String(bytes.byteLength),
      /* The clip name is the identity: a changed clip is a new file, not a new
         body under the same URL. A day of cache keeps a reload cheap without
         pinning a stale loop for the life of the page. */
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    }
    if (method === 'HEAD') { send(200, headers); return }
    send(200, headers, bytes)
  }
}

/**
 * Register the motion route on the platform's HTTP carrier.
 *
 * Optional on purpose: `webServer` does not exist under every carrier, and a
 * missing route is the documented silent-degradation path, not a load failure.
 *
 * The registered key is {@link MOTION_ROUTE_PATH} — no trailing slash, because
 * the carrier appends the separator itself. Registering {@link MOTION_PATH}
 * here is exactly the 1.47.x bug: a healthy registration that matches nothing.
 *
 * The reader is built from `ctx` (the `fs` service) unless a caller injects one
 * — the preflight does, so it can drive the handler in plain Node.
 *
 * @param ctx - the plugin context.
 * @returns `{ registered, why, path, reader }` — never throws.
 */
export function registerMotionRoute(ctx, options = {}) {
  try {
    if (!ctx || typeof ctx.inject !== 'function') return { registered: false, why: 'no-ctx-inject' }
    const path = typeof options.path === 'string' ? options.path : MOTION_ROUTE_PATH
    const reader = options.reader !== undefined
      ? options.reader
      : (options.readBytes !== undefined
        ? { read: options.readBytes, state: null }
        : createServiceReader(ctx, motionDir()))
    const read = reader && typeof reader.read === 'function' ? reader.read : defaultReadBytes
    /* 同一份 verdict，两条路共用（v1.49.7）：宿主座位的 checkUpdate 与页面的
       /wisp-motion/__update 读的是同一个函数，答案不可能互相矛盾。 */
    const urls = options.urls && typeof options.urls === 'object' ? options.urls : DEFAULT_SOURCES
    const readPublished = typeof options.readPublished === 'function'
      ? options.readPublished
      : () => readPublishedForPage(ctx, urls)
    ctx.inject(['webServer'], (webCtx) => {
      if (!webCtx || typeof webCtx.webServer?.register !== 'function') return
      try {
        webCtx.effect(
          () => webCtx.webServer.register({
            kind: 'prefix',
            path,
            handler: motionHandler(read, {
              reader: reader ? reader.state : null,
              path,
              host: typeof options.host === 'function' ? options.host : hostApplyState,
              readPublished,
            }),
          }),
          'dsh-wisp: motion clips over the host HTTP carrier',
        )
      } catch (error) {
        /* 注册失败（例如路由被占）不能让整个插件倒掉：这条路由是**可选**的，
           没有它画面就是静态立绘。 */
      }
    })
    return { registered: true, path, reader }
  } catch (error) {
    return { registered: false, why: String(error && error.message ? error.message : error).slice(0, 120) }
  }
}

/**
 * Read one clip from disk with a Node module. Returns null instead of throwing:
 * every caller treats "cannot read" as "serve 404", which the browser half
 * already turns into the static sprite.
 *
 * PREFLIGHT + DIAGNOSTIC ONLY (see the block above MOTION_PATH). The running
 * plugin reads through the `fs` service; this exists because verify-wisp.mjs
 * loads this module in plain Node with no ctx to get a service from, and
 * because __diag reports whether this road is open in the live shell at all.
 *
 * @param absolutePath - the clip's host path.
 * @returns the bytes, or null.
 */
export function defaultReadBytes(absolutePath) {
  try {
    const require = createRequire(import.meta.url)
    const fs = require('node:fs')
    return new Uint8Array(fs.readFileSync(absolutePath))
  } catch (error) {
    return null
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wisp'

/** Stamped into every balance request. Must match package.json — the preflight guards it. */
export const VERSION = '1.50.1'

/**
 * NO DECLARED SERVICE DEPENDENCIES — deliberately, and this line is load-bearing.
 *
 * Cordis does NOT read `{ required, optional }` here. The static `inject` export
 * is a NAME → INTERCEPT-CONFIG map (or a plain array of names); the loader
 * normalizes it with `Array.isArray(inject) ? inject : Object.keys(inject)`, so
 * the 1.47.x/1.48.x literal `{ required: [], optional: ['web', 'deepseekAccount'] }`
 * declared two services literally NAMED `required` and `optional`. Nothing
 * provides either, so `Fiber._refresh()` could never fill `_store`, the fiber
 * stayed PENDING, `apply()` was never called, and everything this half does —
 * `/wisp-motion/`, `checkUpdate`, `checkBalance` — simply did not exist. The
 * install log said it in one line and nobody read it as a bug:
 *
 *     wisp (dsh-wisp): pending (waiting for services: required, optional)
 *
 * WHY IT COULD NOT BE FIXED BY RESTARTING. The declaration is re-read on every
 * boot, so the fiber parked again on every boot; the browser half is delivered
 * independently (the /plugins route serves lib/client.js from disk), which is
 * why client-half edits appeared immediately while the host half stayed dead.
 *
 * WHY EMPTY IS THE RIGHT SHAPE. Every service this half needs is resolved at
 * CALL time with `ctx.get(name)` — `resolveWebService` (web), `createServiceReader`
 * (fs), `resolveAccountService` (deepseekAccount), `readManagedVersion`
 * (pluginManager). `ctx.get` reads the registry without an inject requirement,
 * so it works whether or not the service exists yet, and an absent service is
 * reported as absent instead of parking the whole plugin. An empty declaration
 * gives `_refresh()` zero names to wait for: the fiber activates immediately in
 * ANY composition, and no future composition can park it.
 *
 * Do not "improve" this into a list of names: every name added here becomes a
 * service the fiber must wait for, and a single missing one hides her entirely.
 */
export const inject = []

/** The two places a published version can be read from. Overridable per install. */
export const DEFAULT_SOURCES = {
  npm: 'https://registry.npmjs.org/dsh-wisp/latest',
  github: 'https://raw.githubusercontent.com/969246694/dsh-wisp/main/package.json',
}

/** How long ONE source may take before it is reported as a timeout. */
const CHECK_TIMEOUT_MS = 8000

/** 这个包自己的名字 —— 兜底通道（问插件管理器）按包名查。 */
const UPDATE_PACKAGE_NAME = 'dsh-wisp'

/** 一眼看懂一个"服务"到底是什么（诊断用；永远不抛）。 */
function describeService(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  const type = typeof value
  if (type !== 'object' && type !== 'function') return type
  try {
    const keys = Object.keys(value).slice(0, 6).join(',')
    return type + '{' + keys + '}' + (typeof value.fetch === 'function' ? '+fetch' : '-fetch')
  } catch (error) { return type + '(unreadable)' }
}

/**
 * Resolve the `web` service LATE, on every call — and say HOW, and what was found.
 *
 * `inject.optional: ['web']` hands us `ctx.web`, but only when the service was
 * already provided at the moment this fiber materialized — and this half is
 * inserted by a bundle patch, so it can start BEFORE the web service registers.
 * An optional dependency that was absent at start does not retroactively appear,
 * which would disable the update check forever. `ctx.get('web')` looks the
 * service up at call time instead, so a startup race cannot wedge it.
 *
 * 真实运行里两种路都拿不到时，**必须能说清是哪一种**：`ctx.get` 有没有？
 * 拿到的东西是什么形状？—— 没有这一层，"没有联网的通道"是一句无法追问的话。
 *
 * @returns `{ service, how, why }` — never throws.
 *   how: 'ctx.get' | 'ctx.web' | 'none'   拿到了没有、从哪拿的
 *   why: 一句话说明"看到了什么"（进了 doctor 与她的失败台词）
 */
export function resolveWebService(ctx) {
  let late
  let getThrew = null
  try {
    if (ctx && typeof ctx.get === 'function') late = ctx.get('web')
    else getThrew = 'ctx.get 不是函数（' + describeService(ctx && ctx.get) + '）'
  } catch (error) { getThrew = 'ctx.get 抛错：' + String(error && error.message ? error.message : error).slice(0, 60) }
  if (late && typeof late.fetch === 'function') {
    return { service: late, how: 'ctx.get', why: 'ctx.get("web")→' + describeService(late) }
  }
  let declared
  let webThrew = null
  try { declared = ctx && ctx.web } catch (error) { webThrew = String(error && error.message ? error.message : error).slice(0, 60) }
  if (declared && typeof declared.fetch === 'function') {
    return { service: declared, how: 'ctx.web', why: 'ctx.web→' + describeService(declared) }
  }
  const parts = []
  parts.push('ctx.get("web")→' + describeService(late))
  if (getThrew) parts.push(getThrew)
  parts.push('ctx.web→' + describeService(declared))
  if (webThrew) parts.push('ctx.web 读取抛错：' + webThrew)
  /* 拿到了对象但没有 fetch 也要如实说 —— "有服务但没这个方法"和"根本没有服务"是两件事 */
  const service = (late && typeof late === 'object') ? late : ((declared && typeof declared === 'object') ? declared : undefined)
  if (service) {
    return { service, how: 'partial', why: parts.join('; ') + '（无 fetch）' }
  }
  return { service: undefined, how: 'none', why: parts.join('; ') }
}

/**
 * 兜底通道：向插件管理器问"这个包现在是什么版本"。
 *
 * 它本来就是**去 registry 问这个包**的那个人（安装前先 inspect），所以这条路
 * 走的是应用自己那条网络出口、且尊重用户配的镜像源 —— 比我们自己去抓 packument
 * 更接近"安装时会装到哪一版"。`web` 服务拿不到时，这是唯一还活着的更新通道。
 *
 * @returns `{ ok, version, registry }` 或 `{ ok: false, reason, detail }` — never throws.
 */
export async function readManagedVersion(ctx, name, timeoutMs) {
  let manager
  try {
    if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: 'no-ctx-get' }
    manager = ctx.get('pluginManager')
  } catch (error) {
    return { ok: false, reason: 'manager-unreachable', detail: String(error && error.message ? error.message : error).slice(0, 80) }
  }
  if (!manager || typeof manager.inspect !== 'function') {
    return { ok: false, reason: 'no-plugin-manager', detail: describeService(manager) }
  }
  try {
    const info = await withTimeout(manager.inspect(name), timeoutMs)
    if (info && info.status === 'accepted' && typeof info.version === 'string') {
      return { ok: true, version: info.version, registry: info.registry ?? null }
    }
    return {
      ok: false,
      reason: 'inspect-refused',
      detail: info && info.reason ? String(info.reason).slice(0, 100) : describeService(info),
    }
  } catch (error) {
    return { ok: false, reason: 'inspect-failed', detail: String(error && error.message ? error.message : error).slice(0, 100) }
  }
}

/**
 * Fetch one manifest and pull `version` out of it.
 * @param web - the `web` service, or undefined when it is not loaded.
 * @param url - the manifest URL.
 * @param signal - optional cancellation signal.
 * @returns `{ ok, version }` or `{ ok: false, reason }` — never throws.
 */
export async function readVersion(web, url, signal) {
  if (!web) return { ok: false, reason: 'no-web-service' }
  /* "有服务但没有 fetch"和"根本没有服务"是两件事 —— 台词的下一步动作不同
     （一个是应用/平台的问题，一个是插件注入的问题），所以别合并成一句。 */
  if (typeof web.fetch !== 'function') return { ok: false, reason: 'web-has-no-fetch', detail: describeService(web) }
  try {
    const res = await web.fetch({ url }, signal)
    if (!res || typeof res.statusCode !== 'number') return { ok: false, reason: 'bad-result' }
    /* Per the service contract a non-2xx response is a RESULT, not a throw —
       so the status must be checked here instead of caught below. */
    if (res.statusCode !== 200) return { ok: false, reason: 'http-' + res.statusCode }
    const text = res.body && typeof res.body.content === 'string' ? res.body.content : ''
    let version = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.version === 'string') version = parsed.version
    } catch (error) {
      return { ok: false, reason: 'not-json' }
    }
    if (version === null) return { ok: false, reason: 'no-version-field' }
    return { ok: true, version }
  } catch (error) {
    const detail = error && error.message ? String(error.message) : String(error)
    return { ok: false, reason: 'fetch-failed', detail }
  }
}

/** Compare two dotted versions. Returns -1 / 0 / 1; non-numeric parts count as 0. */export function compareVersions(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => {
    const x = Number.parseInt(n, 10)
    return Number.isFinite(x) ? x : 0
  })
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * Read every source and report the highest version found.
 * @param web - the `web` service.
 * @param urls - `{ npm, github }` (or any other set of named sources).
 * @param signal - optional cancellation signal shared by every source.
 * @param timeoutMs - when given, EACH source gets its own deadline instead.
 * @returns a plain, JSON-serializable verdict (it crosses the sandbox boundary).
 */
export async function readPublishedVersion(web, urls, signal, timeoutMs) {
  const names = Object.keys(urls ?? {})
  const perSource = typeof timeoutMs === 'number' && timeoutMs > 0
    && typeof AbortController === 'function' && typeof setTimeout === 'function'
  const results = await Promise.all(names.map((key) => {
    /* 每个源一个**自己的**截止时间。共用一个信号时，一个卡住的镜像会在到点时把
       另一个已经拿到结果的源一起作废 —— 那次检查就整个失败，而其实 npm 是通的。
       （实测：raw.githubusercontent.com 在这台机器上根本连不上。） */
    if (!perSource) return readVersion(web, urls[key], signal)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    return readVersion(web, urls[key], controller.signal)
      .then((result) => { clearTimeout(timer); return result })
      .catch((error) => { clearTimeout(timer); throw error })
  }))
  const sources = {}
  let best = null
  let from = null
  let anyOk = false
  names.forEach((key, i) => {
    const r = results[i]
    sources[key] = r.ok ? { ok: true, version: r.version } : { ok: false, reason: r.reason, detail: r.detail }
    if (!r.ok) return
    anyOk = true
    /* The HIGHER version wins, so a stale mirror cannot mask a newer release. */
    if (best === null || compareVersions(best, r.version) < 0) {
      best = r.version
      from = key
    }
  })
  if (!anyOk) {
    const first = results.find((r) => r && !r.ok)
    return { ok: false, reason: first ? first.reason : 'no-sources', sources }
  }
  return { ok: true, latest: best, from, sources }
}

/* ---------------------------------------------------------------------------
   ACCOUNT BALANCE.

   The shape of the platform service, read from the live Host Service registry
   rather than guessed:

     ctx.deepseekAccount.getBalance(client: AccountClientMetadata)
       -> { status: 'ready', value: AccountWallet[], bonusWallets: AccountWallet[] }
        | { status: 'failed' }
        | null                      // signed out, or the grant changed mid-query
     ctx.deepseekAccount.getState()
       -> { status: 'signed-out' | 'credential-stored', links, attempt }

     AccountClientMetadata = { version, locale, timezoneOffsetSeconds }
     AccountWallet         = { currency: 'CNY' | 'USD', balance: string }

   `null` deliberately means TWO different things, and telling the user the wrong
   one is worse than saying nothing — so when it happens we ask getState() once
   more to find out which. Signed out => "log in first"; still credential-stored
   => the grant moved under us => "didn't read it, try again".
   --------------------------------------------------------------------------- */

/** How long a balance query may take before it is reported as a timeout. */
export const BALANCE_TIMEOUT_MS = 8000

/** Keep only well-formed wallets, and never let an unbounded list cross the sandbox. */
export function normalizeWallets(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const wallet of list) {
    if (!wallet || typeof wallet !== 'object') continue
    if (typeof wallet.balance !== 'string') continue
    out.push({ currency: typeof wallet.currency === 'string' ? wallet.currency : '', balance: wallet.balance })
    if (out.length >= 8) break
  }
  return out
}

/**
 * Settle with the platform call, or reject with `timeout` — whichever is first.
 * The service takes no AbortSignal, so a race is the only way to bound it: an
 * unbounded await here would mean she simply never says anything.
 */
function withTimeout(promise, ms) {
  if (!(ms > 0) || typeof setTimeout !== 'function') return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('timeout'))
    }, ms)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (typeof clearTimeout === 'function') clearTimeout(timer)
      fn(value)
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

/**
 * Ask the platform for the account balance.
 * @param account - the `deepseekAccount` service, or undefined when it is not loaded.
 * @param client - `AccountClientMetadata` for the requesting UI.
 * @param timeoutMs - override for tests; defaults to BALANCE_TIMEOUT_MS.
 * @returns a plain, JSON-serializable verdict (it crosses the sandbox boundary) — never throws.
 */
export async function readBalance(account, client, timeoutMs) {
  const limit = typeof timeoutMs === 'number' ? timeoutMs : BALANCE_TIMEOUT_MS
  if (!account || typeof account.getBalance !== 'function') {
    return { ok: false, reason: 'no-account-service' }
  }
  let result = null
  try {
    result = await withTimeout(account.getBalance(client), limit)
  } catch (error) {
    const detail = error && error.message ? String(error.message) : String(error)
    return { ok: false, reason: detail === 'timeout' ? 'timeout' : 'call-failed', detail }
  }
  if (result === null || result === undefined) {
    /* null 同时意味着"没登录"和"授权在查询途中换了"。分不清时**不许猜**：
       只有 getState() 明确说 signed-out 才说"去登录"，否则一律说"刚才没读到" ——
       叫人去登录一个已经登录的账户，比说"没读到"糟得多。 */
    let state = null
    try {
      if (typeof account.getState === 'function') {
        state = await withTimeout(account.getState(), limit)
      }
    } catch (error) { state = null }
    const signedIn = state && typeof state.status === 'string' ? state.status === 'credential-stored' : null
    return {
      ok: true,
      status: signedIn === false ? 'signed-out' : 'unavailable',
      signedIn,
      wallets: [],
      bonusWallets: [],
    }
  }
  if (typeof result !== 'object' || result.status !== 'ready') {
    /* The platform answered, and the answer was "failed" — a result, not a throw. */
    return { ok: true, status: 'failed', wallets: [], bonusWallets: [] }
  }
  return {
    ok: true,
    status: 'ready',
    wallets: normalizeWallets(result.value),
    bonusWallets: normalizeWallets(result.bonusWallets),
  }
}

/** Build the metadata every balance query carries. */
export function accountClientMetadata(locale) {
  return {
    version: VERSION,
    locale: typeof locale === 'string' && locale !== '' ? locale : 'zh-CN',
    /* The service wants seconds EAST of UTC; getTimezoneOffset() is minutes WEST. */
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * Resolve the `deepseekAccount` service LATE, on every call — the same rule as
 * {@link resolveWebService}, and for the same two reasons:
 *
 *   1. NOTHING IS DECLARED IN `inject` (see the export above), so a service must
 *      be fetched from the registry at call time. `ctx.get(name)` does exactly
 *      that, with no inject requirement.
 *   2. `ctx.deepseekAccount` on a shell that does not provide the service THROWS
 *      (`cannot get property "deepseekAccount" without inject`) instead of
 *      returning undefined — reading it raw inside the handler would turn "no
 *      account service in this shell" into a rejected `host.call`. The property
 *      is still consulted as a fallback, but inside its own guard.
 *
 * @returns `{ service, how, why }` — never throws.
 *   how: 'ctx.get' | 'ctx.account' | 'none'
 */
export function resolveAccountService(ctx) {
  let late
  try {
    if (ctx && typeof ctx.get === 'function') late = ctx.get('deepseekAccount')
  } catch (error) { /* 读不到就是"没有"，不是失败 */ }
  if (late && typeof late.getBalance === 'function') {
    return { service: late, how: 'ctx.get', why: 'ctx.get("deepseekAccount")→' + describeService(late) }
  }
  let declared
  try { declared = ctx && ctx.deepseekAccount } catch (error) { declared = undefined }
  if (declared && typeof declared.getBalance === 'function') {
    return { service: declared, how: 'ctx.account', why: 'ctx.deepseekAccount→' + describeService(declared) }
  }
  return {
    service: undefined,
    how: 'none',
    why: 'ctx.get("deepseekAccount")→' + describeService(late) + '; ctx.deepseekAccount→' + describeService(declared),
  }
}

/**
 * Read the published versions **for whoever asks** — the `checkUpdate` handler and the
 * same-origin `/wisp-motion/__update` endpoint share exactly this (v1.49.7), so the
 * answer the page reads can never disagree with what a host seat would have said.
 *
 * 两条上游通道，按"能不能用"排序：
 *   ① 平台给的 `web` 服务（`ctx.web.fetch`）—— 宿主这一侧的网络出口；
 *   ② 拿不到 `web` 时问 `pluginManager`"这个包现在是什么版本"—— 那是"安装时会
 *      装到哪一版"的权威答案，走应用自己的出口。
 * 都不行就如实回 `no-web-service`，并把两条路各自的 why 带上：台词只有一句，
 * 但 doctor() 与窗口标题里必须追得下去。
 *
 * @param ctx - the plugin context.
 * @param urls - `{ npm, github }` source set (`config.urls` overrides the defaults).
 * @returns a plain, JSON-serializable verdict `{ ok, latest, from, sources, diag }`.
 */
export async function readPublishedForPage(ctx, urls) {
  /* 服务在**调用时**解析，不用闭包里那个可能早就定格的 ctx.web（见 resolveWebService）。 */
  const resolved = resolveWebService(ctx)
  if (resolved.service) {
    const verdict = await readPublishedVersion(resolved.service, urls, undefined, CHECK_TIMEOUT_MS)
    return { ...verdict, diag: { via: 'web', how: resolved.how, why: resolved.why } }
  }
  /* 没有可用的 web 服务时的兜底：问插件管理器"这个包现在是什么版本"。
     它走的是应用自己那条网络出口（安装前就要去 registry 问），所以这条路
     是"安装时会装到哪一版"的权威答案 —— 而且不依赖插件能否拿到 web。 */
  const managed = await readManagedVersion(ctx, UPDATE_PACKAGE_NAME, CHECK_TIMEOUT_MS)
  const sources = { npm: managed.ok
    ? { ok: true, version: managed.version }
    : { ok: false, reason: managed.reason, detail: managed.detail } }
  if (managed.ok) {
    return {
      ok: true,
      latest: managed.version,
      from: 'npm',
      sources,
      diag: { via: 'pluginManager', how: resolved.how, why: resolved.why, registry: managed.registry ?? null },
    }
  }
  sources.github = { ok: false, reason: 'no-web-service', detail: resolved.why }
  return {
    ok: false,
    reason: 'no-web-service',
    sources,
    diag: { via: 'none', how: resolved.how, why: resolved.why, manager: managed.reason + (managed.detail ? '：' + managed.detail : '') },
  }
}

/** Register the handlers the browser half reaches through `host.call`. */
export function registerHandlers(ctx, options = {}) {
  const urls = options.urls && typeof options.urls === 'object' ? options.urls : DEFAULT_SOURCES
  /* `harness` is a sandbox global: the host half is evaluated inside a vm whose
     context carries it. Guard the reference so this module also loads — and is
     testable — outside that sandbox. */
  const seat = typeof harness === 'undefined' ? undefined : harness
  if (!seat || typeof seat.handle !== 'function') {
    return { registered: false, reason: 'no-harness-seat' }
  }
  const dispose = seat.handle('checkUpdate', async (args) => {
    const current = args && typeof args.current === 'string' ? args.current : null
    /* 判据与同源端点共用一份实现（v1.49.7）：两条路给出的答案必须一模一样。 */
    const verdict = await readPublishedForPage(ctx, urls)
    return { ...verdict, current, checkedAt: new Date().toISOString() }
  })
  /* The balance handler. The service is resolved at CALL time (ctx.get first) and
     may legitimately be absent — readBalance() turns that into `no-account-service`
     rather than a throw, so the browser half can say "not in this shell" honestly. */
  const disposeBalance = seat.handle('checkBalance', async (args) => {
    /* 服务在**调用时**解析，而且**先 ctx.get**：没有任何 inject 声明（见上面那段），
       而 `ctx.deepseekAccount` 在没提供该服务的壳里是**抛错**，不是 undefined。 */
    const account = resolveAccountService(ctx)
    const verdict = await readBalance(
      account.service,
      accountClientMetadata(args && args.locale),
    )
    return { ...verdict, checkedAt: new Date().toISOString() }
  })
  return {
    registered: true,
    dispose: () => {
      if (typeof dispose === 'function') dispose()
      if (typeof disposeBalance === 'function') disposeBalance()
    },
    urls,
  }
}

/**
 * What the LAST `apply()` on this module instance actually did.
 *
 * `GET /wisp-motion/__diag` reads it (see {@link hostApplyState}), so a live
 * shell can answer "did the host half run, and which handlers did it register?"
 * — the one question that was unanswerable during the PENDING-fiber incident:
 * a parked fiber produces exactly the same external symptoms as a missing
 * route, a missing update check and a missing balance check, all at once.
 */
const HOST_APPLY = { applied: false, at: null, registered: false, reason: null, handlers: [], motion: null }

/** Read-only copy of {@link HOST_APPLY} — `__diag` must never hand out the live object. */
export function hostApplyState() {
  return { ...HOST_APPLY, handlers: [...HOST_APPLY.handlers] }
}

export function apply(ctx, config) {
  /* The body stays tiny: register the handlers, and keep their disposer on the
     fiber so unloading the package takes both of them with it. */
  const result = registerHandlers(ctx, config || {})
  HOST_APPLY.applied = true
  HOST_APPLY.at = new Date().toISOString()
  HOST_APPLY.registered = result.registered === true
  HOST_APPLY.reason = result.registered === true ? null : (result.reason ?? null)
  HOST_APPLY.handlers = result.registered === true ? ['checkUpdate', 'checkBalance'] : []
  if (result.registered && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (typeof result.dispose === 'function') result.dispose()
    }, 'dsh-wisp: host handlers')
  }
  /* v1.47.0: the frame-animation clips are files in this package, served to
     the page over the host HTTP carrier. Optional and silent — see the block
     above MOTION_PATH. v1.48.1: the route is registered WITHOUT the trailing
     slash, which is the difference between "registered" and "reachable". */
  const motion = registerMotionRoute(ctx, config || {})
  HOST_APPLY.motion = {
    registered: motion.registered === true,
    path: typeof motion.path === 'string' ? motion.path : null,
    why: motion.why ?? null,
  }
  if (motion.registered && typeof console === 'object' && console !== null && typeof console.log === 'function') {
    console.log(`[wisp] /wisp-motion route registered at ${motion.path} (page asks ${MOTION_PATH}<clip>.webp); `
      + `GET ${MOTION_ROUTE_PATH}/${MOTION_DIAG_NAME} reports hits, the read path and the last error`)
  }
}

export default { name, inject, apply }
