/**
 * DSH-elysia / voice.js —— 语音朗读（可选功能）
 *
 * ## 它做什么
 *
 * 把助手这一轮的回复文本，交给本机的 GPT-SoVITS 引擎合成成语音，
 * 再由宿主播放。用户听得到「她」说话，而不只是读到。
 *
 * ## 为什么默认关闭
 *
 * 语音需要三样外部条件同时就绪：
 *   1. 本机装了 GPT-SoVITS 引擎（`D:\tts\GPT-SoVITS-*`）
 *   2. 引擎在 9880 端口跑着
 *   3. 有可用的参考音频
 * 换一台机器这些都不在。**插件本身要能干净地跑，语音是加装的皮肤。**
 * 所以 `voice.enabled` 默认 `false`，用户主动打开才生效。
 *
 * ## 为什么不在这里合成
 *
 * GPT-SoVITS 是 Python 栈（torch + CUDA + 一堆模型权重）。
 * 插件是纯 JS，不装任何 Python 依赖、不 import 任何第三方包。
 * 所以这里只做三件事：**预处理文本 → 起子进程调引擎 → 交回音频路径**。
 *
 * ## 静音失败
 *
 * 语音是锦上添花。引擎没起来、权重缺失、显存不够 —— 任何一种都不该
 * 让对话本身出错。所有失败都只记日志，静默降级成"这轮不出声"。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 默认引擎地址与权重（用户可在配置里覆盖） */
export const VOICE_DEFAULTS = {
  enabled: false,
  engineUrl: 'http://127.0.0.1:9880',
  pythonPath: '',
  scriptPath: '',
  model: 'v5turbo',
  ref: 'R06',
  speed: 1.0,
  /** 少于这么多字不朗读（"好的"「嗯」这种没必要出声） */
  minChars: 4,
  /** 超过这么多字截断（长报告念起来很折磨） */
  maxChars: 1200,
  /** 两次朗读之间的最小间隔，毫秒 */
  cooldownMs: 800,
  /** 是否朗读代码块之外的部分 */
  stripCodeBlocks: true
}

/**
 * 把 Markdown 回复清洗成适合朗读的纯文本。
 *
 * 念「三个星号、三个星号、标题、冒号」是灾难。规则：
 *   - 去掉代码块（整段）、行内代码只留内容
 *   - 去掉表格（读出来毫无意义）
 *   - 链接只留文字
 *   - 去掉 Markdown 标记符
 *   - 数字和英文之间补空格，让引擎断句自然
 *   - 压缩连续空行
 */
export function cleanForSpeech(text, options = {}) {
  const stripCode = options.stripCodeBlocks !== false
  let s = String(text ?? '')

  // 1. 代码块整段去掉（含 ``` 围栏）
  if (stripCode) {
    s = s.replace(/```[\s\S]*?```/g, ' ')
    s = s.replace(/~~~[\s\S]*?~~~/g, ' ')
  }

  // 2. 表格整块去掉（连续的 | ... | 行）
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')

  // 3. 图片 / 链接 → 只留文字
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 4. HTML 标签
  s = s.replace(/<[^>]+>/g, ' ')

  // 5. 引用符号与列表符号
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*\d+\.\s+/gm, '')

  // 6. 标题符号
  s = s.replace(/^\s*#{1,6}\s+/gm, '')

  // 7. 强调 / 删除线 / 行内代码
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')
  s = s.replace(/(\*|_)(.*?)\1/g, '$2')
  s = s.replace(/~~(.*?)~~/g, '$1')

  // 8. 水平线
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')

  // 9. ♪ 之类的装饰符：gbk 编码会炸，直接去掉
  s = s.replace(/[♪♫♬]/g, '')

  // 10. 空白收敛
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()

  return s
}

