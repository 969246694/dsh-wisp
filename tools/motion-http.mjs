/* ============================================================================
   motion-http.mjs — 「这条路由**真的**发得出字节吗」的端到端 HTTP 检查（v1.48.1）。

   为什么单独有一个工具：预检（verify-wisp.mjs）把 handler 当函数驱动了一遍 ——
   它证明不了"注册键能不能被载体匹配上"，也证明不了"换个真的 socket 还成立吗"。
   1.47.x 的 404 恰恰死在前者：路由注册成功了，注册键却带着尾斜杠，而载体的
   前缀匹配自己补那个斜杠（`pathname === prefix || pathname.startsWith(prefix + '/')`），
   于是**一次都没匹配上**，请求全落到平台自己的 404 兜底。函数级测试全绿，
   画面上她一动不动。

   所以这个工具起一个**真的 node:http 载体**，用载体原样的注册表与匹配规则，
   让 lib/index.js 里那个真的 registerMotionRoute() 自己把路由挂上去，
   fs 服务用一份按文档签名实现的本地后端（resolve/contains/stat/readBytes），
   然后发真的 HTTP 请求：200 的字节数与磁盘逐条比对。

   RUN
     node tools/motion-http.mjs                  # 自建载体：不需要应用在跑
     node tools/motion-http.mjs --live http://127.0.0.1:19387
                                                 # 打**运行中的** DSH：四个验收原样重跑
                                                 # （宿主半包是旧模块世代时，404 上没有
                                                 #   x-wisp-motion 头 —— 那就是重启信号）
   ========================================================================== */

import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const liveIndex = process.argv.indexOf('--live')
const liveBase = liveIndex >= 0 ? (process.argv[liveIndex + 1] ?? 'http://127.0.0.1:19387') : null

let failures = 0
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

const MOTION_DIR = join(here, 'assets', 'motion')
const clips = existsSync(MOTION_DIR)
  ? readdirSync(MOTION_DIR).filter((f) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/.test(f)).sort()
  : []
const pick = (name) => (clips.includes(name) ? name : (clips[0] ?? null))

/** 四个验收：两个真素材、一个不存在的名字、一条路径穿越。 */
async function verifyHttp(base, { requireMarker }) {
  const clipA = pick('canon_idle.webp')
  const clipB = pick('swim_idle.webp')
  const cases = [
    { label: `GET ${clipA ?? '(无素材)'}`, url: `${base}/wisp-motion/${clipA ?? 'canon_idle.webp'}`, want: clipA === null ? null : 200, disk: clipA === null ? null : join(MOTION_DIR, clipA) },
    { label: `GET ${clipB ?? '(无素材)'}`, url: `${base}/wisp-motion/${clipB ?? 'swim_idle.webp'}`, want: clipB === null ? null : 200, disk: clipB === null ? null : join(MOTION_DIR, clipB) },
    { label: 'GET nope.webp', url: `${base}/wisp-motion/nope.webp`, want: 404, disk: null },
    /* 三个穿越写法，**都**得是 400/404：
       ① 明文 `../` —— HTTP 客户端（curl / 浏览器 / fetch）在发出去之前就把它规范化成
          `/package.json`，于是它落在路由**之外**，由载体的兜底 404 接走。这条不要
          求 x-wisp-motion 头，要求的是"没有字节漏出去"。
       ② `%2e%2e` 写法 —— WHATWG 的 URL 解析器把 %2e 当点做路径规范化，载体在匹配之前
          就把它折成 `/package.json` 了，同样落在路由之外。它证明的是"载体这一层先挡了一道"。
       ③ 百分号斜杠 `..%2f` —— 规范化**不动**它（%2f 不是分隔符），它会原样进到我们的
          handler 里，必须被名字规则拒掉。这条要求那个头：答话的必须是我们自己。 */
    { label: 'GET ../package.json（客户端先规范化掉）', url: `${base}/wisp-motion/../package.json`, want: [400, 404], disk: null, marker: false },
    { label: 'GET %2e%2e/package.json（载体先规范化掉）', url: `${base}/wisp-motion/%2e%2e/package.json`, want: [400, 404], disk: null, marker: false },
    { label: 'GET ..%2fpackage.json（进到 handler 里）', url: `${base}/wisp-motion/..%2fpackage.json`, want: [400, 404], disk: null, marker: requireMarker },
  ]
  for (const item of cases) {
    if (item.want === null) { console.log(`  SKIP  ${item.label} —— 这个包没有素材`); continue }
    let status = 0
    let body = null
    let marker = null
    try {
      const res = await fetch(item.url, { redirect: 'manual' })
      status = res.status
      marker = res.headers.get('x-wisp-motion')
      body = Buffer.from(await res.arrayBuffer())
    } catch (error) {
      check(false, item.label, String(error && error.message ? error.message : error))
      continue
    }
    const want = Array.isArray(item.want) ? item.want : [item.want]
    const statusOk = want.includes(status)
    const bytesOk = item.disk === null || (body !== null && body.length === statSync(item.disk).size && body.equals(readFileSync(item.disk)))
    const markerOk = (item.marker ?? requireMarker) ? marker === 'hit' : true
    check(statusOk && bytesOk && markerOk, item.label,
      `${status}${item.disk === null ? '' : ` · ${body === null ? '?' : body.length} B vs disk ${statSync(item.disk).size} B`}`
      + ` · x-wisp-motion=${String(marker)}${markerOk ? '' : '（没有这个头 ⇒ 答话的不是本插件的 handler）'}`)
  }
  /* 诊断：它是"路由没被命中"和"读不到文件"的分水岭。 */
  try {
    const res = await fetch(`${base}/wisp-motion/__diag?name=${pick('canon_idle.webp') ?? 'canon_idle.webp'}`, { redirect: 'manual' })
    const text = await res.text()
    let diag = null
    try { diag = JSON.parse(text) } catch (error) { diag = null }
    check(res.status === 200 && diag !== null && diag.route?.registeredKeyMatchesExample === true,
      'GET /wisp-motion/__diag 说得清路由的实情',
      diag === null ? `status=${res.status} 不是 JSON` : `${String(diag.route?.registeredAt)} · hits=${String(diag.route?.hits)} · reader=${String(diag.reader?.via)} · probe=${JSON.stringify(diag.probe)}`)
  } catch (error) {
    check(false, 'GET /wisp-motion/__diag', String(error && error.message ? error.message : error))
  }
}

