/**
 * dsh-elysia / entryindex.js
 *
 * 每条记忆的「关键词索引 + 命中计数」。存在主文件旁边的 MEMORY.index.json
 * （单文件，原子写；它只是分层决策的元数据，丢了会退化成"按时间归档"，主文件内容不受影响）。
 *
 * 一条记录：
 *   { section, scope, kws: [...], hits, created, lastHit, archived }
 *
 * 命中来源：
 *   - memory_file_search 命中         → +2（明确有人/模型在找它）
 *   - 被注入系统提示词（真的用上了）  → +1
 *
 * 分层规则（见 MemoryStore.rebalance）：
 *   保护期（默认 3 天）内的条目强制留主文件 → 其余按 hits 降序、created 降序取前 entryCap 条
 *   留在主文件，其余进归档；归档条目下次分层时仍参与比较，命中高的会被**回迁**到主文件。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { oneLine } from './store.js'
import { extractKeywords } from './keywords.js'

/** 内容指纹：同一条记忆（同分区 + 同正文）永远得到同一个 key */
export function entryKey(section, text) {
  const source = `${section}\u0001${oneLine(text)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${section}:${hash.toString(36)}`
}

function emptyIndex() {
  return { version: 1, updatedAt: '', entries: {}, cooc: {} }
}

/** 每个词最多保留多少个联想邻居（防止共现图无限膨胀） */
const MAX_NEIGHBORS = 16

export class EntryIndex {
  constructor(file, options = {}) {
    this.file = path.resolve(String(file))
    this.log = typeof options.log === 'function' ? options.log : null
    this.data = emptyIndex()
    this.loaded = false
    this.dirty = false
  }

