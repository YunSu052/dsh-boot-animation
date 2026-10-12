#!/usr/bin/env node
// MP4 faststart 重封装：把 moov（索引）从文件尾部搬到 mdat（数据）**前面**。
//
// ── 为什么需要 ─────────────────────────────────────────────────────────────
// moov 是索引（每一帧在哪），mdat 是数据。播放器**必须先读到 moov** 才知道去哪找帧。
// 很多导出工具把 moov 写在尾部 ⇒ 浏览器得把整个文件下完才能出首帧。
// 搬到前面后，开头几百 KB 就能解出画面 —— 这是"开机瞬间就该看到视频"的前提。
//
// ── 关键点（漏了会坏文件）─────────────────────────────────────────────────
// mdat 一移动，moov 里 stco/co64 记录的**块绝对偏移**就全错了，必须同步加上位移量。
// 漏掉这一步 = 文件能解析但画面全花或播不出来。本工具会修正它，并在写完后**自校验**。
//
// ── 用法 ──────────────────────────────────────────────────────────────────
//   node tools/faststart.mjs <输入.mp4> [选项]
//   node tools/faststart.mjs <输入.mp4> [输出.mp4] [选项]
//
// 选项：
//   -o, --out <路径>   指定输出路径（等价于第二个位置参数）
//   -y, --yes          输出已存在时允许覆盖（**默认拒绝**，不赌你的文件）
//       --no-color     纯文本输出（重定向到文件时自动如此）
//   -h, --help         显示帮助
//
// 退出码：0 = 成功或无需处理 / 1 = 处理失败 / 2 = 用法错误
//
// ⚠ 安全承诺：**永不写入输入路径**；输出先写临时文件、校验通过才改名；
//    校验不通过就删掉临时文件并报错（绝不留下坏产物）。
import { open, stat, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

/* ------------------------------------------------------------------ 输出样式 */

const useColor = process.stdout.isTTY === true && !process.argv.includes('--no-color')
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const dim = (s) => paint('2', s)
const bold = (s) => paint('1', s)
const red = (s) => paint('31', s)
const green = (s) => paint('32', s)

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

/** 失败退出：一句人话 + 退出码，**不甩栈**。 */
function fail(message, code = EXIT_FAIL) {
  console.error(red('✗ ') + message)
  process.exit(code)
}

const USAGE = `${bold('MP4 faststart 重封装')} —— 把索引(moov)搬到数据(mdat)前面，让视频能"边下边播"

${bold('用法')}
  node tools/faststart.mjs <输入.mp4> [选项]
  node tools/faststart.mjs <输入.mp4> [输出.mp4] [选项]

${bold('选项')}
  -o, --out <路径>   指定输出路径（等价于第二个位置参数）
  -y, --yes          输出已存在时允许覆盖（默认拒绝）
      --no-color     纯文本输出
  -h, --help         显示本帮助

${bold('输出')}
  默认写同目录的 <名字>-faststart.mp4，**绝不覆盖输入文件**。
  先写临时文件、自校验通过才改名；校验失败会删掉临时文件。

${bold('退出码')}
  0 = 成功或无需处理   1 = 处理失败   2 = 用法错误

${bold('例子')}
  node tools/faststart.mjs D:\\videos\\kt.mp4
  node tools/faststart.mjs kt.mp4 -o kt-opt.mp4 -y
`

/* ---------------------------------------------------------------- 参数解析 */

function parseArgs(argv) {
  const out = { input: '', output: '', yes: false, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { out.help = true; continue }
    if (a === '-y' || a === '--yes') { out.yes = true; continue }
    if (a === '--no-color') continue                    // 已在上面读掉
    if (a === '-o' || a === '--out') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) fail(`${a} 后面要跟一个输出路径`, EXIT_USAGE)
      out.output = v
      i += 1
      continue
    }
    if (a.startsWith('-') && a !== '-') fail(`不认识的选项：${a}\n\n${USAGE}`, EXIT_USAGE)
    positional.push(a)
  }
  out.input = positional[0] ?? ''
  // 位置参数给了输出、同时 -o 也给了 ⇒ 冲突要说出来，别默默选一个
  if (positional[1] !== undefined) {
    if (out.output !== '') fail('输出路径给了两次（位置参数 + -o），请只保留一个', EXIT_USAGE)
    out.output = positional[1]
  }
  if (positional.length > 2) fail(`多余的参数：${positional.slice(2).join(' ')}`, EXIT_USAGE)
  return out
}

/* -------------------------------------------------------------- MP4 box 解析 */

const u32 = (b, o) => b.readUInt32BE(o)
const u64 = (b, o) => Number(b.readBigUInt64BE(o))

/**
 * 解析一层 box。容错：遇到非法 size 就停下（返回已解析部分），绝不抛。
 * @returns {Promise<Array<{type:string, offset:number, size:number, headerSize:number, contentOffset:number}>>}
 */