/** 引擎是否活着 */
export async function engineAlive(engineUrl, timeoutMs = 1500) {
  const url = String(engineUrl || '').replace(/\/+$/, '')
  if (!url) return false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(`${url}/docs`, { signal: ctl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/**
 * 调 elysia_say.py 合成一句话，返回音频文件路径。
 *
 * 用子进程而不是直接打 HTTP，因为 elysia_say.py 里有一整套后处理链
 * （去齿音、谱减降噪、吸气压缩、语速、说话时机对齐），
 * 这些是反复调出来的，不该在插件里重写一遍。
 */
export function synthesizeViaScript({ scriptPath, pythonPath, text, options = {}, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    if (!scriptPath || !existsSync(scriptPath)) {
      resolve({ ok: false, error: `找不到合成脚本：${scriptPath || '(未配置)'}` })
      return
    }
    const py = pythonPath || 'python'
    const args = [
      scriptPath,
      text,
      '--save-only', // 只出文件，不自己播放（播放交给宿主）
      '--no-auto-start', // 引擎没起就算了，别在这里拉起一个几百 MB 的进程
      '--model', String(options.model ?? VOICE_DEFAULTS.model),
      '--ref', String(options.ref ?? VOICE_DEFAULTS.ref)
    ]
    if (Number.isFinite(options.speed)) args.push('--speed', String(options.speed))

    let out = ''
    let err = ''
    let done = false
    const child = spawn(py, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        resolve({ ok: false, error: '合成超时' })
      }
    }, timeoutMs)

    child.stdout?.on('data', (b) => {
      out += b.toString('utf8')
    })
    child.stderr?.on('data', (b) => {
      err += b.toString('utf8')
    })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, error: `启动失败：${e.message}` })
    })
    child.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      // elysia_say.py 成功时 stdout 形如：
      //   [ok] 3.37s | 316KB | 合成 1.63s | RTF=0.49
      //        C:\...\say_20261106_015437.wav
      const m = /(\S+\.wav)\s*$/m.exec(out)
      if (m && existsSync(m[1])) {
        resolve({ ok: true, file: m[1], stdout: out, stderr: err })
      } else {
        resolve({ ok: false, error: (err || out || '没有产出音频').slice(-400) })
      }
    })
  })
}

/**
 * 语音朗读器：带节流、去重、失败熔断。
 *
 * 熔断的理由：引擎挂了的时候，每一轮都去 spawn 一个 python 进程、
 * 等 120 秒超时，会拖慢整个对话。连续失败 3 次就停 5 分钟再试。
 */
export function createSpeaker(config = {}, logger = null) {
  const cfg = { ...VOICE_DEFAULTS, ...config }
  let lastAt = 0
  let failStreak = 0
  let cooldownUntil = 0
  let lastHash = ''

  const log = (level, msg) => {
    try {
      logger?.[level]?.(`[elysia-voice] ${msg}`)
    } catch {
      /* 日志本身不该抛 */
    }
  }

  return {
    cfg,

    get enabled() {
      return Boolean(cfg.enabled)
    },

    /** 状态：给 UI / 工具用 */
    status() {
      return {
        enabled: Boolean(cfg.enabled),
        engineUrl: cfg.engineUrl,
        model: cfg.model,
        ref: cfg.ref,
        failStreak,
        cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
        lastAt: lastAt ? new Date(lastAt).toISOString() : null
      }
    },

    /**
     * 朗读一段文本。返回 { spoke, reason?, file? }。
     * 任何情况下都不抛异常。
     */
    async say(rawText, overrides = {}) {
      if (!cfg.enabled) return { spoke: false, reason: 'disabled' }

      const now = Date.now()
      if (cooldownUntil > now) {
        return { spoke: false, reason: 'cooldown', until: new Date(cooldownUntil).toISOString() }
      }
      const gap = Number(overrides.cooldownMs ?? cfg.cooldownMs)
      if (lastAt && now - lastAt < gap) return { spoke: false, reason: 'throttled' }

      const text = cleanForSpeech(rawText, { stripCodeBlocks: cfg.stripCodeBlocks })
      if (text.length < Number(cfg.minChars)) return { spoke: false, reason: 'too-short' }

      const clipped = text.length > Number(cfg.maxChars) ? text.slice(0, Number(cfg.maxChars)) : text

      // 完全相同的内容不重复朗读（重试、刷新都可能触发）
      const hash = `${clipped.length}:${clipped.slice(0, 64)}`
      if (hash === lastHash) return { spoke: false, reason: 'duplicate' }
      lastHash = hash

      const alive = await engineAlive(cfg.engineUrl)
      if (!alive) {
        failStreak += 1
        if (failStreak >= 3) cooldownUntil = Date.now() + 5 * 60 * 1000
        return { spoke: false, reason: 'engine-down' }
      }

      const r = await synthesizeViaScript({
        scriptPath: cfg.scriptPath,
        pythonPath: cfg.pythonPath,
        text: clipped,
        options: {
          model: overrides.model ?? cfg.model,
          ref: overrides.ref ?? cfg.ref,
          speed: overrides.speed ?? cfg.speed
        }
      })

      if (!r.ok) {
        failStreak += 1
        if (failStreak >= 3) cooldownUntil = Date.now() + 5 * 60 * 1000
        log('warn', `合成失败：${r.error}`)
        return { spoke: false, reason: 'synth-failed', error: r.error }
      }

      failStreak = 0
      lastAt = Date.now()
      log('info', `已合成 ${path.basename(r.file)}`)
      return { spoke: true, file: r.file }
    },

    /** 给测试用：手动清状态 */
    _reset() {
      lastAt = 0
      failStreak = 0
      cooldownUntil = 0
      lastHash = ''
    }
  }
}
