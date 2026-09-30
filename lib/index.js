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
//   2. Nothing else. `web` is declared as an OPTIONAL inject on purpose: a
//      required inject that nothing provides would leave this fiber `waiting`
//      forever, and the companion would simply disappear from the UI.

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wisp'

/**
 * `web` is optional on purpose. A required inject that nothing provides keeps
 * the fiber in `waiting` forever, and the user's companion would vanish.
 */
export const inject = { required: [], optional: ['web'] }

/** Where the check reads the published version from. Overridable per install. */
export const DEFAULT_UPDATE_URL = 'https://raw.githubusercontent.com/969246694/dsh-wisp/main/package.json'

/** How long a check may take before it is reported as a timeout. */
const CHECK_TIMEOUT_MS = 8000

/**
 * Fetch the published package.json and pull `version` out of it.
 * @param web - the `web` service, or undefined when it is not loaded.
 * @param url - the manifest URL.
 * @param signal - optional cancellation signal.
 * @returns a plain, JSON-serializable verdict (this crosses the sandbox boundary).
 */
export async function readPublishedVersion(web, url, signal) {
  if (!web || typeof web.fetch !== 'function') {
    return { ok: false, reason: 'no-web-service', url }
  }
  try {
    const res = await web.fetch({ url }, signal)
    if (!res || typeof res.statusCode !== 'number') return { ok: false, reason: 'bad-result', url }
    /* Per the service contract a non-2xx response is a RESULT, not a throw —
       so the status must be checked here instead of caught below. */
    if (res.statusCode !== 200) return { ok: false, reason: 'http-' + res.statusCode, url }
    const text = res.body && typeof res.body.content === 'string' ? res.body.content : ''
    let latest = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.version === 'string') latest = parsed.version
    } catch (error) {
      return { ok: false, reason: 'not-json', url }
    }
    if (latest === null) return { ok: false, reason: 'no-version-field', url }
    return { ok: true, url, latest }
  } catch (error) {
    const detail = error && error.message ? String(error.message) : String(error)
    return { ok: false, reason: 'fetch-failed', detail, url }
  }
}

/** Compare two dotted versions. Returns -1 / 0 / 1; non-numeric parts count as 0. */
export function compareVersions(a, b) {
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

/** Register the handler the browser half reaches through `host.call`. */
export function registerHandlers(ctx, options = {}) {
  const url = typeof options.updateUrl === 'string' && options.updateUrl !== ''
    ? options.updateUrl
    : DEFAULT_UPDATE_URL
  /* `harness` is a sandbox global: the host half is evaluated inside a vm whose
     context carries it. Guard the reference so this module also loads — and is
     testable — outside that sandbox. */
  const seat = typeof harness === 'undefined' ? undefined : harness
  if (!seat || typeof seat.handle !== 'function') {
    return { registered: false, reason: 'no-harness-seat' }
  }
  const dispose = seat.handle('checkUpdate', async (args) => {
    const current = args && typeof args.current === 'string' ? args.current : null
    const canAbort = typeof AbortController === 'function'
    const controller = canAbort ? new AbortController() : null
    let timer = null
    if (controller && typeof setTimeout === 'function') {
      timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    }
    try {
      const verdict = await readPublishedVersion(ctx && ctx.web, url, controller ? controller.signal : undefined)
      return { ...verdict, current, checkedAt: new Date().toISOString() }
    } finally {
      if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
    }
  })
  return { registered: true, dispose, url }
}

export function apply(ctx, config) {
  /* The body stays tiny: register the handler, and keep its disposer on the
     fiber so unloading the package takes the handler with it. */
  const result = registerHandlers(ctx, config || {})
  if (result.registered && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (typeof result.dispose === 'function') result.dispose()
    }, 'dsh-wisp: checkUpdate handler')
  }
}

export default { name, inject, apply }