async function readBoxes(fh, start, end) {
  const list = []
  let off = start
  const head = Buffer.alloc(16)
  while (off + 8 <= end) {
    const n = (await fh.read(head, 0, 16, off)).bytesRead
    if (n < 8) break
    let size = u32(head, 0)
    const type = head.toString('latin1', 4, 8)
    let headerSize = 8
    if (size === 1) {
      if (n < 16) break
      size = u64(head, 8)
      headerSize = 16
    } else if (size === 0) {
      size = end - off                                  // 一直到文件结尾
    }
    if (size < headerSize || off + size > end) break
    list.push({ type, offset: off, size, headerSize, contentOffset: off + headerSize })
    off += size
  }
  return list
}

/**
 * 在 moov 里递归找 stco / co64（位于 trak>mdia>minf>stbl 下）。
 * 只走容器 box，不盲目全文件扫描 —— 免得把 mdat 里的随机字节当 box 头。
 */
const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf',
])
async function findChunkTables(fh, start, end, acc = []) {
  for (const b of await readBoxes(fh, start, end)) {
    if (b.type === 'stco' || b.type === 'co64') acc.push(b)
    else if (CONTAINERS.has(b.type)) await findChunkTables(fh, b.contentOffset, b.offset + b.size, acc)
  }
  return acc
}

/* ------------------------------------------------------------------ 流式拷贝 */

/** 分块把 [start, start+len) 从 src 抄到 dst 的 pos 位置；内存占用恒定为 chunk 大小。 */
async function copyRange(srcFh, dstFh, start, len, pos, chunkSize = 8 * 1024 * 1024) {
  const buf = Buffer.alloc(Math.min(chunkSize, Math.max(1, len)))
  let done = 0
  while (done < len) {
    const want = Math.min(buf.length, len - done)
    const { bytesRead } = await srcFh.read(buf, 0, want, start + done)
    if (bytesRead <= 0) throw new Error(`读取意外结束（已抄 ${done}/${len} 字节）`)
    await dstFh.write(buf, 0, bytesRead, pos + done)
    done += bytesRead
  }
}

/* -------------------------------------------------------------------- 主流程 */

const args = parseArgs(process.argv.slice(2))
if (args.help) { process.stdout.write(USAGE); process.exit(EXIT_OK) }
if (args.input === '') fail(`缺少输入文件。\n\n${USAGE}`, EXIT_USAGE)

const inPath = resolve(args.input)
let st
try {
  st = await stat(inPath)
} catch {
  fail(`输入文件不存在或读不到：${inPath}`)
}
if (!st.isFile()) fail(`输入不是一个文件：${inPath}`)

const outPath = args.output !== ''
  ? resolve(args.output)
  : join(dirname(inPath), `${basename(inPath, extname(inPath))}-faststart.mp4`)

if (outPath === inPath) fail('输出路径和输入相同 —— 本工具绝不覆盖输入文件，请换一个输出路径')

// 输出已存在 ⇒ **默认拒绝**（不赌用户的文件）。要覆盖必须显式 -y。
if (!args.yes) {
  let exists = false
  try { await stat(outPath); exists = true } catch { /* 不存在才好 */ }
  if (exists) {
    fail(`输出文件已存在：${outPath}\n  要覆盖请加 -y，或换一个输出路径。`)
  }
}

const src = await open(inPath, 'r')
let tops
try {
  tops = await readBoxes(src, 0, st.size)
} catch (error) {
  await src.close()
  fail(`读取文件结构失败：${String(error?.message ?? error)}`)
}

const mdat = tops.find((b) => b.type === 'mdat')
const moov = tops.find((b) => b.type === 'moov')

// 不是 MP4（比如 mkv/webm 改名成 .mp4）⇒ 说清原因，别让人以为是"工具坏了"
if (mdat === undefined || moov === undefined) {
  await src.close()
  const missing = [mdat === undefined ? 'mdat' : '', moov === undefined ? 'moov' : ''].filter(Boolean).join(' 和 ')
  fail(
    `这不是可重封装的 MP4：缺 ${missing}。\n` +
    `  常见原因：文件其实是别的容器（如 .mkv / .webm / .avi）只是改了扩展名。\n` +
    `  本工具只处理真正的 MP4（ISO BMFF）。`,
  )
}

if (moov.offset < mdat.offset) {
  await src.close()
  console.log(green('✓ ') + `已经是 faststart（moov@${moov.offset} 在 mdat@${mdat.offset} 之前）⇒ 无需处理。`)
  process.exit(EXIT_OK)
}

// 新布局：mdat/moov 之外的 box 保持原相对顺序，然后 moov，最后 mdat
const before = tops.filter((b) => b.type !== 'mdat' && b.type !== 'moov')
const newMdatOffset = [...before, moov].reduce((a, b) => a + b.size, 0)
const delta = newMdatOffset - mdat.offset

// ① 修正 moov 里的块偏移表（在内存里改 moov 的副本；moov 很小，通常几十 KB）
const moovBuf = Buffer.alloc(moov.size)
await src.read(moovBuf, 0, moov.size, moov.offset)
const tables = await findChunkTables(src, moov.contentOffset, moov.offset + moov.size)

