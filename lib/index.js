/**
 * 爱莉希雅的记忆插件（DSH-elysia）—— Host 侧
 *
 * 一个文件，所有会话共用：
 *   ~/.dsh/dsh-shared-memory/MEMORY.md       ← 主文件
 *   D:\dsh-shared-memory/MEMORY.md           ← 镜像（另一块硬盘分区）
 *
 * 行为：
 *  1. 每个会话开始：确保记忆文件存在（缺一侧自动回补）并把会话登记进索引
 *  2. 每轮用户输入：摘要进「会话请求流水」（requests），不污染精选的 requirements
 *  3. 人设 + 记忆摘要常驻系统提示词；每条都从磁盘读，压缩后自然重读，并额外打"已重读"告示
 *  4. 模型用 memory_file_* 工具写 教训 / 指正 / 更好方法 / 要求 / 人设
 *  5. 双写主+镜像；启动对账 + 每 10 分钟自动对账回补；写入前留历史版本
 *  6. 记忆网页：GET <origin>/dsh-shared-memory （路径不变，避免书签失效）
 *
 * 只用 node 内置模块，不依赖任何 @deepseek-ai/* 包（本地 link bundle 解析不到）。
 */

import { promises as fsp } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { MemoryStore, ENTRY_SECTIONS, entryLine, oneLine, clip, shortId, nowIso, projectScope, GLOBAL_SCOPE } from './store.js'
import { buildMemoryPrompt, buildPersonaPrompt, buildIdentityPrompt } from './prompt.js'
import { buildMemoryTools } from './tools.js'
import { registerMemoryPage, MEMORY_PAGE_PREFIX } from './webui.js'
import { MAX_SKEPTICISM, defaultMethodbook, parseMethodbook, renderMethodbook } from './methodbook.js'
import { runInstallSelfTest } from './selftest.js'
import { skillsSummary, listSkills, matchSkills } from './skills.js'
import { stickersSummary } from './stickers.js'
import { listPacks, packStatus, packsDir } from './packs.js'
import { VOICE_DEFAULTS, createSpeaker, cleanForSpeech, engineAlive, synthesizeViaScript, stopPlayback, isPlaying } from './voice.js'
import { runDoctor, INSTALL_STEPS, SIZE_HINT } from './setup.js'
import { createSentenceBuffer, extractChunkText } from './streamtext.js'
import { summarizeForSpeech, ANNOUNCE_SYSTEM } from './announce.js'

