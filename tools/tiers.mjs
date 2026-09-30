/* ============================================================================
   tiers.mjs — 把「已经抠好的透明 PNG」分成四档素材。

   与 assets.mjs 的分工：
     assets.mjs   绿幕母版 → 抠图 → 四档           （一次做完）
     tiers.mjs    已抠好的透明 PNG → 四档           （不重复抠图）

   什么时候用这个：母版是抠过的成品、或者绿幕原图已经不在了。**不要**把已经抠过的
   图再喂给 assets.mjs —— 那会二次抠图，结果依赖"透明像素里是否还残留绿色"。
   抠图是幂等的假象，不是保证。

   RUN
     node tools/tiers.mjs --from <透明PNG目录> --skin <皮肤名>
     node tools/tiers.mjs --from ./keyed --skin deepsea
   ========================================================================== */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function loadSharp() {
  const dir = process.env.DSH_PROFILE_DIR
  const candidates = [
    process.env.WISP_SHARP,
    dir ? join(dir, '..', 'node_modules', 'sharp') : null,
    'sharp',
  ].filter(Boolean)
  for (const c of candidates) {
    try { return require(c) } catch (e) { /* 试下一个 */ }
  }
  throw new Error('找不到 sharp：请设置环境变量 WISP_SHARP 指向 sharp 包目录')
}

const argv = process.argv.slice(2)
/* 默认只写第一档（会进包的那一档）；--all-tiers 才写全部四档。 */
const allTiers = argv.includes('--all-tiers')
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const MOODS = ['idle', 'happy', 'sleepy', 'work', 'attn']
/* 同 tools/assets.mjs：默认只写会进包的那一档，其余要 --all-tiers。 */
const ALL_TIERS = [
  { suffix: '', w: 1024, q: 84 },
  { suffix: '_md', w: 512, q: 82 },
  { suffix: '_sm', w: 256, q: 80 },
  { suffix: '_hi', w: 2048, q: 86 },
]
/* 选择语句必须**在数组定义之后**：放在前面会踩 TDZ（Cannot access before initialization）。 */
const TIERS = allTiers ? ALL_TIERS : ALL_TIERS.slice(0, 1)

const srcDir = resolve(here, flag('--from', 'keyed'))
const skin = flag('--skin', '')
if (skin === '') {
  console.error('用法: node tools/tiers.mjs --from <透明PNG目录> --skin <皮肤名>')
  process.exit(1)
}
const outDir = resolve(here, flag('--out', join('assets', skin)))

if (!existsSync(srcDir)) {
  console.error(`母版目录不存在: ${srcDir}`)
  process.exit(1)
}
const available = new Set(readdirSync(srcDir).map((f) => f.replace(/\.png$/i, '')))
const missing = MOODS.filter((m) => !available.has(m))
if (missing.length > 0) {
  console.error(`缺少已抠母版: ${missing.map((m) => m + '.png').join(', ')}（在 ${srcDir}）`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const sharp = loadSharp()
console.log(`已抠母版: ${srcDir}\n输出:     ${outDir}\n`)
console.log('mood    源尺寸      四档')

let total = 0
for (const mood of MOODS) {
  const src = join(srcDir, `${mood}.png`)
  const meta = await sharp(src).metadata()
  if (!meta.hasAlpha) {
    // 没有 alpha 说明它根本不是抠过的图 —— 分档会得到带底色的素材，必须拦住
    console.error(`  ${mood}: 没有 alpha 通道，这不是抠好的图（该走 tools/assets.mjs）`)
    process.exit(1)
  }
  const sizes = []
  for (const tier of TIERS) {
    const out = join(outDir, `${mood}${tier.suffix}.webp`)
    await sharp(src)
      .resize(tier.w, Math.round(tier.w * 1.5), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: tier.q, alphaQuality: 92, effort: 6 })
      .toFile(out)
    sizes.push(`${tier.suffix || '默认'} ${Math.round(statSync(out).size / 1024)}KB`)
    total += statSync(out).size
  }
  console.log(`  ${mood.padEnd(7)} ${String(meta.width + 'x' + meta.height).padEnd(11)} ${sizes.join('  ')}`)
}

console.log(`\n共 ${(total / 1024).toFixed(0)} KB（四档 × ${MOODS.length} 情绪）`)
console.log('接着跑 `node build.mjs`（默认用「默认」档；要 4K 档加 --tier=hi）。')
