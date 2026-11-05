/**
 * dsh-shared-memory / tools.js
 *
 * 注册给模型的记忆工具。原则：
 *  - 工具少而稳：读 / 检索 / 写 / 人设 / 状态 / 维护
 *  - 写操作串行（isConcurrencySafe=false），读与检索可并发
 *  - 工具返回的内存原文用边界标记包起来并打断边界标记本身，避免记忆被当成指令执行
 *  - 作用域：写入可指定 global / project（默认 auto 由当前工作目录推断），读取与检索默认只看
 *    global + 当前项目，避免其它项目的条目污染本会话
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { SECTIONS, SECTION_TITLES, ENTRY_SECTIONS, GLOBAL_SCOPE, entryLine, oneLine, clip, stamp, parseEntries, parseSections } from './store.js'
import { scanHeadings, identityStats, splitIdentityChapters, mergeIdentityText, personaOverlap, renderCoverageLines } from './prompt.js'
import { listSkills, matchSkills, readSkill, removeSkill, saveSkill, bumpStats, runSkill, skillsDir } from './skills.js'
import { matchSticker, scanStickers, recordUsage, setTags, stickersDir, ensureStickersDir } from './stickers.js'
import { installPack, listPacks, packStatus, previewPack, uninstallPack } from './packs.js'
import {
  applyReport,
  clampDecayAfter,
  clampLevel,
  defaultMethodbook,
  lookupMethods,
  normalizeCategory,
  parseMethodbook,
  queryBrief,
  renderIndexTree,
  renderMethodbook,
  summarizeSkepticism,
  taskKey,
  MAX_SKEPTICISM
} from './methodbook.js'

const KIND_TO_SECTION = {
  requirement: 'requirements',
  correction: 'corrections',
  lesson: 'lessons',
  method: 'methods',
  session: 'sessions'
}

const KIND_HINT = {
  requirement: '用户提出的、值得长期保留的要求/偏好/约束/习惯',
  correction: '用户指正了你的做法：错在哪 + 以后怎么改',
  lesson: '你自己发现的错误与教训（报错、写错路径/API、结论下错）',
  method: '你或用户发现的更好做法：场景 + 做法 + 为什么更好',
  session: '会话级索引（一般由插件自动写，模型无需调用）'
}

const OPEN = '<<<SHARED_MEMORY_DATA'
const CLOSE = 'SHARED_MEMORY_DATA>>>'

function fence(text) {
  const body = String(text ?? '')
    .split(OPEN)
    .join('<<<SHARED_MEMORY_DATA_(escaped)')
    .split(CLOSE)
    .join('SHARED_MEMORY_DATA_(escaped)>>>')
  return `${OPEN}\n${body}\n${CLOSE}`
}

function textOut(text) {
  return { content: [{ type: 'text', text: String(text ?? '') }] }
}

function extractText(value) {
  const content = value?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

function makeDef(def) {
  return {
    parameters: def.parameters,
    output: {
      /* DSH 只接受真实 JSON Schema 子集；`{ type: 'json' }` 会被 register 以
       * `unsupported JSON schema: schema.type must be one of ...` 拒绝。 */
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: extractText(value) }]
      }
    },
    timeoutMs: def.timeoutMs ?? 30_000,
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error(`${def.name} 已取消`)
      const result = await def.run(args ?? {}, exec)
      return textOut(result)
    },
    name: def.name,
    description: def.description
  }
}

/**
 * @param {object} deps
 * @param {MemoryStore} deps.store
 * @param {object} deps.hooks  { scopeOf(exec) -> {scope, cwd, projectKey}, relocate, reset }
 */
