/* ============================================================================
   build.mjs — inline the sprites into lib/client.js.

   lib/client.template.js holds the whole browser half with two placeholders.
   __SPRITES_LITERAL__ is replaced with a small object of data URIs:

       { idle: "data:image/webp;base64,…", happy: …, sleepy: …, work: … }

   …and __MOTION_LITERAL__ with the frame-animation clips (currently one alpha
   WebM — the sleeping loop):

       { sleepy: "data:video/webm;base64,…" }

   Embedding rather than shipping asset files is deliberate: the delivered
   plugin is a single self-contained file, so a share carries no path, no
   extra route, and no missing-asset failure mode.

   RUN
     node build.mjs                      # default tier: 1024x1536 —— 这一档进包，也是唯一被显示的
     node build.mjs --tier=hi            # 2048x3072（需先 tools/assets.mjs --all-tiers 生成 _hi）
     node build.mjs --tier=md            # 512x768
     node build.mjs --tier=sm            # 256x384  (--small is an alias)
     node build.mjs --from assets/       # optional, defaults to ./assets

   ONLY ONE TIER SHIPS. assets/ now carries just <mood>.webp (1024x1536) per skin.
   The other three tiers are no longer published: runtime never reads them, and
   _hi measured no sharper than the default (DPR 2: 0.3% high-frequency
   difference; DPR 1/3: 1024 was 4~5% BETTER — 2048 gets resampled harder, and
   resampling is itself a low-pass filter). They cost 9.9 MB of the package for
   nothing. Regenerate on demand with `tools/assets.mjs --all-tiers`; the TIERS
   map below falls back down its chain when a preferred file is absent.

   The default is the smallest tier that is sharp on every realistic display:
   sharp to devicePixelRatio ~4.9 at the shipped render size (210x315 CSS px).
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flagValue = (name, fallback) => {
  const at = argv.indexOf(name)
  if (at >= 0 && argv[at + 1] !== undefined) return argv[at + 1]
  const inline = argv.find((a) => a.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : fallback
}
const assetsDir = resolve(here, flagValue('--from', 'assets'))
const templatePath = join(here, 'lib', 'client.template.js')
const outPath = join(here, 'lib', 'client.js')

/* report = 抱着记录本汇报（值班汇报 / 今日小结 / 专注结束）。它和其它格子一样，
   但**允许缺素材**：缺了就跳过，客户端由 SPRITE_FALLBACK 退回 idle。 */
const MOODS = ['idle', 'happy', 'sleepy', 'work', 'attn', 'poked', 'proud', 'eat', 'report']
const OPTIONAL_MOODS = ['report']

/* 皮肤 = assets/ 下的一个子目录，里面是这套皮肤的 <mood>[_tier].webp。
   如果没有子目录含精灵图，就把 assets/ 本身当作一个名为 default 的皮肤 ——
   这样 --from <任意目录> 的单套素材用法仍然成立。 */
const SKIN_LABELS = { deepsea: '深海女仆', canon: '原版女仆', classic: '素绘女仆', default: '默认' }
const skinLabel = (id) => SKIN_LABELS[id] ?? id
/* 顺序即优先级：列表里第一个就是默认皮肤。不这么写的话默认值会由目录名的字母序
   决定 —— 那是构建实现的偶然，不该变成产品行为。未列出的排在后面。 */
const SKIN_PRIORITY = ['deepsea', 'canon', 'classic', 'night', 'pajama']
const skinRank = (id) => {
  const at = SKIN_PRIORITY.indexOf(id)
  return at < 0 ? SKIN_PRIORITY.length : at
}

/** Preference order per tier: the first hit wins, later entries are fallbacks. */
const TIERS = {
  hi: ['_hi', '', '_md', '_sm'],
  full: ['', '_hi', '_md', '_sm'],
  md: ['_md', '', '_sm'],
  sm: ['_sm', '_md', ''],
}
const alias = argv.includes('--small') ? 'sm' : argv.includes('--hi') ? 'hi' : argv.includes('--md') ? 'md' : 'full'
const tier = flagValue('--tier', alias)
if (TIERS[tier] === undefined) {
  console.error(`build: unknown --tier "${tier}" (expected one of ${Object.keys(TIERS).join(', ')})`)
  process.exit(1)
}

if (!existsSync(assetsDir)) {
  console.error(`build: assets directory not found: ${assetsDir}`)
  process.exit(1)
}

