/* ============================================================================
   assets.mjs — 一条命令把"绿幕母版"变成可入包的素材。

   输入：一个目录，里面是四张绿幕母版 <mood>.png（2048x3072，纯绿背景）
   输出：assets/ 下的四档素材
           <mood>.webp      1024x1536  默认档
           <mood>_md.webp    512x768
           <mood>_sm.webp    256x384
           <mood>_hi.webp   2048x3072  与母版同尺寸，仅重新编码

   每一步都会报告键控质量；任何一张的键控异常都会让整条命令以非 0 退出，
   避免"某一张没抠干净"悄悄混进包里 —— 这种错误很难从最终效果反推。

   RUN
     node tools/assets.mjs --from ./绿幕母版
     node tools/assets.mjs --from ./绿幕母版 --out ./assets
   ========================================================================== */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
/* report = 抱记录本汇报（v1.57.0 起有素材）。走路（walk）不在这张表里 ——
   它是 720x1280、要跟帧动画同画布，走另一条流水线，不进 assets.mjs。 */
const MOODS = ['idle', 'happy', 'sleepy', 'work', 'attn', 'poked', 'proud', 'eat', 'report', 'worried', 'care', 'punch']
const srcDir = resolve(here, flag('--from', 'masters'))
/* 皮肤 = assets/ 下的一个子目录。--skin 决定输出到哪一套。
   注意 build.mjs 会把每个子目录当成一套皮肤打进包里，所以皮肤越多包越大。 */
const skin = flag('--skin', '')
const outDir = resolve(here, flag('--out', skin === '' ? 'assets' : join('assets', skin)))

const T0 = 14
const T1 = 96
/* 只有第一档会被 build.mjs 打进 JS 包并真正显示；其余三档运行时**从不读取**
   （_hi 也测不出画质差别：DPR 2 差 0.3%，DPR 1/3 反而低 4~5%）。
   所以默认只写第一档 —— 不让 9.9 MB 死重悄悄长回包里。
   确实要用别的档重打包时：加 --all-tiers。 */
const ALL_TIERS = [
  { suffix: '', w: 1024, q: 84 },
  { suffix: '_md', w: 512, q: 82 },
  { suffix: '_sm', w: 256, q: 80 },
  { suffix: '_hi', w: 2048, q: 86 },
]
/* 选择语句必须**在数组定义之后**：放在前面会踩 TDZ（Cannot access before initialization）。 */
const TIERS = allTiers ? ALL_TIERS : ALL_TIERS.slice(0, 1)

if (!existsSync(srcDir)) {
  console.error(`母版目录不存在: ${srcDir}`)
  process.exit(1)
}
/* 这里**不**要求每个情绪都有母版：给已有皮肤补一个新情绪（例如后来加的 poked）时，
   别的母版早就没了。缺哪个由下面的循环逐条打印，最后用"一张都没处理"兜底 ——
   既不因为缺一张就整条停下，也不会把"文件名写错"静默吞掉。 */
mkdirSync(outDir, { recursive: true })

const sharp = loadSharp()
const kb = (n) => `${(n / 1024).toFixed(0)} KB`
let failed = 0

/** 绿幕键控：返回 { png, opaque, soft } 或抛错。 */
async function key(srcPath, outPath) {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels } = info
  if (channels !== 4) throw new Error(`期望 4 通道，实得 ${channels}`)
  const px = Buffer.alloc(W * H * 4)
  let opaque = 0
  let soft = 0
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    let a = 1 - ((g - Math.max(r, b)) - T0) / (T1 - T0)
    a = a < 0 ? 0 : a > 1 ? 1 : a
    if (a >= 1) opaque++
    else if (a > 0) { soft++; data[p + 1] = Math.min(g, Math.max(r, b)) }
    px[p] = data[p]
    px[p + 1] = data[p + 1]
    px[p + 2] = b
    px[p + 3] = Math.round(a * 255)
  }
  const opaqueRatio = opaque / (W * H)
  const softRatio = soft / (W * H)
  if (opaqueRatio > 0.9) throw new Error(`键控几乎无效（不透明 ${(opaqueRatio * 100).toFixed(1)}%）—— 这张多半不是绿幕底`)
  if (softRatio > 0.05) throw new Error(`半透明边缘占比 ${(softRatio * 100).toFixed(1)}% 过高 —— 源图可能不是干净绿幕`)
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outPath)
  return { opaque: opaqueRatio, soft: softRatio, w: W, h: H }
}

console.log(`母版: ${srcDir}\n出图: ${outDir}\n`)
console.log('mood    键控(不透明/边缘)      档位      尺寸         体积')
let processed = 0
for (const mood of MOODS) {
  const src = join(srcDir, `${mood}.png`)
  /* 缺某个情绪的母版**不是错误**：给已有皮肤补一个新情绪（例如新加的 poked）时，
     别的母版早就没了，只有这一张。以前这里会直接中止，于是"补一个情绪"必须先凑齐全部母版。
     但也不能静默跳过 —— 打出来，好让"文件名写错"和"本来就没有"分得清。 */
  if (!existsSync(src)) {
    console.log(`  ${mood.padEnd(7)} 跳过（这个目录里没有 ${mood}.png）`)
    continue
  }
  /* 抠图后的全尺寸 PNG 是**中间产物**，写到系统临时目录而不是 outDir：
     以前它写在发布目录里、最后再删，删除一旦失败就在 assets/ 里留下 0 字节的隐藏残骸
     （实测 classic 4 个、night 5 个，而且会随包发布）。中间产物根本不该出现在发布目录。 */
  const keyed = join(tmpdir(), `wisp-key-${skin || 'default'}-${mood}-${process.pid}.png`)
  let meta
  try {
    meta = await key(src, keyed)
  } catch (error) {
    failed++
    console.error(`  ${mood.padEnd(7)} 抠图失败: ${error.message}`)
    continue
  }
  for (const tier of TIERS) {
    const out = join(outDir, `${mood}${tier.suffix}.webp`)
    await sharp(keyed)
      .resize(tier.w, Math.round(tier.w * 1.5), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: tier.q, alphaQuality: 92, effort: 6 })
      .toFile(out)
  }
  processed++
  console.log(
    `  ${mood.padEnd(7)} ${(meta.opaque * 100).toFixed(1)}% / ${(meta.soft * 100).toFixed(2)}%`.padEnd(30),
    (TIERS[0].suffix || '默认').padEnd(8),
    `${Math.round(meta.w / 2)}x${Math.round(meta.h / 2)}`.padEnd(13),
    kb(statSync(join(outDir, `${mood}.webp`)).size),
  )
  // 中间产物在系统临时目录里，删不掉也只是临时目录的事，不会污染发布内容
  try { rmSync(keyed, { force: true }) } catch (e) { /* 临时目录的残留无害 */ }
}

if (processed === 0) {
  console.error('\n这个目录里一张母版都没找到 —— 检查 --from 是否指对了目录。')
  process.exit(1)
}
if (failed > 0) {
  console.error(`\n${failed} 张母版抠图失败 —— 素材未更新，请检查这些图是否是干净的纯绿背景。`)
  process.exit(1)
}
console.log('\n完成。接着跑 `node build.mjs`（默认就用 <mood>.webp 那一档，要出别的档位加 --all-tiers）。')
