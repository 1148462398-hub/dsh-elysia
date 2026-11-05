/**
 * lib/streamtext.js —— 流式文本 → 句子切分
 *
 * 从 LLM 的流式 chunk 里攒文本，够一句就吐出来，好让语音「边生成边念」。
 *
 * ## 什么时候算一句
 *
 * 只认句末标点：`。 ！ ？ ！ ？ ； …` 以及英文 `. ! ? ;`。
 * **逗号不断** —— 用户明确要「句号/问号/感叹号断句」，
 * 逗号断会碎成一顿一顿的。
 *
 * ## 为什么要有上限
 *
 * 模型有时候一口气写 300 字不用句号（尤其列表、长句）。
 * 硬等句号会让第一句话憋很久，所以加个 `maxChars` 兜底：
 * 超过就在最近的逗号处切，没有逗号就硬切。
 *
 * ## 代码块怎么办
 *
 * ``` 围栏里的内容不念（读出来是灾难），用一个开关跳过。
 * 但**围栏本身要能闭合**，不能因为跳过而把后面的正文也吞掉。
 */

/** 句末标点（中文 + 英文） */
const SENTENCE_END = /[。！？；…!?;]/

/** 二级断点：兜底用 */
const SOFT_BREAK = /[，,、：:—]/

export function createSentenceBuffer(options = {}) {
  const maxChars = Number(options.maxChars) || 120
  const minChars = Number(options.minChars) || 4
  const skipCodeBlocks = options.skipCodeBlocks !== false

  let buf = ''
  let inFence = false
  let fenceMarker = ''
  const out = []

  /** 从 buf 里切出完整的句子，push 到 out */
  function drain() {
    for (;;) {
      let cut = -1

      // 1. 找句末标点
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i]
        if (SENTENCE_END.test(ch)) {
          // 连续标点（「？！」「……」）一起切走
          let j = i + 1
          while (j < buf.length && SENTENCE_END.test(buf[j])) j++
          cut = j
          break
        }
      }

      // 2. 没有句末标点但太长 → 在最近逗号处切
      if (cut < 0 && buf.length > maxChars) {
        for (let i = Math.min(buf.length - 1, maxChars); i >= 0; i--) {
          if (SOFT_BREAK.test(buf[i])) {
            cut = i + 1
            break
          }
        }
        // 连逗号都没有就硬切
        if (cut < 0) cut = maxChars
      }

      if (cut < 0) break

      const piece = buf.slice(0, cut).trim()
      buf = buf.slice(cut)
      if (piece.length >= minChars) out.push(piece)
    }
  }

  return {
    /**
     * 喂一段增量文本。返回本次新切出的完整句子（可能为空数组）。
     */
    push(delta) {
      if (!delta || typeof delta !== 'string') return []
      out.length = 0

      if (!skipCodeBlocks) {
        buf += delta
        drain()
        return out.slice()
      }

      // 逐字符处理围栏，围栏内的内容丢弃（但仍要能识别闭合）
      let i = 0
      while (i < delta.length) {
        if (!inFence) {
          // 找下一个 ``` 或 ~~~
          const m = /```|~~~/g
          m.lastIndex = i
          const hit = m.exec(delta)
          if (!hit) {
            buf += delta.slice(i)
            break
          }
          buf += delta.slice(i, hit.index)
          // 检查围栏闭合：``` 后面可能跟语言名，这里只认三连
          fenceMarker = hit[0]
          inFence = true
          i = hit.index + 3
        } else {
          // 围栏内：找闭合
          const idx = delta.indexOf(fenceMarker, i)
          if (idx < 0) {
            i = delta.length
            break
          }
          inFence = false
          i = idx + 3
          // 关闭围栏后补一个句号，让前面未完成的句子能切出来
          buf += '。'
        }
      }

      drain()
      return out.slice()
    },

    /** 收尾：把剩下的不管完整与否都吐出去 */
    flush() {
      out.length = 0
      const rest = buf.trim()
      buf = ''
      inFence = false
      if (rest.length >= minChars) out.push(rest)
      return out.slice()
    },

    /** 当前缓冲里还有多少没吐出去 */
    pending() {
      return buf.length
    },

    reset() {
      buf = ''
      inFence = false
      out.length = 0
    }
  }
}

/**
 * 从 LLM 的 chunk 对象里抽文本。
 *
 * DSH 的 chunk 形状不固定（可能挂在 `delta.content` / `content` / `text`），
 * 这里把几种常见形态都兜住，抽不到就返回空串——**绝不能让提取失败影响主流程**。
 */
export function extractChunkText(chunk) {
  if (!chunk) return ''
  try {
    if (typeof chunk === 'string') return chunk

    // OpenAI 风格：choices[0].delta.content
    const choice = chunk.choices?.[0]
    if (choice) {
      const d = choice.delta ?? choice.message
      if (typeof d?.content === 'string') return d.content
      if (Array.isArray(d?.content)) {
        return d.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('')
      }
    }

    // 直接挂 content
    if (typeof chunk.content === 'string') return chunk.content
    if (Array.isArray(chunk.content)) {
      return chunk.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    }

    if (typeof chunk.text === 'string') return chunk.text
    if (typeof chunk.delta === 'string') return chunk.delta
    if (typeof chunk.delta?.text === 'string') return chunk.delta.text
  } catch {
    /* 提取失败就当没这一块 */
  }
  return ''
}