const pickFile = (dir, mood) => {
  for (const suffix of TIERS[tier]) {
    for (const ext of ['.webp', '.png']) {
      const p = join(dir, `${mood}${suffix}${ext}`)
      if (existsSync(p)) return p
    }
  }
  return null
}
const hasSprite = (dir) => MOODS.some((mood) => pickFile(dir, mood) !== null)

const skinIds = readdirSync(assetsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => hasSprite(join(assetsDir, name)))
  .sort((a, b) => skinRank(a) - skinRank(b) || a.localeCompare(b))
const legacySingleSkin = skinIds.length === 0 && hasSprite(assetsDir)
const skins = legacySingleSkin ? ['default'] : skinIds
if (skins.length === 0) {
  console.error(`build: no sprites anywhere under ${assetsDir}`)
  process.exit(1)
}

/* 音效：assets/audio/<名字>.mp3 -> { <名字>: "data:audio/mpeg;base64,…" }。
   没有文件就是空对象 —— 客户端据此连菜单开关都不显示（点了没反应的开关更糟）。 */
const audioDir = join(assetsDir, 'audio')
const sounds = {}
if (existsSync(audioDir)) {
  const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }
  for (const name of readdirSync(audioDir).sort()) {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (MIME[ext] === undefined) continue
    sounds[name.slice(0, name.lastIndexOf('.'))] = `data:${MIME[ext]};base64,${readFileSync(join(audioDir, name)).toString('base64')}`
  }
}
if (Object.keys(sounds).length > 0) console.log(`  audio: ${Object.keys(sounds).join(', ')}`)

/* ---- 帧动画（motion）：assets/motion/<名字>.webm -> { <名字>: "data:video/webm;base64,…" }。

   和音效同一档待遇：**可选**。没有文件就是空对象，客户端据此连 <video> 都不建 ——
   一个"永远不播的空盒子"比没有它更糟（它会占位、会吃内存、还要有人去解释它）。

   MIME 写死 video/webm，别的扩展名一律不认：这一档素材是 VP9 + **alpha 平面**
   （EBML 里 AlphaMode=1，本脚本不看，但选它就是因为透明处能透出壁纸）。
   收别的格式进来，透明处会变成一块黑底。 */
const motionDir = join(assetsDir, 'motion')
const motion = {}
let motionRaw = 0
for (const name of existsSync(motionDir) ? readdirSync(motionDir).sort() : []) {
  if (!name.toLowerCase().endsWith('.webm')) continue
  const file = join(motionDir, name)
  const bytes = readFileSync(file)
  const key = name.slice(0, -'.webm'.length)
  motion[key] = `data:video/webm;base64,${bytes.toString('base64')}`
  motionRaw += bytes.length
  console.log(`  motion: ${key}  ${(bytes.length / 1024).toFixed(1)} KB raw  /  ${(motion[key].length / 1024).toFixed(1)} KB base64  <- ${file.slice(here.length + 1)}`)
}

const sprites = {}
let total = 0
for (const skin of skins) {
  const dir = skin === 'default' ? assetsDir : join(assetsDir, skin)
  sprites[skin] = {}
  console.log(`  ${skin}（${skinLabel(skin)}）`)
  for (const mood of MOODS) {
    const file = pickFile(dir, mood)
    if (!file) {
      /* 可选心情（report）缺素材只警告不中断：客户端有回退表，缺它不会变成坏行为。 */
      if (OPTIONAL_MOODS.includes(mood)) {
        console.warn(`  ! ${skin}: 跳过可选心情 "${mood}"（还没有素材）`)
        continue
      }
      console.error(`build: skin "${skin}" has no sprite for mood "${mood}"`)
      process.exit(1)
    }
    const bytes = readFileSync(file)
    total += bytes.length
    const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
    const mime = ext === 'png' ? 'image/png' : 'image/webp'
    sprites[skin][mood] = `data:${mime};base64,${bytes.toString('base64')}`
    console.log(`    ${mood.padEnd(7)} ${String(Math.round(bytes.length / 1024)).padStart(4)} KB  <- ${file.slice(here.length + 1)}`)
  }
}

