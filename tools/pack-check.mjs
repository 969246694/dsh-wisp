/* ============================================================================
   pack-check.mjs — 打包自足性检查：`npm pack` → 解包 → **从解出的副本**跑预检与重建。

   为什么需要它：「这个包能不能被别人装走」不能靠"我看过 files[] 了"来回答 ——
   文档指向包外、tools/ 少声明一个、素材没打进去，全都要真的解出副本才暴露。
   （这个检查第一次跑就抓到了 README 里指向开发机绝对路径的死引用。）

   RUN
     node tools/pack-check.mjs

   npm 与 tar 都是可选依赖：找不到就以 0 退出并说明原因。
   ========================================================================== */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: isWin, ...opts })

if (run(npm, ['--version']).status !== 0) {
  console.log('pack-check: 未找到 npm —— 跳过打包检查（这不是失败）')
  process.exit(0)
}

let failures = 0
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

const work = mkdtempSync(join(tmpdir(), 'wisp-pack-'))
try {
  console.log('== 打包 ==')
  const packed = run(npm, ['pack', '--pack-destination', work], { cwd: here })
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'))
  check(packed.status === 0 && tgz !== undefined, 'npm pack succeeds',
    tgz ?? String(packed.stderr ?? '').slice(0, 160))
  if (!tgz) { process.exit(1) }
  check(statSync(join(work, tgz)).size > 1024, 'the tarball is not empty',
    `${Math.round(statSync(join(work, tgz)).size / 1024)} KB`)

  console.log('\n== 解包 ==')
  const extract = join(work, 'x')
  mkdirSync(extract, { recursive: true })
  const untar = run('tar', ['-xzf', join(work, tgz), '-C', extract])
  check(untar.status === 0, 'tar extracts the tarball', String(untar.stderr ?? '').slice(0, 160))
  const root = join(extract, 'package')
  check(existsSync(join(root, 'package.json')), 'it extracts to a package root', root)
  if (!existsSync(join(root, 'package.json'))) { process.exit(1) }

  console.log('\n== 发布子集是否自足 ==')
  for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'assets']) {
    check(existsSync(join(root, required)), `${required} ships`, '')
  }

  console.log('\n== 从解出的副本跑预检 ==')
  const verify = run('node', [join(root, 'verify-wisp.mjs')])
  const passed = (String(verify.stdout ?? '').match(/^\s+PASS/gm) ?? []).length
  const failed = (String(verify.stdout ?? '').match(/^\s+FAIL/gm) ?? []).length
  check(verify.status === 0 && failed === 0 && passed > 0,
    'the published subset verifies on its own', `${passed} passed, ${failed} failed`)

  console.log('\n== 从解出的副本重建 ==')
  const build = run('node', [join(root, 'build.mjs')])
  const inlined = (String(build.stdout ?? '').match(/base64 inlined\s+([\d.]+) KB/) ?? [])[1]
  check(build.status === 0, 'the shipped art is enough to rebuild the bundle',
    inlined ? `${inlined} KB inlined` : String(build.stderr ?? '').slice(0, 160))

  console.log(`\n${failures === 0 ? '=== PACK OK ===' : '=== PACK FAILED ==='}`)
  process.exit(failures === 0 ? 0 : 1)
} finally {
  rmSync(work, { recursive: true, force: true })
}
