/* ============================================================================
   build.mjs — inline the sprites into lib/client.js.

   lib/client.template.js holds the whole browser half with one placeholder,
   __SPRITES__. This script replaces it with a small object of data URIs:

       { idle: "data:image/webp;base64,…", happy: …, sleepy: …, work: … }

   Embedding rather than shipping asset files is deliberate: the delivered
   plugin is a single self-contained file, so a share carries no path, no
   extra route, and no missing-asset failure mode.

   RUN
     node build.mjs                      # default tier: 1024x1536
     node build.mjs --tier=hi            # 2048x3072 masters  (~3x the bundle)
     node build.mjs --tier=md            # 512x768
     node build.mjs --tier=sm            # 256x384  (--small is an alias)
     node build.mjs --from assets/       # optional, defaults to ./assets

   WHICH SOURCE IS INLINED MATTERS FOR SHARPNESS. assets/ carries four tiers per
   mood, all downsampled from one 2048x3072 master:

     <mood>.webp      1024x1536   default   sharp to devicePixelRatio ~4.9 at the
                                            shipped render size (210x315 CSS px)
     <mood>_md.webp    512x768              the pre-0.4 size
     <mood>_sm.webp    256x384              smallest
     <mood>_hi.webp   2048x3072             headroom for a much larger wisp

   The default is the smallest tier that is sharp on every realistic display; the
   tiers above it add bytes, not visible pixels, until she is drawn much bigger.
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

const MOODS = ['idle', 'happy', 'sleepy', 'work', 'attn', 'poked', 'proud']

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

const sprites = {}
let total = 0
for (const skin of skins) {
  const dir = skin === 'default' ? assetsDir : join(assetsDir, skin)
  sprites[skin] = {}
  console.log(`  ${skin}（${skinLabel(skin)}）`)
  for (const mood of MOODS) {
    const file = pickFile(dir, mood)
    if (!file) {
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

const literal = '{\n' + skins.map((skin) => (
  `      ${JSON.stringify(skin)}: {\n`
  + MOODS.map((m) => `        ${m}: '${sprites[skin][m]}',`).join('\n')
  + '\n      },'
)).join('\n') + '\n    }'
const out = template.replace(PLACEHOLDER, literal)

if (out.includes(PLACEHOLDER)) {
  console.error('build: placeholder survived the substitution; refusing to write a broken bundle')
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
const table = out.match(/const SPRITES = \{([\s\S]*?)\n {4}\}/)
if (!table || MOODS.some((m) => !new RegExp(`\\b${m}:\\s*'data:image/`).test(table[1]))) {
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

writeFileSync(outPath, out, 'utf8')

const kb = (n) => (n / 1024).toFixed(1)
console.log(`\n  sprites total   ${kb(total)} KB`)
console.log(`  base64 inlined  ${kb(out.length)} KB`)
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