const PLACEHOLDER = '__SPRITES_LITERAL__'
const MOTION_PLACEHOLDER = '__MOTION_LITERAL__'
const template = readFileSync(templatePath, 'utf8')
const placeholderCount = template.split(PLACEHOLDER).length - 1
if (placeholderCount !== 1) {
  // Exactly one occurrence, and it must NOT sit inside a comment. An earlier
  // revision used `/*__SPRITES__*/{}` as the placeholder; the substitution then
  // left `/*{…}`, the whole injected table became a block comment, SPRITES
  // silently evaluated to {}, and every sprite rendered as a broken image.
  console.error(`build: template must contain ${PLACEHOLDER} exactly once (found ${placeholderCount})`)
  process.exit(1)
}
const motionPlaceholderCount = template.split(MOTION_PLACEHOLDER).length - 1
if (motionPlaceholderCount !== 1) {
  console.error(`build: template must contain ${MOTION_PLACEHOLDER} exactly once (found ${motionPlaceholderCount})`)
  process.exit(1)
}

const literal = '{\n' + skins.map((skin) => (
  `      ${JSON.stringify(skin)}: {\n`
  + MOODS.map((m) => `        ${m}: '${sprites[skin][m]}',`).join('\n')
  + '\n      },'
)).join('\n') + '\n    }'
/* 空表也要是**合法的空对象**：没有 motion 素材的包照样能构建（客户端会连 <video> 都不建）。 */
const motionLiteral = '{\n' + Object.keys(motion).map((key) => (
  `      ${JSON.stringify(key)}: '${motion[key]}',`
)).join('\n') + '\n    }'
const soundsInlined = template.replace(
  "const SOUNDS = (typeof __WISP_SOUNDS__",
  `const __WISP_SOUNDS__ = ${JSON.stringify(sounds)}\nconst SOUNDS = (typeof __WISP_SOUNDS__`,
)
/* 用函数形式替换：base64 里不会有 `$`，但把替换值当**值**传递是唯一不用去想
   `$&`/`$1` 转义问题的写法，而这两张表将来都可能换个编码。 */
const out = soundsInlined
  .replace(MOTION_PLACEHOLDER, () => motionLiteral)
  .replace(PLACEHOLDER, () => literal)

if (out.includes(PLACEHOLDER)) {
  console.error('build: placeholder survived the substitution; refusing to write a broken bundle')
  process.exit(1)
}
if (out.includes(MOTION_PLACEHOLDER)) {
  console.error('build: the motion placeholder survived the substitution; refusing to write a broken bundle')
  process.exit(1)
}

/* ---- guard: never call a global the dynamic client runner traps ----------
   setTimeout/setInterval/clearTimeout/clearInterval/fetch/require are shadowed
   by THROWING parameters in a client half, so a call to one is a guaranteed
   runtime crash that no bundler reports. The pattern demands a real call, so
   the prose in the file header (which names them without parentheses) is not a
   false positive. verify-wisp.mjs proves the same thing by executing the bundle
   with all six shadowed by traps. */
const TRAPPED_CALL = /(setTimeout|setInterval|clearTimeout|clearInterval|fetch|require)\s*\(/
const trapped = out.match(TRAPPED_CALL)
if (trapped) {
  console.error(`build: the bundle calls the trapped global "${trapped[1]}" — the client half would throw at runtime`)
  process.exit(1)
}

/* ---- guard: the stamped version must match package.json ------------------ */
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const stamped = out.match(/const VERSION = '([^']+)'/)
if (!stamped) {
  console.error('build: client half carries no VERSION constant; the mount log would lie about the running build')
  process.exit(1)
}
if (stamped[1] !== pkg.version) {
  console.error(`build: version drift — client stamps ${stamped[1]}, package.json says ${pkg.version}`)
  process.exit(1)
}

