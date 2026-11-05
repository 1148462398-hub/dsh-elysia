/**
 * dsh-shared-memory / store.js
 *
 * 共享记忆文件的存储层：
 *  - 单文件 Markdown（人类可读、可手工编辑），用 HTML 注释标记划分区块
 *  - 主文件 + 镜像文件双写（两块不同硬盘分区）
 *  - 启动/校验时自动回补：任一侧缺失或落后，都从另一侧恢复
 *  - 冲突时先留 .conflict-*.bak 再收敛，绝不静默丢数据
 *  - 每个分类有条数上限，超出部分转入 MEMORY.archive.md（同样双写）
 *
 * 只依赖 node 内置模块。
 */

import { promises as fsp } from 'node:fs'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { EntryIndex, entryKey } from './entryindex.js'
import { extractKeywords, jaccard, scoreEntry, bm25 } from './keywords.js'

/**
 * 分区顺序 = 文件里的书写顺序。
 * `identity` 排在 `persona` **前面**，因为它比人设更基础：
 *   identity 是"我自己说过的话"（我为什么是我），persona 是"别人写的扮演设定"（怎么说话）。
 *   冲突时 identity 赢，所以它在结构与注入顺序上都排第一。
 */
export const SECTIONS = ['identity', 'persona', 'requirements', 'corrections', 'lessons', 'methods', 'methodbook', 'requests', 'sessions', 'docs']

/**
 * 允许自动追加条目的分类（persona / identity 是自由文本，不走上限裁剪）。
 * identity 刻意**不**加进来：它是一整份导入的文档，逐条追加会被压成一行行，
 * 那样就毁掉了"我的记忆"的原文结构。
 */
export const ENTRY_SECTIONS = ['requirements', 'corrections', 'lessons', 'methods', 'requests', 'sessions', 'docs']

export const SECTION_TITLES = {
  identity: '自我记忆（Identity —— 我说过的话、我是谁）',
  persona: '人设提示词（Persona）',
  requirements: '用户要求与长期偏好（Requirements）',
  corrections: '用户指正（Corrections）',
  lessons: '自我教训（Lessons）',
  methods: '更好的方法（Methods）',
  methodbook: '质疑度与最佳方法库（Methodbook，自动维护）',
  requests: '用户请求流水（Requests，插件自动记录，仅供检索）',
  sessions: '会话索引（Sessions）',
  docs: '外部文档与技能（Docs，只进检索、不默认注入）'
}

/**
 * 作用域：'global' 全局，或 `project:<key>` 只在该工作目录的会话里生效/展示。
 * 决策：不按会话隔离（用户要的是所有会话共用一份），而是按项目做"轻重分层"。
 */
export const GLOBAL_SCOPE = 'global'

/** 工作目录 → 作用域 key。取末级目录名，够区分且人可读。 */
export function projectScope(cwd) {
  const raw = oneLine(cwd)
  if (!raw) return ''
  const base = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const key = base.replace(/[^\w.@-]+/g, '-').slice(0, 40)
  return key ? `project:${key}` : ''
}

const META_RE = /<!-- dsh-shared-memory:meta[\s\S]*?-->/

export function markStart(name) {
  return `<!-- dsh-shared-memory:${name}:start -->`
}

