/* ============================================================================
   audit-log.mjs — 生成过程审计日志（哈希链）

   为什么要它：Maker 代理的登记表（.maker/assets/generated-assets.json）只记
   **工具名 / 提示词 / 时间 / 产物路径**，**不记参数** —— 而 generate_image 与
   batch_generate_images 是允许传可选 reference_images 的。所以"没喂参考图"这件事，
   代理那边证不了。

   这个日志把两类东西分开记，谁强谁弱一目了然：

     registry  代理自己写的、独立于本插件的证据：这次调用用的是哪个工具、什么时间、
                产物落在哪。（**edit_image 是唯一能做图生图的工具**，所以工具名是硬证据。）
     declared  本次调用发出去的参数（含 reference_images 是否为空）。**这是自我声明**，
                强度不如上面那条 —— 但它被写进哈希链，事后改不了，而且写在调用之前。

   每条记录还带**入包素材的相对路径与 sha256** —— 于是"这个入包文件 = 那次纯文生图调用的
   产物，且此后没被改过"可以在任何机器上复查。

   USAGE
     node tools/audit-log.mjs --verify                 校验链 + 重算产物哈希
     node tools/audit-log.mjs --declare <manifest>     生成前：登记将要发出的参数
     node tools/audit-log.mjs --confirm <manifest>     生成后：并入代理登记表 + 记产物哈希
     node tools/audit-log.mjs --backfill --since <ISO> 回溯：只凭代理登记表补录（标注来源）
     node tools/audit-log.mjs --retire <skin> [--reason <text>]  整套皮肤退役：旧路径不再比对存在性

   manifest（JSON 数组）：
     [{ "name": "ds2_idle", "prompt": "……", "skin": "deepsea", "mood": "idle",
        "params": { "model": "gpt", "resolution": "4K", "target_size": "2048x3072",
                    "reference_images": [] } }]
   ========================================================================== */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')          // 包根
const LOG_DIR = join(here, 'audit')
const LOG_PATH = join(LOG_DIR, 'generation-audit.jsonl')
const REGISTRY = process.env.WISP_MAKER_REGISTRY || 'F:/孤屿/.maker/assets/generated-assets.json'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const fileHash = (p) => (existsSync(p) ? sha256(readFileSync(p)) : null)
const rel = (p) => {
  const r = relative(here, p)
  return r.startsWith('..') ? p : r.split('\\').join('/')
}
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

