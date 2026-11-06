/**
 * lib/announce.js —— 「口播」：把回复压成一句适合念出来的话
 *
 * ## 为什么需要这一层
 *
 * 用户原话：「思考过程和分析过程应该不用语音」「只需要的是和我沟通的部分」。
 * 直接念正文的问题：
 *   - 500 字的分析念 30 秒，跟不上对话
 *   - 夹英文术语（`messageText`、`type === 'text'`），念出来是灾难
 *   - 代码、表格、路径全在
 *
 * ## 两条路（B + C）
 *
 *   B. 模型主动调 memory_file_voice({action:"announce", text:"…"})
 *      —— 最快，跟正文一致，但依赖模型记得调
 *
 *   C. 插件在 turn/end 时兜底：拿正文再调一次 LLM，压成 60 字口语
 *      —— 保证不漏，代价是多一次小请求（约 1-2 秒）
 *
 * 谁先到用谁；B 调过之后，C 这一轮就跳过。
 *
 * ## 硬规矩
 *
 * 口播**只能压缩正文，不能超出正文**。
 * 正文说「做不到」，口播不能变成「可以试试」——那是欺骗。
 * 所以给 LLM 的提示词里明确要求「不新增任何信息」。
 */

/** 口播的系统提示词 */
export const ANNOUNCE_SYSTEM = [
  '你是一个「口播压缩器」。',
  '',
  '用户刚收到一段技术回复，现在要把它的**核心意思**压成一句可以直接读出口的话。',
  '',
  '规则（必须遵守）：',
  '1. **只用纯中文**，不出现任何英文单词、代码、路径、变量名。',
  '2. **50-90 字**，一句话或两短句，能一口气说完。',
  '3. 保留**结论和态度**，丢掉过程、步骤、参数、列表。',
  '4. **不新增任何正文里没有的信息**——只压缩，不发挥。',
  '5. 语气自然，像在跟人说话，允许用「嗯」「其实」「不过」这类口语词。',
  '6. 如果正文本身就是在报告失败或问题，口播要如实说失败，不能美化成成功。',
  '',
  '只输出那句话本身，不要任何前缀、引号、解释。'
].join('\n')

/**
 * 调 LLM 把正文压成口播。
 *
 * @param {object} ctx  cordis 上下文（用来 ctx.get('llm')）
 * @param {string} bodyText  完整正文
 * @param {object} options  { provider, model, timeoutMs, maxChars }
 * @returns {Promise<{ok:boolean, text?:string, reason?:string}>}
 */
export async function summarizeForSpeech(ctx, bodyText, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 20000
  const maxChars = Number(options.maxChars) || 140

  const text = String(bodyText ?? '').trim()
  if (text.length < 20) {
    // 本来就很短，不用压
    return { ok: true, text: text.slice(0, maxChars), passthrough: true }
  }

  let llm
  try {
    llm = ctx?.get?.('llm')
  } catch {
    llm = undefined
  }
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'llm-unavailable' }
  }

  // 自动挑一个便宜的模型：优先 deepseek flash 一类
  let route = { provider: options.provider, model: options.model }
  if (!route.provider || !route.model) {
    try {
      const picked = await pickCheapModel(llm)
      if (picked) route = picked
    } catch {
      /* 挑不到就让 llm.stream 自己报错 */
    }
  }

  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: `把下面这段压成一句口播（50-90 字）：\n\n${text.slice(0, 6000)}` }]
    }
  ]

  let out = ''
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system: ANNOUNCE_SYSTEM,
      maxTokens: 300,
      signal: AbortSignal.timeout(timeoutMs)
    })
    for await (const chunk of stream) {
      out += extractChunkText(chunk)
    }
  } catch (e) {
    return { ok: false, reason: `llm-error: ${e?.message ?? e}` }
  }

  out = cleanAnnounce(out, maxChars)
  if (!out) return { ok: false, reason: 'empty' }
  return { ok: true, text: out }
}

/** 从模型清单里挑一个便宜的（flash/mini/turbo 优先） */
async function pickCheapModel(llm) {
  if (typeof llm.listProviders !== 'function') return null
  const providers = await llm.listProviders()
  if (!Array.isArray(providers) || !providers.length) return null

  // 优先 deepseek 系
  const preferred =
    providers.find((p) => /deepseek/i.test(String(p?.id ?? p ?? ''))) ?? providers[0]
  const providerId = String(preferred?.id ?? preferred ?? '')
  if (!providerId || typeof llm.listModels !== 'function') return null

  const models = await llm.listModels(providerId)
  if (!Array.isArray(models) || !models.length) return null

  const CHEAP = /flash|mini|turbo|lite|fast|small/i
  const hit =
    models.find((m) => CHEAP.test(String(m?.id ?? m ?? ''))) ?? models[0]
  const modelId = String(hit?.id ?? hit ?? '')
  if (!modelId) return null
  return { provider: providerId, model: modelId }
}

/** 从 chunk 里抽文本（复用 voice.js 的思路，这里独立一份避免循环依赖） */
function extractChunkText(chunk) {
  if (!chunk) return ''
  try {
    if (typeof chunk === 'string') return chunk
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

/** 清洗模型输出：去引号、去 markdown、限长 */
export function cleanAnnounce(text, maxChars = 140) {
  let s = String(text ?? '').trim()
  // 去掉可能的包装
  s = s.replace(/^["'「『]|["'」』]$/g, '').trim()
  s = s.replace(/^口播[：:]\s*/i, '').trim()
  // 去 markdown
  s = s.replace(/```[\s\S]*?```/g, '')
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')
  s = s.replace(/[*_#>]/g, '')
  /*
   * 只保留第一段（模型有时会多写）。
   * ⚠️ 必须在「空白收敛」**之前**做——否则 \s+ 会先把换行压成空格，
   * 后面再按 \n 找分段就永远找不到（实测「嗯。\n\n第二段不该有」这句没被截断）。
   */
  const paras = s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (paras.length > 1 && paras[0].length >= 8) s = paras[0]
  // 空白收敛
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, maxChars)
}