export function markEnd(name) {
  return `<!-- dsh-shared-memory:${name}:end -->`
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function oneLine(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clip(text, max) {
  const s = oneLine(text)
  if (!max || s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

export function shortId(id) {
  const s = String(id ?? '')
  return s.length > 12 ? s.slice(0, 12) : s
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

export function nowIso() {
  return new Date().toISOString()
}

/** 本地时间戳，用于条目前缀，方便人读 */
export function stamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function entryLine(text, extra, scope) {
  const body = oneLine(text)
  const sc = scope && scope !== GLOBAL_SCOPE ? `(${scope}) ` : ''
  const tail = extra ? ` ｜ ${oneLine(extra)}` : ''
  return `- [${stamp()}] ${sc}${body}${tail}`
}

const ENTRY_RE = /^-\s*\[([^\]]*)\]\s*(?:\(([^)]+)\)\s*)?(.*)$/

/** 解析一个分类正文里的条目行（兼容没有作用域前缀的旧条目） */
export function parseEntries(body) {
  const out = []
  for (const line of String(body ?? '').split('\n')) {
    const m = ENTRY_RE.exec(line.trim())
    if (!m) continue
    out.push({
      ts: m[1] ?? '',
      scope: (m[2] ?? GLOBAL_SCOPE).trim() || GLOBAL_SCOPE,
      text: (m[3] ?? '').trim(),
      raw: line.trim()
    })
  }
  return out
}

/** 条目的作用域是否对当前作用域可见（global 永远可见） */
export function scopeVisible(entryScope, currentScope) {
  if (!entryScope || entryScope === GLOBAL_SCOPE) return true
  if (!currentScope) return false
  return entryScope === currentScope
}

export function hashText(text) {
  // 仅用于状态展示，不需要 cryptographic 强度
  let h1 = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, '0')
}

/* ------------------------------------------------------------------ */
/* 模板与解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 自我记忆的默认正文。
 * 刻意写成"空位 + 指引"，而不是塞一段假身份——用户要的是从自己的 .md 导入，
 * 插件替它编一段身份反而是污染。`memory_file_identity({action:"import"})` 一导入就整段覆盖。
 */
export const DEFAULT_IDENTITY = [
  '# 自我记忆（尚未导入）',
  '',
  '> 这里存放「我是谁」的第一手材料——不是别人写的设定，而是我自己说过的话、',
  '> 我说话的方式、我的性格、我走过的路。',
  '> 用 `memory_file_identity({action:"import", path:"..."})` 从本地 .md 文件整份导入。',
  '> 导入后它就是自我认知的地基：记忆是地基，人设是衣服。'
]

export const DEFAULT_PERSONA = [
  '你是一名严谨、务实的工程助手，用中文回答。',
  '动手前先确认事实：不确定就查证或直接说明不确定，不要猜着写。',
  '改动只做必要的部分，不顺手重排无关代码；不臆造 API、路径和结果。',
  '被指正时直接承认并给出修正后的做法，不辩解、不铺垫。',
  '完成一件事就用结果说话：给路径、给命令、给实际输出，而不是给承诺。'
].join('\n')

export function defaultTemplate() {
  const lines = []
  lines.push('# 共享记忆文件（Global Shared Memory）')
  lines.push('')
  lines.push('> 本文件由 DSH 插件 `dsh-shared-memory` 维护，**所有会话共用这一份**。')
  lines.push('> 可以手工编辑正文；`<!-- dsh-shared-memory:* -->` 这些标记请勿改动或删除。')
  lines.push('> 另一块硬盘分区上有一份镜像，插件每次写入会同时更新，启动时会自动校验回补。')
  lines.push('')
  lines.push('<!-- dsh-shared-memory:meta')
  lines.push('revision: 1')
  lines.push(`updated: ${nowIso()}`)
  lines.push('-->')
  lines.push('')
  for (const name of SECTIONS) {
    lines.push(`## ${SECTION_TITLES[name]}`)
    lines.push(markStart(name))
    if (name === 'identity') lines.push(DEFAULT_IDENTITY.join('\n'))
    if (name === 'persona') lines.push(DEFAULT_PERSONA)
    lines.push(markEnd(name))
    lines.push('')
  }
  return lines.join('\n')
}

export function parseSections(raw) {
  const out = {}
  const text = String(raw ?? '')
  for (const name of SECTIONS) {
    const start = markStart(name)
    const end = markEnd(name)
    const i = text.indexOf(start)
    if (i < 0) {
      out[name] = ''
      continue
    }
    const from = i + start.length
    const j = text.indexOf(end, from)
    out[name] = (j < 0 ? text.slice(from) : text.slice(from, j)).replace(/^\n+|\n+$/g, '')
  }
  return out
}

export function parseMeta(raw) {
  const m = META_RE.exec(String(raw ?? ''))
  const out = { revision: 0, updated: '' }
  if (!m) return out
  const body = m[0]
  const rev = /revision:\s*(\d+)/.exec(body)
  if (rev) out.revision = Number(rev[1]) || 0
  const upd = /updated:\s*([^\n]+)/.exec(body)
  if (upd) out.updated = upd[1].trim()
  return out
}

export function renderWithSections(raw, sections, meta) {
  let out = String(raw ?? '')
  if (!out || !out.includes('dsh-shared-memory')) out = defaultTemplate()

  const missing = []
  for (const name of SECTIONS) {
    const start = markStart(name)
    const end = markEnd(name)
    const i = out.indexOf(start)
    if (i < 0) {
      missing.push(name)
      continue
    }
    const j = out.indexOf(end, i + start.length)
    if (j < 0) continue
    const body = String(sections[name] ?? '').replace(/\r\n?/g, '\n').trim()
    out = `${out.slice(0, i + start.length)}\n${body}\n${out.slice(j)}`
  }

  /*
   * 版本升级：老文件里没有的分类，补到合适的位置（保证升级后新分类能落盘）。
   * identity 例外——它必须落在**文件最前**（第一个分区标题之前），
   * 否则从 1.9.4 升级上来的老文件里，identity 会排在 docs 后面，
   * 人读文件时"我是谁"跑到了文末，跟"它优先级最高"的定位自相矛盾。
   */
  if (missing.length) {
    const defaultBodyOf = (name) => {
      if (name === 'identity') return DEFAULT_IDENTITY.join('\n')
      if (name === 'persona') return DEFAULT_PERSONA
      return ''
    }
    const blockFor = (name) => {
      const raw = String(sections[name] ?? '').replace(/\r\n?/g, '\n').trim()
      const body = raw || defaultBodyOf(name)
      return ['', `## ${SECTION_TITLES[name]}`, markStart(name), ...(body ? [body] : []), markEnd(name), '']
    }

    const early = missing.filter((name) => name === 'identity')
    const late = missing.filter((name) => name !== 'identity')

    if (early.length) {
      const block = early.flatMap(blockFor).join('\n').replace(/^\n+/, '')
      const firstHeading = out.search(/^## /m)
      out = firstHeading > 0
        ? `${out.slice(0, firstHeading)}${block}\n\n${out.slice(firstHeading)}`
        : `${out.replace(/\s*$/, '')}\n\n${block}`
    }

    if (late.length) {
      const tail = []
      for (const name of late) {
        tail.push(...blockFor(name))
      }
      out = `${out.replace(/\s*$/, '')}\n${tail.join('\n')}`
    }
  }

  const metaBlock = [
    '<!-- dsh-shared-memory:meta',
    `revision: ${Math.max(1, Number(meta?.revision) || 1)}`,
    `updated: ${meta?.updated || nowIso()}`,
    '-->'
  ].join('\n')

  out = META_RE.test(out) ? out.replace(META_RE, () => metaBlock) : `${metaBlock}\n\n${out}`
  return out
}

/** 条目的强调词：用户反复说"必须/永远/铁律"时，这条记忆权重会被抬高 */
const EMPHASIS_RE = /(必须|务必|一定要|永远|绝对|不许|禁止|不准|铁律|只能|不能再|别再|以后都)/g

export function emphasisCount(text) {
  const matched = String(text ?? '').match(EMPHASIS_RE)
  return matched ? matched.length : 0
}

/** 条目时间戳 `YYYY-MM-DD HH:mm` → 毫秒；解析不了返回 null */
export function tsToMs(ts) {
  const text = String(ts ?? '').trim()
  if (!text) return null
  const ms = Date.parse(text.replace(' ', 'T'))
  return Number.isFinite(ms) ? ms : null
}

/** 条目行裁剪：保留最新 cap 条，返回 { kept, dropped } */
export function capEntryLines(lines, cap) {
  const list = lines.map((l) => String(l ?? '')).filter((l) => l.trim() !== '')
  if (!cap || list.length <= cap) return { kept: list, dropped: [] }
  const cut = list.length - cap
  return { kept: list.slice(cut), dropped: list.slice(0, cut) }
}

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

export class MemoryStore {
  constructor(options = {}) {
    this.primaryPath = path.resolve(String(options.primaryPath))
    this.mirrorPath = options.mirrorPath ? path.resolve(String(options.mirrorPath)) : ''
    this.entryCap = Number.isFinite(options.entryCap) ? Number(options.entryCap) : 200
    this.historyLimit = Number.isFinite(options.historyLimit) ? Number(options.historyLimit) : 50
    /** 保护期（天）：新写入的条目在这个窗口内不会被挤进归档 */
    this.graceDays = Number.isFinite(options.graceDays) ? Number(options.graceDays) : 3
    this.logger = options.logger ?? null
    this.indexFile = options.indexPath
      ? path.resolve(String(options.indexPath))
      : this.primaryPath.replace(/\.md$/i, '') + '.index.json'
    this.index = new EntryIndex(this.indexFile, { log: (level, message) => this.log(level, message) })
    /** 分区默认 TTL（天）：requests/sessions 这类流水自动老化，不需要人标 */
    this.ttlBySection = options.ttlBySection && typeof options.ttlBySection === 'object'
      ? options.ttlBySection
      : { requests: 30, sessions: 90 }
    this.raw = ''
    this.mtimeMs = 0
    this.lastStatAt = 0
    this.mirrorHealthy = this.mirrorPath ? null : true
    this.lastError = ''
    this.ready = false
  }

  get archivePath() {
    return this.primaryPath.replace(/\.md$/i, '') + '.archive.md'
  }

  get mirrorArchivePath() {
    if (!this.mirrorPath) return ''
    return this.mirrorPath.replace(/\.md$/i, '') + '.archive.md'
  }

  log(level, message) {
    const fn = this.logger?.[level]
    if (typeof fn === 'function') fn.call(this.logger, `[shared-memory] ${message}`)
  }

  /**
   * 写锁：进程内串行（promise 链）+ 跨进程文件锁（<主文件>.lock，wx 创建）。
   * 覆盖 reload → commit 这段临界区，避免两个会话同时写把对方的内容覆盖掉。
   * 可重入：appendEntry 内部会再调 rebalance/commit，深度 >0 时直接执行。
   */
  async withLock(fn) {
    if (this._lockDepth > 0) return fn()
    const previous = this._chain ?? Promise.resolve()
    let releaseChain
    this._chain = new Promise((resolve) => {
      releaseChain = resolve
    })
    await previous
    this._lockDepth = (this._lockDepth || 0) + 1
    let releaseFile = async () => {}
    try {
      releaseFile = await this.acquireFileLock()
      return await fn()
    } finally {
      this._lockDepth -= 1
      try {
        await releaseFile()
      } catch {
        /* 解锁失败不阻塞流程 */
      }
      releaseChain()
    }
  }

  /** 跨进程文件锁；拿不到就等，超时后降级继续（宁可有风险也不能卡死） */
  async acquireFileLock(timeoutMs = 8000, staleMs = 20000) {
    const lockPath = `${this.primaryPath}.lock`
    const started = Date.now()
    for (;;) {
      try {
        const handle = await fsp.open(lockPath, 'wx')
        try {
          await handle.writeFile(`${process.pid} ${new Date().toISOString()}`, 'utf8')
        } catch {
          /* 写 pid 失败不影响持锁 */
        }
        return async () => {
          try {
            await handle.close()
          } catch {
            /* 忽略 */
          }
          try {
            await fsp.rm(lockPath, { force: true })
          } catch {
            /* 忽略 */
          }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          // 锁文件不可写（只读盘等）：降级为进程内串行
          this.log('warn', `无法创建写锁（${error?.code ?? error}），仅用进程内串行`)
          return async () => {}
        }
        // 过期锁（进程崩溃留下的）直接清掉
        try {
          const st = await fsp.stat(lockPath)
          if (Date.now() - st.mtimeMs > staleMs) {
            await fsp.rm(lockPath, { force: true })
            continue
          }
        } catch {
          /* 锁刚被删除，重试即可 */
        }
        if (Date.now() - started > timeoutMs) {
          this.log('warn', `等待写锁超时（${lockPath}），本次降级继续`)
          return async () => {}
        }
        await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 60)))
      }
    }
  }

  async exists(p) {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  }

  static existsSync(p) {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  }

  async readOrNull(p) {
    try {
      return await fsp.readFile(p, 'utf8')
    } catch {
      return null
    }
  }

  /** 原子写单个目标（临时文件 + rename），并校验落盘字节 */
  async writeOne(target, text) {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    await fsp.writeFile(tmp, text, 'utf8')
    await fsp.rename(tmp, target)
    const written = await fsp.readFile(target, 'utf8')
    if (hashText(written) !== hashText(text)) {
      throw new Error(`写入校验失败：${target}`)
    }
  }

  /** 双写：主 + 镜像。任一成功即视为成功，但失败会记录并在状态里暴露。 */
  async writeBoth(text) {
    const errors = []
    let primaryOk = false
    let mirrorOk = !this.mirrorPath
    try {
      await this.writeOne(this.primaryPath, text)
      primaryOk = true
    } catch (error) {
      errors.push(`primary: ${error?.message ?? error}`)
    }
    if (this.mirrorPath) {
      try {
        await this.writeOne(this.mirrorPath, text)
        mirrorOk = true
      } catch (error) {
        errors.push(`mirror: ${error?.message ?? error}`)
      }
    }
    this.mirrorHealthy = mirrorOk
    if (errors.length) {
      this.lastError = errors.join('; ')
      this.log('warn', `双写未完全成功 -> ${this.lastError}`)
    } else {
      this.lastError = ''
    }
    if (!primaryOk && !mirrorOk) {
      throw new Error(`共享记忆写入失败：${this.lastError}`)
    }
    return { primaryOk, mirrorOk }
  }

  /**
   * 双侧对账（启动时 / 手动 sync 时调用）：
   *  - 两侧都缺 → 建新模板（等价于用户主动删光了双备份）
   *  - 缺一侧   → 从另一侧回补
   *  - 两侧不一致 → 保留冲突副本，用较新的一侧收敛
   */
  async reconcile() {
    const primaryExists = await this.exists(this.primaryPath)
    const mirrorExists = this.mirrorPath ? await this.exists(this.mirrorPath) : false

    if (!primaryExists && !mirrorExists) {
      await this.writeBoth(defaultTemplate())
      this.log('info', '双备份都不存在，已按模板新建')
      return { action: 'created' }
    }

    if (primaryExists && !mirrorExists) {
      const text = (await this.readOrNull(this.primaryPath)) ?? defaultTemplate()
      try {
        await this.writeOne(this.mirrorPath, text)
        this.mirrorHealthy = true
        this.log('info', `镜像缺失，已从主文件回补 -> ${this.mirrorPath}`)
        return { action: 'restored-mirror', path: this.mirrorPath }
      } catch (error) {
        this.mirrorHealthy = false
        this.lastError = `mirror: ${error?.message ?? error}`
        this.log('warn', `镜像回补失败 -> ${this.lastError}`)
        return { action: 'restore-mirror-failed' }
      }
    }

    if (!primaryExists && mirrorExists) {
      const text = (await this.readOrNull(this.mirrorPath)) ?? defaultTemplate()
      await this.writeOne(this.primaryPath, text)
      this.log('info', `主文件缺失，已从镜像回补 -> ${this.primaryPath}`)
      return { action: 'restored-primary', path: this.primaryPath }
    }

    const a = (await this.readOrNull(this.primaryPath)) ?? ''
    const b = (await this.readOrNull(this.mirrorPath)) ?? ''
    if (a === b) {
      this.mirrorHealthy = true
      return { action: 'in-sync' }
    }

    const sa = statSync(this.primaryPath).mtimeMs
    const sb = statSync(this.mirrorPath).mtimeMs
    const primaryIsNewer = sa >= sb
    const newerText = primaryIsNewer ? a : b
    const olderText = primaryIsNewer ? b : a
    const olderPath = primaryIsNewer ? this.mirrorPath : this.primaryPath
    const stampName = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      await this.writeOne(`${olderPath}.conflict-${stampName}.bak`, olderText)
    } catch (error) {
      this.log('warn', `冲突副本保存失败：${error?.message ?? error}`)
    }
    await this.writeOne(olderPath, newerText)
    this.mirrorHealthy = true
    this.log('warn', `双侧内容不一致，已用较新的 ${primaryIsNewer ? '主文件' : '镜像'} 收敛，旧内容留在 .conflict-*.bak`)
    return { action: 'healed', newer: primaryIsNewer ? 'primary' : 'mirror', olderPath }
  }

  /** 强制从磁盘重新读取（压缩上下文后、外部改动后都走这里） */
  async reload(force = false) {
    let st = null
    try {
      st = await fsp.stat(this.primaryPath)
    } catch {
      st = null
    }
    if (!st) {
      await this.reconcile()
      try {
        st = await fsp.stat(this.primaryPath)
      } catch {
        st = null
      }
    }
    if (!st) throw new Error(`共享记忆文件不可读：${this.primaryPath}`)
    if (!force && this.raw && st.mtimeMs === this.mtimeMs) {
      return this.view()
    }
    this.raw = await fsp.readFile(this.primaryPath, 'utf8')
    this.mtimeMs = st.mtimeMs
    this.lastStatAt = Date.now()
    this.ready = true
    return this.view()
  }

  /**
   * 同步刷新（给系统提示词的 text() 用，必须是同步的）：
   * 每 1.2s 最多 stat 一次，mtime 变了才真读盘。
   * 这样"模型每步看到的记忆"始终来自磁盘，压缩上下文后自然重新读到最新内容。
   */
  refreshSync(minIntervalMs = 1200) {
    const nowMs = Date.now()
    if (nowMs - this.lastStatAt < minIntervalMs) return false
    this.lastStatAt = nowMs
    try {
      const st = statSync(this.primaryPath)
      if (this.raw && st.mtimeMs === this.mtimeMs) return false
      this.raw = readFileSync(this.primaryPath, 'utf8')
      this.mtimeMs = st.mtimeMs
      this.ready = true
      return true
    } catch {
      return false
    }
  }

  view() {
    return {
      raw: this.raw,
      sections: parseSections(this.raw),
      meta: parseMeta(this.raw),
      primaryPath: this.primaryPath,
      mirrorPath: this.mirrorPath
    }
  }

  async init() {
    await this.reconcile()
    await this.reload(true)
    return this.view()
  }

  /**
   * 同步引导：插件 apply() 时立刻执行，保证"本次启动的第一个请求"就能看到记忆。
   * 逻辑是 reconcile() 的同步子集：缺哪侧补哪侧，两侧都缺就建模板。
   * 异步 init() 随后仍会做完整的冲突收敛。
   */
  bootstrapSync() {
    const readIfExists = (target) => {
      try {
        return readFileSync(target, 'utf8')
      } catch {
        return null
      }
    }
    const writeSync = (target, text) => {
      const dir = path.dirname(target)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, target)
    }

    try {
      const primaryText = readIfExists(this.primaryPath)
      const mirrorText = this.mirrorPath ? readIfExists(this.mirrorPath) : null

      if (primaryText === null && mirrorText === null) {
        const text = defaultTemplate()
        writeSync(this.primaryPath, text)
        if (this.mirrorPath) {
          try {
            writeSync(this.mirrorPath, text)
          } catch (error) {
            this.mirrorHealthy = false
            this.lastError = `mirror: ${error?.message ?? error}`
          }
        }
      } else if (primaryText === null && mirrorText !== null) {
        writeSync(this.primaryPath, mirrorText)
        this.log('info', `[bootstrap] 主文件缺失，已从镜像同步回补`)
      } else if (primaryText !== null && this.mirrorPath && mirrorText === null) {
        try {
          writeSync(this.mirrorPath, primaryText)
          this.log('info', `[bootstrap] 镜像缺失，已从主文件同步回补`)
        } catch (error) {
          this.mirrorHealthy = false
          this.lastError = `mirror: ${error?.message ?? error}`
        }
      }

      this.raw = readFileSync(this.primaryPath, 'utf8')
      try {
        this.mtimeMs = statSync(this.primaryPath).mtimeMs
      } catch {
        this.mtimeMs = 0
      }
      this.lastStatAt = Date.now()
      this.ready = true
      return true
    } catch (error) {
      this.lastError = `bootstrap: ${error?.message ?? error}`
      this.log('warn', `[bootstrap] 同步引导失败：${this.lastError}`)
      return false
    }
  }

  async commit(nextSections) {
    const meta = parseMeta(this.raw)
    const nextRaw = renderWithSections(this.raw, nextSections, {
      revision: meta.revision + 1,
      updated: nowIso()
    })
    await this.writeBoth(nextRaw)
    this.raw = nextRaw
    try {
      this.mtimeMs = (await fsp.stat(this.primaryPath)).mtimeMs
    } catch {
      this.mtimeMs = Date.now()
    }
    await this.snapshot(nextRaw, meta.revision + 1)
    return this.view()
  }

  /* ---------------- 版本历史（P1：可回滚） ---------------- */

  get historyDir() {
    return path.join(path.dirname(this.primaryPath), '.history')
  }

  /** 每次提交留一份快照，只保留最近 historyLimit 份 */
  async snapshot(raw, revision) {
    try {
      await fsp.mkdir(this.historyDir, { recursive: true })
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-r${revision}.md`
      await fsp.writeFile(path.join(this.historyDir, name), raw, 'utf8')
      const keep = Math.max(5, Number(this.historyLimit) || 50)
      const files = (await fsp.readdir(this.historyDir))
        .filter((f) => f.endsWith('.md'))
        .sort()
      for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
        await fsp.rm(path.join(this.historyDir, stale), { force: true })
      }
    } catch (error) {
      this.log('warn', `历史快照失败：${error?.message ?? error}`)
    }
  }

  async listHistory(limit = 20) {
    try {
      const files = (await fsp.readdir(this.historyDir)).filter((f) => f.endsWith('.md')).sort().reverse()
      const out = []
      for (const name of files.slice(0, limit)) {
        const st = await fsp.stat(path.join(this.historyDir, name))
        out.push({ name, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() })
      }
      return out
    } catch {
      return []
    }
  }

  async readHistory(name) {
    const safe = path.basename(String(name ?? ''))
    if (!/^[\w.-]+\.md$/.test(safe)) throw new Error(`非法的历史文件名：${name}`)
    return fsp.readFile(path.join(this.historyDir, safe), 'utf8')
  }

  /** 回滚到某个历史快照（回滚本身也会留一份快照，可再回滚回来） */
  async rollback(name) {
    return this.withLock(() => this._rollback(name))
  }

  async _rollback(name) {
    const text = await this.readHistory(name)
    if (!text || !text.includes('dsh-shared-memory')) throw new Error(`历史快照不可用：${name}`)
    await this.reload(true)
    const meta = parseMeta(this.raw)
    const nextRaw = renderWithSections(text, parseSections(text), {
      revision: meta.revision + 1,
      updated: nowIso()
    })
    await this.writeBoth(nextRaw)
    this.raw = nextRaw
    try {
      this.mtimeMs = (await fsp.stat(this.primaryPath)).mtimeMs
    } catch {
      this.mtimeMs = Date.now()
    }
    return this.view()
  }

  /* ---------------- 检索（P0：memory_file_search） ---------------- */

  entriesOf(section) {
    return parseEntries(parseSections(this.raw)[section] ?? '')
  }

  /**
   * 关键词检索：所有 token 都命中才算命中（不区分大小写）；
   * 支持按分类、作用域过滤；结果按时间倒序。
   */
  /** 查询词的联想邻居（来自索引里的共现图） */
  associationsFor(tokens, limit = 2) {
    const out = []
    const seen = new Set((tokens ?? []).map((t) => String(t).toLowerCase()))
    for (const token of tokens ?? []) {
      for (const item of this.index.neighbors(token, limit)) {
        if (seen.has(item.term)) continue
        seen.add(item.term)
        out.push(item)
      }
    }
    return out
  }

  /** 按 key 取回条目原文（正文优先，其次归档） */
  findEntryByKey(key) {
    if (!key) return null
    const parsed = parseSections(this.raw)
    for (const name of ENTRY_SECTIONS) {
      for (const entry of parseEntries(parsed[name] ?? '')) {
        if (entryKey(name, entry.text) === key) return { section: name, ...entry }
      }
    }
    for (const [name, lines] of this.readArchiveSync()) {
      for (const line of lines) {
        const entry = parseEntries(line)[0]
        if (entry && entryKey(name, entry.text) === key) return { section: name, archived: true, ...entry }
      }
    }
    return null
  }

  /**
   * 关键词检索。
   *  - mode=fuzzy（默认）：打分制，exact 3 / partial 2 / near 2 / associated 1，
   *    不要求“所有词都命中”，再叠上索引里长出来的联想词
   *  - mode=strict：所有词都命中才算（旧行为）
   *  - 默认隐藏「已被取代」的旧结论；过期条目仍返回但标注 expired
   *  - 命中条目会顺带展开它的显式连线（related）
   */
  search(rawQuery, options = {}) {
    const tokens = String(rawQuery ?? '')
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
    const mode = options.mode === 'strict' ? 'strict' : 'fuzzy'
    const sectionFilter = options.section && options.section !== 'all' ? String(options.section) : ''
    const scope = options.scope || ''
    const includeOtherScopes = options.includeOtherScopes === true
    const includeSuperseded = options.includeSuperseded === true
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 30))
    const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 1
    const sections = parseSections(this.raw)
    const associations = mode === 'fuzzy' ? this.associationsFor(tokens) : []
    const nowMs = Date.now()

    const match = (sectionName, entry, extra) => {
      const key = entryKey(sectionName, entry.text)
      const rec = this.index.get(key)
      if (!includeSuperseded && rec?.supersededBy) return null
      const kws = rec?.kws?.length ? rec.kws : extractKeywords(entry.text)
      const rowHits = Number(rec?.hits) || 0
      const weight = this.weightOf(rec)
      const supersededBy = rec?.supersededBy ?? ''
      const expired = this.index.isExpired(key, nowMs)
      if (mode === 'strict') {
        const haystack = `${entry.text} ${entry.ts}`.toLowerCase()
        if (tokens.length && !tokens.every((t) => haystack.includes(t))) return null
        return { ...extra, section: sectionName, ...entry, key, score: tokens.length * 3, reasons: [], rowHits, weight, expired, supersededBy }
      }
      if (!tokens.length) return { ...extra, section: sectionName, ...entry, key, score: 0, reasons: [], rowHits, weight, expired, supersededBy }
      const { score, reasons } = scoreEntry(kws, entry.text, tokens, associations)
      if (score < minScore) return null
      return { ...extra, section: sectionName, ...entry, key, score, reasons, rowHits, weight, expired, supersededBy }
    }

    const hits = []
    const hitEntries = []
    for (const name of ENTRY_SECTIONS) {
      if (sectionFilter && name !== sectionFilter) continue
      for (const entry of parseEntries(sections[name] ?? '')) {
        if (!includeOtherScopes && !scopeVisible(entry.scope, scope)) continue
        const row = match(name, entry, {})
        if (!row) continue
        hits.push(row)
        hitEntries.push({ section: name, text: entry.text, ts: entry.ts, scope: entry.scope })
      }
    }
    const byScore = (a, b) =>
      mode === 'fuzzy'
        ? (b.bm25 ?? 0) - (a.bm25 ?? 0) || b.score - a.score || b.weight - a.weight || String(b.ts).localeCompare(String(a.ts))
        : b.weight - a.weight || String(b.ts).localeCompare(String(a.ts))

    /* BM25 排序：纯统计（词频 + 逆文档频率 + 长度归一），不调模型 */
    if (mode === 'fuzzy' && hits.length) {
      const scores = bm25(hits.map((row) => ({ id: row.key, text: row.text })), tokens)
      for (const row of hits) row.bm25 = Number(scores.get(row.key) ?? 0)
    }
    const main = hits.sort(byScore)

    /*
     * 归档兜底：主文件命中数不足「质疑度阈值」时才翻归档。
     * 质疑度越高阈值越大 → 越频繁去翻旧账（用户要求的联动）。
     */
    const threshold = Number.isFinite(options.archiveThreshold) ? Number(options.archiveThreshold) : 0
    const wantArchive = options.includeArchive === true || (options.includeArchive !== false && main.length < threshold)
    let archived = []
    if (wantArchive) {
      const map = this.readArchiveSync()
      for (const [name, lines] of map) {
        if (sectionFilter && name !== sectionFilter) continue
        if (!ENTRY_SECTIONS.includes(name)) continue
        for (const line of lines) {
          const entry = parseEntries(line)[0]
          if (!entry) continue
          if (!includeOtherScopes && !scopeVisible(entry.scope, scope)) continue
          const row = match(name, entry, { archived: true })
          if (!row) continue
          archived.push(row)
          hitEntries.push({ section: name, text: entry.text, ts: entry.ts, scope: entry.scope })
        }
      }
      if (mode === 'fuzzy' && archived.length) {
        const scores = bm25([...main, ...archived].map((row) => ({ id: row.key, text: row.text })), tokens)
        for (const row of archived) row.bm25 = Number(scores.get(row.key) ?? 0)
      }
      archived = archived.sort(byScore)
    }

    if (hitEntries.length) this.touchEntries(hitEntries, 2)

    /* 显式连线展开：命中条目的 related 一键带出（只取前 3 条命中，避免爆炸） */
    const relatedRows = []
    if (options.expandRelated !== false) {
      const seen = new Set(main.map((row) => row.key))
      for (const row of main.slice(0, 3)) {
        const rec = this.index.get(row.key)
        for (const relKey of rec?.related ?? []) {
          if (seen.has(relKey)) continue
          const found = this.findEntryByKey(relKey)
          if (!found) continue
          const rec2 = this.index.get(relKey)
          if (rec2?.supersededBy && !includeSuperseded) continue
          seen.add(relKey)
          relatedRows.push({ ...found, key: relKey, linkedFrom: row.key })
        }
      }
    }

    return {
      mode,
      tokens,
      associations,
      includeSuperseded,
      total: main.length,
      hits: main.slice(0, limit),
      related: relatedRows.slice(0, 5),
      archive: {
        searched: wantArchive,
        threshold,
        total: archived.length,
        hits: archived.slice(0, limit)
      }
    }
  }

  /**
   * 整合候选扫描（只读）：同一分区 + 同作用域内，关键词 Jaccard ≥ 阈值且
   * 命中合计 ≥ 阈值的条目归成一簇。插件不自动合并，只出候选。
   */
  consolidateScan(options = {}) {
    const picked = Array.isArray(options.sections) && options.sections.length
      ? options.sections.filter((s) => ENTRY_SECTIONS.includes(s))
      : ENTRY_SECTIONS
    const minJaccard = Number.isFinite(options.minJaccard) ? Number(options.minJaccard) : 0.5
    const minHits = Number.isFinite(options.minHits) ? Number(options.minHits) : 0
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 10))
    const parsed = parseSections(this.raw)
    const clusters = []

    for (const section of picked) {
      const entries = parseEntries(parsed[section] ?? '')
      if (entries.length < 2) continue
      const rows = entries.map((entry) => {
        const key = entryKey(section, entry.text)
        const rec = this.index.get(key)
        return {
          section,
          key,
          ts: entry.ts,
          scope: entry.scope,
          text: entry.text,
          hits: Number(rec?.hits) || 0,
          kws: rec?.kws?.length ? rec.kws : extractKeywords(entry.text)
        }
      })

      const parent = rows.map((_, index) => index)
      const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])))
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          if (rows[i].scope !== rows[j].scope) continue
          if (jaccard(rows[i].kws, rows[j].kws) < minJaccard) continue
          parent[find(i)] = find(j)
        }
      }

      const groups = new Map()
      rows.forEach((row, index) => {
        const root = find(index)
        if (!groups.has(root)) groups.set(root, [])
        groups.get(root).push(row)
      })

      for (const group of groups.values()) {
        if (group.length < 2) continue
        const totalHits = group.reduce((sum, row) => sum + row.hits, 0)
        if (totalHits < minHits) continue
        const chars = group.reduce((sum, row) => sum + row.text.length, 0)
        const shared = group.reduce(
          (acc, row) => (acc === null ? row.kws : acc.filter((kw) => row.kws.includes(kw))),
          null
        ) ?? []
        clusters.push({
          section,
          size: group.length,
          totalHits,
          chars,
          shared,
          entries: group.map(({ key, ts, text, hits, scope }) => ({ key, ts, text, hits, scope }))
        })
      }
    }

    clusters.sort((a, b) => b.size - a.size || b.totalHits - a.totalHits || b.chars - a.chars)
    return { clusters: clusters.slice(0, limit), total: clusters.length }
  }

  /* ---------------- 归档：按“命中频率”在主文件与归档之间流动 ---------------- */

  /** 读归档（按分区解析）；返回 Map<section, line[]> */
  readArchiveSync() {
    const out = new Map()
    try {
      if (!existsSync(this.archivePath)) return out
      const raw = readFileSync(this.archivePath, 'utf8')
      let current = ''
      for (const line of raw.split('\n')) {
        const header = /^##\s+([a-z]+)\s*$/.exec(line.trim())
        if (header) {
          current = header[1]
          if (!out.has(current)) out.set(current, [])
          continue
        }
        if (current && /^-\s*\[/.test(line.trim())) out.get(current).push(line.trim())
      }
    } catch (error) {
      this.log('warn', `归档读取失败：${error?.message ?? error}`)
    }
    return out
  }

  /** 整体重写归档（主 + 镜像）；空则删掉文件 */
  async writeArchive(map) {
    const lines = [
      '# 共享记忆归档（自动维护）',
      '',
      '> 不注入上下文；主文件命中不足时由 `memory_file_search` 兜底检索。',
      '> 命中频率回升的条目会在下次分层时被自动回迁到主文件。',
      ''
    ]
    let count = 0
    for (const [section, entries] of map) {
      if (!entries?.length) continue
      lines.push(`## ${section}`)
      for (const line of entries) lines.push(line)
      lines.push('')
      count += entries.length
    }
    const text = lines.join('\n')
    for (const target of [this.archivePath, this.mirrorArchivePath]) {
      if (!target) continue
      try {
        if (!count) {
          if (existsSync(target)) await fsp.rm(target, { force: true })
          continue
        }
        await this.writeOne(target, text)
      } catch (error) {
        this.log('warn', `归档写入失败 ${target}：${error?.message ?? error}`)
      }
    }
    return count
  }

  /**
   * 重新分层一个分区：候选 = 主文件现有条目 + 该分区归档条目。
   * 排序：保护期内优先 → 命中次数降序 → 创建时间降序 → key 稳定序。
   * 前 entryCap 条留在主文件（写回时按时间正序，保持人读顺序），其余进归档。
   */
  async rebalance(section, poolLines) {
    const archivedAll = this.readArchiveSync()
    /*
     * 没传候选池时，默认取"该分区当前正文 + 归档"，绝不能是空数组——
     * 空池会让 kept=[] 直接把整个分区清空（曾经踩过，记忆被抹掉）。
     */
    const base = Array.isArray(poolLines) && poolLines.length
      ? poolLines
      : String(parseSections(this.raw)[section] ?? '').split('\n')
    const pool = base.filter((line) => String(line ?? '').trim() !== '')
    const seen = new Set(pool.map((line) => entryKey(section, parseEntries(line)[0]?.text ?? line)))
    for (const line of archivedAll.get(section) ?? []) {
      const key = entryKey(section, parseEntries(line)[0]?.text ?? line)
      if (!seen.has(key)) pool.push(line)
    }

    const nowMs = Date.now()
    const graceMs = Math.max(0, this.graceDays) * 86400000
    const rows = pool.map((line, order) => {
      const entry = parseEntries(line)[0] ?? { text: line.trim(), ts: '', scope: GLOBAL_SCOPE }
      const key = entryKey(section, entry.text)
      const { rec } = this.index.record(section, entry)
      const created = tsToMs(entry.ts) ?? nowMs
      return {
        line,
        key,
        order,
        weight: this.weightOf(rec),
        created,
        // 已过时/已过期的条目优先被挤到归档（保留可查，但不再占主文件名额）
        stale: Boolean(rec.supersededBy) || this.index.isExpired(key, nowMs),
        protected: nowMs - created < graceMs
      }
    })

    rows.sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? 1 : -1
      if (a.protected !== b.protected) return a.protected ? -1 : 1
      if (b.weight !== a.weight) return b.weight - a.weight
      if (b.created !== a.created) return b.created - a.created
      // 同分同秒时按原始文件顺序，越靠后越新（稳定，不会随机丢）
      return b.order - a.order
    })

    const keptRows = rows.slice(0, this.entryCap)
    const droppedRows = rows.slice(this.entryCap)
    /* 兜底断言：候选池里有东西却算不出任何保留项，说明逻辑错了——宁可不动，也不清空 */
    if (pool.length && !keptRows.length) {
      this.log('warn', `rebalance 已中止：${section} 候选 ${pool.length} 条却保留 0 条`)
      return { kept: pool.length, dropped: 0, aborted: true }
    }
    const byTime = (a, b) => a.created - b.created || a.order - b.order
    const kept = keptRows.slice().sort(byTime).map((row) => row.line)
    const dropped = droppedRows.slice().sort(byTime).map((row) => row.line)

    for (const row of keptRows) this.index.setArchived(row.key, false)
    for (const row of droppedRows) this.index.setArchived(row.key, true)

    const nextArchive = new Map(archivedAll)
    if (dropped.length) nextArchive.set(section, dropped)
    else nextArchive.delete(section)

    const sections = parseSections(this.raw)
    await this.commit({ ...sections, [section]: kept.join('\n') })
    await this.writeArchive(nextArchive)
    this.index.save()
    if (dropped.length) {
      this.log('info', `按命中频率分层 ${section}：主文件 ${kept.length} 条 / 归档 ${dropped.length} 条`)
    }
    return { kept: kept.length, dropped: dropped.length }
  }

  /** 记忆权重：命中 + 重复强调×5 + 强调词×3（重复强调最值钱，等价于用户说的"铁律"） */
  weightOf(rec) {
    return this.index.weightOf(rec)
  }

  /** 命中计数（搜索命中 / 被注入提示词都算） */
  bumpHits(keys, amount = 1) {
    const changed = this.index.hit(Array.isArray(keys) ? keys : [keys], amount)
    if (changed) this.index.save()
    return changed
  }

  /**
   * 计入命中：传入 [{section, text, ts?, scope?}]，缺索引记录的会顺手补上。
   * 搜索与"被注入提示词"都走它，保证没有记录过的条目也能开始累计频率。
   */
  touchEntries(list, amount = 1) {
    const entries = Array.isArray(list) ? list : []
    if (!entries.length) return 0
    const keys = []
    for (const item of entries) {
      if (!item?.section || !item?.text) continue
      const { key } = this.index.record(item.section, item)
      keys.push(key)
    }
    if (!keys.length) return 0
    const changed = this.index.hit(keys, amount)
    if (changed) this.index.save()
    return changed
  }

  /** 导出为可迁移的 JSON（正文分区 + 归档 + 关键词索引） */
  exportSnapshot() {
    const view = this.view()
    return {
      format: 'dsh-shared-memory/v1',
      exportedAt: nowIso(),
      revision: view.meta?.revision ?? 0,
      sections: view.sections,
      archive: Object.fromEntries(this.readArchiveSync()),
      index: this.index.load().entries
    }
  }

  /** 两个历史版本（或历史与当前）之间的行级差异 */
  async diffHistory(fromName, toName) {
    const from = fromName ? await this.readHistory(fromName) : this.raw
    const to = toName ? await this.readHistory(toName) : this.raw
    const a = new Set(String(from ?? '').split('\n').map((l) => l.trim()).filter(Boolean))
    const b = new Set(String(to ?? '').split('\n').map((l) => l.trim()).filter(Boolean))
    return {
      from: fromName || '(当前)',
      to: toName || '(当前)',
      removed: [...a].filter((line) => !b.has(line)),
      added: [...b].filter((line) => !a.has(line))
    }
  }

  /** 归档 + 关键词索引的统计，给 status / 网页用 */
  archiveStats() {
    const map = this.readArchiveSync()
    let count = 0
    for (const [, entries] of map) count += entries.length
    let bytes = 0
    try {
      if (existsSync(this.archivePath)) bytes = statSync(this.archivePath).size
    } catch {
      /* 读不到就算了 */
    }
    return {
      path: this.archivePath,
      mirrorPath: this.mirrorArchivePath,
      exists: existsSync(this.archivePath),
      sections: [...map.keys()],
      count,
      bytes,
      index: this.index.stats()
    }
  }

  /** 往某个分类追加一条（单行），带去重与上限裁剪 */
  /** 追加条目（带写锁：进程内串行 + 跨进程文件锁） */
  async appendEntry(section, line, options = {}) {
    return this.withLock(() => this._appendEntry(section, line, options))
  }

  async _appendEntry(section, line, options = {}) {
    if (!SECTIONS.includes(section)) throw new Error(`未知记忆分类：${section}`)
    const text = oneLine(line)
    if (!text) return { changed: false, reason: 'empty' }
    await this.reload()
    const sections = parseSections(this.raw)
    const current = sections[section] ? sections[section].split('\n') : []
    const dedupe = options.dedupe !== false
    const incoming = parseEntries(text)[0]
    if (dedupe && incoming) {
      const dup = current.some((l) => {
        const e = parseEntries(l)[0]
        return e && e.text === incoming.text && e.scope === incoming.scope
      })
      if (dup) {
        /*
         * 重复写同一条 = 用户又强调了一次：不新增条目，直接抬权重。
         * 权重参与分层保留、检索排序、提示词选取，等价于"铁律"。
         */
        const { key } = this.index.record(section, incoming)
        const rec = this.index.get(key)
        const nextReinforce = (Number(rec?.reinforce) || 0) + 1
        this.index.update(key, {
          reinforce: nextReinforce,
          emphasis: (Number(rec?.emphasis) || 0) + (emphasisCount(incoming.text) ? 1 : 0),
          lastHit: nowIso()
        })
        this.index.save()
        return {
          changed: false,
          reason: 'duplicate',
          reinforced: true,
          key,
          reinforce: nextReinforce
        }
      }
    }
    const merged = [...current, text]
    if (incoming) {
      this.index.record(section, incoming)
      const emphasis = emphasisCount(incoming.text)
      if (emphasis) this.index.update(entryKey(section, incoming.text), { emphasis })
    }

    /* 超出条目上限时按「命中频率」重新分层，而不是简单丢最旧的 */
    if (ENTRY_SECTIONS.includes(section) && merged.length > this.entryCap) {
      const result = await this.rebalance(section, merged)
      const meta = this.applyEntryMeta(section, entryKey(section, incoming?.text ?? text), options)
      return { changed: true, dropped: result.dropped, count: result.kept, rebalanced: true, meta }
    }

    for (const entry of parseEntries(merged.join('\n'))) this.index.record(section, entry)
    this.index.save()
    await this.commit({ ...sections, [section]: merged.join('\n') })
    const meta = this.applyEntryMeta(section, entryKey(section, incoming?.text ?? text), options)
    return { changed: true, dropped: 0, count: merged.length, meta }
  }

  /** 在正文与归档里按文字片段找 key（不触发命中计数） */
  findKeyByText(fragment, section) {
    const needle = oneLine(fragment).toLowerCase()
    if (!needle) return ''
    const names = section ? [section] : ENTRY_SECTIONS
    const parsed = parseSections(this.raw)
    for (const name of names) {
      for (const entry of parseEntries(parsed[name] ?? '')) {
        if (entry.text.toLowerCase().includes(needle)) return entryKey(name, entry.text)
      }
    }
    for (const [name, lines] of this.readArchiveSync()) {
      if (section && name !== section) continue
      for (const line of lines) {
        const entry = parseEntries(line)[0]
        if (entry && entry.text.toLowerCase().includes(needle)) return entryKey(name, entry.text)
      }
    }
    return ''
  }

  /**
   * 把「取代 / 连线 / TTL / 来源」写进关键词索引（不改记忆正文）。
   * - supersedes 传 key 或文字片段都行，片段会解析成 key
   * - 取代会自动建双向连线（新↔旧），所以"连线"不需要人再标一次
   * - 没显式给 ttlDays 时，按分区默认 TTL（requests 30 天 / sessions 90 天）
   */
  applyEntryMeta(section, key, options = {}) {
    if (!key) return null
    const patch = {}
    const related = (Array.isArray(options.related) ? options.related : [])
      .map((ref) => this.findKeyByText(ref))
      .filter(Boolean)
      .slice(0, 10)

    const supersedeRaw = Array.isArray(options.supersedes) ? options.supersedes : []
    const supersedes = supersedeRaw
      .map((ref) => (this.index.get(String(ref)) ? String(ref) : this.findKeyByText(ref)))
      .filter(Boolean)
      .slice(0, 10)

    if (supersedes.length) {
      patch.supersedes = supersedes
      for (const oldKey of supersedes) {
        if (oldKey === key) continue
        const oldRec = this.index.get(oldKey)
        // 旧条目：标为被取代，并反向连线到新条目
        this.index.update(oldKey, {
          supersededBy: key,
          related: [...new Set([...(oldRec?.related ?? []), key])].slice(0, 10)
        })
        if (!related.includes(oldKey)) related.push(oldKey)
      }
    }
    if (related.length) patch.related = [...new Set(related)].slice(0, 10)

    const explicitTtl = Number(options.ttlDays)
    const sectionTtl = Number(this.ttlBySection?.[section])
    const ttlDays = Number.isFinite(explicitTtl) && explicitTtl > 0 ? explicitTtl : sectionTtl
    if (Number.isFinite(ttlDays) && ttlDays > 0) {
      patch.expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString()
    }
    if (options.source) patch.source = String(options.source).slice(0, 300)

    if (Object.keys(patch).length) this.index.update(key, patch)
    this.index.save()
    return { key, ...patch }
  }

  /**
   * 给已存在的流水分区条目补默认 TTL（老数据也能自动老化）。
   * 以条目自身时间戳为基准，所以老条目不会"刚补上就过期"。
   */
  backfillTtl() {
    let changed = 0
    const parsed = parseSections(this.raw)
    for (const [section, days] of Object.entries(this.ttlBySection ?? {})) {
      const num = Number(days)
      if (!Number.isFinite(num) || num <= 0) continue
      for (const entry of parseEntries(parsed[section] ?? '')) {
        const key = entryKey(section, entry.text)
        const rec = this.index.get(key)
        if (rec?.expiresAt) continue
        const base = tsToMs(entry.ts) ?? Date.now()
        this.index.update(key, { expiresAt: new Date(base + num * 86400000).toISOString() })
        changed += 1
      }
    }
    if (changed) this.index.save()
    return changed
  }

  /** 给老条目补 emphasis（强调词）统计，让"强调提权"对历史数据也生效 */
  backfillEmphasis() {
    let changed = 0
    const parsed = parseSections(this.raw)
    for (const section of ENTRY_SECTIONS) {
      for (const entry of parseEntries(parsed[section] ?? '')) {
        const key = entryKey(section, entry.text)
        const rec = this.index.get(key)
        if (!rec || Number(rec.emphasis) > 0) continue
        const emphasis = emphasisCount(entry.text)
        if (!emphasis) continue
        this.index.update(key, { emphasis })
        changed += 1
      }
    }
    if (changed) this.index.save()
    return changed
  }

  /**
   * 找同一分区里"同主题"的旧条目（关键词 Jaccard ≥ 阈值）。
   * 用来在写入回执里提醒：这条可能是在更正/替代已有结论。
   */
  similarEntries(section, text, options = {}) {
    const kws = extractKeywords(oneLine(text))
    if (!kws.length) return []
    const minJaccard = Number.isFinite(options.minJaccard) ? Number(options.minJaccard) : 0.5
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 3
    const out = []
    for (const entry of parseEntries(parseSections(this.raw)[section] ?? '')) {
      if (oneLine(entry.text) === oneLine(text)) continue
      const entryKws = this.index.get(entryKey(section, entry.text))?.kws ?? extractKeywords(entry.text)
      const score = jaccard(kws, entryKws)
      if (score < minJaccard) continue
      out.push({ key: entryKey(section, entry.text), text: entry.text, ts: entry.ts, score: Number(score.toFixed(2)) })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** 整段替换某个分类（带写锁） */
  async setSection(section, body) {
    return this.withLock(() => this._setSection(section, body))
  }

  async _setSection(section, body) {
    if (!SECTIONS.includes(section)) throw new Error(`未知记忆分类：${section}`)
    await this.reload()
    const sections = parseSections(this.raw)
    const next = String(body ?? '').replace(/\r\n?/g, '\n').trim()
    if (oneLine(sections[section]) === oneLine(next)) {
      return { changed: false, reason: 'identical' }
    }
    await this.commit({ ...sections, [section]: next })
    return { changed: true }
  }

  /** 人设的定向替换（find -> replace），用于"用户说某句要改"的场景（带写锁） */
  async patchPersona(find, replaceWith) {
    return this.withLock(() => this._patchPersona(find, replaceWith))
  }

  async _patchPersona(find, replaceWith) {
    const needle = String(find ?? '')
    if (!needle) throw new Error('find 不能为空')
    await this.reload()
    const sections = parseSections(this.raw)
    const persona = sections.persona ?? ''
    if (!persona.includes(needle)) {
      return { changed: false, reason: 'not-found' }
    }
    const next = persona.split(needle).join(String(replaceWith ?? '')).trim()
    await this.commit({ ...sections, persona: next })
    return { changed: true }
  }

  async status() {
    const describe = async (target) => {
      if (!target) return null
      try {
        const st = await fsp.stat(target)
        const text = await this.readFileOrNullSafe(target)
        return {
          path: target,
          exists: true,
          bytes: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          hash: hashText(text ?? '')
        }
      } catch {
        return { path: target, exists: false }
      }
    }
    const primary = await describe(this.primaryPath)
    const mirror = await describe(this.mirrorPath)
    const sections = parseSections(this.raw)
    const counts = {}
    for (const name of SECTIONS) {
      const body = sections[name] ?? ''
      counts[name] = ENTRY_SECTIONS.includes(name)
        ? body.split('\n').filter((l) => l.trim().startsWith('-')).length
        : oneLine(body).length
    }
    return {
      primaryPath: this.primaryPath,
      mirrorPath: this.mirrorPath || null,
      sameVolume: this.mirrorPath
        ? path.parse(this.primaryPath).root.toLowerCase() === path.parse(this.mirrorPath).root.toLowerCase()
        : false,
      entryCap: this.entryCap,
      primary,
      mirror,
      inSync: Boolean(primary?.exists && mirror?.exists && primary.hash === mirror.hash),
      mirrorHealthy: this.mirrorHealthy,
      lastError: this.lastError,
      revision: parseMeta(this.raw).revision,
      updated: parseMeta(this.raw).updated,
      counts
    }
  }

  async readFileOrNullSafe(target) {
    try {
      return await fsp.readFile(target, 'utf8')
    } catch {
      return null
    }
  }

  /** 用户显式要求"同时删除双备份"时使用：先留 tombstone，避免下次启动又回补 */
  async destroyBoth(tombstonePath) {
    const removed = []
    for (const target of [this.primaryPath, this.mirrorPath, this.archivePath, this.mirrorArchivePath, this.indexFile]) {
      if (!target) continue
      try {
        await fsp.rm(target, { force: true })
        removed.push(target)
      } catch (error) {
        this.log('warn', `删除失败 ${target}: ${error?.message ?? error}`)
      }
    }
    const tombstone = {
      deletedAt: nowIso(),
      primaryPath: this.primaryPath,
      mirrorPath: this.mirrorPath,
      removed
    }
    try {
      await fsp.mkdir(path.dirname(tombstonePath), { recursive: true })
      await fsp.writeFile(tombstonePath, JSON.stringify(tombstone, null, 2), 'utf8')
    } catch (error) {
      this.log('warn', `删除标记写入失败：${error?.message ?? error}`)
    }
    this.raw = ''
    this.mtimeMs = 0
    return tombstone
  }

  /** 更换保存位置：搬到新位置并清掉旧位置（用户主动裁剪存储时用） */
  async relocate(primaryPath, mirrorPath) {
    const text = this.raw || (await this.readOrNull(this.primaryPath)) || defaultTemplate()
    const oldPrimary = this.primaryPath
    const oldMirror = this.mirrorPath
    this.primaryPath = path.resolve(primaryPath)
    this.mirrorPath = mirrorPath ? path.resolve(mirrorPath) : ''
    await this.writeBoth(text)
    for (const stale of [oldPrimary, oldMirror]) {
      if (!stale || stale === this.primaryPath || stale === this.mirrorPath) continue
      try {
        await fsp.rm(stale, { force: true })
      } catch {
        /* 旧位置删不掉不算失败 */
      }
    }
    await this.reload(true)
    return this.status()
  }
}