// Prove the injected table survives parsing before writing anything.
// 可选心情（report）允许缺失：客户端有 SPRITE_FALLBACK 兜底，缺它不会变成坏行为。
const table = out.match(/const SPRITES = \{([\s\S]*?)\n {4}\}/)
const requiredMoods = MOODS.filter((m) => !OPTIONAL_MOODS.includes(m))
if (!table || requiredMoods.some((m) => !new RegExp(`\\b${m}:\\s*'data:image/`).test(table[1]))) {
  console.error('build: the injected SPRITES table is missing sprites; aborting')
  process.exit(1)
}
try {
  // Evaluate exactly that statement to be certain it is not commented out, and
  // walk every skin/mood pair — a missing pair is a blank companion, not an error
  // anyone would see at build time.
  const value = new Function(`${table[0]}\nreturn SPRITES`)()
  const broken = []
  for (const skin of skins) {
    for (const mood of MOODS) {
      if (OPTIONAL_MOODS.includes(mood)) continue      // 可缺：客户端由 SPRITE_FALLBACK 兜底
      const uri = value?.[skin]?.[mood]
      if (typeof uri !== 'string' || uri.indexOf('data:image/') !== 0) broken.push(`${skin}/${mood}`)
    }
  }
  if (broken.length > 0) {
    console.error(`build: SPRITES is missing ${broken.join(', ')}; aborting`)
    process.exit(1)
  }
  if (Object.keys(value).length !== skins.length) {
    console.error(`build: SPRITES holds ${Object.keys(value).length} skins, expected ${skins.length}; aborting`)
    process.exit(1)
  }
} catch (error) {
  console.error(`build: injected SPRITES table does not evaluate (${error.message}); aborting`)
  process.exit(1)
}

/* 同一道防线给 MOTION：表必须真的存在、真的能求值，而且每个值都必须是 video/webm 的
   data URI。写坏一个 key（例如把 .webm 之外的素材塞进 assets/motion/）时，客户端
   会建一个永远不播的 <video>，而失败是**静默**的 —— 只有这里能拦。 */
const motionTable = out.match(/const MOTION = \{([\s\S]*?)\n {4}\}/)
if (!motionTable) {
  console.error('build: the injected MOTION table is missing; aborting')
  process.exit(1)
}
try {
  const value = new Function(`${motionTable[0]}\nreturn MOTION`)()
  const broken = Object.keys(value).filter((key) => typeof value[key] !== 'string' || value[key].indexOf('data:video/webm;base64,') !== 0)
  if (broken.length > 0) {
    console.error(`build: MOTION entries are not inlined video/webm data URIs: ${broken.join(', ')}; aborting`)
    process.exit(1)
  }
  if (Object.keys(value).length !== Object.keys(motion).length) {
    console.error(`build: MOTION holds ${Object.keys(value).length} clips, expected ${Object.keys(motion).length}; aborting`)
    process.exit(1)
  }
} catch (error) {
  console.error(`build: injected MOTION table does not evaluate (${error.message}); aborting`)
  process.exit(1)
}

writeFileSync(outPath, out, 'utf8')

const kb = (n) => (n / 1024).toFixed(1)
console.log(`\n  sprites total   ${kb(total)} KB`)
console.log(`  base64 inlined  ${kb(out.length)} KB`)
if (Object.keys(motion).length > 0) {
  /* 帧动画的体积账单独打一行：它是**唯一**一个进包的视频，而预算（verify-wisp.mjs）
     盯的是 base64 之后的长度，不是原始文件大小。 */
  console.log(`  motion raw      ${kb(motionRaw)} KB  (${Object.keys(motion).join(', ')})`)
  console.log(`  motion inlined  ${kb(Object.values(motion).reduce((n, uri) => n + uri.length, 0))} KB  base64`)
}
console.log(`  wrote           lib/client.js`)

/* 体积与锐度是同一个决定的两面，所以把账算在构建输出里，而不是只写在文档里：
   她在屏上是 140*size x 210*size CSS px，需要多少设备像素只取决于当前屏幕的 DPR。 */
const SOURCE_WIDTH = { hi: 2048, full: 1024, md: 512, sm: 256 }[tier]
const drawnW = 140 * 4
const drawnH = 210 * 4
console.log(`\n  tier            ${tier}  (${SOURCE_WIDTH}px wide per sprite)`)
console.log(`  she is drawn    ${drawnW}x${drawnH} CSS px  (size 4)`)
for (const dpr of [1, 1.5, 2, 3]) {
  const need = drawnW * dpr
  const ratio = SOURCE_WIDTH / need
  const verdict = ratio >= 1
    ? `downscale ${ratio.toFixed(2)}x — crisp`
    : `UPSCALE ${(1 / ratio).toFixed(2)}x — slightly soft`
  console.log(`    DPR ${String(dpr).padEnd(3)} needs ${String(Math.round(need)).padStart(4)}px  →  ${verdict}`)
}

if (assetsDir !== join(here, 'assets') && readdirSync(assetsDir).length === 0) {
  console.warn('\n  warning: assets directory is empty')
}
