/* ============================================================================
   motion-seam.mjs — 帧动画的**环缝**指标（环缝闸 2026-10-09）。

   为什么需要它：19 条素材都是"首帧 = 尾帧"这条思路生成的（模式 first_last_frame，
   首尾喂同一张图），设计意图是**天然无缝循环**。但这条意图**从来没有被量过** ——
   预检里钉的是 720x1280 / 97 帧 / 41ms，全是"素材长什么样"，没有一条是
   "接到一起顺不顺"。实测：19 条里有 6 条的接头比它自己平时的帧间变化还大，
   最差的一条（canon_attn）是 2.29 倍 —— 每 4 秒她会**顿一下**，而画面上不报错。

   指标只有一条：

     ratio = seam / meanStep

     seam     = 第 n-1 帧 → 第 0 帧（就是循环接回去的那一步）的 |ΔRGB| 全画布均值
     meanStep = 相邻两帧同一个量的平均（"这条素材平时一帧动多少"）

   **两边都有错法**：
     ratio ≈ 1   接回去正好是普通的一步 —— 对；
     ratio → 0   最后一帧和第一帧几乎一样，接回去**同一张画停两帧** —— 看到的是"顿一下"；
     ratio > 1.25 接回去那一下比平时都猛 —— 看到的是"跳"。
   所以判定是一条**带**（0.75~1.25），不是一个上限。

   只量 **RGB**，不量 alpha：alpha 是无损编码的，实测同参数重编码逐位相同；
   而透明像素下面的 RGB 编码器有权改（改了你也不知道），把它算进来只会污染指标。

   RUN
     node tools/motion-seam.mjs                     # 量 assets/motion/ 下全部素材
     node tools/motion-seam.mjs --ffmpeg <路径>      # ffmpeg 不在 PATH 时
     node tools/motion-seam.mjs --json              # 机器可读
     node tools/motion-seam.mjs --table             # 打印可以直接贴进 verify-wisp.mjs 的表

   为什么用 ffmpeg 解码、而不是纯 Node：动图 WebP 是 VP8（有损）+ ALPH（无损）两套
   编码，纯 JS 解它等于把 libwebp 抄一遍。这个仓库的**美术流水线本来就用 ffmpeg**
   （生成、抠像、编码三条命令），所以这里跟着它走，不引入新的依赖类别。
   **预检不跑这个脚本** —— verify-wisp.mjs 必须零依赖、到哪都能跑，它只查这张
   表的**指纹**（见那边的 MOTION_SEAM：每个数字都钉在素材字节的 sha256 上，
   素材一换数字就作废，必须重新量）。
   ========================================================================== */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const argv = process.argv.slice(2)
