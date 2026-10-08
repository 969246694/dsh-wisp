/* ============================================================================
   motion-trim.mjs — 从动图 WebP 的**尾部去掉若干整帧**（环缝闸 2026-10-09）。

   为什么需要它：环缝指标（`tools/motion-seam.mjs`）量出两条素材的**最后一帧是离群帧** ——
   `canon_work` 的末步是它自己平均帧间变化的 1.97 倍，接回第 0 帧那一下是 1.94 倍；
   砍掉那一帧，接头掉到 **1.01**。`swim_work` 同样是 1.41 → 0.46。

   为什么是**改容器**而不是重编码：动图 WebP 就是一串 ANMF 块，每块自带矩形与像素数据
   （这些素材逐帧 `blend=no` —— 每帧**完整覆盖自己的矩形**，所以帧与帧之间没有像素依赖）。
   把最后一块拿掉、把 RIFF 的长度字段改对，就是一条少一帧、**一个字节都没重编码**的素材。
   重编码会为了丢一帧再赔一代画质，没有道理。

   不变量（任何一条不成立就拒绝写文件）：
     * RIFF/WEBP 魔数，且存在 VP8X / ANIM；
     * 要丢掉的那些块**必须**是文件末尾的连续 ANMF —— 后面还跟着别的块就说明
       它不只是"多了一帧"，别猜；
     * 丢完至少还剩 2 帧。

   RUN
     node tools/motion-trim.mjs assets/motion/canon_work.webp          # 默认丢最后 1 帧
     node tools/motion-trim.mjs assets/motion/swim_work.webp 1 --dry    # 只看会掉多少字节
   ========================================================================== */

import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const positional = argv.filter((a) => !a.startsWith('--'))
const target = positional[0]
const drop = positional[1] === undefined ? 1 : Number(positional[1])

if (target === undefined || !Number.isInteger(drop) || drop < 1) {
  console.error('usage: node tools/motion-trim.mjs <clip.webp> [frames-to-drop] [--dry]')
  process.exit(1)
}

const bytes = readFileSync(target)
if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WEBP') {
  console.error(`motion-trim: ${target} is not a RIFF/WEBP file`)
  process.exit(1)
}

/* 切块表：每块记下 [起点, 整块长度（含 8 字节头与奇偶补齐）]。 */
const chunks = []
for (let off = 12; off + 8 <= bytes.length;) {
  const id = bytes.subarray(off, off + 4).toString('latin1')
  const size = bytes.readUInt32LE(off + 4)
  const total = 8 + size + (size % 2)
  chunks.push({ id, off, total, size })
  off += total
}
const anmfAt = chunks.map((c, i) => (c.id === 'ANMF' ? i : -1)).filter((i) => i >= 0)
const lastChunk = chunks[chunks.length - 1]

if (!chunks.some((c) => c.id === 'VP8X') || !chunks.some((c) => c.id === 'ANIM')) {
  console.error('motion-trim: no VP8X/ANIM — this is not an animated WebP')
  process.exit(1)
}
if (anmfAt.length - drop < 2) {
  console.error(`motion-trim: only ${anmfAt.length} frame(s); dropping ${drop} would leave fewer than 2`)
  process.exit(1)
}
/* 要丢的必须是**文件末尾**的连续 ANMF：末尾那一块不是 ANMF 就直接拒绝。 */
const tail = chunks.slice(chunks.length - drop)
if (tail.length !== drop || tail.some((c) => c.id !== 'ANMF')) {
  console.error(`motion-trim: the last ${drop} chunk(s) are not all ANMF (${tail.map((c) => c.id).join(', ')}) — refusing to guess`)
  process.exit(1)
}

const cutAt = chunks[chunks.length - drop].off
const head = bytes.subarray(0, cutAt)
const out = Buffer.from(head)
out.writeUInt32LE(out.length - 8, 4)      // RIFF 长度 = 整体长度 - 8

const frames = (buf) => buf.toString('latin1').split('ANMF').length - 1
const durationMs = (buf) => {
  let total = 0
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.subarray(off, off + 4).toString('latin1')
    const size = buf.readUInt32LE(off + 4)
    if (id === 'ANMF') total += buf.readUIntLE(off + 20, 3)
    off += 8 + size + (size % 2)
  }
  return total
}
const before = { frames: frames(bytes), ms: durationMs(bytes), bytes: bytes.length }
const after = { frames: frames(out), ms: durationMs(out), bytes: out.length }
/* RIFF 长度字段必须与实际字节数自洽 —— 写错了浏览器会截断或整条不认。 */
if (out.readUInt32LE(4) !== out.length - 8 || after.frames !== before.frames - drop) {
  console.error('motion-trim: self-check failed (RIFF size or frame count) — nothing written')
  process.exit(1)
}
/* 落在末尾的 ANMF 必须真的被丢掉了：最后一块还叫 ANMF 就说明切点在别处。 */
if (lastChunk.id !== 'ANMF') {
  console.error('motion-trim: the file does not end with an ANMF chunk')
  process.exit(1)
}

if (!dry) writeFileSync(target, out)
console.log(`${dry ? '[dry] ' : ''}${target}`)
console.log(`  frames  ${before.frames} -> ${after.frames}   (${drop} dropped)`)
console.log(`  loop    ${before.ms} ms -> ${after.ms} ms`)
console.log(`  bytes   ${(before.bytes / 1024).toFixed(1)} KB -> ${(after.bytes / 1024).toFixed(1)} KB  (-${((before.bytes - after.bytes) / 1024).toFixed(1)} KB)`)
console.log('  接着跑 node tools/motion-seam.mjs 量一遍环缝，再 node build.mjs && node verify-wisp.mjs')
