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
  play: true,
  /**
   * 整轮聚合：等这一轮说完，把多段文本拼成一段再念。
   *
   * 为什么默认开：一轮对话里 assistant/message 会来好几次
   * （说一句 → 调工具 → 再说一句 → 再调工具……）。
   * 逐句念的听感是「说一句…安静 10 秒…说一句…安静 10 秒」，
   * 用户原话：「不同任务的都在一起说话，而且中间停顿很多」。
   *
   * 聚合成一段 → 合成一次 → 播一次，才像一段自然的叙述。
   * 代价是要等这一轮结束才出声，但用户明确选了「整轮说完再念」。
   */
  aggregateTurn: true,
  /** 聚合上限：攒够这么多字就先念，不等整轮结束（避免长回复憋太久） */
  aggregateMaxChars: 240,
  /**
   * 流式逐句朗读：**默认关闭**。
   *
   * ⚠️ 2026-11-06：这条线和「整轮聚合」同时开着，导致两套语音互相抢——
   * 流式那条边生成边念（碎），聚合那条在 turn/end 再念一次（完整），
   * 用户听到的是「句子之间互抢」。
   *
   * 现在统一走「整轮聚合 + 口播」，流式那条只在显式设 true 时才启用。
   */
  streaming: false,
  /** C 方案：没调 announce 时，用 LLM 把正文压成口播（默认开） */
  summarizeForSpeech: true,
  /** 口播长度上限（字） */
  announceMaxChars: 140,
  /** 摘要请求超时（毫秒） */
  announceTimeoutMs: 20000,
  /**
   * 播放是否串行：正在播一段时，后面的排队等它播完，而不是同时播。
   *
   * fire-and-forget 的 playWav 在两条 say 挨得近时会让两个 SoundPlayer
   * 同时出声，互相盖住——用户听到的就是「互抢」。
   */
  serializePlayback: true
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
/**
 * 播放串行链：同一时刻只有一段在播，后面的排队等。
 *
 * 为什么需要：原来 playWav 是 fire-and-forget，两条 say 挨得近时
 * 两个 SoundPlayer 会同时出声互相盖住——用户原话「句子之间会互抢」。
 */
let playChain = Promise.resolve()

export function playWav(wavPath, logger = null) {
  const run = playChain.then(
    () => playOne(wavPath, logger),
    () => playOne(wavPath, logger)
  )
  // 队列不能因为某一段失败而断掉
  playChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 真正的播放：等它播完（exit）才 resolve，串行链才有效。
 *
 * ⚠️ 两个不能再犯的坑：
 *   1. **不能 detached** —— 子进程进新进程组后音频会话上下文不对，
 *      SoundPlayer 静默不发声（不报错也不返回）。实测四组对照确认。
 *   2. **不能 unref** —— unref 之后父进程不再等它，也就收不到 exit，
 *      队列会以为「播完了」立刻放行下一段，又变回同时播。
 *
 * 父进程不会因此阻塞：调用方 await 的是这个 Promise，不是同步等。
 * 90 秒兜底：万一 exit 不来（进程卡住），强制放行。
 */
function playOne(wavPath, logger = null) {
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

    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    try {
      const child = spawn(
        exe,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
        { detached: false, stdio: 'ignore', windowsHide: true }
      )
      const timer = setTimeout(() => finish({ played: true, timedOut: true }), 90000)
      child.on('error', (e) => {
        clearTimeout(timer)
        logger?.warn?.(`[elysia-voice] 播放失败：${e.message}`)
        finish({ played: false, reason: e.message })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish({ played: true, exitCode: code ?? 0 })
      })
    } catch (e) {
      finish({ played: false, reason: e.message })
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

    /*
     * ★ 2026-11-06 卡死修复：再加一道 'exit' 监听。
       *
     * 'close' 要求**子进程退出且所有 stdio 管道关闭**。如果 Python 那边
     * 因为任何原因挂住（等 CUDA、等 socket、stdout 阻塞），'close' 永远不来。
     * 上面虽有 timer 兜底，但实际观测到的现象是：
     * 日志有 [say]、永远没有 [sayResult]，后面的句子全堵在串行队列里。
       *
     * 'exit' 只要进程真的结束就触发，不依赖 stdio 排空。
     * 留 120ms 让 stdout 最后几个 chunk 到齐（[ok] 行含文件路径）。
       */
      child.on('exit', () => {
      setTimeout(() => {
        if (done) return
        done = true
        clearTimeout(timer)
          const m = /(\S+\.wav)\s*$/m.exec(out)
        if (m && existsSync(m[1])) {
          resolve({ ok: true, file: m[1], stdout: out, stderr: err })
        } else {
          resolve({ ok: false, error: (err || out || '进程退出但没有产出音频').slice(-400) })
        }
      }, 120)
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
  /**
   * 串行队列：同一时刻只跑一个合成。
   *
   * 为什么不是「丢掉后到的」：一次合成要 5-6 秒，而一轮对话里
   * assistant/message 可能来三四次（短句 → 工具 → 长回复）。
   * 如果后到的直接 return，长回复永远轮不上，用户听到的是沉默。
   * 排队的话，最多慢一点，但每句都会念到。
   */
  let chain = Promise.resolve()

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
        speed: cfg.speed,
        volume: cfg.volume,
        failStreak,
        cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
        lastAt: lastAt ? new Date(lastAt).toISOString() : null
      }
    },

    /**
     * 朗读一段文本。返回 { spoke, reason?, file? }。
     * 任何情况下都不抛异常。
     */
    /**
     * 朗读一段文本。返回 { spoke, reason?, file? }。
     * 任何情况下都不抛异常。
     *
     * 外面套一层串行队列：并发的调用会排队而不是互相挤掉。
     * 一轮对话里 assistant/message 可能来好几次（短句 → 工具 → 长回复），
     * 丢掉后到的意味着长回复永远念不出来。
     */
    say(rawText, overrides = {}) {
      const run = chain.then(() => this._sayOnce(rawText, overrides))
      // 队列本身不能因为单次失败而断掉
      chain = run.then(
        () => undefined,
        () => undefined
      )
      /*
       * 兜底超时：_sayOnce 内部已经有多道超时（合成 120s / 探活 12s），
       * 但如果某处 await 真的悬住（例如 spawn 的 close 事件没触发），
       * 整个 Promise 会永远 pending —— 表现就是「日志里有 [say]，
       * 但永远没有 [sayResult]」，用户端一片沉默且毫无线索。
       * 这里加一道总闸：180 秒还没结果，就当作失败返回，让调用方继续。
       */
      return Promise.race([
        run,
        new Promise((resolve) =>
          setTimeout(() => resolve({ spoke: false, reason: 'timeout' }), 180000).unref?.()
        )
      ])
    },

    async _sayOnce(rawText, overrides = {}) {
      if (!cfg.enabled) return { spoke: false, reason: 'disabled' }

      const now = Date.now()
      if (cooldownUntil > now) {
        return { spoke: false, reason: 'cooldown', until: new Date(cooldownUntil).toISOString() }
      }
      /*
       * 排队而不是丢弃。
       *
       * ⚠️ 2026-11-06 实测的坑：一轮对话里模型会先冒一句「好的，我来看看」
       * 然后立刻调工具，真正的内容在后面的长回复里。一次合成要 5-6 秒，
       * 如果第二次到达时因为 cooldown（800ms）直接 return 'throttled'，
       * 那么**长句永远轮不到**——用户听到的是沉默。
       *
       * 所以：同一时间只跑一个合成，后来的**排队**等前一个跑完，
       * 而不是丢掉。队列里只保留最新一条（旧的话已经过时了）。
       */
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