/** 当前插件版本（安装自检按版本只跑一次） */
const PLUGIN_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return String(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

export const name = 'dsh-elysia-memory'
export const inject = ['systemPrompt', 'tools', 'timer']

const DEFAULT_INJECT_CHARS = 6000
const DEFAULT_ENTRY_CAP = 200
const DEFAULT_USER_SUMMARY_CHARS = 220
const DEFAULT_MIN_USER_CHARS = 4
const RELOAD_NOTICE_TTL_MS = 30 * 60 * 1000
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/** 找一块和主文件不同盘符的可用分区，用于默认镜像位置 */
function pickMirrorPath(primaryPath) {
  const primaryRoot = path.parse(path.resolve(primaryPath)).root.toUpperCase()
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  for (const letter of letters) {
    const root = `${letter}:\\`
    if (root.toUpperCase() === primaryRoot) continue
    try {
      if (existsSync(root)) return path.join(`${letter}:\\`, 'dsh-shared-memory', 'MEMORY.md')
    } catch {
      /* 跳过错过的盘符 */
    }
  }
  return ''
}

function sessionIdOf(value) {
  const session = value?.session ?? value
  if (typeof session?.id === 'string') return session.id
  if (typeof session?.header?.id === 'string') return session.header.id
  if (typeof value?.id === 'string') return value.id
  return undefined
}

function sessionOf(value) {
  return value?.session ?? value
}

function isSubagentSession(session) {
  const header = session?.header ?? {}
  if (header.parentSessionId || header.parent) return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  if (typeof session?.delegationDepth === 'number' && session.delegationDepth > 0) return true
  if (header.origin === 'subagent' || header.kind === 'subagent') return true
  return false
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function isInjectedMessage(message) {
  const kind = message?.source?.kind
  if (typeof kind !== 'string') return false
  return kind !== 'user' && kind !== 'human'
}

function isCompactionCheckpoint(message) {
  const kind = message?.source?.kind
  if (typeof kind === 'string' && /compact|checkpoint|summary/i.test(kind)) return true
  const text = messageText(message)
  return /^<compact|<compaction|<session-summary/i.test(text.trim())
}

/** 侧边栏（client 半边）是否已被宿主组装进浏览器启动图 —— 只用于展示与自检。 */
function clientEntryInfo(ctx) {
  try {
    const clientModules = ctx.get('clientModules')
    if (!clientModules || typeof clientModules.graph !== 'function') {
      return { supported: false, registered: false }
    }
    const graph = clientModules.graph()
    const entry = (graph?.entries ?? []).find((item) => item?.id === name)
    const bundlePath =
      typeof clientModules.clientPath === 'function' ? clientModules.clientPath(name) : undefined
    if (!entry) {
      return {
        supported: true,
        registered: false,
        bundlePath: bundlePath ?? null,
        packaged: typeof bundlePath === 'string'
      }
    }
    return {
      supported: true,
      registered: true,
      url: entry.url,
      rev: entry.rev,
      immediately: entry.immediately === true
    }
  } catch (error) {
    return { supported: false, registered: false, error: String(error?.message ?? error) }
  }
}

export function apply(ctx, config) {
  const raw = config ?? {}

  const primaryPath = raw.primaryPath
    ? path.resolve(String(raw.primaryPath))
    : path.join(dshHome(), 'dsh-shared-memory', 'MEMORY.md')
  const stateDir = path.join(dshHome(), 'dsh-shared-memory')
  const statePath = path.join(stateDir, 'state.json')
  const tombstonePath = path.join(stateDir, 'deleted.json')

  const injectChars = Number.isFinite(raw.injectChars) ? Number(raw.injectChars) : DEFAULT_INJECT_CHARS
  /**
   * 自我记忆的注入预算（字符）。留空 = 用 prompt.js 里的默认算法
   * （min(4200, injectChars × 0.56)，比人设的 2400 更宽——身份层不能先被截断）。
   */
  const identityChars = Number.isFinite(raw.identityChars) && raw.identityChars > 0
    ? Math.floor(Number(raw.identityChars))
    : undefined
  const entryCap = Number.isFinite(raw.entryCap) ? Number(raw.entryCap) : DEFAULT_ENTRY_CAP
  /**
   * 语音朗读（可选）。默认关闭 —— 它依赖本机装好 GPT-SoVITS 引擎，
   * 换一台机器这些都不在。插件本身要能干净地跑，语音是加装的皮肤。
   */
  const voiceConfig = {
    ...VOICE_DEFAULTS,
    ...(raw.voice && typeof raw.voice === 'object' ? raw.voice : {})
  }
  // 允许用扁平写法 voice.enabled 或顶层 voiceEnabled
  if (typeof raw.voiceEnabled === 'boolean' && raw.voice === undefined) {
    voiceConfig.enabled = raw.voiceEnabled
  }
  // ⚠️ 注意：这里**不能**调用 loadStateSync()。
  // stateCache 是 let，定义在下面（约 L223），此处读它会命中 TDZ 抛 ReferenceError，
  // 被 catch 吞掉后永远用配置里的 false —— 表现就是「面板开了关，重启就丢」。
  // 真正的读回放在 stateCache 定义之后做（见下方 applyPersistedVoice）。
  const speaker = createSpeaker(voiceConfig, {
    info: (m) => ctx.logger?.info?.(m),
    warn: (m) => ctx.logger?.warn?.(m)
  })

  /**
   * 说话风格检测 —— 决定要不要在 persona 后面塞一句短提醒（B 方案）。
   *
   * 判断依据来自真实语料统计（1696 条官方语音）：
   *   · 句尾语气词呢/呀/吧/哦/啦：这五个共 1241 次，是「哎呀」的 20 倍
   *   · 52.1% 的话是问句或半问句
   *   · 从不说 AI 话术
   *
   * 只在**走样时**塞提醒，而不是每轮都塞：
   * 典型一轮对话约 638 tokens，提醒 36 tokens 是多花 5.6%，
   * 按需触发能省 2/3，而且更精准。
   */
  /** 上一轮回复的正文，供 styleDrifted 判断 */
  let lastReplyText = ''
  let lastStyleCheck = null

  function styleDrifted(text) {
    const t = String(text ?? '')

    /*
     * AI 话术：**再短也要认**。
     * 「很抱歉，我无法回答」只有 10 个字，但已经明显不是她的语气。
     * 所以这一条放在长度判断之前。
     */
    const AI_TALK =
      /作为(一个)?(AI|语言模型|助手)|感谢(您|你)的提问|我可以?帮(助|你)|希望能?帮到你|有什么(其他|别的)问题|很抱歉|无法回答|很遗憾/
    const hasAiTalk = t.length >= 6 && AI_TALK.test(t)

    // 太短的话没法判断语气分布，但 AI 话术已经能定性了
    if (t.length < 20) {
      lastStyleCheck = { short: true, hasAiTalk }
      return hasAiTalk
    }

    // 1. 句尾语气词（呢呀吧哦啦嘛）的密度
    const tics = (t.match(/[呢呀吧哦啦嘛]/g) || []).length
    const density = (tics / t.length) * 100

    // 2. 有没有问句
    const hasQuestion = /[？?]/.test(t) || /吗[，。！？…]?$/.test(t)

    lastStyleCheck = { tics, density: Number(density.toFixed(2)), hasQuestion, hasAiTalk }

    if (hasAiTalk) return true
    if (density < 1.2 && !hasQuestion) return true
    return false
  }

  const recordUserTurns = raw.recordUserTurns !== false
  const recordSubagents = raw.recordSubagents === true
  const userSummaryChars = Number.isFinite(raw.userSummaryChars) ? Number(raw.userSummaryChars) : DEFAULT_USER_SUMMARY_CHARS
  const minUserChars = Number.isFinite(raw.minUserChars) ? Number(raw.minUserChars) : DEFAULT_MIN_USER_CHARS
  const reconcileIntervalMs = Number.isFinite(raw.reconcileIntervalMs) && raw.reconcileIntervalMs > 10_000
    ? Number(raw.reconcileIntervalMs)
    : RECONCILE_INTERVAL_MS
  /**
   * 技能自动执行：默认开启（用户要求"不要每次问"）。
   * 关掉后每个技能执行都要带 confirm:true；标了 dangerous 的技能无论开关如何都要确认。
   */
  const autoRunSkills = raw.autoRunSkills !== false
  /** 表情包目录（用户自己往里放图；留空 = <记忆目录>/stickers） */
  const stickerDir = typeof raw.stickerDir === 'string' ? raw.stickerDir.trim() : ''
  /** 记忆网页注册成功后记下直链前缀，工具挑图时给可渲染的 URL */
  let stickerBaseUrl = ''

  const log = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('shared-memory') : ctx.logger
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /* ---------------- 状态文件：记住用户改过的保存位置 ---------------- */
  let stateCache = null

  /**
   * 把 state.json 里记的语音开关读回来。
   *
   * 为什么单独一个函数、且在这里才调用：stateCache 是 let，
   * 在它声明之前调用 loadStateSync() 会命中 TDZ（ReferenceError），
   * 而被 try/catch 吞掉的话就是静默失效——正是之前「开关重启就丢」的原因。
   */
  function applyPersistedVoice() {
    try {
      const st = loadStateSync()
      if (typeof st.voiceEnabled === 'boolean') speaker.cfg.enabled = st.voiceEnabled
      if (Number.isFinite(st.voiceVolume)) {
        speaker.cfg.volume = Math.max(-12, Math.min(12, Number(st.voiceVolume)))
      }
      if (Number.isFinite(st.voiceSpeed) && Number(st.voiceSpeed) > 0) {
        speaker.cfg.speed = Math.max(0.5, Math.min(2, Number(st.voiceSpeed)))
      }
      return speaker.cfg.enabled
    } catch {
      /* 读不到就保持配置值 */
    }
    return speaker.cfg.enabled
  }
  applyPersistedVoice()

  function loadStateSync() {
    if (stateCache) return stateCache
    stateCache = {}
    try {
      if (existsSync(statePath)) stateCache = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      stateCache = {}
    }
    return stateCache
  }

  async function saveState(patch) {
    stateCache = { ...(stateCache ?? {}), ...patch, updatedAt: nowIso() }
    try {
      await fsp.mkdir(stateDir, { recursive: true })
      await fsp.writeFile(statePath, JSON.stringify(stateCache, null, 2), 'utf8')
    } catch (error) {
      log('warn', `状态文件写入失败：${error?.message ?? error}`)
    }
  }

  const persisted = loadStateSync()
  const effectivePrimary = persisted.primaryPath ? path.resolve(String(persisted.primaryPath)) : primaryPath
  const effectiveMirror = persisted.mirrorPath !== undefined
    ? (persisted.mirrorPath ? path.resolve(String(persisted.mirrorPath)) : '')
    : (raw.mirrorPath ? path.resolve(String(raw.mirrorPath)) : pickMirrorPath(effectivePrimary))

  const PROFILE_IDS = ['lean', 'standard', 'rich']
  let profile = PROFILE_IDS.includes(String(persisted.profile ?? ''))
    ? String(persisted.profile)
    : PROFILE_IDS.includes(String(raw.profile ?? '')) ? String(raw.profile) : 'standard'

  const store = new MemoryStore({
    primaryPath: effectivePrimary,
    mirrorPath: effectiveMirror,
    entryCap,
    graceDays: Number.isFinite(raw.archiveGraceDays) ? Number(raw.archiveGraceDays) : 3,
    ttlBySection: (persisted.ttlBySection && typeof persisted.ttlBySection === 'object')
      ? persisted.ttlBySection
      : (raw.ttlDaysBySection && typeof raw.ttlDaysBySection === 'object' ? raw.ttlDaysBySection : undefined),
    logger: {
      info: (m) => log('info', m),
      warn: (m) => log('warn', m),
      error: (m) => log('error', m)
    }
  })

  if (store.mirrorPath && path.parse(store.primaryPath).root.toLowerCase() === path.parse(store.mirrorPath).root.toLowerCase()) {
    log('warn', `主文件与镜像在同一分区（${path.parse(store.primaryPath).root}），镜像备份无意义，建议用 memory_file_maintain relocate 改到另一块盘`)
  }

  /* ---------------- 同步引导：第一个请求就要能读到记忆 ---------------- */
  store.bootstrapSync()

  /* ---------------- 初始化（惰性、可重试） ---------------- */
  let initPromise = null
  function ensureReady() {
    if (!initPromise) {
      initPromise = store
        .init()
        .then((view) => {
          log('info', `记忆已就绪：${store.primaryPath}（镜像 ${store.mirrorPath || '未配置'}），revision ${view.meta.revision}`)
          return view
        })
        .catch((error) => {
          initPromise = null
          log('warn', `初始化失败：${error?.message ?? error}`)
          throw error
        })
    }
    return initPromise
  }

  /* ---------------- 安装自检：每个版本首次启用跑一次（临时目录，不碰真实记忆） ---------------- */
  let selfTestPromise = null
  function maybeInstallSelfTest() {
    if (selfTestPromise) return selfTestPromise
    if (raw.selfTestOnInstall === false) return Promise.resolve(null)
    selfTestPromise = ensureReady()
      .then(async () => {
        const done = loadStateSync().selfTest
        if (done && done.version === PLUGIN_VERSION && done.ok) return done
        const result = await runInstallSelfTest({
          sessions: 2,
          perSession: 3,
          // 默认走进程内并发：安装期 fork 子进程容易被市场评审当成"异常安装期行为"，
          // 需要真·多进程验证时把 selfTestMultiProcess 打开（或跑 test/multiprocess.mjs）。
          multiProcess: raw.selfTestMultiProcess === true
        })
        await saveState({ selfTest: { ...result, version: PLUGIN_VERSION } })
        log(
          result.ok ? 'info' : 'warn',
          `安装自检${result.ok ? '通过' : '未通过'}：${result.mode} 模式，${result.entries}/${result.expected} 条，${result.ms}ms` +
            (result.detail ? `｜${result.detail}` : '')
        )
        return result
      })
      .catch((error) => {
        selfTestPromise = null
        log('warn', `安装自检失败：${error?.message ?? error}`)
        return null
      })
    return selfTestPromise
  }


  /* ---------------- 质疑度 / 最佳方法库：首次启动补齐分区 ---------------- */
  let methodbookPromise = null
  function ensureMethodbook() {
    if (!methodbookPromise) {
      methodbookPromise = ensureReady()
        .then(async () => {
          const body = store.view()?.sections?.methodbook ?? ''
          if (parseMethodbook(body)) return null
          const cfgLevel = Number.isFinite(raw.skepticism)
            ? Number(raw.skepticism)
            : Number.isFinite(raw.skepticismLevel) ? Number(raw.skepticismLevel) : undefined
          const state = defaultMethodbook({
            level: cfgLevel,
            auto: raw.autoDecay !== false,
            decayAfter: Number.isFinite(raw.decayAfter) ? Number(raw.decayAfter) : undefined
          })
          await store.setSection('methodbook', renderMethodbook(state))
          log('info', `已初始化最佳方法库（质疑度 ${state.skepticism.level}/${MAX_SKEPTICISM}）`)
          return state
        })
        .catch((error) => {
          methodbookPromise = null
          log('warn', `方法库初始化失败：${error?.message ?? error}`)
          return null
        })
    }
    return methodbookPromise
  }

  /* ---------------- 记忆包：启动时扫一次目录，把"有哪些包 / 装了没"记进日志 ---------------- */
  /*
   * 只读目录 + 读小 manifest，不读 identity.md（60KB+）。
   * 目的是让用户在日志里就能看到"这台机器上有记忆包可选"，不用先知道有这个功能。
   * 绝不自动安装：安装只发生在用户显式点按钮 / 调工具 / 跑脚本时。
   */
  let packsScanPromise = null
  function scanPacksOnce() {
    if (packsScanPromise) return packsScanPromise
    packsScanPromise = ensureReady()
      .then(async () => {
        const packs = listPacks()
        if (!packs.length) {
          log('info', `记忆包：插件目录里没有包（${packsDir()}）`)
          return null
        }
        const status = await packStatus(store)
        const names = packs.map((p) => `${p.id} v${p.version}`).join('、')
        const installed = status.installed
        log(
          'info',
          `记忆包：发现 ${packs.length} 个（${names}）｜已安装：${installed.length ? installed.join('、') : '无（默认不安装，用户主动点才写入）'}` +
            `｜备份目录 ${status.backupRoot}`
        )
        return status
      })
      .catch((error) => {
        log('warn', `记忆包扫描失败：${error?.message ?? error}`)
        return null
      })
    return packsScanPromise
  }

  /* ---------------- 作用域解析（per-project） ---------------- */
  function cwdOfAgent(agent) {
    try {
      const session = agent?.session ?? (agent?.id ? ctx.agents?.get?.(agent.id)?.session : undefined)
      return String(session?.header?.cwd ?? '')
    } catch {
      return ''
    }
  }

  /** 工具执行上下文 → { scope, cwd } */
  function scopeOfExec(exec) {
    const cwd = cwdOfAgent(exec?.agent)
    return { cwd, scope: projectScope(cwd) || GLOBAL_SCOPE }
  }

  /* ---------------- 压缩后重读标记 ---------------- */
  const reloadPending = new Map()

  /**
   * 压缩上下文之前先把记忆同步写入两块盘：压缩会把会话历史换成摘要，
   * 记忆是压缩后唯一的长期载体，所以这里必须落盘一致。
   */
  async function flushBeforeCompaction(reason) {
    try {
      store.refreshSync(0)
      store.bootstrapSync()
      await store.writeBoth(store.raw)
      log('info', `压缩前已把记忆写入双备份（${reason}）`)
      return true
    } catch (error) {
      log('warn', `压缩前双备份失败（${reason}）：${error?.message ?? error}`)
      return false
    }
  }

  function markReload(sessionId, reason) {
    if (!sessionId) return
    reloadPending.set(sessionId, Date.now())
    log('info', `已标记上下文压缩后重读记忆（${reason}, session=${shortId(sessionId)}）`)
    try {
      store.refreshSync(0)
    } catch {
      /* 忽略 */
    }
    void flushBeforeCompaction(reason)
  }

  function pendingNotice(sessionId) {
    if (!sessionId) return ''
    const at = reloadPending.get(sessionId)
    if (!at) return ''
    if (Date.now() - at > RELOAD_NOTICE_TTL_MS) {
      reloadPending.delete(sessionId)
      return ''
    }
    return '你刚经历过上下文压缩，共享记忆已重新读取。'
  }

  /* ---------------- 技能库摘要（10 秒缓存，避免每轮都扫目录） ---------------- */
  let skillsCache = { at: 0, value: { count: 0, names: [], top: [] } }
  function skillsSummaryCached() {
    const now = Date.now()
    if (now - skillsCache.at < 10_000) return skillsCache.value
    try {
      skillsCache = { at: now, value: skillsSummary() }
    } catch (error) {
      log('warn', `技能目录读取失败：${error?.message ?? error}`)
      skillsCache = { at: now, value: { count: 0, names: [], top: [] } }
    }
    return skillsCache.value
  }

  /* ---------------- 表情包摘要（15 秒缓存） ---------------- */
  let stickersCache = { at: 0, value: { count: 0, dir: '', moods: [], sample: [] } }
  function stickersSummaryCached() {
    const now = Date.now()
    if (now - stickersCache.at < 15_000) return stickersCache.value
    try {
      stickersCache = { at: now, value: stickersSummary({ stickerDir }) }
    } catch (error) {
      log('warn', `表情包目录读取失败：${error?.message ?? error}`)
      stickersCache = { at: now, value: { count: 0, dir: '', moods: [], sample: [] } }
    }
    return stickersCache.value
  }

  /* ---------------- 记忆包摘要（15 秒缓存；只扫目录，不读大文件） ---------------- */
  let packsCache = { at: 0, value: { count: 0, installed: [], ids: [], dir: '' } }
  function packsSummaryCached() {
    const now = Date.now()
    if (now - packsCache.at < 15_000) return packsCache.value
    try {
      const packs = listPacks()
      const records = loadStateSync().packs ?? {}
      const installed = Object.keys(records)
      packsCache = {
        at: now,
        value: {
          count: packs.length,
          ids: packs.map((p) => p.id),
          installed,
          dir: packsDir()
        }
      }
    } catch (error) {
      log('warn', `记忆包目录读取失败：${error?.message ?? error}`)
      packsCache = { at: now, value: { count: 0, installed: [], ids: [], dir: '' } }
    }
    return packsCache.value
  }

  /* ---------------- 1) 系统提示词 ---------------- */
  /*
   * 三段注入，order 越小越靠前（= 越基础、越优先）：
   *   23 identity 自我记忆：我自己说过的话 → 决定"我是谁"
   *   24 persona  角色设定：别人写的扮演材料 → 决定"怎么说话"
   *   25 shared-memory 记忆参考数据
   * identity 排在 persona 之前不是排版偏好：模型读系统提示词是按顺序累积语境的，
   * 先生成的身份描述会盖住后面对它的改写。用户明确要求"身份优先于人设"，靠的就是这个顺序。
   */
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'shared-memory-identity',
      order: 3,
      text: () => {
        try {
          store.refreshSync()
        } catch {
          /* 读盘失败就用手里的缓存 */
        }
        return buildIdentityPrompt(store.view(), { injectChars, identityChars })
      }
    })
  )

  // 角色设定单独一段、排在记忆段之前：身份与语气属于指令层，不能混在记忆资料里
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'shared-memory-persona',
      order: 2,
              text: () => {
          try {
            store.refreshSync()
          } catch {
            /* 读盘失败就用手里的缓存 */
          }
          const base = buildPersonaPrompt(store.view(), { injectChars })
          /*
           * B 方案：检测到说话风格走样时，在 persona 末尾追一句短提醒。
           * 检测依据见 styleDrifted() 的注释。
           * 提醒很短（约 60 字 ≈ 45 tokens），只在需要时出现。
           */
          if (!styleDrifted(lastReplyText)) return base
          return (
            base +
            '\n>' +
            '\n> **提醒**：最近这几句说得太「工具人」了。回到她的说话方式——' +
            '一半以上是问句，句尾挂「呢/呀/吧/哦/啦」，' +
            '不用「作为AI」「感谢提问」这类话术。' +
            '内容照旧，只是语气要像她。\n'
          )
        }
    })
  )

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'shared-memory',
      order: 25,
      text: (context) => {
        try {
          store.refreshSync()
        } catch {
          /* 读盘失败就用手里的缓存 */
        }
        const agent = context?.scope
        const sessionId = sessionIdOf(agent)
        const scope = projectScope(cwdOfAgent(agent)) || GLOBAL_SCOPE
        return buildMemoryPrompt(store.view(), {
          injectChars,
          scope,
          profile,
          index: store.index,
          skills: skillsSummaryCached(),
          stickers: stickersSummaryCached(),
          skillHint: pendingSkillHint(sessionId),
          reloadNotice: pendingNotice(sessionId),
          primaryPath: store.primaryPath,
          mirrorPath: store.mirrorPath,
          // 被注入 = 真的被用上了，计入命中频率（决定它留主文件还是进归档）
          onInjected: (entries) => {
            try {
              store.touchEntries(entries, 1)
            } catch {
              /* 索引写失败不影响提示词 */
            }
          }
        })
      }
    })
  )

  /* ---------------- 2) 工具 ---------------- */
  /** 上一次 announce 的时间戳（毫秒）。turn/end 用它判断这一轮要不要兜底摘要 */
  let announceAt = 0

  const hooks = {
    scopeOf: scopeOfExec,
    /* ---------------- 语音朗读（可选） ---------------- */
    voiceStatus: () => ({ ...speaker.status(), playing: isPlaying() }),
    voiceClean: (text) => cleanForSpeech(text, { stripCodeBlocks: speaker.cfg.stripCodeBlocks }),
    voiceAlive: () => engineAlive(speaker.cfg.engineUrl),
    /**
     * 朗读一段文本。返回 { spoke, reason?, file? }。
     * 不抛异常；关闭时立即返回 disabled。
     */
    async voiceSay(text, overrides) {
      return speaker.say(text, overrides ?? {})
    },
    /**
     * 语音开关。会持久化到 state.json（不是 MEMORY.md）——
     * 之前只改内存，DSH 一重启就回落到配置里的 enabled:false，
     * 用户明明在面板上开过，重启后却发现又不出声了。
     */
    voiceSetEnabled(next) {
      speaker.cfg.enabled = Boolean(next)
      /*
       * 关掉时**立刻停掉正在播的那段**。
       *
       * SoundPlayer 的 PlaySync 一旦开始，外部没法调音量或中断，
       * 唯一的办法是 kill 掉那个进程。用户原话：
       * 「没法降低音量也没法关闭语音来关闭，只能等说完」。
       */
      if (!speaker.cfg.enabled) {
        const r = stopPlayback()
        if (r.stopped) log('info', `语音：已停止正在播放的内容（pid ${r.pid}）`)
      }
      void saveState({ voiceEnabled: speaker.cfg.enabled }).catch((e) =>
        log('warn', `语音开关保存失败：${e?.message ?? e}`)
      )
      return speaker.status()
    },
    /** 立刻停掉正在播的声音（不改开关，只停这一段） */
    voiceStop() {
      const r = stopPlayback()
      if (r.stopped) log('info', `语音：已停止（pid ${r.pid}）`)
      return { ...r, playing: isPlaying() }
    },
    /** 当前是否正在播 */
    voicePlaying() {
      return { playing: isPlaying(), ...speaker.status() }
    },
    /**
     * 改音量 / 语速。同样持久化到 state.json。
     * volume 是 dB（-12..+12），speed 是倍率（0.6..1.4）。
     */
    voiceSetParams({ volume, speed } = {}) {
      const patch = {}
      if (Number.isFinite(volume)) {
        const v = Math.max(-12, Math.min(12, Number(volume)))
        speaker.cfg.volume = v
        patch.voiceVolume = v
      }
      if (Number.isFinite(speed) && Number(speed) > 0) {
        const s = Math.max(0.5, Math.min(2, Number(speed)))
        speaker.cfg.speed = s
        patch.voiceSpeed = s
      }
      if (Object.keys(patch).length) {
        void saveState(patch).catch((e) => log('warn', `语音参数保存失败：${e?.message ?? e}`))
      }
      return speaker.status()
    },
    /**
     * B 方案：模型主动给的口播。直接合成播放，不走正文聚合。
     * 顺手标记这一轮已有口播，turn/end 时就不再兜底摘要。
     */
    async voiceAnnounce(text) {
      // 用时间戳标记，不依赖 sessionId
      announceAt = Date.now()
      return speaker.say(text, { cooldownMs: 0 })
    },
    /** 试听：用给定音量合成一句固定的话并播放 */
    async voiceTest({ volume } = {}) {
      const prev = speaker.cfg.volume
      if (Number.isFinite(volume)) speaker.cfg.volume = Number(volume)
      try {
        return await speaker.say('哎呀，这样听起来怎么样呢？音量合适吗？', { cooldownMs: 0 })
      } finally {
        speaker.cfg.volume = prev
      }
    },
    /**
     * 环境检测：显卡 / Python / 磁盘 / 引擎 / 权重。
     * 只读，不改任何东西——用户看清楚缺什么再决定装不装。
     */
    async voiceDoctor() {
      const result = await runDoctor({ engineDir: speaker.cfg.engineDir })
      return {
        ...result,
        steps: INSTALL_STEPS,
        size: SIZE_HINT,
        engineUrl: speaker.cfg.engineUrl
      }
    },
    /** 当前质疑度：越高，检索时越容易去翻归档（阈值 = 档位） */
    getSkepticismLevel() {
      try {
        const state = parseMethodbook(store.view()?.sections?.methodbook ?? '') ?? defaultMethodbook()
        return state.skepticism.level
      } catch {
        return 0
      }
    },
    async relocate(primary, mirror) {
      const status = await store.relocate(primary, mirror)
      await saveState({ primaryPath: store.primaryPath, mirrorPath: store.mirrorPath })
      initPromise = Promise.resolve(store.view())
      log('info', `记忆位置已迁移：${store.primaryPath} / ${store.mirrorPath || '未配置'}`)
      return status
    },
    async reset() {
      const tombstone = await store.destroyBoth(tombstonePath)
      await store.init()
      log('warn', `双备份已被显式删除并重建空模板（${tombstone.deletedAt}）`)
      return tombstone
    },
    /** 注入档位（lean / standard / rich），持久化到 state.json */
    async setProfile(next) {
      const id = String(next ?? '').trim()
      if (!PROFILE_IDS.includes(id)) throw new Error(`未知档位：${id}（可选 ${PROFILE_IDS.join(' / ')}）`)
      profile = id
      await saveState({ profile: id })
      return id
    },
    getProfile() {
      return profile
    },
    /** 技能自动执行开关（默认 true；dangerous 技能另需 confirm） */
    getSkillAutoRun() {
      return autoRunSkills
    },
    /** 表情包目录等选项（工具与提示词共用） */
    getStickerOptions() {
      return { stickerDir, baseUrl: stickerBaseUrl }
    },
    /** 自我记忆的注入预算（工具 status 与网页都要用它算"覆盖到哪一章"） */
    getIdentityOptions() {
      return { injectChars, identityChars }
    },
    /** 记忆网页注册后回传直链前缀 */
    onStickerBase(base) {
      stickerBaseUrl = String(base ?? '')
    },
    /** 面板用：一次性拿到所有可调项 */
    getSettings() {
      return {
        profile,
        entryCap: store.entryCap,
        graceDays: store.graceDays,
        ttlBySection: { ...(store.ttlBySection ?? {}) },
        selfTest: loadStateSync().selfTest ?? null,
        version: PLUGIN_VERSION,
        skills: skillsSummaryCached(),
        packs: packsSummaryCached()
      }
    },
    /** 流水分区 TTL（天），持久化到 state.json 并回填老条目 */
    async setTtl(map) {
      const next = {}
      for (const [section, value] of Object.entries(map ?? {})) {
        if (!ENTRY_SECTIONS.includes(section)) continue
        const days = Number(value)
        if (!Number.isFinite(days) || days < 0) continue
        next[section] = Math.round(days)
      }
      store.ttlBySection = { ...(store.ttlBySection ?? {}), ...next }
      await saveState({ ttlBySection: store.ttlBySection })
      try {
        store.backfillTtl()
      } catch {
        /* 回填失败不影响设置生效 */
      }
      return { ...store.ttlBySection }
    }
  }

  ctx.effect(() => {
    const disposers = []
    for (const tool of buildMemoryTools({ store, hooks })) {
      try {
        disposers.push(ctx.tools.register(tool))
      } catch (error) {
        log('warn', `工具注册失败 ${tool.name}：${error?.message ?? error}`)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
    }
  })

  /* ---------------- 3) 记忆网页 ---------------- */
  ctx.effect(() =>
    registerMemoryPage(ctx, { store, log, hooks, extra: () => ({ client: clientEntryInfo(ctx) }) })
  )

  /* ---------------- 4) 会话开始：登记 + 压缩后重读 ---------------- */
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    const source = String(payload?.source ?? 'startup')
    const sessionId = sessionIdOf(agent)
    const session = sessionOf(agent)
    const subagent = isSubagentSession(session)
    const cwd = String(session?.header?.cwd ?? '')

    if (source === 'compact') markReload(sessionId, 'agent/created source=compact')

    void ensureReady()
      .then(async () => {
        await store.reload(true)
        if (subagent && !recordSubagents) return
        if (source === 'compact') {
          await store.appendEntry('sessions', entryLine('上下文压缩后重读记忆', `session=${shortId(sessionId)}`))
          return
        }
        await store.appendEntry(
          'sessions',
          entryLine(source, `session=${shortId(sessionId)}｜cwd=${oneLine(cwd)}`)
        )
      })
      .catch((error) => log('warn', `会话登记失败：${error?.message ?? error}`))
  })

  /* ---------------- 5) 用户输入：摘要进「会话请求流水」 ---------------- */
  const turnMarks = new Map()
  /**
   * 每轮助手回复的文本，供 turn/end 兜底朗读。
   * `assistant/message` 一般自带 message.content；但流式被打断时可能只有
   * interrupted 的片段，所以顺手存一份，`turn/end` 时如果拿不到就用它。
   */
  const lastAssistantText = new Map()

  /**
   * 整轮聚合缓冲：sessionId → { parts: string[], chars: number }
   *
   * 一轮对话里 assistant/message 会来好几次（说一句→调工具→再说一句）。
   * 逐句念会变成「说一句…安静 10 秒…说一句」，用户反馈「中间停顿很多」。
   * 所以先攒着，等 turn/end 拼成一段再念。
   */
  const turnTextBuffer = new Map()
  /** 这一轮是否已经通过 announce 工具给过口播（B 方案）——给了就不再用 C 兜底 */

  /**
   * 把这一轮攒的文本拼成一段，念一次。
   *
   * 拼接用「，」而不是空串 —— 模型分段时本来就该有停顿，
   * 但用句号连会变成几句独立的话，合成时各带一次起音吸气。
   * 用逗号连起来更像一口气说完。
   */
  async function flushTurnBuffer(sessionId, why) {
    const slot = turnTextBuffer.get(sessionId)
    if (!slot || !slot.parts.length) return
    turnTextBuffer.delete(sessionId)
    if (!speaker.cfg.enabled) return

    /* B 方案优先：这一轮模型已经通过 announce 给过口播，不重复摘要 */
    // 这一轮末尾刚 announce 过（60 秒内）→ 不再兜底摘要
    if (announceAt && Date.now() - announceAt < 60000) {
      log('info', '语音：本轮已由 announce 提供口播，跳过兜底摘要')
      return
    }

    const rawBody = slot.parts.join('\n')
    if (oneLine(rawBody).length < Number(speaker.cfg.minChars || 4)) return

    /*
     * C 方案兜底：拿正文调一次小 LLM，压成 50-90 字口语。
     *
     * 为什么要多这一步：直接念正文的话，500 字的分析要念 30 秒，
     * 而且夹着英文术语、代码、路径。用户原话：
     * 「思考过程和分析过程应该不用语音」「只需要的是和我沟通的部分」。
     * 一次小请求约 1-2 秒，比省下来的 25 秒划算得多。
     *
     * 失败就退回全文（至少能听见点什么），不让整轮变成静音。
     */
    /* ---- 诊断：确认摘要分支真的进来了 ---- */
    try {
      const _llm = ctx.get('llm')
      const _kind =
        _llm === undefined ? 'undefined' : _llm === null ? 'null' : typeof _llm
      const _keys =
        _llm && typeof _llm === 'object' ? Object.keys(_llm).slice(0, 12).join(',') : '-'
      void import('node:fs').then((fs) => {
        const dbgDiag =
          new Date().toISOString() +
          ' [diag] summarize=' + speaker.cfg.summarizeForSpeech +
          ' llm=' + _kind +
          ' keys=[' + _keys + ']' +
          ' bodyLen=' + rawBody.length +
          '\n'
        fs.appendFileSync(path.join(stateDir, 'voice-debug.log'), dbgDiag, 'utf8')
      })
    } catch (e) {
      log('warn', '语音诊断异常：' + (e?.message ?? e))
    }

    let toSpeak = rawBody
    let source = 'raw'
    if (speaker.cfg.summarizeForSpeech !== false) {
      try {
        const r = await summarizeForSpeech(
          { get: (k) => (k === 'llm' ? ctx.get('llm') : undefined) },
          rawBody,
          {
            maxChars: Number(speaker.cfg.announceMaxChars) || 140,
            timeoutMs: Number(speaker.cfg.announceTimeoutMs) || 20000
          }
        )
        if (r.ok && r.text) {
          toSpeak = r.text
          source = r.passthrough ? 'passthrough' : 'summary'
        } else {
          void import('node:fs').then((fs) => {
            fs.appendFileSync(
              path.join(stateDir, 'voice-debug.log'),
              new Date().toISOString() +
                ' [summ-fail] reason=' + JSON.stringify(r.reason) +
                ' probe=' + JSON.stringify(r.probe ?? '') +
                ' hasStream=' + (r.hasStream ?? '-') +
                ' keys=' + JSON.stringify(r.keys ?? []) +
                '\n',
              'utf8'
            )
          })
        }
      } catch (e) {
        log('warn', `语音：摘要异常（${e?.message ?? e}），退回原文`)
      }
    }

    if (oneLine(toSpeak).length < Number(speaker.cfg.minChars || 4)) return


    const joined = slot.parts
      .map((s) => String(s).replace(/[。！？；…]+$/g, ''))
      .filter(Boolean)
      .join('，')
    if (oneLine(joined).length < Number(speaker.cfg.minChars || 4)) return

    void speaker
      .say(toSpeak)
      .then((r) => {
        try {
          const d =
            new Date().toISOString() +
            ' [sayResult] spoke=' + r.spoke +
            ' played=' + r.played +
            ' reason=' + String(r.reason || '-') +
            ' parts=' + slot.parts.length +
            ' src=' + source +
            ' why=' + why +
            ' file=' + String(r.file || '-').split(/[\\/]/).pop() +
            ' err=' + String(r.error || '-').slice(0, 120) +
            '\n'
          void import('node:fs').then((fs) =>
            fs.appendFileSync(path.join(stateDir, 'voice-debug.log'), d, 'utf8')
          )
        } catch {}
        if (r.spoke) log('info', `语音：${r.file} played=${r.played}`)
      })
      .catch((e) => log('warn', `语音失败：${e?.message ?? e}`))
  }

  /** 每轮用户输入自动匹配到的自有技能（下一轮提示词里带一行提示） */
  const skillHints = new Map()
  const SKILL_HINT_TTL_MS = 30 * 60 * 1000

  function pendingSkillHint(sessionId) {
    if (!sessionId) return ''
    const hint = skillHints.get(sessionId)
    if (!hint) return ''
    if (Date.now() - hint.at > SKILL_HINT_TTL_MS) {
      skillHints.delete(sessionId)
      return ''
    }
    const parts = hint.hits.map((item) => `\`${item.name}\`（匹配 ${item.score}）`)
    return `这轮用户输入可能命中自有技能：${parts.join('、')}。先 \`memory_file_skill({action:"match", task:"…"})\` 确认再用；也可以直接 \`{action:"read", name:"…"}\` 看步骤。`
  }

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    /* ---- 语音调试：把事件写进文件，重启后才看得到证据 ---- */
    if (speaker.cfg.enabled) {
      try {
        const dk = event.data && typeof event.data === 'object' ? Object.keys(event.data).join(',') : typeof event.data
        const mk = event.data && event.data.message ? Object.keys(event.data.message).join(',') : '(无 message)'
        const line = new Date().toISOString() + ' type=' + event.type + ' dataKeys=' + dk + ' messageKeys=' + mk + '\n'
        void import('node:fs').then((fs) =>
          fs.appendFileSync(path.join(stateDir, 'voice-debug.log'), line, 'utf8')
        )
      } catch {
        /* 调试日志失败不影响主流程 */
      }
    }
    const sessionId = sessionIdOf(session)
    const type = event.type

    /* ---------------- 语音朗读：把助手这一轮的回复念出来 ----------------
     *
     * 这里是「自动说」的接线点。之前只做了 memory_file_voice({action:"say"})
     * 那种手动调用 —— 等于「能说」但「不会自己说」，用户开了开关也听不到。
     *
     * 真实事件（从 asar 里的 SessionEventMap 确认）：
     *   'assistant/message': { turn, step, message: AssistantMessage, stream, usage?, interrupted? }
     *   'turn/end':          { turn, reason }
     * message.content 是内容块数组，文本块形如 { type: 'text', text }。
     *
     * 只在 assistant/message 时念 —— turn/end 拿不到文本，仅用来清缓存。
     * 一轮可能有多个 step（工具调用后再答），每个带文本的都会念，这是想要的：
     * 语音对话本来就该一段一段地说。
     */
    if (type === 'assistant/message' && speaker.cfg.enabled) {
      try {
        const msg = event.data?.message ?? event.message ?? event.data
        const text = messageText(msg)
        /* ---- 语音细粒度调试 ---- */
        try {
          let btypes = '-'
          if (msg && Array.isArray(msg.content)) btypes = msg.content.map((b) => (b && b.type) || '?').join('|')
          else btypes = typeof (msg && msg.content)
          const dbgLine =
            new Date().toISOString() +
            ' [say] role=' + String(msg && msg.role) +
            ' blocks=' + btypes +
            ' textLen=' + text.length +
            ' oneLine=' + oneLine(text).length +
            ' enabled=' + speaker.cfg.enabled +
            ' cooldown=' + String(speaker.status().cooldownUntil || 'none') +
            ' preview=' + JSON.stringify(oneLine(text).slice(0, 100)) +
            '\n'
          void import('node:fs').then((fs) => fs.appendFileSync(path.join(stateDir, 'voice-debug.log'), dbgLine, 'utf8'))
        } catch {}
        if (oneLine(text).length >= 2) {
          lastAssistantText.set(sessionId, text)
          lastReplyText = text
          /* ---- 整轮聚合：先攒，等 turn/end 再念 ---- */
          if (speaker.cfg.aggregateTurn) {
            const slot = turnTextBuffer.get(sessionId) ?? { parts: [], chars: 0 }
            const line = oneLine(text).trim()
            slot.parts.push(line)
            slot.chars += line.length
            turnTextBuffer.set(sessionId, slot)
            if (slot.chars >= Number(speaker.cfg.aggregateMaxChars || 240)) {
              flushTurnBuffer(sessionId, 'threshold')
            }
            return
          }
          void speaker
            .say(text)
            .then((r) => {
              try {
                const d =
                  new Date().toISOString() +
                  ' [sayResult] spoke=' + r.spoke +
                  ' played=' + r.played +
                  ' reason=' + String(r.reason || '-') +
                  ' file=' + String(r.file || '-').split(/[\\/]/).pop() +
                  ' err=' + String(r.error || '-').slice(0, 120) +
                  '\n'
                void import('node:fs').then((fs) =>
                  fs.appendFileSync(path.join(stateDir, 'voice-debug.log'), d, 'utf8')
                )
              } catch {}
              if (r.spoke) log('info', `语音：${r.file} played=${r.played}`)
              else if (r.reason && r.reason !== 'disabled' && r.reason !== 'too-short') {
                log('info', `语音跳过：${r.reason}`)
              }
            })
            .catch((e) => {
              try {
                const d = new Date().toISOString() + ' [sayThrow] ' + String(e && e.message ? e.message : e) + '\n'
                void import('node:fs').then((fs) =>
                  fs.appendFileSync(path.join(stateDir, 'voice-debug.log'), d, 'utf8')
                )
              } catch {}
              log('warn', `语音失败：${e?.message ?? e}`)
            })
        }
      } catch (error) {
        log('warn', `语音朗读失败：${error?.message ?? error}`)
      }
      return
    }
    if (type === 'turn/end') {
      lastAssistantText.delete(sessionId)
      if (speaker.cfg.aggregateTurn) flushTurnBuffer(sessionId, 'turn-end')
    }

    if (/^compact/i.test(type)) {
      markReload(sessionId, `session/event ${type}`)
      return
    }

    if (type === 'turn/start') {
      turnMarks.set(sessionId, { awaitingUser: true })
      return
    }

    if (type !== 'user/message') return
    if (!recordUserTurns) return

    const mark = turnMarks.get(sessionId)
    if (!mark || !mark.awaitingUser) return
    mark.awaitingUser = false

    const message = event.data
    if (isInjectedMessage(message)) return
    if (isCompactionCheckpoint(message)) return
    if (isSubagentSession(session) && !recordSubagents) return

    const text = messageText(message)
    if (oneLine(text).length < minUserChars) return

    const summary = clip(text, userSummaryChars)
    if (!summary) return

    /* 自动技能检索：按这轮用户输入匹配自有技能，下一轮提示词里带一行提示（不用模型主动问） */
    try {
      const hits = matchSkills(summary, { limit: 2 }).filter((item) => item.score >= 2)
      if (hits.length) {
        skillHints.set(sessionId, {
          at: Date.now(),
          hits: hits.map((item) => ({ name: item.name, score: item.score, description: clip(item.description, 50) }))
        })
      } else {
        skillHints.delete(sessionId)
      }
    } catch {
      /* 技能目录读失败不影响记录 */
    }

    const cwd = String(session?.header?.cwd ?? '')
    const scope = projectScope(cwd) || GLOBAL_SCOPE

    void ensureReady()
      .then(() => store.appendEntry('requests', entryLine(summary, `自动记录｜session=${shortId(sessionId)}`, scope)))
      .catch((error) => log('warn', `用户输入记录失败：${error?.message ?? error}`))
  })

  /* ---------------- 6) 压缩动作本身（LLM purpose=compaction）
   *      兼：流式语音朗读（边生成边念） ---------------- */
  ctx.on('llm/stream', async function* (options, next) {
    try {
      if (String(options?.purpose ?? '') === 'compaction') {
        markReload(sessionIdOf({ session: { id: options?.sessionId } }), 'llm/stream purpose=compaction')
        await flushBeforeCompaction('llm/stream purpose=compaction')
      }
    } catch {
      /* 探测失败不影响主流程 */
    }

    /*
     * 流式语音：边生成边念。
     *
     * ★ 硬约束（AGENTS.md 里记的坑）：
     *   `llm/stream` 是 waterfall，必须 `async function*` + `yield* next()`。
     *   写成 async 箭头函数体里直接交回 next()（不带 yield*）会让 DSH 每轮崩；
     *   手写 `for await (…) yield c` 虽然语义等价，
     *   但这个仓库的 smoke 测试认的就是 `yield* next()` 字面写法。
     *   所以**主路径保持 yield* next() 不变**，语音走完全独立的旁路。
     *
     * 旁路怎么拿到文本：next() 只能消费一次，不能既 yield* 又自己遍历。
     * 所以用「包装 next 返回的流」——把 source 塞进一个 tee 里，
     * 主动消费的那一路交给 yield*，镜像那一路只读不阻塞。
     */
    let streamSource = next()

    /*
     * 旁路：如果语音开着，就把 source 包一层 tap 流再交给 yield*。
     * tap 流只做一件事——交出 chunk 的同时把文本丢给句子缓冲。
     * 它内部不 await 任何合成，所以不会拖慢流。
     *
     * 用 typeof 探测而不是直接读 speaker：这个钩子会被测试单独抠出来跑，
     * 那时 speaker 不在作用域里。**语音开不了事小，流断了事大**。
     */
    let narrate = false
    try {
      narrate =
        typeof speaker !== 'undefined' &&
        Boolean(speaker?.cfg?.enabled) &&
        speaker.cfg.streaming !== false &&
        ['', 'chat', 'agent'].includes(String(options?.purpose ?? ''))
    } catch {
      narrate = false
    }

    if (narrate) {
      try {
        const sink = createSentenceBuffer({
          maxChars: Number(speaker.cfg.streamMaxChars) || 90,
          minChars: Number(speaker.cfg.minChars) || 4,
          skipCodeBlocks: speaker.cfg.stripCodeBlocks !== false
        })
        const pushSentence = (s) => {
          try {
            void speaker.say(s, { cooldownMs: 0 }).catch(() => {})
          } catch {
            /* 忽略 */
          }
        }
        const source = streamSource
        streamSource = (async function* tap() {
          try {
            for await (const chunk of source) {
              try {
                const delta = extractChunkText(chunk)
                if (delta) for (const s of sink.push(delta)) pushSentence(s)
              } catch {
                /* 提取失败不影响透传 */
              }
              yield chunk
            }
          } finally {
            try {
              for (const s of sink.flush()) pushSentence(s)
            } catch {
              /* 忽略 */
            }
          }
        })()
      } catch {
        /* 旁路挂掉就退回原始流 */
      }
    }

    yield* streamSource
  })

  /* ---------------- 7) 启动对账 + 定时巡检 ---------------- */
  void ensureReady().catch(() => {
    /* ensureReady 内部已记日志 */
  })
  void ensureMethodbook()
  void maybeInstallSelfTest()
  void scanPacksOnce()
  void ensureReady()
    .then(() => {
      const filled = store.backfillTtl()
      if (filled) log('info', `已给 ${filled} 条流水记忆补上默认过期时间`)
      const emphasized = store.backfillEmphasis()
      if (emphasized) log('info', `已给 ${emphasized} 条历史记忆补上强调权重`)
    })
    .catch(() => {
      /* ensureReady 内部已记日志 */
    })

  const runReconcile = async (reason) => {
    try {
      await ensureReady()
      const result = await store.reconcile()
      if (result.action && result.action !== 'in-sync') {
        log('info', `定时对账（${reason}）：${result.action}`)
        await store.reload(true)
      }
    } catch (error) {
      log('warn', `定时对账失败（${reason}）：${error?.message ?? error}`)
    }
  }

  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') {
      log('info', 'timer 服务不可用，跳过定时对账')
      return () => {}
    }
    return ctx.interval(() => {
      void runReconcile('interval')
    }, reconcileIntervalMs)
  })

  log(
    'info',
    `已加载：主=${store.primaryPath} 镜像=${store.mirrorPath || '（未配置）'}；网页 ${MEMORY_PAGE_PREFIX}；巡检 ${Math.round(reconcileIntervalMs / 60000)} 分钟`
  )
}
