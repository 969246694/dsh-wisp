/* ============================================================================
   motion-trim.mjs — 动图 WebP 的**容器手术**：丢尾部整帧 / 改每帧时长。

   为什么是改容器而不是重编码：动图 WebP 就是一串 ANMF 块，每块自带矩形与像素数据
   （这些素材逐帧 blend=no —— 每帧完整覆盖自己的矩形，帧与帧之间没有像素依赖）。
   丢一块、或者把块内那 3 个字节的时长改掉，都不会碰到一个像素的编码数据。
   重编码为了丢一帧再赔一代画质，没有道理。

   两个开关各自解决一件已经被量出来的事：
     * 丢帧：环缝指标量出某条的**末帧是离群帧**（canon_work 的末步是自己平均的 1.97 倍），
       砍掉它接头 1.94 → 1.02。
     * 改时长：走路素材要 **34 ms/帧**（25 帧 = 850 ms = 一次溜达的半个来回），
       而视频模型吐出来的是 24 fps（41 ms）。ANMF 块 +12 起 3 字节小端就是该帧时长，
       块长度不变 ⇒ RIFF 长度字段不用动。见 docs/walk-action-prep.md 第 3 节。

   不变量（任何一条不成立就拒绝写文件）：
     * RIFF/WEBP 魔数，且存在 VP8X / ANIM；
     * 要丢掉的那些块**必须**是文件末尾的连续 ANMF —— 后面还跟着别的块就说明
       它不只是"多了一帧"，别猜；
     * 丢完至少还剩 2 帧；
     * 改完时长要**逐帧复核**：帧数不变、每帧都是给定值（写错一个字节就是一条播不对的素材，
       而页面上不会报任何错）。

   RUN
     node tools/motion-trim.mjs assets/motion/canon_work.webp            # 默认丢最后 1 帧
     node tools/motion-trim.mjs assets/motion/swim_work.webp 1 --dry      # 只看会掉多少字节
     node tools/motion-trim.mjs assets/motion/canon_walk.webp --set-duration 34   # 只改时长
   ========================================================================== */

import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const durAt = argv.indexOf('--set-duration')
const setDuration = durAt >= 0 ? Number(argv[durAt + 1]) : null
const positional = argv.filter((a, i) => !a.startsWith("--") && !(durAt >= 0 && i === durAt + 1))
const target = positional[0]
/* 只改时长时默认**一帧都不丢**；两者可以一起用。 */
const drop = positional[1] === undefined ? (setDuration === null ? 1 : 0) : Number(positional[1])

const badDuration = setDuration !== null && (!Number.isInteger(setDuration) || setDuration < 1 || setDuration > 0xffffff)
if (target === undefined || !Number.isInteger(drop) || drop < 0 || badDuration) {
  console.error('usage: node tools/motion-trim.mjs <clip.webp> [frames-to-drop] [--set-duration <ms>] [--dry]')
  process.exit(1)
}

const bytes = readFileSync(target)
if (bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WEBP") {
  console.error(`motion-trim: ${target} is not a RIFF/WEBP file`)
  process.exit(1)
}

/* 切块表：每块记下 [起点, 整块长度（含 8 字节头与奇偶补齐）]。 */
const chunks = []
for (let off = 12; off + 8 <= bytes.length;) {
  const id = bytes.subarray(off, off + 4).toString("latin1")
  const size = bytes.readUInt32LE(off + 4)
  const total = 8 + size + (size % 2)
  chunks.push({ id, off, total, size })
  off += total
}
const anmfAt = chunks.map((c, i) => (c.id === "ANMF" ? i : -1)).filter((i) => i >= 0)
const lastChunk = chunks[chunks.length - 1]

if (!chunks.some((c) => c.id === "VP8X") || !chunks.some((c) => c.id === "ANIM")) {
  console.error("motion-trim: no VP8X/ANIM — this is not an animated WebP")
  process.exit(1)
}
if (anmfAt.length - drop < 2) {
  console.error(`motion-trim: only ${anmfAt.length} frame(s); dropping ${drop} would leave fewer than 2`)
  process.exit(1)
}
if (drop > 0) {
  /* 要丢的必须是**文件末尾**的连续 ANMF：末尾那一块不是 ANMF 就直接拒绝。 */
  const tail = chunks.slice(chunks.length - drop)
  if (tail.length !== drop || tail.some((c) => c.id !== "ANMF")) {
    console.error(`motion-trim: the last ${drop} chunk(s) are not all ANMF (${tail.map((c) => c.id).join(", ")}) — refusing to guess`)
    process.exit(1)
  }
  if (lastChunk.id !== "ANMF") {
    console.error("motion-trim: the file does not end with an ANMF chunk")
    process.exit(1)
  }
}

const cutAt = drop > 0 ? chunks[chunks.length - drop].off : bytes.length
const out = Buffer.from(bytes.subarray(0, cutAt))
out.writeUInt32LE(out.length - 8, 4)      // RIFF 长度 = 整体长度 - 8

/* 改时长：ANMF 块内偏移 20（= 8 字节头 + 12）起 3 字节小端。块长度不变，RIFF 长度因此也不变。 */
let retimed = 0
if (setDuration !== null) {
  for (let off = 12; off + 8 <= out.length;) {
    const id = out.subarray(off, off + 4).toString("latin1")
    const size = out.readUInt32LE(off + 4)
    if (id === "ANMF") { out.writeUIntLE(setDuration, off + 20, 3); retimed += 1 }
    off += 8 + size + (size % 2)
  }
}

const frames = (buf) => buf.toString("latin1").split("ANMF").length - 1
const durations = (buf) => {
  const list = []
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.subarray(off, off + 4).toString("latin1")
    const size = buf.readUInt32LE(off + 4)
    if (id === "ANMF") list.push(buf.readUIntLE(off + 20, 3))
    off += 8 + size + (size % 2)
  }
  return list
}
const before = { frames: frames(bytes), ms: durations(bytes).reduce((a, b) => a + b, 0), bytes: bytes.length }
const after = { frames: frames(out), ms: durations(out).reduce((a, b) => a + b, 0), bytes: out.length }
/* RIFF 长度字段必须与实际字节数自洽 —— 写错了浏览器会截断或整条不认。 */
if (out.readUInt32LE(4) !== out.length - 8 || after.frames !== before.frames - drop) {
  console.error("motion-trim: self-check failed (RIFF size or frame count) — nothing written")
  process.exit(1)
}
/* 改过时长就逐帧复核一遍：一条播不对的素材在页面上不会报任何错。 */
if (setDuration !== null) {
  const d = durations(out)
  if (retimed !== d.length || d.some((x) => x !== setDuration)) {
    console.error("motion-trim: self-check failed (per-frame duration) — nothing written")
    process.exit(1)
  }
}

if (!dry) writeFileSync(target, out)
console.log(`${dry ? "[dry] " : ""}${target}`)
console.log(`  frames  ${before.frames} -> ${after.frames}   (${drop} dropped)`)
if (retimed > 0) console.log(`  retime  ${retimed} frame(s) -> ${setDuration} ms each  (loop ${((retimed * setDuration) / 1000).toFixed(3)} s)`)
console.log(`  loop    ${before.ms} ms -> ${after.ms} ms`)
console.log(`  bytes   ${(before.bytes / 1024).toFixed(1)} KB -> ${(after.bytes / 1024).toFixed(1)} KB  (-${((before.bytes - after.bytes) / 1024).toFixed(1)} KB)`)
console.log("  接着跑 node tools/motion-seam.mjs 量一遍环缝，再 node build.mjs && node verify-wisp.mjs")