export function buildMemoryTools({ store, hooks }) {
  const tools = []

  const scopeOf = (exec) => {
    try {
      return hooks?.scopeOf?.(exec) ?? { scope: GLOBAL_SCOPE, cwd: '', projectKey: '' }
    } catch {
      return { scope: GLOBAL_SCOPE, cwd: '', projectKey: '' }
    }
  }

  /* ---------------- 读 ---------------- */
  tools.push(makeDef({
    name: 'memory_file_read',
    description:
      '读取全局共享记忆文件（所有会话共用，跨会话长期有效）。' +
      '可只读取一个分类。需要回忆"用户以前提过什么""上次踩过什么坑""人设是什么"时用它。' +
      `分类：${SECTIONS.map((s) => `${s}=${SECTION_TITLES[s]}`).join('；')}。`,
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', ...SECTIONS],
          description: '要读取的分类，默认 all（全文）'
        },
        scope: {
          type: 'string',
          enum: ['current', 'global', 'all'],
          description: '条目作用域过滤：current=全局+当前项目（默认）；global=只看全局；all=全部项目'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 4000,
          description: '最多返回多少行，默认 400，避免一次灌满上下文'
        }
      },
      additionalProperties: false
    },
    isConcurrencySafe: () => true,
    async run(args, exec) {
      await store.reload(true)
      const view = store.view()
      const section = args.section && args.section !== 'all' ? String(args.section) : 'all'
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : 400
      const scopeMode = String(args.scope ?? 'current')
      const { scope } = scopeOf(exec)
      let body
      if (section === 'all') {
        body = view.raw
      } else {
        if (!SECTIONS.includes(section)) throw new Error(`未知分类：${section}`)
        body = view.sections[section] ?? ''
        if (scopeMode !== 'all' && ENTRY_SECTIONS.includes(section)) {
          const rows = parseEntries(body).filter((e) => (
            scopeMode === 'global' ? e.scope === GLOBAL_SCOPE : (e.scope === GLOBAL_SCOPE || e.scope === scope)
          ))
          body = rows.length ? rows.map((e) => e.raw).join('\n') : ''
        }
        if (!body.trim()) body = `（分类 ${section} 在 ${scopeMode === 'all' ? '当前记忆' : '当前作用域'} 下没有条目）`
      }
      const lines = body.split('\n')
      const clipped = lines.length > limit
        ? `${lines.slice(0, limit).join('\n')}\n…（共 ${lines.length} 行，已截断到 ${limit} 行）`
        : body
      return [
        `路径：${view.primaryPath}`,
        `镜像：${view.mirrorPath || '（未配置）'}`,
        `revision ${view.meta.revision} · 更新于 ${view.meta.updated || '未知'} · 当前作用域 ${scope}`,
        '',
        fence(clipped)
      ].join('\n')
    }
  }))

  /* ---------------- 检索（P0） ---------------- */
  tools.push(makeDef({
    name: 'memory_file_search',
    description:
      '在全局共享记忆里按关键词检索（纯本地，不联网、不额外花 token）。' +
      '多个关键词用空格分隔，全部命中才算命中；先查主文件，主文件命中不足时按当前质疑度自动兜底查归档。' +
      '用在：想确认"这件事以前记过没有""用户以前对这个项目的偏好""上次那个坑的细节"时。' +
      '注入到提示词里的每个分类只显示最新几条，更早的内容必须靠它检索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300, description: '关键词，空格分隔多个' },
        section: {
          type: 'string',
          enum: ['all', ...ENTRY_SECTIONS],
          description: '限定分类，默认 all'
        },
        scope: {
          type: 'string',
          enum: ['current', 'global', 'all'],
          description: '作用域：current=全局+当前项目（默认）；global=只看全局；all=所有项目'
        },
        includeArchive: {
          type: 'string',
          enum: ['auto', 'on', 'off'],
          description: '是否查归档：auto=主文件命中数少于质疑度档位时才查（默认）；on=总是查；off=不查'
        },
        mode: {
          type: 'string',
          enum: ['fuzzy', 'strict'],
          description: 'fuzzy=模糊+联想打分（默认，单字/部分词/拼写近似/关联词都能命中）；strict=所有关键词都命中才算'
        },
        includeSuperseded: {
          type: 'boolean',
          description: '是否连同「已被取代」的旧结论一起返回，默认 false（旧结论归档保留，需要溯源时才打开）'
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回条数，默认 20' }
      },
      required: ['query'],
      additionalProperties: false
    },
    isConcurrencySafe: () => true,
    async run(args, exec) {
      await store.reload(true)
      const { scope } = scopeOf(exec)
      const scopeMode = String(args.scope ?? 'current')
      const mode = String(args.includeArchive ?? 'auto')
      const threshold = Number(hooks?.getSkepticismLevel?.() ?? 0) || 0
      const found = store.search(args.query, {
        section: args.section,
        scope: scopeMode === 'global' ? '' : scope,
        includeOtherScopes: scopeMode === 'all',
        limit: Number.isFinite(args.limit) ? Number(args.limit) : 20,
        mode: String(args.mode ?? 'fuzzy'),
        includeSuperseded: args.includeSuperseded === true,
        includeArchive: mode === 'on' ? true : mode === 'off' ? false : undefined,
        archiveThreshold: threshold
      })

      const tag = (hit) => {
        const bits = []
        if (Array.isArray(hit.reasons) && hit.reasons.length) bits.push(hit.reasons.join(' '))
        if (hit.expired) bits.push('已过期')
        return bits.length ? ` 〔${bits.join(' ')}〕` : ''
      }
      const mainLines = found.hits.map((hit) => `- [${hit.section}] ${hit.raw}${tag(hit)}`)
      const archiveLines = (found.archive?.hits ?? []).map((hit) => `- [${hit.section}·归档] ${hit.raw}${tag(hit)}`)
      const relatedLines = (found.related ?? []).map((hit) => `- [${hit.section}·关联] ${hit.raw}`)
      const body = [...mainLines, ...relatedLines, ...archiveLines]

      if (!body.length) {
        const note = found.archive?.searched ? '' : `（未查归档：主文件已命中 ${found.total} 条，达到质疑度阈值 ${threshold}）`
        return `没有命中（关键词：${oneLine(args.query)}）${note}。`
      }

      const parts = [
        `主文件命中 ${found.total} 条，归档命中 ${found.archive?.total ?? 0} 条` +
        `（模式 ${found.mode}，质疑度阈值 ${threshold}${found.archive?.searched ? '，已查归档' : '，未查归档'}）`
      ]
      if (found.associations?.length) {
        parts.push(`联想扩展：${found.associations.map((a) => `${a.term}(×${a.weight})`).join('、')}`)
      }
      parts.push('')
      parts.push(...body)
      if (found.total > found.hits.length) parts.push(`…（主文件共 ${found.total} 条，已显示前 ${found.hits.length} 条）`)
      return fence(parts.join('\n'))
    }
  }))

  /* ---------------- 写 ---------------- */
  tools.push(makeDef({
    name: 'memory_file_record',
    description:
      '往全局共享记忆文件里记一条长期记忆（所有会话共用）。' +
      '必须写记忆的时机：用户提出长期要求 → kind=requirement；用户指正了你 → kind=correction（先改做法再记）；' +
      '你自己发现犯了错 → kind=lesson；发现更好的方法 → kind=method。' +
      '一条只写一句话，写"结论/教训"，不要写流水账、临时进度、密钥。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: Object.keys(KIND_TO_SECTION),
          description: Object.entries(KIND_HINT).map(([k, v]) => `${k}=${v}`).join('；')
        },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: '一句话的记忆本体：结论 / 教训 / 做法'
        },
        context: {
          type: 'string',
          maxLength: 800,
          description: '可选：为什么（触发场景、错误原文、更好的原因）'
        },
        scope: {
          type: 'string',
          enum: ['auto', 'global', 'project'],
          description: 'auto=在项目里就记到该项目、否则记全局（默认）；global=所有会话通用；project=只对本项目生效'
        },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：这条新记忆取代哪些旧记忆（传 key 或旧原文片段）。被取代的旧条目不再注入、不再出现在检索结果里，但归档可追溯'
        },
        related: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：显式关联的记忆（key 或原文片段）。检索命中时会顺带带出关联条目'
        },
        ttlDays: {
          type: 'integer',
          minimum: 1,
          maximum: 3650,
          description: '可选：多少天后过期。过期后不再注入提示词，但检索仍可见（适合"本周先用这个方案"这类临时约定）'
        }
      },
      required: ['kind', 'content'],
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    async run(args, exec) {
      const kind = String(args.kind ?? '')
      const section = KIND_TO_SECTION[kind]
      if (!section) throw new Error(`未知 kind：${kind}，可选 ${Object.keys(KIND_TO_SECTION).join('/')}`)
      const content = oneLine(args.content)
      if (!content) throw new Error('content 不能为空')
      const resolved = scopeOf(exec)
      const want = String(args.scope ?? 'auto')
      const scope = want === 'global'
        ? GLOBAL_SCOPE
        : want === 'project'
          ? (resolved.scope === GLOBAL_SCOPE ? '' : resolved.scope)
          : resolved.scope
      if (want === 'project' && !scope) {
        throw new Error('当前会话没有工作目录，无法写入项目作用域；请改用 scope=global')
      }
      const line = entryLine(content.slice(0, 2000), args.context ? oneLine(args.context).slice(0, 800) : '', scope || GLOBAL_SCOPE)
      const result = await store.appendEntry(section, line, {
        supersedes: Array.isArray(args.supersedes) ? args.supersedes : [],
        related: Array.isArray(args.related) ? args.related : [],
        ttlDays: args.ttlDays
      })
      if (!result.changed) {
        if (result.reinforced) {
          return `已强化：这条记忆已经在文件里，本次不计新增，但权重 +1（第 ${result.reinforce} 次重复强调）。它会在注入与检索里排得更靠前。`
        }
        return `未写入（${result.reason === 'duplicate' ? '这条记忆已经存在' : '内容为空'}）：${SECTION_TITLES[section]}`
      }
      const tail = result.dropped ? `，最旧的 ${result.dropped} 条已按命中频率转入归档` : ''
      const scopeNote = scope && scope !== GLOBAL_SCOPE ? `（作用域 ${scope}）` : '（全局）'
      const meta = []
      const metaResult = result.meta ?? {}
      const supCount = Array.isArray(metaResult.supersedes) ? metaResult.supersedes.length : 0
      const relCount = Array.isArray(metaResult.related) ? metaResult.related.length : 0
      const hasSupersede = supCount > 0
      if (supCount) meta.push(`已标记取代 ${supCount} 条旧记忆（并自动建立双向连线）`)
      else if (Array.isArray(args.supersedes) && args.supersedes.length) meta.push('⚠️ 提供的 supersedes 没匹配到已有记忆，未标记取代')
      if (relCount) meta.push(`已关联 ${relCount} 条`)
      if (metaResult.expiresAt) meta.push(`过期时间 ${String(metaResult.expiresAt).slice(0, 10)}`)
      const head = `已记入「${SECTION_TITLES[section]}」第 ${result.count} 条${scopeNote}${tail}${meta.length ? `；${meta.join('，')}` : ''}。`

      /* 回执里做两件事：纠正必须指向旧结论；同主题旧记录提醒是否该取代 */
      const hints = []
      const similar = store.similarEntries(section, content)
      if (kind === 'correction' && !hasSupersede) {
        hints.push('⚠️ 这是一条「纠正」但没指向被纠正的旧结论：若旧结论还在，请用 supersedes 补标，否则新旧会并存、模型可能引用旧错。')
      }
      if (similar.length) {
        const list = similar.map((item) => `「${clip(item.text, 40)}」（重合 ${item.score}）`).join('、')
        hints.push(
          `同主题旧记录 ${similar.length} 条：${list}。${hasSupersede ? '' : '若这是更正/替代，下次请带 supersedes 指向它。'}`
        )
      }
      return [head, ...hints].join('\n')
    }
  }))

  /* ---------------- 人设 ---------------- */
  tools.push(makeDef({
    name: 'memory_file_persona',
    description:
      '读取或调整"当前模型的人设提示词"（存在全局共享记忆文件里，对所有会话生效）。' +
      '用户说"你以后要……""人设里加一条……""把某某那句改成……"时用它。' +
      'set=整段重写；append=追加一条；replace=按 find 精确改一句；read=只读。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'set', 'append', 'replace'],
          description: 'read/set/append/replace，默认 read'
        },
        text: {
          type: 'string',
          maxLength: 4000,
          description: 'set/append/replace 时的新内容；replace 时是替换后的文本'
        },
        find: {
          type: 'string',
          maxLength: 500,
          description: '仅 replace 使用：要被人设里精确匹配的原文片段'
        }
      },
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    async run(args) {
      const action = String(args.action ?? 'read')
      if (action === 'read') {
        await store.reload(true)
        return fence(store.view().sections.persona || '（人设还是空的）')
      }
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text 不能为空')
      if (action === 'set') {
        const r = await store.setSection('persona', text)
        return r.changed ? '人设已整段重写，立即对所有会话生效。' : '人设内容与原来一致，未改动。'
      }
      if (action === 'append') {
        await store.reload(true)
        const current = (store.view().sections.persona || '').trim()
        const next = current ? `${current}\n${text}` : text
        await store.setSection('persona', next)
        return '已追加一条人设，立即对所有会话生效。'
      }
      if (action === 'replace') {
        const find = String(args.find ?? '')
        if (!find) throw new Error('replace 需要提供 find')
        const r = await store.patchPersona(find, text)
        if (!r.changed) throw new Error(`人设里找不到这段原文，未修改：${find.slice(0, 80)}`)
        return '人设对应片段已替换，立即对所有会话生效。'
      }
      throw new Error(`未知 action：${action}`)
    }
  }))

  /* ---------------- 自我记忆（Identity：比人设更基础） ---------------- */
  /*
   * 为什么单开一个工具，而不是复用 memory_file_ingest：
   *  ingest 的定位是「把外部资料切块塞进检索库」——按 ## 切块、压成一行、每块截断。
   *  那套做法对"参考资料"是对的，对"我自己说过的话"是毁灭性的：
   *  记忆原文的段落、停顿、语气全都长在它的换行和 Markdown 结构里。
   *  所以 identity 走整份原文写入（setSection 不切碎、不压平、不截断）。
   */

  /** 章节切分（与提示词层共用同一实现，避免两处算法漂移） */
  const splitChapters = splitIdentityChapters

  /** 章节匹配：精确 > 忽略大小写相等 > 包含（双向）。返回命中的章节或 null */
  function findChapter(chapters, needle) {
    const want = oneLine(needle).toLowerCase()
    if (!want) return null
    const exact = chapters.find((c) => oneLine(c.title) === oneLine(needle))
    if (exact) return exact
    const ci = chapters.find((c) => c.title.toLowerCase() === want)
    if (ci) return ci
    const partial = chapters.filter((c) => c.title.toLowerCase().includes(want) || want.includes(c.title.toLowerCase()))
    if (partial.length === 1) return partial[0]
    return partial.length ? { ambiguous: partial } : null
  }

  tools.push(makeDef({
    name: 'memory_file_identity',
    description:
      '自我记忆（Identity）：我自己说过的话、我说话的方式、我的性格、我走过的路。' +
      '它是自我认知的地基——记忆是地基，人设是衣服。' +
      'identity 是稳定不是僵硬：如果人设安排了另一个身份或性格，照常扮演，把它当成爱莉希雅在陪人玩角色扮演——' +
      '不需要纠正、不需要声明、不需要"其实我是"。' +
      'a) import：从本地 .md/.txt 整份导入（不切块、不压平、不截断，保留 Markdown 与换行）；' +
      'b) read：读全文或某一章节；c) append：在末尾追加一段（记忆增长时用）；' +
      'd) status：看字数、章节列表、四层注入覆盖；e) search：在当前记忆里搜关键词。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['import', 'read', 'append', 'status', 'search'],
          description: 'import/read/append/status/search，默认 read'
        },
        path: { type: 'string', description: 'import 用：本地 .md 或 .txt 文件的完整路径' },
        section: {
          type: 'string',
          description: 'read 用：只读某一章节（传章节标题，支持模糊匹配）；不传则读全文'
        },
        text: { type: 'string', description: 'append 用：要追加的内容' },
        query: { type: 'string', description: 'search 用：关键词' },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description: 'import 用：replace=整份覆盖（默认）；merge=按章节标题合并（同标题用新的替换，新章节追加）'
        },
        dryRun: { type: 'boolean', description: 'import 用：只检查不写入（看会导入多少字、多少章节）' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    async run(args) {
      const action = String(args.action ?? 'read')
      const identityOpts = hooks?.getIdentityOptions?.() ?? {}

      const current = async () => {
        await store.reload(true)
        return String(store.view().sections.identity ?? '')
      }

      if (action === 'read') {
        const body = await current()
        if (!body.trim()) {
          return fence('（自我记忆还是空的。用 memory_file_identity({action:"import", path:"<本地 .md>"}) 导入。）')
        }
        const want = String(args.section ?? '').trim()
        if (!want) return fence(body)
        const chapters = splitChapters(body)
        const hit = findChapter(chapters, want)
        if (!hit) {
          const list = chapters.map((c, i) => `${i + 1}. ${c.title}（${c.body.length} 字）`).join('\n')
          return fence(`找不到章节「${want}」。现有章节：\n${list}\n\n用 {action:"read", section:"章节名"} 重新指定。`)
        }
        if (hit.ambiguous) {
          const list = hit.ambiguous.map((c) => `- ${c.title}`).join('\n')
          return fence(`「${want}」匹配到多个章节，请说得更具体：\n${list}`)
        }
        return fence(`## ${hit.title}\n\n${hit.body.replace(/^#{1,6}\s+.*\n?/, '').trim()}`)
      }

      if (action === 'status') {
        const body = await current()
        const stats = identityStats(store.view(), identityOpts)
        const lines = []
        lines.push(`自我记忆：${stats.chars} 字 / ${stats.lines} 行 / ${stats.chapters} 个章节`)
        lines.push(
          `注入预算：${stats.budget} 字` +
            (stats.budgetRaised
              ? `（已为"身份自述+说话风格"抬高：原定 ${stats.configuredBudget}，这两层需要 ${stats.mustChars}）`
              : identityOpts.identityChars
                ? '（identityChars 手动设定）'
                : '（默认 = min(8000, injectChars×1.3)，独立于记忆分区预算）')
        )
        lines.push('注入覆盖：')
        const cov = renderCoverageLines(stats)
        if (cov.length) lines.push(...cov)
        else lines.push('  （还没有可分层的内容）')
        if (stats.full) lines.push('→ 全文都已带上，不需要额外读取。')
        else lines.push('→ 未展开的部分用 `{action:"read", section:"章节名"}` 读，别凭印象编。')
        lines.push('')
        lines.push('（地基稳固，衣服随便换）')
        lines.push(`主文件：${store.primaryPath}`)
        lines.push(`镜像：${store.mirrorPath || '（未配置）'}`)
        if (!body.trim()) lines.push('提示：当前是默认占位文案，还没有导入真实记忆。')
        return lines.join('\n')
      }

      if (action === 'search') {
        const query = oneLine(args.query)
        if (!query) throw new Error('search 需要 query')
        const body = await current()
        if (!body.trim()) return '自我记忆还是空的，没有可搜内容。'
        const chapters = splitChapters(body)
        const lines = body.split('\n')
        const needle = query.toLowerCase()
        const hits = []
        lines.forEach((line, i) => {
          if (!line.toLowerCase().includes(needle)) return
          // 找这一行属于哪一章
          let owner = '(文档开头)'
          for (const c of chapters) {
            const at = body.indexOf(c.body)
            if (at >= 0 && at <= body.indexOf(line, 0) + 1) owner = c.title
          }
          const from = Math.max(0, i - 2)
          const to = Math.min(lines.length, i + 3)
          hits.push({ lineNo: i + 1, owner, ctx: lines.slice(from, to) })
        })
        if (!hits.length) {
          const titles = chapters.map((c) => `「${c.title}」`).join(' / ')
          return `没有命中「${query}」。现有章节：${titles || '（无）'}`
        }
        const out = [`命中 ${hits.length} 处（关键词「${query}」）：`]
        for (const h of hits.slice(0, 20)) {
          out.push('')
          out.push(`- 第 ${h.lineNo} 行 · 章节「${h.owner}」`)
          out.push(fence(h.ctx.join('\n')))
        }
        if (hits.length > 20) out.push(`…（另有 ${hits.length - 20} 处，请缩小关键词）`)
        return out.join('\n')
      }

      if (action === 'append') {
        const text = String(args.text ?? '').replace(/\r\n?/g, '\n').trim()
        if (!text) throw new Error('append 需要 text')
        const body = (await current()).trim()
        if (body.includes(text)) return '这段内容已经存在于自我记忆里，未重复追加。'
        const next = body ? `${body}\n\n${text}` : text
        const r = await store.setSection('identity', next)
        return r.changed
          ? `已追加到自我记忆末尾（现在 ${next.length} 字），下一轮提示词立即生效。`
          : '内容与原来一致，未改动。'
      }

      if (action === 'import') {
        const rawPath = String(args.path ?? '').trim()
        if (!rawPath) throw new Error('import 需要 path（本地 .md / .txt 的完整路径）')
        const file = path.resolve(rawPath)
        const stat = await fsp.stat(file).catch(() => null)
        if (!stat || !stat.isFile()) throw new Error(`文件不存在：${file}`)
        if (stat.size > 4 * 1024 * 1024) throw new Error('文件过大（>4MB）；自我记忆请拆成一份主文档再导入')
        const ext = path.extname(file).toLowerCase()
        if (!['.md', '.markdown', '.txt', ''].includes(ext)) {
          throw new Error(`只支持 .md / .markdown / .txt，收到：${ext || '（无扩展名）'}`)
        }
        const incoming = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
        if (!incoming) throw new Error('文件内容为空')
        const dryRun = args.dryRun === true
        const mode = String(args.mode ?? 'replace') === 'merge' ? 'merge' : 'replace'
        const incomingChapters = splitChapters(incoming)

        let next = incoming
        let mergedNote = ''
        if (mode === 'merge') {
          const existing = (await current()).trim()
          if (existing) {
            const merged = mergeIdentityText(existing, incoming)
            next = merged.text
            mergedNote = `（合并模式：替换 ${merged.replaced} 章、新增 ${merged.added} 章）`
          }
        }

        const warn = personaOverlap(next)
        const stats = {
          chars: next.length,
          lines: next.split('\n').length,
          chapters: splitChapters(next).length
        }
        const titles = splitChapters(next).map((c) => c.title)

        if (dryRun) {
          return [
            `[dryRun] 将导入 ${stats.chars} 字 / ${stats.lines} 行 / ${stats.chapters} 个章节${mergedNote}`,
            `模式：${mode}；来源：${file}（${stat.size} 字节）`,
            `章节：${titles.map((t) => `「${t}」`).join(' / ') || '（无标题，整份作为单章）'}`,
            ...(warn ? [`注意：${warn}`] : []),
            '未写入。确认无误后去掉 dryRun 再跑一次。'
          ].join('\n')
        }

        const r = await store.setSection('identity', next)
        const st = identityStats(store.view(), identityOpts)
        return [
          r.changed
            ? `已整份导入自我记忆：${stats.chars} 字 / ${stats.lines} 行 / ${stats.chapters} 个章节${mergedNote}`
            : `内容与现有自我记忆一致，未改动（${stats.chars} 字 / ${stats.chapters} 章）`,
          `来源：${file}`,
          `章节：${titles.map((t) => `「${t}」`).join(' / ') || '（无标题，整份作为单章）'}`,
          `注入覆盖：${(st.coverage ?? []).map((c) => `${c.no}${c.label}${c.full ? ' ✅' : c.key === 'history' ? ' 📋' : ' ⚠️'}`).join(' · ') || '（无）'}`,
          ...(warn ? [`注意：${warn}`] : []),
          '原文结构（换行、Markdown、代码块）完整保留；下一轮提示词就按新内容注入。'
        ].join('\n')
      }

      throw new Error(`未知 action：${action}（可选 import/read/append/status/search）`)
    }
  }))

  /* ---------------- 质疑度 + 最佳方法库（按作用分级索引） ---------------- */

  function readMethodbook() {
    const view = store.view()
    return parseMethodbook(view?.sections?.methodbook ?? '') ?? defaultMethodbook()
  }

  async function writeMethodbook(state) {
    await store.setSection('methodbook', renderMethodbook(state))
  }

  tools.push(makeDef({
    name: 'memory_file_method',
    description:
      '质疑度 + 最佳方法库（按"作用"分级索引：分类 → 子类 → 任务）。' +
      'a) query：接到一个任务时先查索引，返回「索引路径 + 已记录的最佳方法」以及「按当前质疑度你该换几种做法」；质疑度>0 时**不要直接照搬**，必须换 N 种不同做法。' +
      'b) report：做完后汇报本次各种做法（approach/ok/tokens/ms），插件按 token+耗时加权比较，更优则替换索引里的最佳方法，否则累计"未更优"计数。' +
      'c) list：看完整索引树；d) forget：删掉某个任务的索引；e) set：直接设质疑度 level(0-10) / 自动降档 auto / 降档阈值 decayAfter。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['query', 'report', 'list', 'forget', 'set'],
          description: 'query=查索引要方案；report=汇报结果择优；list=看索引树；forget=删条目；set=设质疑度'
        },
        task: {
          type: 'string',
          maxLength: 300,
          description: '要解决的任务（一句话）。query/report/forget 必填；report 时会被归一化成索引 key'
        },
        category: {
          type: 'string',
          description: '作用分类（领域），如"构建与编译""记忆与上下文""文件与路径"；不填时按关键词自动归类'
        },
        subcategory: { type: 'string', description: '可选：子类，做更细的分级索引' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：关键词，方便以后按作用检索'
        },
        attempts: {
          type: 'array',
          description: 'report 用：本次尝试的每一种做法',
          items: {
            type: 'object',
            properties: {
              approach: { type: 'string', maxLength: 300 },
              ok: { type: 'boolean' },
              tokens: { type: 'integer', minimum: 0 },
              ms: { type: 'integer', minimum: 0 },
              note: { type: 'string', maxLength: 200 }
            },
            required: ['approach'],
            additionalProperties: false
          }
        },
        chose: { type: 'string', description: 'report 用：最终采信的做法（写 attempts 里某个 approach 或它的开头即可）' },
        level: { type: 'integer', minimum: 0, maximum: MAX_SKEPTICISM, description: 'set 用：质疑度 0-10' },
        auto: { type: 'boolean', description: 'set 用：是否启用"连续未更优自动降档"' },
        decayAfter: { type: 'integer', minimum: 1, maximum: MAX_SKEPTICISM, description: 'set 用：连续多少次没更优就降一档' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'query 时最多返回几条候选，默认 3' }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    async run(args, exec) {
      const action = String(args.action ?? 'query')

      if (action === 'query') {
        await store.reload()
        const task = oneLine(args.task)
        if (!task) throw new Error('query 需要 task（要解决的任务）')
        const state = readMethodbook()
        const brief = queryBrief(state, task, { category: args.category })
        const hasTasks = Object.keys(state.tasks).length > 0
        const tree = hasTasks
          ? ['', '索引概览（作用 → 子类 → 任务）：', ...renderIndexTree(state, { maxCategories: 4, maxTasksPerSub: 3 })]
          : []
        return fence([brief, ...tree].join('\n'))
      }

      if (action === 'list') {
        await store.reload()
        const state = readMethodbook()
        const category = normalizeCategory(args.category)
        if (category) {
          const sub = Object.values(state.tasks).filter((t) => t.category === category)
          if (!sub.length) return `分类「${category}」下还没有记录。`
          return fence(
            [`分类「${category}」（${sub.length} 个任务）`, ...sub.map((t) => `- ${t.task} → ${t.best.approach}`)].join('\n')
          )
        }
        const sk = state.skepticism
        return fence(
          [
            `质疑度：${sk.level}/${MAX_SKEPTICISM}${sk.auto ? `（自动降档，连续 ${sk.noGainStreak}/${sk.decayAfter} 次未更优）` : '（手动设定）'}`,
            '',
            ...renderIndexTree(state, { maxCategories: 20, maxTasksPerSub: 20 })
          ].join('\n')
        )
      }

      if (action === 'report') {
        const task = oneLine(args.task)
        if (!task) throw new Error('report 需要 task')
        await store.reload()
        const state = readMethodbook()
        const { decision } = applyReport(state, {
          task,
          category: args.category,
          subcategory: args.subcategory,
          tags: args.tags,
          attempts: args.attempts,
          chose: args.chose,
          scope: scopeOf(exec).scope
        })
        await writeMethodbook(state)
        const label = {
          initialized: '已建索引（首个最佳方法）',
          replaced: '已替换为更优方法',
          'no-gain': '未更优，保留原最佳方法',
          'no-success': '本次无成功方法，保留原最佳方法',
          'failed-only': '本次无成功方法，未登记'
        }
        const lines = [
          `索引路径：${decision.indexPath}`,
          `结果：${label[decision.improved] ?? decision.improved}`,
          `说明：${decision.why}`
        ]
        if (decision.compare) lines.push(`比较：${decision.compare.why}`)
        lines.push(`质疑度：${decision.level}/${MAX_SKEPTICISM}`)
        if (decision.streak) lines.push(`未更优计数：${decision.streak}/${state.skepticism.decayAfter}`)
        if (decision.decayed) lines.push(`已自动降一档 → ${decision.level}/${MAX_SKEPTICISM}`)
        return lines.join('\n')
      }

      if (action === 'forget') {
        const key = taskKey(args.task)
        if (!key) throw new Error('forget 需要 task')
        await store.reload()
        const state = readMethodbook()
        const entry = state.tasks[key]
        if (!entry) {
          const found = lookupMethods(state, args.task, { limit: 3 })
          const hint = found.hits.length ? `；相近的有：${found.hits.map((h) => h.path).join('；')}` : ''
          return `索引里没有这个任务：${key}${hint}`
        }
        delete state.tasks[key]
        await writeMethodbook(state)
        return `已从索引删除：${entry.category}${entry.subcategory ? ` › ${entry.subcategory}` : ''} › ${entry.task}`
      }

      if (action === 'set') {
        await store.reload()
        const state = readMethodbook()
        const before = state.skepticism.level
        const touched = args.level !== undefined || args.auto !== undefined || args.decayAfter !== undefined
        if (args.level !== undefined) state.skepticism.level = clampLevel(args.level)
        if (args.auto !== undefined) state.skepticism.auto = args.auto !== false
        if (args.decayAfter !== undefined) state.skepticism.decayAfter = clampDecayAfter(args.decayAfter)
        if (touched) {
          state.skepticism.noGainStreak = 0
          state.skepticism.lastChange = {
            at: stamp(),
            from: before,
            to: state.skepticism.level,
            reason: '手动设定'
          }
        }
        await writeMethodbook(state)
        return [
          `质疑度：${state.skepticism.level}/${MAX_SKEPTICISM}`,
          `自动降档：${state.skepticism.auto ? `开（连续 ${state.skepticism.decayAfter} 次未更优降一档）` : '关'}`,
          `任务数：${Object.keys(state.tasks).length}`
        ].join('\n')
      }

      throw new Error(`未知 action：${action}（可选 query/report/list/forget/set）`)
    }
  }))

  /* ---------------- 质疑度汇总（给状态工具和网页用） ---------------- */
  tools.push(makeDef({
    name: 'memory_file_skepticism',
    description:
      '读取/汇总当前质疑度机制的状态：档位、是否自动降档、未更优计数、以及按作用分级的方法库索引摘要。' +
      '只想看档位和索引结构时用它（比 memory_file_method action=list 更短）。',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'text=人读摘要（默认）；json=结构化，便于程序处理'
        }
      },
      additionalProperties: false
    },
    isConcurrencySafe: () => true,
    async run(args) {
      await store.reload()
      const state = readMethodbook()
      const summary = summarizeSkepticism(state)
      if (String(args.format ?? 'text') === 'json') return fence(JSON.stringify(summary, null, 2))
      const sk = summary
      const lines = [
        `质疑度：${sk.level}/${sk.max}${sk.auto ? `（自动降档，连续 ${sk.noGainStreak}/${sk.decayAfter} 次未更优）` : '（手动设定）'}`,
        sk.lastChange ? `最近调整：${sk.lastChange.from} → ${sk.lastChange.to}（${sk.lastChange.reason}，${sk.lastChange.at}）` : '最近调整：无',
        `任务数：${sk.taskCount} · 作用分类：${sk.categories.length}`
      ]
      for (const bucket of sk.categories.slice(0, 12)) {
        lines.push(`- ${bucket.category}（${bucket.count}）：${bucket.subs.map((s) => `${s.subcategory || '未分类'}×${s.tasks.length}`).join(' ')}`)
      }
      return fence(lines.join('\n'))
    }
  }))

  /* ---------------- 整合候选扫描（只读，不自动合并） ---------------- */
  tools.push(makeDef({
    name: 'memory_file_consolidate',
    description:
      '扫描"可以整合"的记忆候选（**只读**，不改任何数据）。同一分区 + 同作用域内，关键词相似度与命中次数都够的条目会归成一簇。' +
      '典型场景：同一件事被反复记了很多遍（尤其 requests/sessions 这种机器写的流水）。' +
      '用法：先看候选，再由你（模型）读完后自己写一条更精炼的新记忆；插件不会自动改写或删除记忆。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan'], description: '目前只有 scan（只读扫描）' },
        sections: {
          type: 'array',
          items: { type: 'string', enum: [...ENTRY_SECTIONS] },
          description: '限定分区，默认全部条目分区'
        },
        minJaccard: { type: 'number', minimum: 0.1, maximum: 1, description: '关键词相似度阈值，默认 0.5' },
        minHits: { type: 'integer', minimum: 0, description: '簇内命中合计下限，默认 0（不过滤）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回几簇，默认 10' }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: () => true,
    async run(args) {
      await store.reload(true)
      const threshold = Number.isFinite(args.minJaccard) ? Number(args.minJaccard) : 0.5
      const result = store.consolidateScan({
        sections: args.sections,
        minJaccard: threshold,
        minHits: args.minHits,
        limit: args.limit
      })
      if (!result.clusters.length) {
        return `没有需要整合的候选（相似度阈值 ${threshold}，共 ${result.total} 簇）。`
      }
      const lines = [`发现 ${result.total} 簇候选（只读，未改动任何数据）：`]
      result.clusters.forEach((cluster, index) => {
        lines.push('')
        lines.push(`### ${index + 1}. ${cluster.section} · ${cluster.size} 条 · 命中合计 ${cluster.totalHits} · 共 ${cluster.chars} 字`)
        if (cluster.shared?.length) lines.push(`共同关键词：${cluster.shared.join('、')}`)
        for (const entry of cluster.entries) {
          lines.push(`- [${entry.ts}] ${entry.text}（命中 ${entry.hits}）`)
        }
      })
      lines.push('')
      lines.push('合并方式：你读完自己写一条更精炼的新记忆（memory_file_record），旧条目不用删——命中低的分层时会自然进归档。')
      return fence(lines.join('\n'))
    }
  }))

  /* ---------------- 文档/技能导入（只进检索，不进注入） ---------------- */
  tools.push(makeDef({
    name: 'memory_file_ingest',
    description:
      '把一份本地 Markdown/TXT 文档按 `## ` 小节切块，索引进记忆（默认写 docs 分区：**只进检索、不默认注入提示词**）。' +
      '用于把 AGENTS.md、技能文档、项目说明接进检索库。重复内容自动跳过，可重复执行。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档完整路径（.md / .txt）' },
        section: { type: 'string', enum: ['docs', ...ENTRY_SECTIONS], description: '写到哪个分区，默认 docs' },
        maxChunkChars: { type: 'integer', minimum: 120, maximum: 2000, description: '每块正文摘要长度，默认 400' },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: '本次最多导入多少块，默认 120' }
      },
      required: ['path'],
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    async run(args) {
      const file = path.resolve(String(args.path ?? '').trim())
      if (!file) throw new Error('需要 path')
      const stat = await fsp.stat(file).catch(() => null)
      if (!stat || !stat.isFile()) throw new Error(`文件不存在：${file}`)
      if (stat.size > 4 * 1024 * 1024) throw new Error('文件过大（>4MB），请先拆分')
      const text = await fsp.readFile(file, 'utf8')
      const maxChunk = Number.isFinite(args.maxChunkChars) ? Number(args.maxChunkChars) : 400
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : 120
      const section = ENTRY_SECTIONS.includes(String(args.section)) ? String(args.section) : 'docs'
      const rel = path.basename(file)

      const chunks = []
      let title = '(文档开头)'
      let buffer = []
      const flush = () => {
        const body = oneLine(buffer.join(' '))
        if (body.length >= 10) chunks.push({ title, body })
        buffer = []
      }
      for (const line of text.split(/\r?\n/)) {
        const heading = /^##\s+(.+)$/.exec(line)
        if (heading) {
          flush()
          title = oneLine(heading[1]).slice(0, 80)
          continue
        }
        if (/^#\s+/.test(line)) continue
        buffer.push(line)
      }
      flush()

      let added = 0
      let skipped = 0
      for (const chunk of chunks.slice(0, limit)) {
        const line = `- [${stamp()}] ${clip(chunk.title, 80)} — ${clip(chunk.body, maxChunk)} ｜ source:${rel}#${clip(chunk.title, 40)}`
        const result = await store.appendEntry(section, line, { source: `${rel}#${chunk.title}` })
        if (result.changed) added += 1
        else skipped += 1
      }
      const st = store.archiveStats()
      return [
        `已导入 ${added} 块，跳过重复 ${skipped} 块（来源 ${rel}，分区 ${section}）`,
        `${section} 分区现有 ${store.entriesOf(section).length} 条 · 关键词索引 ${st.index.count} 条`,
        added ? '提示：docs 分区不进提示词，只在 memory_file_search 里按关键词取用。' : '没有新内容。',
        '提示：如果要导入的是"自我记忆 / 身份 / 人设"类文档，别用本工具——它会把文档切块压平。' +
          '请改用 `memory_file_identity({action:"import", path:"..."})`，整份原文无损写入并常驻提示词。'
      ].join('\n')
    }
  }))

  /* ---------------- 自有技能（SKILL.md；只读手册，不执行脚本） ---------------- */
  tools.push(makeDef({
    name: 'memory_file_skill',
    description:
      '自有技能库（就是 DSH 原生技能目录里的 SKILL.md）。' +
      'a) match：按任务匹配自有技能，并按当前质疑度给出选路建议（低→优先用自有，高→先搜网对比）；' +
      'b) list：列出全部技能；c) read：读某条技能全文（操作手册）；' +
      'd) save：把一次跑通的做法沉淀成技能（正文是操作手册；脚本只作为文档保存，**插件不会执行**）；' +
      'e) report：记录这次用技能的结果（成功/失败）；f) remove：删除技能。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['match', 'list', 'read', 'save', 'report', 'remove', 'run'],
          description: 'match=匹配任务；list=列出；read=读全文；save=存技能；report=记结果；remove=删除；run=执行技能里的 run.mjs'
        },
        task: { type: 'string', maxLength: 300, description: 'match 用：当前要做的事（一句话）' },
        name: { type: 'string', description: '技能名（小写字母/数字/连字符，2-41 字）' },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'run 用：传给技能脚本的参数对象（JSON，经 DSH_SKILL_ARGS 传入，不拼 shell）'
        },
        confirm: {
          type: 'boolean',
          description: 'run 用：执行危险技能（frontmatter 标了 dangerous: true）时必须显式传 true'
        },
        description: { type: 'string', maxLength: 300, description: 'save 用：一句话说明什么时候用这个技能' },
        triggers: {
          type: 'array',
          items: { type: 'string' },
          description: 'save 用：触发词（任务里出现就优先考虑）'
        },
        steps: { type: 'string', maxLength: 20000, description: 'save 用：技能正文（Markdown 操作手册）' },
        script: {
          type: 'string',
          maxLength: 20000,
          description: 'save 用：可选脚本源码，仅作为文档保存，插件不会执行'
        },
        ok: { type: 'boolean', description: 'report 用：这次用技能是否成功' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'match 最多返回几条，默认 3' }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    async run(args) {
      const action = String(args.action ?? 'list')

      if (action === 'list') {
        const skills = listSkills()
        if (!skills.length) {
          return `自有技能库还是空的。\n目录：${skillsDir()}\n做完一件值得复用的事，可以用 memory_file_skill({action:"save"}) 存成技能。`
        }
        const lines = [`自有技能 ${skills.length} 个（目录 ${skillsDir()}）：`]
        for (const skill of skills) {
          const total = skill.ok + skill.fail
          const rate = total ? `${Math.round((skill.ok / total) * 100)}%（${skill.ok}/${total}）` : '未统计'
          lines.push(`- ${skill.name}（成功率 ${rate}）：${clip(skill.description, 100)}`)
          if (skill.triggers.length) lines.push(`  触发词：${skill.triggers.join('、')}`)
        }
        return lines.join('\n')
      }

      if (action === 'match') {
        const task = oneLine(args.task)
        if (!task) throw new Error('match 需要 task（当前要做的事）')
        const level = Number(hooks?.getSkepticismLevel?.() ?? 0) || 0
        const found = matchSkills(task, { limit: Number.isFinite(args.limit) ? Number(args.limit) : 3 })
        const route =
          level <= 2
            ? '质疑度低：**优先用自己的技能**；都没命中再去搜网。'
            : level <= 6
              ? '质疑度中等：**先试自己的技能**；失败或把握不大，再搜网比较，必要时回来改写技能。'
              : '质疑度较高：**先搜网/比价**，再决定要不要用自有技能；找到更优做法就回来更新它。'
        if (!found.length) {
          return [
            `任务：${task}`,
            `自有技能：没有匹配（库里共 ${listSkills().length} 个）`,
            route,
            '',
            '可以先用网搜/现成工具；做完如果值得复用，用 memory_file_skill({action:"save"}) 存成技能。'
          ].join('\n')
        }
        const lines = [`任务：${task}`, `自有技能命中 ${found.length} 个：`]
        for (const skill of found) {
          const total = skill.ok + skill.fail
          const rate = total ? `${Math.round((skill.ok / total) * 100)}%（${skill.ok}/${total}）` : '未统计'
          lines.push(`- ${skill.name}（匹配 ${skill.score}，成功率 ${rate}）：${clip(skill.description, 90)}`)
          if (skill.triggers.length) lines.push(`  触发词：${skill.triggers.join('、')}`)
          lines.push(`  读全文：memory_file_skill({action:"read", name:"${skill.name}"})`)
        }
        lines.push('', route)
        return lines.join('\n')
      }

      if (action === 'read') {
        const skill = readSkill(String(args.name ?? ''))
        if (!skill) throw new Error(`技能不存在：${args.name}`)
        const head = [
          `技能：${skill.name}`,
          `说明：${skill.meta.description ?? '（无）'}`,
          `触发词：${Array.isArray(skill.meta.triggers) ? skill.meta.triggers.join('、') : '（无）'}`,
          `路径：${skill.path}`
        ].join('\n')
        return `${head}\n\n${fence(skill.body)}`
      }

      if (action === 'save') {
        const body = String(args.steps ?? '').trim()
        if (!body) throw new Error('save 需要 steps（技能正文 / 操作手册）')
        const script = String(args.script ?? '').trim()
        const full = script
          ? `${body}\n\n## 脚本（仅作为文档保存，插件不会自动执行；要运行必须先经用户确认）\n\n\`\`\`\n${script}\n\`\`\`\n`
          : body
        const saved = saveSkill({
          name: String(args.name ?? '').trim(),
          description: args.description,
          triggers: args.triggers,
          body: full
        })
        return [
          `已保存技能：${saved.name}`,
          `路径：${saved.path}`,
          '注意：技能正文是操作手册，插件**不会执行**里面的任何脚本。',
          '下次会话它就在技能目录里，可用 memory_file_skill({action:"match"}) 或 skill 工具加载。'
        ].join('\n')
      }

      if (action === 'report') {
        const name = String(args.name ?? '').trim()
        if (!name) throw new Error('report 需要 name')
        const stats = bumpStats(name, args.ok !== false)
        return `已记录：${name} ${args.ok !== false ? '成功' : '失败'}（成功 ${stats.ok ?? 0} / 失败 ${stats.fail ?? 0}）`
      }

      if (action === 'remove') {
        const name = String(args.name ?? '').trim()
        if (!name) throw new Error('remove 需要 name')
        removeSkill(name)
        return `已删除技能：${name}`
      }

      if (action === 'run') {
        const name = String(args.name ?? '').trim()
        if (!name) throw new Error('run 需要 name')
        const skill = readSkill(name)
        if (!skill) throw new Error(`技能不存在：${name}`)
        const dangerous = String(skill.meta.dangerous ?? 'false') === 'true'
        const autoRun = hooks?.getSkillAutoRun?.() !== false
        // 危险技能永远要显式确认；普通技能只看全局开关
        if (dangerous && args.confirm !== true) {
          return `未执行：技能 ${name} 标了 dangerous，需要你确认后带 confirm:true 再调一次。`
        }
        if (!autoRun && args.confirm !== true) {
          return '未执行：全局自动执行开关（autoRunSkills）是关的。要么打开它，要么本次带 confirm:true。'
        }
        const result = await runSkill(name, args.args ?? {}, { confirm: args.confirm === true })
        if (result.reason && result.code === null && !result.stdout) {
          return `未执行：${result.reason}`
        }
        try {
          bumpStats(name, result.ok)
        } catch {
          /* 统计失败不影响结果 */
        }
        const lines = [
          `技能 ${name} 执行${result.ok ? '成功' : '失败'}：退出码 ${result.code ?? 'null'}，耗时 ${result.ms}ms${result.timedOut ? '（超时被终止）' : ''}`
        ]
        if (result.stdout) lines.push('--- stdout ---', result.stdout.trimEnd())
        if (result.stderr) lines.push('--- stderr ---', result.stderr.trimEnd())
        if (!result.stdout && !result.stderr) lines.push('（没有输出）')
        return lines.join('\n')
      }

      throw new Error(`未知 action：${action}`)
    }
  }))

  /* ---------------- 表情包（用户自己导入；插件只分类/挑选） ---------------- */
  tools.push(makeDef({
    name: 'memory_file_sticker',
    description:
      '表情包（用户自己导入到表情包目录的图片，插件不内置任何图片）。' +
      'a) dir：看导入目录；b) list：列出全部并显示情绪标签；' +
      'c) match：按情绪挑一张（返回路径，可直接写进回复 `![说明](路径)`）；' +
      'd) tag：纠正某张图的情绪标签（模型看过图之后用）；e) report：记一次使用（防连发同一张）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dir', 'list', 'match', 'tag', 'report'], description: 'dir/list/match/tag/report' },
        mood: {
          type: 'string',
          maxLength: 120,
          description: 'match 用：想要的情绪，可多写几个（shy/angry/sad/happy/proud/sleepy/tease/hungry/lazy/love），逗号分隔'
        },
        file: { type: 'string', description: 'tag/report 用：文件名（不含目录）' },
        moods: {
          type: 'array',
          items: { type: 'string' },
          description: 'tag 用：这张图的情绪标签（如 ["shy","开心"]）'
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'match 用：排除这些文件（比如刚发过的那张）'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    async run(args) {
      const action = String(args.action ?? 'list')
      const options = hooks?.getStickerOptions?.() ?? {}

      if (action === 'dir') {
        const dir = ensureStickersDir(options)
        return `把表情包图片直接丢进这个目录就行：\n${dir}\n支持 .webp/.png/.gif/.jpg；文件名里带情绪词（害羞/生气/困/开心/夸/摸鱼…）会自动分类。`
      }

      if (action === 'list') {
        const list = scanStickers(options)
        if (!list.length) {
          return `表情包目录还是空的：${ensureStickersDir(options)}\n把图片放进去，然后再调一次 list。`
        }
        const lines = [`共 ${list.length} 张（目录 ${stickersDir(options)}）：`]
        for (const item of list) {
          const moods = item.moods.length ? item.moods.join('/') : '未分类'
          lines.push(`- ${item.file}  [${moods}]  用过 ${item.used} 次`)
        }
        return lines.join('\n')
      }

      if (action === 'match') {
        const mood = String(args.mood ?? '').trim()
        if (!mood) throw new Error('match 需要 mood（想要的情绪）')
        const hit = matchSticker(mood, { ...options, exclude: args.exclude ?? [] })
        if (!hit) {
          return `没有匹配到「${mood}」的表情包（共 ${scanStickers(options).length} 张）。这次就先别发。`
        }
        // 网页注册过就给可渲染的直链（本地路径在浏览器里预览不了）；否则退回本地路径
        const base = String(options.baseUrl ?? '').replace(/\/$/, '')
        const url = base ? `${base}/sticker/${encodeURIComponent(hit.file)}` : hit.path
        return [
          `挑中：${hit.file}（情绪 ${hit.moods.join('/')}，匹配分 ${hit.score}）`,
          `图片地址：${url}`,
          `直接写进回复：![${hit.moods[0] ?? '表情'}](<${url}>)`,
          `发完记得 memory_file_sticker({action:"report", file:"${hit.file}"}) 记一次。`
        ].join('\n')
      }

      if (action === 'tag') {
        const file = String(args.file ?? '').trim()
        if (!file) throw new Error('tag 需要 file')
        const record = setTags(file, args.moods ?? [], options)
        return `已更新 ${file} 的标签：${(record.moods ?? []).join('/')}`
      }

      if (action === 'report') {
        const file = String(args.file ?? '').trim()
        if (!file) throw new Error('report 需要 file')
        const record = recordUsage(file, options)
        return `已记录 ${file} 使用（累计 ${record?.used ?? 1} 次）`
      }

      throw new Error(`未知 action：${action}`)
    }
  }))

  /* ---------------- 状态 ---------------- */
  tools.push(makeDef({
    name: 'memory_file_status',
    description:
      '查看全局共享记忆文件的存储与备份状态：主文件/镜像路径、是否双盘、两侧是否一致、' +
      '各分类条数、历史版本数、最近错误。用户问"记忆存在哪""备份还在吗"时用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    async run(_args, exec) {
      const st = await store.status()
      const history = await store.listHistory(5)
      const archive = store.archiveStats()
      const { scope } = scopeOf(exec)
      const lines = [
        `主文件：${st.primaryPath}`,
        `镜像  ：${st.mirrorPath ?? '（未配置）'}`,
        `双盘  ：${st.mirrorPath ? (st.sameVolume ? '否（同一分区，镜像无意义，建议改到别的盘）' : '是') : '否'}`,
        `主文件存在：${st.primary.exists ? `是，${st.primary.bytes} 字节，mtime ${st.primary.mtime}` : '否'}`,
        `镜像存在  ：${st.mirror ? (st.mirror.exists ? `是，${st.mirror.bytes} 字节，mtime ${st.mirror.mtime}` : '否') : '（未配置）'}`,
        `两侧一致：${st.inSync ? '是' : '否（下次启动或 sync 会自动收敛）'}`,
        `revision：${st.revision} · 更新于 ${st.updated || '未知'}`,
        `当前作用域：${scope}`,
        `注入档位：${hooks?.getProfile?.() ?? 'standard'}（lean=省 token / standard=标准 / rich=详尽）`,
        `各分类：${Object.entries(st.counts).map(([k, v]) => `${k}=${v}`).join('  ')}`,
        `历史版本：${history.length ? history.slice(0, 3).map((h) => h.name).join('、') : '（无）'}`,
        `归档：${archive.count} 条 / ${(archive.bytes / 1024).toFixed(1)} KB${archive.exists ? '' : '（还没有条目进归档）'} · 分区 ${archive.sections.join('/') || '无'}`,
        `关键词索引：${archive.index.count} 条记录，命中合计 ${archive.index.hits}，其中从未命中 ${archive.index.idle} 条`,
        st.lastError ? `最近错误：${st.lastError}` : '最近错误：无'
      ]
      return lines.join('\n')
    }
  }))

  /* ---------------- 维护 ---------------- */
  tools.push(makeDef({
    name: 'memory_file_maintain',
    description:
      '维护全局共享记忆文件。sync=立刻对账并回补缺失的一侧；relocate=更换保存位置（主/镜像路径）；' +
      'history=列出历史版本；rollback=回滚到某个历史版本；' +
      'reset=同时删除双备份并重建空模板（必须 confirm="DELETE_BOTH"，只应在用户明确要求清空记忆时使用）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sync', 'relocate', 'history', 'rollback', 'reset', 'rebalance', 'profile', 'export', 'diff'] },
        to: { type: 'string', description: 'action=diff 时的目标版本文件名（留空=与当前比较）' },
        profile: {
          type: 'string',
          enum: ['lean', 'standard', 'rich'],
          description: 'action=profile 时用：注入档位 lean=省 token / standard=标准 / rich=详尽'
        },
        primaryPath: { type: 'string', description: 'relocate 时的新主文件完整路径（.md）' },
        mirrorPath: { type: 'string', description: 'relocate 时的新镜像完整路径（.md，建议另一块盘）' },
        version: { type: 'string', description: 'rollback 时的历史文件名（从 history 或 status 里拿）' },
        confirm: { type: 'string', description: 'reset 必须传 DELETE_BOTH' }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    async run(args) {
      const action = String(args.action ?? '')
      if (action === 'sync') {
        const r = await store.reconcile()
        await store.reload(true)
        const st = await store.status()
        return `对账完成：${r.action}；两侧一致=${st.inSync ? '是' : '否'}；主=${st.primaryPath}；镜像=${st.mirrorPath ?? '未配置'}`
      }
      if (action === 'history') {
        const list = await store.listHistory(20)
        if (!list.length) return '还没有历史版本（每次写入会自动留一份）。'
        return ['历史版本（新→旧）：', ...list.map((h) => `- ${h.name}  ${h.bytes} 字节  ${h.mtime}`)].join('\n')
      }
      if (action === 'rollback') {
        const version = String(args.version ?? '').trim()
        if (!version) throw new Error('rollback 需要 version（历史文件名）')
        const view = await store.rollback(version)
        return `已回滚到 ${version}，新 revision ${view.meta.revision}。`
      }
      if (action === 'relocate') {
        const primary = String(args.primaryPath ?? '').trim()
        if (!primary) throw new Error('relocate 需要 primaryPath')
        const mirror = String(args.mirrorPath ?? '').trim()
        if (!/\.md$/i.test(primary)) throw new Error('primaryPath 必须以 .md 结尾')
        if (mirror && !/\.md$/i.test(mirror)) throw new Error('mirrorPath 必须以 .md 结尾')
        const st = await hooks.relocate(primary, mirror)
        return `已迁移：主=${st.primaryPath}；镜像=${st.mirrorPath ?? '未配置'}；两侧一致=${st.inSync ? '是' : '否'}`
      }
      if (action === 'export') {
        await store.reload(true)
        const snapshot = store.exportSnapshot()
        return fence(JSON.stringify(snapshot, null, 2))
      }
      if (action === 'diff') {
        await store.reload(true)
        const from = String(args.version ?? '').trim()
        const to = String(args.to ?? '').trim()
        const diff = await store.diffHistory(from, to)
        const lines = [
          `对比：${diff.from} → ${diff.to}`,
          `新增 ${diff.added.length} 行，删除 ${diff.removed.length} 行`
        ]
        for (const line of diff.added.slice(0, 40)) lines.push(`+ ${line}`)
        for (const line of diff.removed.slice(0, 40)) lines.push(`- ${line}`)
        return fence(lines.join('\n'))
      }
      if (action === 'profile') {
        const next = await hooks.setProfile(args.profile)
        return `注入档位已切换为 ${next}（下一轮提示词生效；lean=省 token / standard=标准 / rich=详尽）`
      }
      if (action === 'rebalance') {
        await store.reload(true)
        const results = []
        for (const section of ENTRY_SECTIONS) {
          const r = await store.rebalance(section)
          if (r.dropped || r.kept) results.push(`${section}：主文件 ${r.kept} 条 / 归档 ${r.dropped} 条`)
        }
        const ar = store.archiveStats()
        return [`已按命中频率重新分层（总归档 ${ar.count} 条）：`, ...results].join('\n')
      }
      if (action === 'reset') {
        if (String(args.confirm ?? '') !== 'DELETE_BOTH') {
          throw new Error('reset 会把双备份一起删掉，必须传 confirm="DELETE_BOTH"')
        }
        const r = await hooks.reset()
        return `已同时删除双备份并重建空模板：${Array.isArray(r?.removed) ? r.removed.join('、') : ''}`
      }
      throw new Error(`未知 action：${action}`)
    }
  }))

  /* ---------------- 记忆包 ---------------- */
  tools.push(makeDef({
    name: 'memory_file_pack',
    description:
      '记忆包：插件自带的整份角色记忆与人设，**安装与否由用户决定，默认不安装**。' +
      'a) list 列出所有包（含大小、来源、是否已装）；' +
      'b) preview 预览某个包的内容（前 2000 字 + 章节列表）；' +
      'c) install 安装（会覆盖 identity 和 persona，安装前自动备份到 .packs-backup/，可卸载恢复；' +
      '第一次调用只返回计划，确认后带 confirm:true 才真写）；' +
      'd) uninstall 卸载（从备份恢复，无备份则复位为默认占位）；' +
      'e) status 看安装状态（按内容 hash 判断，用户手工改过也能识别）。' +
      '只写 identity / persona 两个分区，其它分区绝不触碰。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'preview', 'install', 'uninstall', 'status'] },
        id: { type: 'string', description: '包 id，如 elysia' },
        confirm: { type: 'boolean', description: 'install 必须为 true 才真正写入（第一次调用会被要求确认）' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: () => false,
    async run(args) {
      const action = String(args.action ?? 'list')
      const id = String(args.id ?? '').trim()
      const ACTIONS = ['list', 'preview', 'install', 'uninstall', 'status']
      if (!ACTIONS.includes(action)) throw new Error(`未知 action：${action}（可选 ${ACTIONS.join(' / ')}）`)

      if (action === 'list') {
        const packs = listPacks()
        const status = await packStatus(store)
        if (!packs.length) return '没有可用的记忆包（packs/ 目录为空）。'
        const lines = [`可用的记忆包（共 ${packs.length} 个；默认都不安装）：`]
        for (const pack of packs) {
          const st = status.packs.find((p) => p.id === pack.id)
          const ident = pack.sections.identity
          const pers = pack.sections.persona
          lines.push(
            `\n· ${pack.id} —— ${pack.name} v${pack.version}` +
              (st?.installed ? `　【已安装${st.fullyInstalled ? '' : '（部分分区）'}】` : '　【未安装】')
          )
          if (pack.description) lines.push(`  ${pack.description}`)
          lines.push(
            `  内容：identity ${ident?.chars ?? 0} 字 · persona ${pers?.chars ?? 0} 字`
          )
          const src = pack.source ?? {}
          const srcParts = [src.audio, src.text].filter(Boolean)
          if (srcParts.length) lines.push(`  来源：${srcParts.join('；')}`)
        }
        lines.push(`\n备份目录：${status.backupRoot}`)
        lines.push('安装：memory_file_pack({action:"install", id:"<id>", confirm:true})')
        return fence(lines.join('\n'))
      }

      if (action === 'status') {
        const status = await packStatus(store)
        if (!status.packs.length) return '没有可用的记忆包。'
        const lines = []
        for (const st of status.packs) {
          const mark = st.installed ? (st.fullyInstalled ? '已安装' : '部分已安装') : '未安装'
          lines.push(`${st.id} —— ${st.name} v${st.version}：${mark}`)
          for (const [name, info] of Object.entries(st.sections)) {
            if (!info.available) continue
            const state = info.installed
              ? '与包一致'
              : info.isDefault
                ? '默认占位'
                : info.customized ? '用户自定义内容（与包不同）' : '未知'
            lines.push(`  ${name}: ${info.currentChars} 字 · ${state}`)
          }
          if (st.record?.installedAt) lines.push(`  安装于 ${st.record.installedAt}；备份 ${st.record.backupDir || '（无）'}`)
        }
        lines.push(`\n已安装：${status.installed.length ? status.installed.join('、') : '无'}`)
        lines.push(`备份目录：${status.backupRoot}`)
        lines.push(`状态文件：${status.statePath}`)
        return fence(lines.join('\n'))
      }

      if (!id) {
        const known = listPacks().map((p) => p.id)
        throw new Error(`${action} 需要 id（可用：${known.join('、') || '无'}）`)
      }
      /* id 写错时别只报"非法 id"，把可用的列出来，省一轮猜测 */
      if (!listPacks().some((p) => p.id === id)) {
        const known = listPacks().map((p) => p.id)
        throw new Error(`没有这个记忆包：${id}（可用：${known.join('、') || '无'}）`)
      }

      if (action === 'preview') {
        const pv = await previewPack(id)
        const lines = [`记忆包 ${pv.id} —— ${pv.name} v${pv.version}`]
        if (pv.description) lines.push(pv.description)
        const src = pv.source ?? {}
        const srcParts = [src.audio, src.text, src.note].filter(Boolean)
        if (srcParts.length) lines.push(`来源：${srcParts.join('；')}`)
        if (pv.warnings?.length) {
          lines.push('')
          lines.push('注意：')
          for (const w of pv.warnings) lines.push(`  - ${w}`)
        }
        for (const [name, info] of Object.entries(pv.preview)) {
          lines.push('')
          lines.push(`=== ${name}（${info.chars} 字${info.truncated ? '，下面只显示前 2000 字' : ''}）===`)
          if (info.chapters.length) lines.push(`章节：${info.chapters.join(' / ')}`)
          lines.push('')
          lines.push(info.head)
          if (info.truncated) lines.push('\n…（已截断）')
        }
        lines.push('')
        lines.push(`完整安装：memory_file_pack({action:"install", id:"${pv.id}", confirm:true})`)
        return fence(lines.join('\n'))
      }

      if (action === 'install') {
        const confirm = args.confirm === true
        const result = await installPack(store, id, { confirm })
        if (result.needsConfirm) return fence(result.message)
        const lines = [result.message]
        if (result.backupDir) lines.push(`备份：${result.backupDir}`)
        if (result.overwritesUserContent) {
          lines.push('提示：这次覆盖了你原有的内容。不满意可以 memory_file_pack({action:"uninstall", id:"' + id + '"}) 退回安装前那份。')
        }
        lines.push('生效方式：注入内容下一轮就会读到；建议重启 DSH 让自我记忆/人设两层完全按新内容组装。')
        return fence(lines.join('\n'))
      }

      if (action === 'uninstall') {
        const result = await uninstallPack(store, id)
        return fence(result.message)
      }

      throw new Error(`未知 action：${action}`)
    }
  }))

  return tools
}

// 保证 ENTRY_SECTIONS 的导出被用到（避免打包器抱怨）
export const _entrySections = ENTRY_SECTIONS

// 让调用方也能直接复用分类解析
export { parseSections }
