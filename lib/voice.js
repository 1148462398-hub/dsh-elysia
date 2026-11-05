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
  /** GPT-SoVITS 引擎根目录（里面有 api_v2.py）；留空 = 不自动拉起 */
  engineDir: '',
  pythonPath: '',
  scriptPath: '',
  /** 跑 elysia_say.py 的 Python（需要 numpy/scipy，不需要 torch）*/
  sayPythonPath: '',
  model: 'v5turbo',
  ref: 'R06',
  speed: 1.0,
  /** 音量增益（dB）。0 = 不调；+6 约两倍响，-6 约一半。只改波形幅度，不动系统音量 */
  volume: 0,
  /** 少于这么多字不朗读（"好的"「嗯」这种没必要出声） */
  minChars: 4,
  /** 超过这么多字截断（长报告念起来很折磨） */
  maxChars: 1200,
  /** 两次朗读之间的最小间隔，毫秒 */
  cooldownMs: 800,
  /** 是否朗读代码块之外的部分 */
  stripCodeBlocks: true,
  /** 合成完是否直接播放（false = 只出文件，测试用） */
  play: true
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

/**
 * 引擎是否活着。
 *
 * ⚠️ 2026-11-06 踩坑：GPT-SoVITS 的 `/docs` 端点**首次请求会卡 4 秒以上**
 * （FastAPI 冷启动 + 模型预热），之后才 0.09s 返回。
 * 老插件 dsh-elysia-vox 用 `timeout=4.0` 探活，撞上这个慢请求就判成 false，
 * 直接返回退出码 2 —— 表现就是「明明引擎在跑，语音却一直不出声」。
 *
 * 所以这里：超时给到 12 秒，并且**失败重试一次**（第二次通常是热的）。
 */
export async function engineAlive(engineUrl, timeoutMs = 12000) {
  const url = String(engineUrl || '').replace(/\/+$/, '')
  if (!url) return false
  const probe = async (ms) => {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), ms)
      const res = await fetch(`${url}/docs`, { signal: ctl.signal })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }
  if (await probe(timeoutMs)) return true
  // 第一次超时可能只是冷启动，再给一次机会
  return probe(Math.min(timeoutMs, 6000))
}

/**
 * 用 PowerShell SoundPlayer 播放 wav，完全脱离父进程。
 *
 * 为什么不用 Node 的音频库：插件是纯 JS、零依赖，装 native 音频模块会拖垮安装。
 * SoundPlayer 是 Windows 自带，`PlaySync()` 在独立进程里跑，DSH 完全不等它。
 */
export function playWav(wavPath, logger = null) {
  return new Promise((resolve) => {
    if (!wavPath || !existsSync(wavPath)) {
      resolve({ played: false, reason: 'file-missing' })
      return
    }
    const ps =
      "$ErrorActionPreference='SilentlyContinue';" +
      `$p=New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}';` +
      '$p.PlaySync()'
    const winPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const exe = existsSync(winPs) ? winPs : 'powershell'
    try {
      const child = spawn(
        exe,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
        { detached: true, stdio: 'ignore', windowsHide: true }
      )
      child.on('error', (e) => {
        logger?.warn?.(`[elysia-voice] 播放失败：${e.message}`)
        resolve({ played: false, reason: e.message })
      })
      child.unref()
      // PlaySync 在子进程里跑，父进程立刻返回
      resolve({ played: true })
    } catch (e) {
      resolve({ played: false, reason: e.message })
    }
  })
}

/**
 * 引擎没起就把它拉起来。
 *
 * 为什么不写在「每次合成前」：GPT-SoVITS 加载权重 + 上 CUDA 要 40-60 秒，
 * 每轮都等这个会让人以为卡死了。只在**开关刚打开**或**首次朗读前**试一次，
 * 成功就记住，失败也记住（不再反复 spawn）。
 *
 * 用法：`python api_v2.py -a 127.0.0.1 -p 9880`，工作目录必须是引擎根目录
 * （脚本用相对路径找 GPT_SoVITS/configs/tts_infer.yaml）。
 */
export async function ensureEngine(options = {}, logger = null) {
  const {
    engineUrl = VOICE_DEFAULTS.engineUrl,
    engineDir = '',
    pythonPath = '',
    timeoutMs = 180000
  } = options

  if (await engineAlive(engineUrl, 1500)) return { started: false, alive: true, reason: 'already-running' }
  if (!engineDir || !existsSync(engineDir)) {
    return { started: false, alive: false, reason: `引擎目录不存在：${engineDir || '(未配置)'}` }
  }
  const py = pythonPath || 'python'
  if (!existsSync(py) && py !== 'python') {
    return { started: false, alive: false, reason: `Python 不存在：${py}` }
  }

  const url = new URL(engineUrl)
  const port = url.port || '9880'
  const host = url.hostname || '127.0.0.1'

  try {
    logger?.info?.(`[elysia-voice] 启动引擎：${engineDir}`)
    const child = spawn(py, ['api_v2.py', '-a', host, '-p', port], {
      cwd: engineDir,
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    })
    // 脱离父进程：DSH 关掉时引擎可以继续跑，下次就不用再等 50 秒
    child.unref()
  } catch (e) {
    return { started: false, alive: false, reason: `启动失败：${e.message}` }
  }

  // 轮询等它就绪
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await engineAlive(engineUrl, 1500)) {
      logger?.info?.('[elysia-voice] 引擎已就绪')
      return { started: true, alive: true }
    }
  }
  return { started: true, alive: false, reason: '启动超时' }
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
    // 音量：只在非 0 时传。0 是脚本默认值（不调），传了反而多跑一次读写。
    if (Number.isFinite(options.volume) && options.volume !== 0) {
      args.push('--volume', String(options.volume))
    }

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
  /** 引擎自动拉起只试一次：失败后不再反复 spawn（每次要等 40-60 秒） */
  let engineAttempted = false

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
        // 第一次发现没起就试着拉一次；成败都记住，不反复 spawn
        if (!engineAttempted) {
          engineAttempted = true
          const r = await ensureEngine(
            { engineUrl: cfg.engineUrl, engineDir: cfg.engineDir, pythonPath: cfg.pythonPath },
            logger
          )
          if (!r.alive) {
            failStreak += 1
            if (failStreak >= 3) cooldownUntil = Date.now() + 5 * 60 * 1000
            return { spoke: false, reason: 'engine-down', error: r.reason }
          }
        } else {
          failStreak += 1
          if (failStreak >= 3) cooldownUntil = Date.now() + 5 * 60 * 1000
          return { spoke: false, reason: 'engine-down' }
        }
      }

      const r = await synthesizeViaScript({
        scriptPath: cfg.scriptPath,
        pythonPath: cfg.sayPythonPath || cfg.pythonPath,
        text: clipped,
        options: {
          model: overrides.model ?? cfg.model,
          ref: overrides.ref ?? cfg.ref,
          speed: overrides.speed ?? cfg.speed,
          volume: overrides.volume ?? cfg.volume
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

      // 合成完直接播。cfg.play === false 时只出文件不发声（测试 / 调试用）。
      let played = false
      if (cfg.play !== false) {
        const pr = await playWav(r.file, logger)
        played = Boolean(pr.played)
        if (!played) log('warn', `播放失败：${pr.reason}`)
      }
      return { spoke: true, file: r.file, played }
    },

    /** 给测试用：手动清状态 */
    _reset() {
      lastAt = 0
      failStreak = 0
      cooldownUntil = 0
      lastHash = ''
      engineAttempted = false
    }
  }
}
