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
//      `web` and `deepseekAccount` are both declared as OPTIONAL injects on
//      purpose: a required inject that nothing provides would leave this fiber
//      `waiting` forever, and the companion would simply disappear from the UI.
//
// WHY TWO SOURCES. npm's registry is the authoritative one, but a publish can sit
// in npm's staging queue for a long time (observed: `PUT 202`, still 404 after 18
// minutes, and re-publishing the same version is refused with 409). GitHub's raw
// manifest updated immediately in the same situation. So the check reads BOTH and
// reports the HIGHER version — which is correct whether or not npm has caught up.
// "npm first, GitHub as fallback" would read the stale npm number and claim you
// were up to date.

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wisp'

/** Stamped into every balance request. Must match package.json — the preflight guards it. */
export const VERSION = '1.46.1'

/**
 * `web` and `deepseekAccount` are optional on purpose. A required inject that
 * nothing provides keeps the fiber in `waiting` forever, and the user's
 * companion would vanish.
 */
export const inject = { required: [], optional: ['web', 'deepseekAccount'] }

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
    /* 服务**在调用时**解析，不用闭包里那个可能早就定格的 ctx.web（见 resolveWebService）。 */
    const resolved = resolveWebService(ctx)
    if (resolved.service) {
      const verdict = await readPublishedVersion(resolved.service, urls, undefined, CHECK_TIMEOUT_MS)
      return { ...verdict, current, diag: { via: 'web', how: resolved.how, why: resolved.why }, checkedAt: new Date().toISOString() }
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
        current,
        diag: { via: 'pluginManager', how: resolved.how, why: resolved.why, registry: managed.registry ?? null },
        checkedAt: new Date().toISOString(),
      }
    }
    sources.github = { ok: false, reason: 'no-web-service', detail: resolved.why }
    return {
      ok: false,
      reason: 'no-web-service',
      sources,
      current,
      diag: { via: 'none', how: resolved.how, why: resolved.why, manager: managed.reason + (managed.detail ? '：' + managed.detail : '') },
      checkedAt: new Date().toISOString(),
    }
  })
  /* The balance handler. `ctx.deepseekAccount` is undefined unless the platform
     provides it — readBalance() turns that into `no-account-service` rather than
     a throw, so the browser half can say "not in this shell" honestly. */
  const disposeBalance = seat.handle('checkBalance', async (args) => {
    const verdict = await readBalance(
      ctx && ctx.deepseekAccount,
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

export function apply(ctx, config) {
  /* The body stays tiny: register the handlers, and keep their disposer on the
     fiber so unloading the package takes both of them with it. */
  const result = registerHandlers(ctx, config || {})
  if (result.registered && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (typeof result.dispose === 'function') result.dispose()
    }, 'dsh-wisp: host handlers')
  }
}

export default { name, inject, apply }
