/* ============================================================================
   keyout.mjs — 绿幕抠图（单张）。

   为什么不用服务端的透明背景：它会把浅蓝渐变的发梢与鲸尾当成浅色背景切掉，
   表现成"生成结果变成了短发、鲸尾消失"，极易误判成模型跑形。绿幕不存在这种
   歧义：角色是深蓝/浅蓝/白配色，与纯绿没有色相重叠，所以可以做得比通用抠图
   保守得多。

   原理：以"绿色占优量" g - max(r, b) 作为键控信号，线性映射成 alpha，
   并对半透明像素做绿色溢出抑制（把 g 压到 max(r,b)），避免发丝边缘泛绿。

   RUN
     node tools/keyout.mjs <绿幕图.png> <输出.png>
     node tools/keyout.mjs in.png out.png --t0 14 --t1 96     # 调宽容忍度
   ========================================================================== */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** sharp 不在插件包里（插件本体零依赖），从 DSH profile 的 node_modules 取。 */
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
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? Number(argv[at + 1]) : fallback
}
const paths = argv.filter((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a))
const [inPath, outPath] = paths

if (!inPath || !outPath) {
  console.error('用法: node tools/keyout.mjs <绿幕图.png> <输出.png> [--t0 14] [--t1 96]')
  process.exit(1)
}

// 判定为「绿」的占优阈值：< T0 完全不透明，> T1 完全透明
const T0 = flag('--t0', 14)
const T1 = flag('--t1', 96)

const sharp = loadSharp()
const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels } = info
if (channels !== 4) throw new Error(`期望 4 通道，实得 ${channels}`)

const out = Buffer.alloc(W * H * 4)
let opaque = 0
let clear = 0
let soft = 0
let minX = W, minY = H, maxX = -1, maxY = -1

for (let i = 0, p = 0; i < W * H; i++, p += 4) {
  const r = data[p]
  const g = data[p + 1]
  const b = data[p + 2]
  const dom = g - Math.max(r, b)
  let a = 1 - (dom - T0) / (T1 - T0)
  a = a < 0 ? 0 : a > 1 ? 1 : a
  if (a >= 1) opaque++
  else if (a <= 0) clear++
  else {
    soft++
    data[p + 1] = Math.min(g, Math.max(r, b))   // 去绿边
  }
  out[p] = data[p]
  out[p + 1] = data[p + 1]
  out[p + 2] = b
  out[p + 3] = Math.round(a * 255)
  if (a > 0.5) {
    const x = i % W
    const y = (i - x) / W
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
}

await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outPath)

const pct = (n) => `${(n / (W * H) * 100).toFixed(2)}%`
console.log(`${inPath.split(/[\\/]/).pop()} -> ${outPath.split(/[\\/]/).pop()}`)
console.log(`  不透明 ${pct(opaque)}  半透明边缘 ${pct(soft)}  全透明 ${pct(clear)}`)
if (maxX < 0) {
  console.error('  警告：整张图都被判成背景，输出是全透明的 —— 多半是这张图不是绿幕底')
  process.exit(2)
}
console.log(`  角色范围 x ${minX}..${maxX} (${((maxX - minX + 1) / W * 100).toFixed(1)}% 宽)  y ${minY}..${maxY} (${((maxY - minY + 1) / H * 100).toFixed(1)}% 高)`)
if (soft / (W * H) > 0.05) {
  console.error('  警告：半透明边缘占比过高，源图可能不是干净的绿幕')
  process.exit(2)
}
