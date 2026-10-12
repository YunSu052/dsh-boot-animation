#!/usr/bin/env node
// 视频转 MP4 工具：把 mkv/webm/HEVC 等浏览器放不了的视频，转成能播的 MP4。
//
// ── 为什么需要转，而不是只换个壳 ────────────────────────────────────────────
// 浏览器（Chromium/Electron）**不支持 HEVC(H.265)**。很多 mkv 正是 H.265，
// 只改封装（-c copy）出来照样播不了，所以必须**真正重编码**成 H.264。
// 转完顺便用 -movflags +faststart 让 moov 落在文件头部 ⇒ 能"边下边播"。
//
// ── 输出两个版本 ──────────────────────────────────────────────────────────
//   原画：保持原始分辨率（画质优先）
//   1080p：缩到 1080 高（体积小得多，日常够用）
// 文件名带标注：`<名字>-原画.mp4` / `<名字>-1080p.mp4`
// 源本来就不高于 1080 时，只出「原画」一个（避免无意义的放大/重复）。
//
// ── 已经是 H.264 的 MP4 ───────────────────────────────────────────────────
// 不需要重编码，只做 faststart 优化（调用同目录的 faststart.mjs）。
//
// 用法：
//   node convert.mjs <文件...> [选项]
// 选项：
//   --orig      只出原画
//   --1080      只出 1080p
//   -y, --yes   覆盖已存在的输出（默认拒绝）
//   -h, --help  帮助
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const useColor = process.stdout.isTTY === true
const paint = (c, s) => (useColor ? `\u001b[${c}m${s}\u001b[0m` : s)
const dim = (s) => paint('2', s)
const bold = (s) => paint('1', s)
const red = (s) => paint('31', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

function fail(msg, code = EXIT_FAIL) {
  console.error(red('✗ ') + msg)
  process.exit(code)
}

const USAGE = `${bold('视频转 MP4')} —— 把浏览器放不了的视频（mkv / HEVC 等）转成能播的 MP4

${bold('用法')}
  node convert.mjs <文件...> [选项]

${bold('输出')}
  默认      <名字>-原画.mp4     保持原分辨率，画质优先
  --1080    <名字>-1080p.mp4    缩到 1080 高，体积小得多
  已经是 H.264 的 MP4 ⇒ 只做 faststart 优化，输出 <名字>-faststart.mp4

${bold('选项')}
  --orig      出原画（默认）
  --1080      出 1080p
  -y, --yes   覆盖已存在的输出（默认拒绝）
  -h, --help  显示本帮助

${bold('画质')}
  H.264 / CRF 18 / preset medium —— 视觉上接近无损。
  音频原样复制（源是 AAC 时）；否则转 AAC 192k。

${bold('提示')}
  两个版本各转一次很费时，所以**一次只转一个**。
  要两个版本，请分别跑两次（两个 .bat 已备好）。
`

/* ---------------------------------------------------------------- 参数解析 */

function parseArgs(argv) {
  // 默认**只出原画**（画质优先）。想只要 1080p 请显式给 --1080。
  const out = { files: [], yes: false, help: false, wantOrig: true, want1080: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { out.help = true; continue }
    if (a === '-y' || a === '--yes') { out.yes = true; continue }
    if (a === '--orig') { out.wantOrig = true; out.want1080 = false; continue }
    if (a === '--1080') { out.wantOrig = false; out.want1080 = true; continue }
    if (a.startsWith('-') && a !== '-') fail(`不认识的选项：${a}\n\n${USAGE}`, EXIT_USAGE)
    out.files.push(a)
  }
  return out
}

/* ------------------------------------------------------------- 找 ffmpeg */

/** 在目录里按深度搜某个文件名；找不到返回 ''。 */
function searchFor(dir, name, depth) {
  if (depth < 0) return ''
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return join(dir, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = searchFor(join(dir, e.name), name, depth - 1)
      if (hit !== '') return hit
    }
  }
  return ''
}

function findFfmpeg() {
  // 1) 本脚本旁边（最独立）
  for (const p of [join(HERE, 'ffmpeg.exe'), join(HERE, 'bin', 'ffmpeg.exe')]) {
    if (existsSync(p)) return p
  }
  // 2) 常见安装位置（winget 装到 C:\Programs\ffmpeg 或 D:\Programs\ffmpeg）
  for (const root of ['C:\\Programs\\ffmpeg', 'D:\\Programs\\ffmpeg', 'C:\\ffmpeg', 'D:\\ffmpeg']) {
    if (!existsSync(root)) continue
    const hit = searchFor(root, 'ffmpeg.exe', 4)
    if (hit !== '') return hit
  }
  // 3) PATH（spawnSync 会自己找）
  return 'ffmpeg'
}

const ffmpeg = findFfmpeg()
const ffprobe = ffmpeg === 'ffmpeg'
  ? 'ffprobe'
  : join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

/* ---------------------------------------------------------------- 探测 */