const flagValue = (name) => {
  const at = argv.indexOf(name)
  if (at >= 0 && argv[at + 1] !== undefined) return argv[at + 1]
  const inline = argv.find((a) => a.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : null
}

/** ffmpeg 优先取 --ffmpeg / WISP_FFMPEG，最后才是 PATH 上的那个。 */
const FFMPEG = flagValue('--ffmpeg') ?? process.env.WISP_FFMPEG ?? 'ffmpeg'

const dir = flagValue('--dir') ?? join(pkgRoot, 'assets', 'motion')
const only = argv.filter((a) => !a.startsWith('--') && a.endsWith('.webp'))
const files = (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.webp')) : [])
  .filter((f) => only.length === 0 || only.includes(f))
  .sort()

if (files.length === 0) {
  console.error(`motion-seam: no clips under ${dir}`)
  process.exit(1)
}

/** 画布尺寸从 VP8X 读（别写死：写死就等于把"素材是什么样"又抄了一遍）。 */
function canvas(file) {
  const b = readFileSync(file)
  if (b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') return null
  for (let off = 12; off + 8 <= b.length;) {
    const id = b.subarray(off, off + 4).toString('latin1')
    const size = b.readUInt32LE(off + 4)
    if (id === 'VP8X') return { w: b.readUIntLE(off + 12, 3) + 1, h: b.readUIntLE(off + 15, 3) + 1 }
    off += 8 + size + (size % 2)
  }
  return null
}

/** 把一条素材解成裸 RGBA 帧流，逐帧算差 —— 只留前一帧，内存与帧数无关。 */
function measure(file) {
  return new Promise((ok, fail) => {
    const size = canvas(file)
    if (size === null) return fail(new Error(`${file}: not a RIFF/WEBP`))
    const frameBytes = size.w * size.h * 4
    const proc = spawn(FFMPEG, [
      '-v', 'error', '-i', file,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err += String(d) })
    let buf = Buffer.alloc(0)
    let prev = null
    let frames = 0
    let stepSum = 0
    let stepCount = 0
    let first = null
    let last = null
    proc.stdout.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      while (buf.length >= frameBytes) {
        const cur = buf.subarray(0, frameBytes)
        buf = buf.subarray(frameBytes)
        if (frames === 0) first = Buffer.from(cur)
        if (prev !== null) {
          let acc = 0
          for (let i = 0; i < frameBytes; i += 4) {
            acc += Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2])
          }
          stepSum += acc / (frameBytes / 4) / 3
          stepCount += 1
        }
        prev = Buffer.from(cur)
        last = prev
        frames += 1
      }
    })
    proc.on('error', (e) => fail(new Error(`${FFMPEG}: ${e.message}`)))
    proc.on('close', (code) => {
      if (code !== 0) return fail(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`))
      if (frames < 3) return fail(new Error(`decoded only ${frames} frame(s)`))
      let seamAcc = 0
      for (let i = 0; i < frameBytes; i += 4) {
        seamAcc += Math.abs(first[i] - last[i]) + Math.abs(first[i + 1] - last[i + 1]) + Math.abs(first[i + 2] - last[i + 2])
      }
      const meanStep = stepSum / stepCount
      const seam = seamAcc / (frameBytes / 4) / 3
      ok({
        frames,
        meanStep,
        seam,
        ratio: seam / meanStep,
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase(),
      })
    })
  })
}

const rows = []
for (const f of files) {
  const file = join(dir, f)
  try {
    const m = await measure(file)
    rows.push({ clip: f.slice(0, -'.webp'.length), file: f, bytes: readFileSync(file).length, ...m })
  } catch (error) {
    rows.push({ clip: f.slice(0, -'.webp'.length), file: f, error: error.message })
  }
}

if (argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1))
} else if (argv.includes('--table')) {
  for (const r of rows) {
    if (r.error) { console.log(`  /* ${r.clip}: ${r.error} */`); continue }
    console.log(`      ${r.clip}: ['${r.sha256}', ${r.ratio.toFixed(2)}],`)
  }
} else {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`${pad('clip', 18)}${'frames'.padStart(7)}${'meanStep'.padStart(10)}${'seam'.padStart(9)}${'ratio'.padStart(8)}  verdict`)
  for (const r of rows) {
    if (r.error) { console.log(`${pad(r.clip, 18)}  ERROR ${r.error}`); continue }
    const verdict = r.ratio > 1.25 ? 'JUMP' : r.ratio < 0.75 ? 'PAUSE (loop holds)' : 'smooth'
    console.log(`${pad(r.clip, 18)}${String(r.frames).padStart(7)}${r.meanStep.toFixed(3).padStart(10)}${r.seam.toFixed(3).padStart(9)}${r.ratio.toFixed(2).padStart(8)}  ${verdict}`)
  }
  const bad = rows.filter((r) => !r.error && r.ratio > 1.2)
  console.log(`\n${rows.length} clip(s); ${bad.length} above 1.20: ${bad.map((r) => `${r.clip} ${r.ratio.toFixed(2)}`).join(', ') || '—'}`)
}