const readLog = () => {
  if (!existsSync(LOG_PATH)) return []
  return readFileSync(LOG_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

/* 链：每条记录的 hash 覆盖自身全部字段（含 prev）。改任何一条都会断链。 */
const chainHash = (entry) => {
  const { hash, ...rest } = entry
  return sha256(JSON.stringify(rest))
}
const append = (entry) => {
  const log = readLog()
  const prev = log.length === 0 ? 'genesis' : log[log.length - 1].hash
  const full = { index: log.length, prev, ...entry }
  full.hash = chainHash(full)
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(LOG_PATH, JSON.stringify(full) + '\n', 'utf8')
  return full
}

const readRegistry = () => {
  if (!existsSync(REGISTRY)) return null
  const json = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const list = Array.isArray(json) ? json : Object.values(json)
  return list.filter((e) => e && typeof e.name === 'string')
}

/* 代理登记表里最后一次以该 name 开头的调用 */
const registryFor = (registry, name) => {
  const hits = registry.filter((e) => e.name === name || e.name.startsWith(name + '_'))
  if (hits.length === 0) return null
  return hits.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[hits.length - 1]
}

/* ------------------------------------------------------------------ verify */
/* 导出给 verify-wisp.mjs 用：同一条检查，不起子进程，也不重复实现一遍。 */
export function verifyAudit(root = here) {
  const log = readLog()
  const problems = []
  let prev = 'genesis'
  for (const e of log) {
    if (e.prev !== prev) problems.push('第 ' + e.index + ' 条断链（prev 不匹配）')
    if (chainHash(e) !== e.hash) problems.push('第 ' + e.index + ' 条内容被改动（hash 不匹配）')
    prev = e.hash
  }
  /* 同一个入包文件被**重出**过时，日志里会有多条 confirm —— 历史必须留着（那正是这个日志
     存在的意义），但要比对的是**最新**那一条：它才代表现在入包的东西。旧条目标为「已被取代」，
     记录在案、不再参与哈希比对；否则任何一次重出都会让预检永久变红。 */
  const confirms = log.filter((e) => e.kind === 'confirm' && e.output && e.output.path)
  const latestOf = new Map()
  for (const e of confirms) latestOf.set(e.output.path, e)
  /* 退役（v1.51.0）：整套皮肤被换掉时，旧目录的素材会被删掉。历史条目**原样留在链上**
     —— 那正是这个日志存在的意义 —— 但已明确退役的路径不再参与"文件还在不在"的比对。
     没有这一条，每换一次皮肤预检就会永久变红，而"永久变红"会让真问题一起被忽略。 */
  const retired = new Set()
  for (const e of log) if (e.kind === 'retire' && Array.isArray(e.paths)) for (const p of e.paths) retired.add(p)
  const assets = [...latestOf.values()].filter((e) => !retired.has(e.output.path))
  const retiredCount = [...latestOf.keys()].filter((p) => retired.has(p)).length
  const superseded = confirms.filter((e) => latestOf.get(e.output.path) !== e)
  for (const e of assets) {
    const p = resolve(root, e.output.path)
    if (!existsSync(p)) { problems.push(e.output.path + ' 不见了'); continue }
    if (fileHash(p) !== e.output.sha256) problems.push(e.output.path + ' 的哈希与记录不符')
  }
  const img2img = log.filter((e) => e.registry && e.registry.tool === 'edit_image')
  const declaredNone = log.filter((e) => e.kind === 'declare' && e.declared
    && Array.isArray(e.declared.reference_images) && e.declared.reference_images.length === 0)
  return { entries: log.length, assets, problems, img2img, declaredNone: declaredNone.length,
    superseded: superseded.length, retired: retiredCount,
    backfilled: log.filter((e) => e.source === 'registry-backfill').length }
}

if (flag('--verify')) {
  const res = verifyAudit(here)
  const log = readLog()
  let bad = 0
  let missing = 0
  let prev = 'genesis'
  for (const e of log) {
    if (e.prev !== prev) { console.log(`  ✗ 第 ${e.index} 条断链（prev 不匹配）`); bad++ }
    if (chainHash(e) !== e.hash) { console.log(`  ✗ 第 ${e.index} 条内容被改动（hash 不匹配）`); bad++ }
    prev = e.hash
  }
  const assets = res.assets
  for (const e of assets) {
    const p = resolve(here, e.output.path)
    if (!existsSync(p)) { console.log(`  ✗ ${e.output.path} 不见了`); missing++; continue }
    if (fileHash(p) !== e.output.sha256) { console.log(`  ✗ ${e.output.path} 的哈希与记录不符`); bad++ }
  }
  const img2img = log.filter((e) => e.registry && e.registry.tool === 'edit_image')
  const unknown = log.filter((e) => e.registry && e.registry.tool && !['generate_image', 'batch_generate_images', 'edit_image'].includes(e.registry.tool))
  console.log(`  记录 ${log.length} 条（declare ${log.filter((e) => e.kind === 'declare').length} / confirm ${log.filter((e) => e.kind === 'confirm').length} / backfill ${log.filter((e) => e.source === 'registry-backfill').length}）`)
  console.log(`  覆盖入包素材 ${assets.length} 个，全部存在且哈希一致：${missing === 0 && bad === 0 ? '是' : '否'}`)
  if (res.superseded > 0) console.log(`  另有 ${res.superseded} 条是同一文件的更早版本（重出记录：历史保留、不参与比对）`)
  console.log(`  代理登记表显示使用过 edit_image（图生图）的条目：${img2img.length}`)
  if (img2img.length > 0) for (const e of img2img) console.log(`    ⚠ ${e.name}  ${e.registry.createdAt}`)
  if (unknown.length > 0) console.log(`  ⚠ 未识别的工具名：${unknown.map((e) => e.registry.tool).join(', ')}`)
  console.log(bad === 0 && missing === 0 ? '  AUDIT OK' : `  AUDIT FAILED（${bad + missing} 个问题）`)
  process.exit(bad + missing === 0 ? 0 : 1)
}

/* ----------------------------------------------------------------- retire */
/* 一条皮肤整套退役：登记它那八条素材路径，让它们不再参与"文件还在不在"的比对。
   素材文件本身由人删（这个日志不碰工作区）。 */
if (flag('--retire')) {
  const skin = valueOf('--retire')
  const RETIRE_MOODS = ['idle', 'happy', 'sleepy', 'work', 'attn', 'poked', 'proud', 'eat']
  const paths = RETIRE_MOODS.map((m) => 'assets/' + skin + '/' + m + '.webp')
  append({
    kind: 'retire', source: 'manifest', at: new Date().toISOString(),
    skin, paths, reason: valueOf('--reason') || null,
  })
  console.log(`retire：${skin} 的 ${paths.length} 条素材路径已登记退役（历史条目保留在链上，文件请自行删除）`)
  process.exit(0)
}

/* --------------------------------------------------------- declare/confirm */
const manifestPath = valueOf('--declare') || valueOf('--confirm')
const isDeclare = flag('--declare')

if (manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest) || manifest.length === 0) {
    console.error('manifest 必须是非空数组'); process.exit(1)
  }
  const registry = readRegistry()
  const at = new Date().toISOString()

  for (const item of manifest) {
    if (typeof item.name !== 'string' || typeof item.prompt !== 'string') {
      console.error(`manifest 项缺 name/prompt：${JSON.stringify(item).slice(0, 80)}`); process.exit(1)
    }
    const params = item.params || {}
    /* 自我声明里也必须照实写：这一项为空才说明没传参考图 */
    const refs = params.reference_images
    if (refs !== undefined && (!Array.isArray(refs) || refs.length !== 0)) {
      console.error(`✗ ${item.name} 声明了参考图 —— 本项目的规则是不喂参考图。拒绝记录。`)
      process.exit(1)
    }

    if (isDeclare) {
      append({
        kind: 'declare',
        source: 'manifest',
        at,
        name: item.name,
        promptSha256: sha256(item.prompt),
        promptPreview: item.prompt.slice(0, 60),
        declared: {
          model: params.model ?? null,
          resolution: params.resolution ?? null,
          target_size: params.target_size ?? null,
          reference_images: [],
        },
      })
      continue
    }

    /* confirm：并入代理登记表，并记下入包素材的哈希 */
    const rec = registry ? registryFor(registry, item.name) : null
    const skin = item.skin
    const mood = item.mood
    const assetPath = skin && mood ? join(here, 'assets', skin, mood + '.webp') : null
    const master = rec && rec.absolutePath ? rec.absolutePath : null
    append({
      kind: 'confirm',
      source: 'manifest+registry',
      at,
      name: item.name,
      skin: skin ?? null,
      mood: mood ?? null,
      registry: rec
        ? { tool: rec.tool, createdAt: rec.createdAt, localPath: rec.localPath ?? null }
        : { tool: null, createdAt: null, localPath: null, note: '登记表里没找到这次调用' },
      master: master ? { path: rel(master), sha256: fileHash(master) } : null,
      output: assetPath && existsSync(assetPath)
        ? { path: rel(assetPath), sha256: fileHash(assetPath), bytes: statSync(assetPath).size }
        : null,
      promptMatchesRegistry: rec ? sha256(item.prompt) === sha256(rec.prompt ?? '') : null,
    })
  }
  console.log(`${isDeclare ? 'declare' : 'confirm'}：写入 ${manifest.length} 条 → ${rel(LOG_PATH)}`)
  process.exit(0)
}