  load() {
    if (this.loaded) return this.data
    this.loaded = true
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
        if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
          this.data = {
            version: 1,
            updatedAt: parsed.updatedAt ?? '',
            entries: parsed.entries,
            cooc: parsed.cooc && typeof parsed.cooc === 'object' ? parsed.cooc : {}
          }
          if (!Object.keys(this.data.cooc).length) this.rebuildCooc()
        }
      }
    } catch (error) {
      // 索引坏了不影响主链路：当作空的，下次写入会重建
      this.log?.('warn', `关键词索引读取失败，按空索引继续：${error?.message ?? error}`)
      this.data = emptyIndex()
    }
    return this.data
  }

  reload() {
    this.loaded = false
    return this.load()
  }

  /** 登记一条记忆（缺失则新建，已有则补关键词）；返回 { key, rec } */
  record(section, entry) {
    const data = this.load()
    const text = oneLine(entry?.text ?? '')
    const key = entryKey(section, text)
    let rec = data.entries[key]
    if (!rec) {
      rec = {
        section,
        scope: entry?.scope ?? 'global',
        kws: extractKeywords(text),
        hits: 0,
        created: String(entry?.ts ?? ''),
        lastHit: '',
        archived: false,
        /** 被哪条记忆取代（key）；非空表示"已过时，默认不再展示" */
        supersededBy: '',
        /** 本条目取代了哪些旧条目（key 数组） */
        supersedes: [],
        /** 显式连线（key 数组） */
        related: [],
        /** 过期时间（ISO）；过期后不再注入，检索仍可见 */
        expiresAt: '',
        /** 来源（文档/技能导入时记 path#heading） */
        source: '',
        /** 被重复写入/被反复强调的次数（权重的主要来源） */
        reinforce: 0,
        /** 文本里出现"必须/永远/铁律"这类强调词的次数 */
        emphasis: 0
      }
      data.entries[key] = rec
      this.dirty = true
      this.touchCooc(rec.kws)
    } else {
      let changed = false
      if (!Array.isArray(rec.kws) || rec.kws.length === 0) {
        rec.kws = extractKeywords(text)
        this.touchCooc(rec.kws)
        changed = true
      }
      // 兼容旧索引：补齐新增字段
      for (const [field, fallback] of [['supersededBy', ''], ['supersedes', []], ['related', []], ['expiresAt', ''], ['source', ''], ['reinforce', 0], ['emphasis', 0]]) {
        if (rec[field] === undefined) {
          rec[field] = fallback
          changed = true
        }
      }
      if (changed) this.dirty = true
    }
    return { key, rec }
  }

  /** 通用元数据更新（取代/连线/TTL/来源都走它） */
  update(key, patch) {
    const rec = this.load().entries[key]
    if (!rec || !patch || typeof patch !== 'object') return null
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue
      rec[field] = value
    }
    this.dirty = true
    return rec
  }

  /** 一条记忆是否"已过时"（被取代） */
  isSuperseded(key) {
    const rec = this.load().entries[key]
    return Boolean(rec && rec.supersededBy)
  }

  /** 一条记忆是否已过期 */
  isExpired(key, nowMs = Date.now()) {
    const rec = this.load().entries[key]
    if (!rec || !rec.expiresAt) return false
    const at = Date.parse(rec.expiresAt)
    return Number.isFinite(at) && at <= nowMs
  }

  /**
   * 联想词典：同一条记忆里的关键词两两共现 +1。
   * 完全是数据自举——不需要外部同义词表，越用越准。
   */
  touchCooc(keywords) {
    const data = this.load()
    data.cooc = data.cooc ?? {}
    const list = (keywords ?? []).slice(0, 8).map((w) => String(w))
    for (let i = 0; i < list.length; i += 1) {
      const term = list[i]
      if (!term) continue
      const bucket = data.cooc[term] ?? (data.cooc[term] = {})
      for (let j = 0; j < list.length; j += 1) {
        if (i === j) continue
        const other = list[j]
        if (!other) continue
        bucket[other] = (bucket[other] ?? 0) + 1
      }
      // 只保留最强的邻居，避免图无限膨胀
      const pairs = Object.entries(bucket)
      if (pairs.length > MAX_NEIGHBORS) {
        data.cooc[term] = Object.fromEntries(
          pairs.sort((a, b) => b[1] - a[1]).slice(0, MAX_NEIGHBORS)
        )
      }
    }
    this.dirty = true
  }

  /** 索引里没有联想图时，从现有记录重建一次 */
  rebuildCooc() {
    this.data.cooc = {}
    for (const rec of Object.values(this.data.entries)) {
      if (Array.isArray(rec.kws) && rec.kws.length) this.touchCooc(rec.kws)
    }
    this.dirty = true
    return Object.keys(this.data.cooc).length
  }

  /** 查询词的联想邻居（按共现次数降序） */
  neighbors(term, limit = 3) {
    const key = String(term ?? '').toLowerCase()
    if (!key) return []
    const bucket = this.load().cooc?.[key]
    if (!bucket) return []
    return Object.entries(bucket)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, limit))
      .map(([word, weight]) => ({ term: word, weight }))
  }

  get(key) {
    return this.load().entries[key]
  }

  /** 记忆权重：命中 + 重复强调×5 + 强调词×3（重复强调最值钱） */
  weightOf(rec) {
    if (!rec) return 0
    return (Number(rec.hits) || 0) + (Number(rec.reinforce) || 0) * 5 + (Number(rec.emphasis) || 0) * 3
  }

  /** 命中计数（keys 可以是数组）；一次批量只标一次 dirty */
  hit(keys, amount = 1) {
    const list = Array.isArray(keys) ? keys : [keys]
    const data = this.load()
    const now = new Date().toISOString()
    let changed = 0
    for (const key of list) {
      const rec = data.entries[key]
      if (!rec) continue
      rec.hits = (rec.hits ?? 0) + amount
      rec.lastHit = now
      changed += 1
    }
    if (changed) this.dirty = true
    return changed
  }

  setArchived(key, archived) {
    const rec = this.load().entries[key]
    if (!rec) return
    const next = archived === true
    if (rec.archived === next) return
    rec.archived = next
    this.dirty = true
  }

  /** 给一条正文重新算关键词（正文被手工改过时用） */
  reindex(section, text) {
    const data = this.load()
    const key = entryKey(section, text)
    const rec = data.entries[key]
    if (!rec) return this.record(section, { text }).key
    rec.kws = extractKeywords(oneLine(text))
    this.dirty = true
    return key
  }

  save() {
    if (!this.dirty) return false
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: this.data.entries,
        cooc: this.data.cooc ?? {}
      }
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, this.file)
      this.dirty = false
      this.loaded = true
      return true
    } catch (error) {
      this.log?.('warn', `关键词索引写入失败：${error?.message ?? error}`)
      return false
    }
  }

  stats() {
    const records = Object.values(this.load().entries)
    const totalHits = records.reduce((sum, rec) => sum + (Number(rec.hits) || 0), 0)
    return {
      file: this.file,
      count: records.length,
      hits: totalHits,
      archived: records.filter((rec) => rec.archived === true).length,
      idle: records.filter((rec) => !rec.hits).length,
      coocTerms: Object.keys(this.data.cooc ?? {}).length
    }
  }
}