if (liveBase !== null) {
  console.log(`== 打运行中的应用：${liveBase} ==`)
  await verifyHttp(liveBase.replace(/\/+$/, ''), { requireMarker: true })
} else {
  console.log('== 自建载体：真的 socket + 真的 registerMotionRoute() ==')
  const mod = await import(pathToFileURL(join(here, 'lib', 'index.js')).href)

  /* 按 Service.listService("fs") 的签名实现的本地后端 —— 和宿主那条路同一个接口：
     resolve 会 realpath，contains 是 canonical 包含判断。 */
  const fsService = {
    async resolve(path) { const real = realpathSync(path); return { targetKey: real, displayPath: real } },
    processPath: (target) => target.targetKey,
    contains(parent, child) {
      const root = String(parent.targetKey).replace(/[\\/]+$/, '')
      const kid = String(child.targetKey)
      return kid === root || kid.startsWith(root + sep)
    },
    async stat(target) {
      try {
        const info = statSync(target.targetKey)
        return { version: 'v1', type: info.isFile() ? 'file' : (info.isDirectory() ? 'directory' : 'other'), size: info.size }
      } catch (error) { return undefined }
    },
    async readBytes(target, signal, maxBytes) {
      const bytes = readFileSync(target.targetKey)
      if (bytes.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      return new Uint8Array(bytes)
    },
  }
  /* 载体：注册表与匹配规则照抄 @deepseek-ai/dsh-host-webserver 的
     register() / match() —— 尾斜杠那条规则是这一版的全部要点，不能凭记忆写。 */
  const routes = new Map()
  const server = createServer((req, res) => {
    const pathname = new URL(String(req.url ?? '/'), 'http://wisp.invalid').pathname
    let best = null
    for (const [prefix, route] of routes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === null || prefix.length > best.prefix.length) best = { prefix, route }
    }
    if (best === null) { res.writeHead(404); res.end(); return }
    Promise.resolve(best.route.handler(req, res)).catch(() => { try { res.destroy() } catch (error) { /* gone */ } })
  })
  const webCtx = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(fn) { return fn() },
  }
  const ctx = {
    get: (name) => (name === 'fs' ? fsService : undefined),
    inject: (deps, cb) => { cb(webCtx) },
    effect: () => () => {},
  }
  const verdict = mod.registerMotionRoute(ctx, {})
  check(verdict.registered === true && routes.has(mod.MOTION_ROUTE_PATH),
    'registerMotionRoute() 把路由挂在载体能匹配的那个键上',
    `path=${String(verdict.path)} keys=${[...routes.keys()].join(', ')}`)
  check(!routes.has(mod.MOTION_PATH),
    '而且**没有**用带尾斜杠的那个拼法注册（那个键匹配不上任何页面请求）',
    `trailing-slash key present=${routes.has(mod.MOTION_PATH)}`)

  const origin = await new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePort(`http://127.0.0.1:${server.address().port}`))
  })
  await verifyHttp(origin, { requireMarker: true })
  /* 服务器与 keep-alive 连接都要收干净再退出：带着半关的句柄 process.exit() 会在
     Windows 的 libuv 上撞断言（实测 0xC0000409），退出码就再也说明不了对错。 */
  server.closeAllConnections?.()
  await new Promise((done) => server.close(done))
}

console.log(`\n${failures === 0 ? '=== MOTION HTTP OK ===' : '=== MOTION HTTP FAILED ==='}`)
process.exitCode = failures === 0 ? 0 : 1
/* 兜底：undici 的空闲连接有时还挂着，给事件循环一个自己走干的机会，超时再硬退。 */
const bail = setTimeout(() => process.exit(process.exitCode), 1000)
bail.unref()