let patched = 0
for (const t of tables) {
  const rel = t.contentOffset - moov.offset
  const count = u32(moovBuf, rel + 4)
  const entrySize = t.type === 'co64' ? 8 : 4
  for (let i = 0; i < count; i += 1) {
    const p = rel + 8 + i * entrySize
    if (p + entrySize > moovBuf.length) break
    if (entrySize === 8) moovBuf.writeBigUInt64BE(BigInt(u64(moovBuf, p) + delta), p)
    else moovBuf.writeUInt32BE(u32(moovBuf, p) + delta, p)
    patched += 1
  }
}

// ② 写临时文件（原子写）：全部写完并校验通过才改名成正式输出
const tmpPath = `${outPath}.tmp-${process.pid}`
const dst = await open(tmpPath, 'w')
try {
  let pos = 0
  for (const b of before) {
    await copyRange(src, dst, b.offset, b.size, pos)
    pos += b.size
  }
  await dst.write(moovBuf, 0, moovBuf.length, pos)
  pos += moovBuf.length
  // mdat：头 8/16 字节原样，其后是纯数据；这里**分块流式**拷贝，不整块进内存
  const mdatHead = Buffer.alloc(mdat.headerSize)
  await src.read(mdatHead, 0, mdat.headerSize, mdat.offset)
  await dst.write(mdatHead, 0, mdatHead.length, pos)
  pos += mdatHead.length
  await copyRange(src, dst, mdat.contentOffset, mdat.size - mdat.headerSize, pos)
  pos += mdat.size - mdat.headerSize
  await dst.close()
} catch (error) {
  await dst.close().catch(() => {})
  await src.close().catch(() => {})
  await unlink(tmpPath).catch(() => {})                 // 绝不留下半成品
  fail(`写入失败（已清理临时文件）：${String(error?.message ?? error)}`)
}

// ③ 写后自校验：重扫产物的 box 结构 + 抽查块偏移是否都落在新 mdat 内。
//    这是最后一道闸 —— 校验不过就删掉产物，绝不留下一个"能解析但播不出来"的文件。
const problems = []
try {
  const chk = await open(tmpPath, 'r')
  try {
    const chkStat = await chk.stat()
    const chkTops = await readBoxes(chk, 0, chkStat.size)
    const cMdat = chkTops.find((b) => b.type === 'mdat')
    const cMoov = chkTops.find((b) => b.type === 'moov')
    if (cMoov === undefined || cMdat === undefined) problems.push('产物缺少 moov 或 mdat')
    if (cMoov !== undefined && cMdat !== undefined && cMoov.offset > cMdat.offset) {
      problems.push('moov 仍在 mdat 之后（搬运未生效）')
    }
    if (chkStat.size !== st.size) problems.push(`产物大小与输入不一致（${chkStat.size} vs ${st.size}）`)
    if (cMoov !== undefined && cMdat !== undefined) {
      const cBuf = Buffer.alloc(cMoov.size)
      await chk.read(cBuf, 0, cMoov.size, cMoov.offset)
      const cTables = await findChunkTables(chk, cMoov.contentOffset, cMoov.offset + cMoov.size)
      let checked = 0
      let bad = 0
      for (const t of cTables) {
        const rel = t.contentOffset - cMoov.offset
        const count = u32(cBuf, rel + 4)
        const entrySize = t.type === 'co64' ? 8 : 4
        for (let i = 0; i < count; i += 1) {
          const p = rel + 8 + i * entrySize
          if (p + entrySize > cBuf.length) break
          const v = entrySize === 8 ? u64(cBuf, p) : u32(cBuf, p)
          checked += 1
          if (v < cMdat.offset || v >= cMdat.offset + cMdat.size) bad += 1
        }
      }
      if (bad > 0) problems.push(`有 ${bad}/${checked} 条块偏移落在 mdat 之外（索引会错）`)
    }
  } finally {
    await chk.close()
  }
} catch (error) {
  problems.push(`自校验读不了产物：${String(error?.message ?? error)}`)
}

if (problems.length > 0) {
  await src.close().catch(() => {})
  await unlink(tmpPath).catch(() => {})
  fail(`自校验未通过，已删除产物（输入文件未受影响）：\n  - ${problems.join('\n  - ')}`)
}

// ④ 校验通过 ⇒ 原子改名成正式输出
await src.close()
try {
  await rename(tmpPath, outPath)
} catch (error) {
  await unlink(tmpPath).catch(() => {})
  fail(`改名失败（已清理临时文件）：${String(error?.message ?? error)}`)
}

console.log(green('✓ ') + '完成（输入文件未改动）')
console.log(`  ${dim('输入')}  ${inPath}  ${(st.size / 1048576).toFixed(2)} MB`)
console.log(`  ${dim('输出')}  ${outPath}`)
console.log(`  ${dim('moov')}  ${moov.offset} → ${newMdatOffset - moov.size}（移到 mdat 之前）`)
console.log(`  ${dim('mdat')}  ${mdat.offset} → ${newMdatOffset}（位移 ${delta >= 0 ? '+' : ''}${delta} 字节）`)
console.log(`  ${dim('修正')}  块偏移 ${patched} 条，自校验通过`)
process.exit(EXIT_OK)
