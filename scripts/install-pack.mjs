#!/usr/bin/env node
/**
 * 记忆包命令行：换电脑 / UI 有问题时的兜底路径。
 *
 * 用法：
 *   node scripts/install-pack.mjs list
 *   node scripts/install-pack.mjs elysia                  # 安装（会先问一次 y/N）
 *   node scripts/install-pack.mjs elysia --yes            # 不问，直接装
 *   node scripts/install-pack.mjs elysia --uninstall      # 卸载（从备份恢复）
 *   node scripts/install-pack.mjs elysia --preview        # 只看内容
 *   node scripts/install-pack.mjs elysia --status         # 看装没装
 *
 * 记忆文件位置：默认跟插件运行时一致（~/.dsh/dsh-shared-memory/MEMORY.md + 另一块盘的镜像）。
 * 也可以用 --primary / --mirror 显式指定。
 *
 * 只用 node 内置模块，直接操作 store，不依赖 DSH 运行时。
 */

import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

import { MemoryStore, SECTIONS } from '../lib/store.js'
import { listPacks, packStatus, previewPack, installPack, uninstallPack, packsDir, backupRoot, statePath } from '../lib/packs.js'

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/** 和 index.js 的 pickMirrorPath 同逻辑：找一块跟主文件不同盘符的盘 */
function pickMirrorPath(primaryPath) {
  const primaryRoot = path.parse(path.resolve(primaryPath)).root.toUpperCase()
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    const root = `${letter}:\\`
    if (root.toUpperCase() === primaryRoot) continue
    try {
      if (existsSync(root)) return path.join(`${letter}:\\`, 'dsh-shared-memory', 'MEMORY.md')
    } catch {
      /* 跳过不可用盘符 */
    }
  }
  return ''
}

function parseArgs(argv) {
  const out = { _: [], flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out.values[key] = next
        i += 1
      } else {
        out.flags.add(key)
      }
    } else {
      out._.push(token)
    }
  }
  return out
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(String(answer ?? '').trim().toLowerCase())
    })
  })
}