/* -------------------------------------------------------------- backfill */
if (flag('--backfill')) {
  const since = valueOf('--since') || '1970-01-01T00:00:00Z'
  const registry = readRegistry()
  if (!registry) { console.error(`读不到代理登记表：${REGISTRY}`); process.exit(1) }
  const SKIN_OF = { ds2: 'deepsea', cl2: 'classic', ng2: 'night', pj2: 'pajama', canon: 'canon' }
  const MOODS = ['idle', 'happy', 'sleepy', 'work', 'attn', 'poked', 'proud']
  let n = 0
  for (const rec of registry) {
    if (String(rec.createdAt) < since) continue
    const [head, mood] = String(rec.name).split('_')
    const skin = SKIN_OF[head]
    if (!skin || !MOODS.includes(mood)) continue
    const assetPath = join(here, 'assets', skin, mood + '.webp')
    append({
      kind: 'confirm',
      source: 'registry-backfill',
      at: new Date().toISOString(),
      name: rec.name,
      skin, mood,
      registry: { tool: rec.tool, createdAt: rec.createdAt, localPath: rec.localPath ?? null },
      master: rec.absolutePath ? { path: rel(rec.absolutePath), sha256: fileHash(rec.absolutePath) } : null,
      output: existsSync(assetPath) ? { path: rel(assetPath), sha256: fileHash(assetPath), bytes: statSync(assetPath).size } : null,
      /* 回溯条目**没有**自我声明的参数（那时还没这个日志），如实标注 */
      declared: null,
      note: '回溯补录：只有代理登记表的事实，没有当次自我声明的参数',
    })
    n++
  }
  console.log(`backfill：补录 ${n} 条 → ${rel(LOG_PATH)}`)
  process.exit(0)
}

console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('USAGE')[1].split('=====')[0].trim())