/** 用 ffprobe 读流信息；失败返回 null。 */
function probe(file) {
  const r = spawnSync(ffprobe, [
    '-v', 'error', '-print_format', 'json',
    '-show_streams', '-show_format', file,
  ], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

/** 源音频能不能直接复制进 mp4（不能就转 AAC）。 */
function audioArgs(info) {
  const a = (info.streams ?? []).find((s) => s.codec_type === 'audio')
  if (!a) return ['-an']                                  // 没音轨
  const copyable = ['aac', 'mp3', 'ac3', 'eac3', 'alac']
  if (copyable.includes(String(a.codec_name))) return ['-c:a', 'copy']
  return ['-c:a', 'aac', '-b:a', '192k']
}

/* ---------------------------------------------------------------- 执行 */

function run(label, args) {
  console.log('')
  console.log(bold('▶ ' + label))
  const r = spawnSync(ffmpeg, args, { stdio: 'inherit' })
  return r.status === 0
}

function exists(p) {
  try { return statSync(p).isFile() } catch { return false }
}

/* ---------------------------------------------------------------- 主流程 */

const args = parseArgs(process.argv.slice(2))
if (args.help) { process.stdout.write(USAGE); process.exit(EXIT_OK) }
if (args.files.length === 0) fail(`缺少输入文件。\n\n${USAGE}`, EXIT_USAGE)

// ffmpeg 可用性检查（一次就够，避免每个文件都失败一遍）
{
  const r = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' })
  if (r.status !== 0) {
    fail(
      `找不到可用的 ffmpeg。\n` +
      `  装法一：winget install --id BtbN.FFmpeg.GPL -e\n` +
      `  装法二：把 ffmpeg.exe 放到本脚本旁边\n` +
      `  下载地址 https://github.com/BtbN/FFmpeg-Builds/releases （选 win64-gpl 的 zip）`,
    )
  }
}

let totalOk = 0
let totalFail = 0

for (const raw of args.files) {
  const inPath = resolve(raw)
  console.log('')
  console.log('='.repeat(64))
  console.log('  ' + basename(inPath))
  console.log('='.repeat(64))

  if (!exists(inPath)) { console.log(red('✗ ') + '文件不存在，跳过'); totalFail += 1; continue }

  const info = probe(inPath)
  if (info === null) { console.log(red('✗ ') + 'ffprobe 读不了这个文件，跳过'); totalFail += 1; continue }

  const v = (info.streams ?? []).find((s) => s.codec_type === 'video')
  if (v === undefined) { console.log(red('✗ ') + '没有视频流，跳过'); totalFail += 1; continue }

  const codec = String(v.codec_name)
  const height = Number(v.height) || 0
  const width = Number(v.width) || 0
  const dur = Number(info.format?.duration) || 0
  console.log(`  ${dim('编码')} ${codec}   ${dim('分辨率')} ${width}x${height}   ${dim('时长')} ${dur.toFixed(1)}s`)

  const base = join(dirname(inPath), basename(inPath, extname(inPath)))

  // ---- 已经是 H.264 的 MP4：只做 faststart（不重编码）----
  if (codec === 'h264') {
    const fsTool = join(HERE, 'faststart.mjs')
    if (!exists(fsTool)) { console.log(red('✗ ') + '同目录缺少 faststart.mjs'); totalFail += 1; continue }
    const a = [fsTool, inPath]
    if (args.yes) a.push('-y')
    const r = spawnSync(process.execPath, a, { stdio: 'inherit' })
    if (r.status === 0) totalOk += 1; else totalFail += 1
    continue
  }

  // ---- 需要重编码 ----
  console.log(yellow('! ') + `${codec} 浏览器放不了 ⇒ 转成 H.264`)
  const aArgs = audioArgs(info)
  // **一次只出一个版本**（两个都转很费时，让用户自己选）。
  const targets = []
  if (args.want1080) {
    targets.push({ tag: '1080p', vf: 'scale=-2:1080:flags=lanczos', h: 1080 })
  } else {
    targets.push({ tag: '原画', vf: null, h: height })
  }

  for (const t of targets) {
    const outPath = `${base}-${t.tag}.mp4`
    if (exists(outPath) && !args.yes) {
      console.log(red('✗ ') + `已存在（要覆盖请加 -y）：${outPath}`)
      totalFail += 1
      continue
    }
    const cmd = [
      '-hide_banner', '-nostdin', '-y',
      '-i', inPath,
      // 只取第一条视频 + 第一条音频：mkv 里的字幕/附件 mp4 装不下，丢掉免得报错
      '-map', '0:v:0', '-map', '0:a:0?',
      ...(t.vf === null ? [] : ['-vf', t.vf]),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      ...aArgs,
      '-movflags', '+faststart',        // moov 放头部 ⇒ 能边下边播
      outPath,
    ]
    const label = `${t.tag}${t.vf === null ? '（保持 ' + width + 'x' + height + '）' : '（缩到 ' + t.h + 'p）'} → ${basename(outPath)}`
    if (run(label, cmd)) {
      const sz = exists(outPath) ? (statSync(outPath).size / 1048576).toFixed(1) : '?'
      console.log(green('✓ ') + `完成 ${sz} MB`)
      totalOk += 1
    } else {
      console.log(red('✗ ') + '转码失败')
      totalFail += 1
    }
  }
}

console.log('')
console.log('='.repeat(64))
console.log(`  完成：成功 ${totalOk} 个，失败 ${totalFail} 个`)
console.log('='.repeat(64))
console.log('')
console.log('  输出就在原视频旁边，文件名带「原画」或「1080p」标注。')
console.log('  原视频没有被改动。')
process.exit(totalFail > 0 ? EXIT_FAIL : EXIT_OK)