function fmt(text) {
  return `  ${text}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const primary = args.values.primary
    ? path.resolve(args.values.primary)
    : path.join(dshHome(), 'dsh-shared-memory', 'MEMORY.md')
  const mirror = args.values.mirror !== undefined
    ? (args.values.mirror ? path.resolve(args.values.mirror) : '')
    : pickMirrorPath(primary)

  const store = new MemoryStore({
    primaryPath: primary,
    mirrorPath: mirror,
    logger: { info() {}, warn(m) { console.log(`[warn] ${m}`) }, error() {} }
  })
  await store.init()

  const cmd = args._[0] ?? 'list'

  if (cmd === 'list') {
    const packs = listPacks()
    const status = await packStatus(store)
    console.log(`packs 目录：${packsDir()}`)
    console.log(`记忆文件：${store.primaryPath}${store.mirrorPath ? `  ⇄  ${store.mirrorPath}` : '（无镜像）'}`)
    console.log('')
    if (!packs.length) {
      console.log('没有可用的记忆包。')
      return 0
    }
    for (const pack of packs) {
      const st = status.packs.find((p) => p.id === pack.id)
      const mark = st?.installed ? (st.fullyInstalled ? '已安装' : '部分已安装') : '未安装'
      console.log(`· ${pack.id}  ${pack.name} v${pack.version}  【${mark}】`)
      if (pack.description) console.log(fmt(pack.description))
      console.log(fmt(`identity ${pack.sections.identity?.chars ?? 0} 字 · persona ${pack.sections.persona?.chars ?? 0} 字`))
    }
    console.log('')
    console.log(`备份目录：${status.backupRoot}`)
    console.log(`状态文件：${status.statePath}`)
    return 0
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('用法：node scripts/install-pack.mjs <list|包id> [--yes] [--uninstall] [--preview] [--status]')
    return 0
  }

  const id = cmd

  if (args.flags.has('preview')) {
    const pv = await previewPack(id)
    console.log(`${pv.name} v${pv.version}`)
    if (pv.description) console.log(pv.description)
    for (const [name, info] of Object.entries(pv.preview)) {
      console.log('')
      console.log(`=== ${name}（${info.chars} 字${info.truncated ? '，只显示前 2000 字' : ''}）===`)
      if (info.chapters.length) console.log(`章节：${info.chapters.join(' / ')}`)
      console.log('')
      console.log(info.head)
      if (info.truncated) console.log('…（已截断）')
    }
    return 0
  }

  if (args.flags.has('status')) {
    const status = await packStatus(store)
    const st = status.packs.find((p) => p.id === id)
    if (!st) {
      console.error(`没有这个记忆包：${id}`)
      return 1
    }
    console.log(`${st.id}  ${st.name} v${st.version}：${st.installed ? (st.fullyInstalled ? '已安装' : '部分已安装') : '未安装'}`)
    for (const [name, info] of Object.entries(st.sections)) {
      if (!info.available) continue
      const state = info.installed ? '与包一致' : info.isDefault ? '默认占位' : info.customized ? '用户自定义内容' : '未知'
      console.log(fmt(`${name}: ${info.currentChars} 字 · ${state}`))
    }
    if (st.record?.installedAt) console.log(fmt(`安装于 ${st.record.installedAt}`))
    if (st.record?.backupDir) console.log(fmt(`备份 ${st.record.backupDir}`))
    return 0
  }

  if (args.flags.has('uninstall')) {
    const status = await packStatus(store)
    const st = status.packs.find((p) => p.id === id)
    if (!st) {
      console.error(`没有这个记忆包：${id}`)
      return 1
    }
    if (!args.flags.has('yes')) {
      const answer = await ask(
        `将从备份恢复 identity / persona（包 ${id}），继续？[y/N] `
      )
      if (answer !== 'y' && answer !== 'yes') {
        console.log('已取消。')
        return 0
      }
    }
    const r = await uninstallPack(store, id)
    console.log(r.message)
    return 0
  }

  /* 默认动作：安装 */
  const statusBefore = await packStatus(store)
  const st = statusBefore.packs.find((p) => p.id === id)
  if (!st) {
    console.error(`没有这个记忆包：${id}`)
    console.error(`可用：${statusBefore.packs.map((p) => p.id).join('、') || '（无）'}`)
    return 1
  }

  console.log(`${st.name} v${st.version}`)
  for (const [name, info] of Object.entries(st.sections)) {
    if (!info.available) continue
    console.log(
      fmt(`${name}: ${info.currentChars} 字 → ${info.packChars} 字` + (info.isDefault ? '（当前是默认占位）' : '（会覆盖现有内容，安装前自动备份）'))
    )
  }
  console.log(fmt(`记忆文件：${store.primaryPath}${store.mirrorPath ? `  ⇄  ${store.mirrorPath}` : ''}`))
  console.log(fmt(`其它 ${SECTIONS.length - 2} 个分区不会被碰`))

  if (!args.flags.has('yes')) {
    const answer = await ask('继续安装？[y/N] ')
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。')
      return 0
    }
  }

  const r = await installPack(store, id, { confirm: true })
  console.log('')
  console.log(r.message)
  if (r.backupDir) console.log(`备份：${r.backupDir}`)
  const after = await packStatus(store)
  const now = after.packs.find((p) => p.id === id)
  console.log(`安装后：identity ${now?.sections.identity.currentChars ?? '?'} 字 · persona ${now?.sections.persona.currentChars ?? '?'} 字`)
  console.log('')
  console.log('重启 DSH 后完全生效。卸载：node scripts/install-pack.mjs ' + id + ' --uninstall')
  return 0
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    console.error(`失败：${error?.message ?? error}`)
    process.exit(1)
  })
