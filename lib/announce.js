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
  let probe = 'unknown'
  try {
    llm = ctx?.get?.('llm')
    probe = llm === undefined ? 'undefined' : llm === null ? 'null' : typeof llm
  } catch (e) {
    llm = undefined
    probe = 'throw:' + (e?.message ?? e)
  }
  if (!llm || typeof llm.stream !== 'function') {
    return {
      ok: false,
      reason: 'llm-unavailable',
      // 把探测结果带出去，方便定位是「service 没注入」还是「注入了一个没 stream 的对象」
      probe,
      hasStream: Boolean(llm && typeof llm.stream === 'function'),
      keys: llm && typeof llm === 'object' ? Object.keys(llm).slice(0, 20) : []
    }
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
      content: [{ type: 'text', text: `把下面这段压成一句口播（50-90 字）：\n\n${text.slice(0, 6000)}` }],
      /*
       * DSH 的消息需要 source 标识生产者（对照 better-sidebar 的
       * createUserMessage({ source: { kind: 'plugin:dsh-better-sidebar' } })）。
       * 缺 source 可能被消息系统拒收或投影成空。
       */
      source: { kind: 'plugin:dsh-elysia-memory' }
    }
  ]

  let out = ''
  let routeInfo = { provider: route.provider, model: route.model }
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system: ANNOUNCE_SYSTEM,
      maxTokens: 300,
      signal: AbortSignal.timeout(timeoutMs)
    })
    let chunkCount = 0
    let firstChunkShape = ''
    for await (const chunk of stream) {
      chunkCount++
      if (!firstChunkShape) {
        // 记录第一个 chunk 的形状，失败时能看清到底是什么格式
        firstChunkShape =
          typeof chunk === 'string'
            ? 'string'
            : chunk && typeof chunk === 'object'
              ? `type=${chunk.type ?? '-'} keys=${Object.keys(chunk).slice(0, 6).join(',')}`
              : String(chunk)
      }
      out += extractChunkText(chunk)
    }
    routeInfo = { ...routeInfo, chunkCount, firstChunkShape, outLen: out.length }
  } catch (e) {
    return { ok: false, reason: `llm-error: ${e?.message ?? e}`, routeInfo }
  }

  out = cleanAnnounce(out, maxChars)
  if (!out) return { ok: false, reason: 'empty', routeInfo }
  return { ok: true, text: out, routeInfo }
}

/** 从模型清单里挑一个便宜的（flash/mini/turbo 优先） */
async function pickCheapModel(llm) {
  if (typeof llm.listProviders !== 'function') return null
  const providers = await llm.listProviders()
  if (!Array.isArray(providers) || !providers.length) return null

  /*
   * DSH 的 provider / model 对象字段不固定（对照 better-sidebar 的 providerEntryOf /
   * modelEntryOf：provider 的 id 可能是 provider/route/id，model 的 id 可能是 id/model/name）。
   * 用容错读取，读不到就跳过，绝不猜。
   */
  const firstStr = (...vals) => {
    for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim()
    return ''
  }

  // 优先 deepseek 系
  const preferred =
    providers.find((p) => /deepseek/i.test(firstStr(p?.provider, p?.route, p?.id, p?.name, String(p ?? '')))) ??
    providers[0]
  const providerId = firstStr(preferred?.provider, preferred?.route, preferred?.id)
  if (!providerId || typeof llm.listModels !== 'function') return null

  const models = await llm.listModels(providerId)
  if (!Array.isArray(models) || !models.length) return null

  const CHEAP = /flash|mini|turbo|lite|fast|small/i
  const hit =
    models.find((m) => CHEAP.test(firstStr(m?.id, m?.model, m?.name))) ?? models[0]
  const modelId = firstStr(hit?.id, hit?.model, hit?.name)
  if (!modelId) return null
  return { provider: providerId, model: modelId }
}

/** 从 chunk 里抽文本（DSH 的 StreamChunk 协议，不是 OpenAI 的 delta 格式） */
function extractChunkText(chunk) {
  if (!chunk) return ''
  try {
    if (typeof chunk === 'string') return chunk

    /*
     * DSH 的 llm.stream 直接 yield StreamChunk：
     *   { type: 'text-delta', index, text }
     *   { type: 'reasoning-delta', index, text }
     *   { type: 'block-start' | 'block-end' | 'usage' | 'finish' }
     *
     * ⚠️ 之前的代码按 OpenAI 的 chunk.choices[0].delta.content 解析，
     * 永远拿不到东西 → 拼出来是空 → reason="empty"。
     *
     * 我们只要 text-delta（口播正文），reasoning-delta 也留着但通常口播模型
     * 不带思考，所以两者都收，最后 cleanAnnounce 会统一清洗。
     */
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      return typeof chunk.text === 'string' ? chunk.text : ''
    }

    // 兼容：有些适配器可能包装成 { time, chunk }
    if (chunk.chunk && typeof chunk.chunk === 'object') {
      return extractChunkText(chunk.chunk)
    }

    // 兜底：老格式（OpenAI delta / 直接 content / 直接 text）
    if (typeof chunk.text === 'string') return chunk.text
    const choice = chunk.choices?.[0]
    if (choice) {
      const d = choice.delta ?? choice.message
      if (typeof d?.content === 'string') return d.content
    }
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
