/**
 * DSH-elysia / client.js
 *
 * 客户端半边：左侧边栏「DSH-elysia」页签 + 主面板。三个视图：
 *   记忆 —— 各分区（含 docs）的查看 / 区内搜索 / 编辑 / 保存
 *   设置 —— 质疑度、注入档位、存储位置、流水 TTL、维护动作
 *   索引 —— 关键词索引 / 归档 / 方法库的统计
 *
 * 数据全部走宿主侧 webui.js 暴露的同源 HTTP 接口。
 * 这个文件是 **经典脚本**（不是 ESM），由 module loader 用
 * window.__ModuleLoader__.load({ id, factory }) 注册；不依赖任何 @deepseek-ai/* 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-elysia-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = 'dsh-elysia-memory'
    const API = '/dsh-shared-memory'
    const PANEL_LABEL = 'DSH-elysia'

    const SECTION_TITLES = {
      persona: '人设',
      requirements: '要求',
      corrections: '指正',
      lessons: '教训',
      methods: '方法',
      methodbook: '方法库',
      requests: '请求',
      sessions: '会话',
      docs: '文档'
    }
    const SECTION_ORDER = [
      'persona',
      'requirements',
      'corrections',
      'lessons',
      'methods',
      'methodbook',
      'requests',
      'sessions',
      'docs'
    ]
    const PROFILES = [
      { id: 'lean', label: '省 token', hint: '预算 ×0.55，每区 5 条' },
      { id: 'standard', label: '标准', hint: '预算 ×1，每区 8 条' },
      { id: 'rich', label: '详尽', hint: '预算 ×1.7，每区 14 条' }
    ]

    const C = {
      dim: 'rgba(127,127,127,0.85)',
      line: 'rgba(127,127,127,0.32)',
      soft: 'rgba(127,127,127,0.12)',
      acc: 'rgba(91,140,255,0.95)',
      ok: 'rgba(62,207,142,0.95)',
      warn: 'rgba(245,165,36,0.95)'
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: 'inherit',
        font: '13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '10px 14px',
        borderBottom: `1px solid ${C.line}`
      },
      title: { fontSize: 14, fontWeight: 600, margin: 0 },
      pill: (tone) => ({
        fontSize: 11,
        padding: '1px 8px',
        border: `1px solid ${tone === 'ok' ? 'rgba(62,207,142,0.45)' : tone === 'warn' ? 'rgba(245,165,36,0.45)' : C.line}`,
        borderRadius: 999,
        color: tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : C.dim,
        whiteSpace: 'nowrap'
      }),
      tabs: { display: 'flex', gap: 4, padding: '8px 14px 0', borderBottom: `1px solid ${C.line}` },
      tab: (on) => ({
        padding: '6px 14px',
        border: 0,
        borderBottom: `2px solid ${on ? C.acc : 'transparent'}`,
        background: 'transparent',
        color: on ? 'inherit' : C.dim,
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: on ? 600 : 400
      }),
      body: { display: 'flex', flex: 1, minHeight: 0 },
      nav: {
        width: 128,
        flex: '0 0 auto',
        borderRight: `1px solid ${C.line}`,
        padding: '8px 6px',
        overflowY: 'auto'
      },
      navItem: (on) => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        width: '100%',
        padding: '6px 8px',
        marginBottom: 2,
        border: `1px solid ${on ? C.acc : 'transparent'}`,
        borderRadius: 7,
        background: on ? C.soft : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left'
      }),
      count: { fontSize: 11, color: C.dim },
      main: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '10px 14px',
        gap: 8,
        minHeight: 0,
        overflowY: 'auto'
      },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: 1,
        minWidth: 120,
        padding: '5px 9px',
        border: `1px solid ${C.line}`,
        borderRadius: 7,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit'
      },
      num: {
        width: 62,
        padding: '4px 8px',
        border: `1px solid ${C.line}`,
        borderRadius: 7,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit'
      },
      mono: {
        flex: 1,
        minWidth: 180,
        padding: '5px 9px',
        border: `1px solid ${C.line}`,
        borderRadius: 7,
        background: 'transparent',
        color: 'inherit',
        font: '11.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace'
      },
      btn: (primary) => ({
        padding: '5px 12px',
        border: primary ? '1px solid transparent' : `1px solid ${C.line}`,
        borderRadius: 7,
        background: primary ? C.acc : 'transparent',
        color: primary ? '#fff' : 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap'
      }),
      editor: {
        flex: 1,
        minHeight: 180,
        width: '100%',
        resize: 'vertical',
        padding: '10px 12px',
        border: `1px solid ${C.line}`,
        borderRadius: 9,
        background: 'rgba(0,0,0,0.12)',
        color: 'inherit',
        font: '12.5px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace'
      },
      card: { border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px', marginBottom: 10 },
      cardTitle: { fontSize: 12.5, fontWeight: 600, marginBottom: 6 },
      hint: { fontSize: 11.5, color: C.dim, lineHeight: 1.65 },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 },
      msg: { fontSize: 11.5, color: C.dim },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 },
      stat: { border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 10px' },
      statLabel: { fontSize: 11, color: C.dim },
      statValue: { fontSize: 16, fontWeight: 600, lineHeight: 1.3 },
      path: { fontSize: 11, color: C.dim, wordBreak: 'break-all' },
      match: {
        listStyle: 'none',
        margin: '6px 0 0',
        padding: 0,
        maxHeight: 160,
        overflowY: 'auto',
        border: `1px solid ${C.line}`,
        borderRadius: 8
      },
      matchItem: { padding: '5px 9px', borderBottom: `1px solid ${C.line}`, fontSize: 12 }
    }

    function MemoryIcon(props) {
      const size = Number(props && props.size) || 18
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { display: 'block' }
        },
        h('path', { d: 'M4 6.5C4 5.1 5.6 4 7.5 4S11 5.1 11 6.5v11C11 16.1 9.4 15 7.5 15S4 16.1 4 17.5v-11Z' }),
        h('path', { d: 'M11 6.5C11 5.1 12.6 4 14.5 4S18 5.1 18 6.5v11c0 1.4-1.6 2.5-3.5 2.5S11 19.4 11 18' }),
        h('line', { x1: 20, y1: 8, x2: 20, y2: 16 })
      )
    }

    function MemoryPanel() {
      const [state, setState] = React.useState(null)
      const [tab, setTab] = React.useState('memory')
      const [section, setSection] = React.useState('persona')
      const [draft, setDraft] = React.useState('')
      const [dirty, setDirty] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [skep, setSkep] = React.useState({ level: 5, auto: true, decayAfter: 3 })
      const [paths, setPaths] = React.useState({ primary: '', mirror: '' })
      const [ttl, setTtl] = React.useState({ requests: 0, sessions: 0 })
      const [history, setHistory] = React.useState([])
      const [diff, setDiff] = React.useState(null)

      const applyState = React.useCallback((next, sec) => {
        setState(next)
        setDraft(next && next.sections ? (next.sections[sec] ?? '') : '')
        setDirty(false)
        const settings = next && next.settings
        if (settings && settings.skepticism) {
          setSkep({
            level: settings.skepticism.level ?? 5,
            auto: settings.skepticism.auto !== false,
            decayAfter: settings.skepticism.decayAfter ?? 3
          })
        }
        if (settings && settings.ttlBySection) {
          setTtl({
            requests: settings.ttlBySection.requests ?? 0,
            sessions: settings.ttlBySection.sessions ?? 0
          })
        }
        setPaths({ primary: (next && next.primaryPath) || '', mirror: (next && next.mirrorPath) || '' })
      }, [])

      const load = async () => {
        setMsg('读取中…')
        try {
          const res = await fetch(API + '/api/state')
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const json = await res.json()
          applyState(json, section)
          setMsg('')
        } catch (err) {
          setMsg('读取失败：' + ((err && err.message) || err))
        }
      }

      React.useEffect(() => {
        void load()
      }, [])

      const post = async (path, body) => {
        const res = await fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-memory': '1' },
          body: JSON.stringify(body || {})
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((json && json.error) || 'HTTP ' + res.status)
        return json
      }

      const run = async (label, fn) => {
        setBusy(true)
        setMsg(label + '…')
        try {
          const note = await fn()
          setMsg(note || '完成')
        } catch (err) {
          setMsg('失败：' + ((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }

      const saveSection = () =>
        run('保存中', async () => {
          const json = await post('/api/save', { section, text: draft })
          applyState(json.state, section)
          return '已保存到主文件与镜像（revision ' + ((json.state.meta && json.state.meta.revision) ?? '?') + '）'
        })

      const saveSkep = () =>
        run('保存质疑度', async () => {
          const json = await post('/api/skepticism', {
            level: Number(skep.level),
            auto: !!skep.auto,
            decayAfter: Number(skep.decayAfter)
          })
          applyState(json.state, section)
          const lv = (json.state.settings && json.state.settings.skepticism.level) ?? '?'
          return '质疑度已设为 ' + lv + ' / 10'
        })

      const saveProfile = (id) =>
        run('切换档位', async () => {
          const json = await post('/api/profile', { profile: id })
          applyState(json.state, section)
          return '注入档位：' + id
        })

      const savePaths = () =>
        run('迁移保存位置', async () => {
          const json = await post('/api/paths', {
            primaryPath: String(paths.primary || '').trim(),
            mirrorPath: String(paths.mirror || '').trim()
          })
          applyState(json.state, section)
          return '保存位置已迁移并双写'
        })

      const saveTtl = () =>
        run('保存 TTL', async () => {
          const json = await post('/api/ttl', {
            requests: Number(ttl.requests),
            sessions: Number(ttl.sessions)
          })
          applyState(json.state, section)
          return '流水过期时间已更新'
        })

      const rebalance = () =>
        run('按命中频率重分层', async () => {
          const json = await post('/api/rebalance', {})
          applyState(json.state, section)
          const moved = (json.results || []).reduce((n, r) => n + (r.dropped || 0), 0)
          return '重分层完成，转入归档 ' + moved + ' 条'
        })

      const reconcile = () =>
        run('对账回补', async () => {
          const json = await post('/api/reconcile', {})
          applyState(json.state, section)
          return '对账完成：' + (json.action || 'ok')
        })

      /* ---------- 表情包：侧边栏导入 / 删除 ---------- */
      const toBase64 = async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        }
        return btoa(binary)
      }

      const uploadStickers = (fileList) =>
        run('导入表情包', async () => {
          const files = Array.from(fileList || []).filter((f) => /\.(webp|png|gif|jpe?g)$/i.test(f.name || ''))
          if (!files.length) return '没有可导入的图片（webp/png/gif/jpg）'
          let ok = 0
          for (const file of files) {
            const json = await post('/api/sticker/upload', { name: file.name, data: await toBase64(file) })
            ok += 1
            if (json.state) applyState(json.state, section)
          }
          return '已导入 ' + ok + ' 张表情包'
        })

      const deleteSticker = (name) =>
        run('删除表情包', async () => {
          const json = await post('/api/sticker/delete', { name })
          if (json.state) applyState(json.state, section)
          return '已删除 ' + name
        })

      const loadHistory = () =>
        run('读取历史版本', async () => {
          const res = await fetch(API + '/api/history')
          const json = await res.json()
          setHistory(json.versions || [])
          setDiff(null)
          return '最近 ' + (json.versions || []).length + ' 个版本'
        })

      const showDiff = (name) =>
        run('对比版本', async () => {
          const res = await fetch(API + '/api/history?from=' + encodeURIComponent(name))
          const json = await res.json()
          setDiff(json.diff)
          const added = (json.diff && json.diff.added && json.diff.added.length) || 0
          const removed = (json.diff && json.diff.removed && json.diff.removed.length) || 0
          return '与当前对比：+' + added + ' / -' + removed
        })

      const counts = (state && state.counts) || {}
      const settings = (state && state.settings) || {}
      const matches = React.useMemo(() => {
        const text = String(query || '').trim().toLowerCase()
        if (!text || !draft) return []
        return draft
          .split('\n')
          .map((line, index) => ({ line, number: index + 1 }))
          .filter((item) => item.line.toLowerCase().includes(text))
          .slice(0, 40)
      }, [query, draft])

      const meta = (state && state.meta) || {}
      const inSync = Boolean(state && state.inSync)
      const profile = settings.profile || 'standard'
      const archive = settings.archive || {}
      const indexStats = settings.index || {}
      const skepState = settings.skepticism || {}

      const headBar = h(
        'div',
        { style: S.head },
        h('h2', { style: S.title }, PANEL_LABEL),
        h('span', { style: S.pill() }, 'revision ' + (meta.revision ?? '?')),
        h(
          'span',
          { style: S.pill(inSync ? 'ok' : 'warn') },
          state ? (state.mirrorPath ? (inSync ? '双备份一致' : '双备份不一致') : '未配置镜像') : '读取中'
        ),
        h('span', { style: S.pill() }, profile),
        h('span', { style: S.pill() }, '质疑度 ' + (skepState.level ?? '?') + '/10'),
        h('span', { style: { flex: 1 } }),
        h('button', { style: S.btn(false), onClick: () => void load(), disabled: busy }, '刷新'),
        h(
          'a',
          {
            href: API,
            target: '_blank',
            rel: 'noreferrer',
            style: { ...S.btn(false), textDecoration: 'none', color: 'inherit' }
          },
          '独立页面'
        )
      )

      const tabBar = h(
        'div',
        { style: S.tabs },
        ...[
          ['memory', '记忆'],
          ['packs', '记忆包'],
          ['voice', '语音'],
          ['settings', '设置'],
          ['index', '索引']
        ].map(([id, label]) =>
          h('button', { key: id, style: S.tab(tab === id), onClick: () => setTab(id) }, label)
        )
      )

      const memoryView = h(
        'div',
        { style: S.body },
        h(
          'div',
          { style: S.nav },
          ...SECTION_ORDER.map((key) =>
            h(
              'button',
              {
                key,
                style: S.navItem(section === key),
                onClick: () => {
                  setSection(key)
                  setQuery('')
                  setDraft(state && state.sections ? (state.sections[key] ?? '') : '')
                  setDirty(false)
                }
              },
              h('span', null, SECTION_TITLES[key] || key),
              h('span', { style: S.count }, String(counts[key] ?? ''))
            )
          )
        ),
        h(
          'div',
          { style: S.main },
          h(
            'div',
            { style: S.toolbar },
            h('input', {
              style: S.input,
              placeholder: '在「' + (SECTION_TITLES[section] || section) + '」里搜关键词（留空=编辑）',
              value: query,
              onChange: (e) => setQuery(e.target.value)
            }),
            h('span', { style: S.msg }, dirty ? '未保存' : draft ? draft.length + ' 字符' : ''),
            h('button', { style: S.btn(true), onClick: saveSection, disabled: busy || !dirty }, '保存到双备份')
          ),
          matches.length
            ? h(
                'div',
                null,
                h('div', { style: S.hint }, '命中 ' + matches.length + ' 行（行号 → 内容）'),
                h(
                  'ul',
                  { style: S.match },
                  ...matches.map((item) =>
                    h('li', { key: item.number, style: S.matchItem }, 'L' + item.number + '  ' + item.line)
                  )
                )
              )
            : h('textarea', {
                style: S.editor,
                value: draft,
                spellCheck: false,
                onChange: (e) => {
                  setDraft(e.target.value)
                  setDirty(true)
                }
              }),
          h('div', { style: S.hint }, '只改分区正文即可，分隔标记由插件维护；保存后下一轮提示词就用新内容。')
        )
      )

      /* ---------------- 记忆包面板 ---------------- */
      //
      // 默认不安装：进来是「未安装」，用户点「安装」才写 identity + persona。
      // 装之前插件会自动备份到 .packs-backup/，卸载能还回原来那份。
      const [packs, setPacks] = React.useState(null)
      const [packBusy, setPackBusy] = React.useState('')
      const [packMsg, setPackMsg] = React.useState('')
      const [packPreview, setPackPreview] = React.useState({})

      const loadPacks = React.useCallback(async () => {
        setPackMsg('读取中…')
        try {
          const res = await fetch(API + '/api/packs')
          const j = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
          setPacks(j)
          setPackMsg('')
        } catch (e) {
          setPacks({ packs: [] })
          setPackMsg('读取失败：' + e.message)
        }
      }, [])

      React.useEffect(() => {
        if (tab === 'packs' && !packs) loadPacks()
      }, [tab, packs, loadPacks])

      const doPack = React.useCallback(
        async (id, action) => {
          setPackBusy(id + ':' + action)
          setPackMsg('')
          try {
            if (action === 'preview') {
              const res = await fetch(API + '/api/packs/' + encodeURIComponent(id) + '/preview')
              const j = await res.json().catch(() => ({}))
              if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
              setPackPreview((prev) => ({ ...prev, [id]: j }))
              setPackMsg('')
            } else {
              // 安装 / 卸载都是「先问再发」：确认框在前端弹，请求直接带 confirm:true。
              // 后端不返回 needsConfirm，它只认 confirm 字段。
              if (action === 'install') {
                const ok = window.confirm(
                  '安装「' + id + '」？\n\n' +
                    '会覆盖 identity 和 persona 两个分区（装前自动备份到 .packs-backup/，可卸载恢复）。\n' +
                    '其它分区不会被碰。'
                )
                if (!ok) {
                  setPackMsg('已取消')
                  setPackBusy('')
                  return
                }
              } else {
                const ok = window.confirm(
                  '卸载「' + id + '」？\n\n' +
                    'identity / persona 会从安装前的备份恢复；没有备份则复位为默认占位。'
                )
                if (!ok) {
                  setPackMsg('已取消')
                  setPackBusy('')
                  return
                }
              }
              const res = await fetch(
                API + '/api/packs/' + encodeURIComponent(id) + '/' + action,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-dsh-memory': '1' },
                  body: JSON.stringify({ confirm: true })
                }
              )
              const j = await res.json().catch(() => ({}))
              if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
              setPackMsg(j.message || '完成')
              await loadPacks()
              setPackPreview({})
            }
          } catch (e) {
            setPackMsg('失败：' + e.message)
          }
          setPackBusy('')
        },
        [loadPacks]
      )

      const packsView = h(
        'div',
        { style: { ...S.main, display: 'block', overflowY: 'auto' } },
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '📦 记忆包'),
          h(
            'div',
            { style: S.msg },
            '插件自带的整份角色记忆与人设。默认不启用：点「安装」才会写入 identity + persona（装前自动备份，可卸载恢复）。其它分区不会被碰。'
          ),
          h(
            'div',
            { style: S.row },
            h('button', { style: S.btn(false), onClick: loadPacks }, '重新读取')
          )
        ),
        !packs
          ? h('div', { style: S.msg }, '读取中…')
          : (packs.packs || []).length === 0
            ? h('div', { style: S.msg }, '没有可用的记忆包（插件 packs/ 目录为空）。')
            : (packs.packs || []).map((pk) => {
                const pv = packPreview[pk.id]
                const busy = packBusy.startsWith(pk.id + ':')
                return h(
                  'div',
                  { key: pk.id, style: S.card },
                  h(
                    'div',
                    { style: { ...S.cardTitle, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    pk.name + '  v' + pk.version,
                    h('span', { style: S.pill(pk.installed ? 'ok' : undefined) }, pk.installed ? '已安装' : '未安装')
                  ),
                  pk.description ? h('div', { style: S.msg }, pk.description) : null,
                  h(
                    'div',
                    { style: S.msg },
                    'identity ' +
                      (pk.sections && pk.sections.identity
                        ? pk.sections.identity.packChars ?? pk.sections.identity.currentChars ?? 0
                        : 0) +
                      ' 字 · persona ' +
                      (pk.sections && pk.sections.persona
                        ? pk.sections.persona.packChars ?? pk.sections.persona.currentChars ?? 0
                        : 0) +
                      ' 字'
                  ),
                  h(
                    'div',
                    { style: S.row },
                    h(
                      'button',
                      { style: S.btn(false), disabled: busy, onClick: () => doPack(pk.id, 'preview') },
                      pv ? '收起预览' : '预览'
                    ),
                    h(
                      'button',
                      {
                        style: S.btn(true),
                        disabled: busy,
                        onClick: () => doPack(pk.id, pk.installed ? 'uninstall' : 'install')
                      },
                      busy ? '处理中…' : pk.installed ? '卸载' : '安装'
                    ),
                    pk.installed
                      ? h('span', { style: S.msg }, '卸载会从备份恢复原来的 identity / persona')
                      : null
                  ),
                  pv
                    ? h(
                        'div',
                        { style: { marginTop: 8, maxHeight: 260, overflowY: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', color: C.dim } },
                        (pv.preview
                          ? Object.keys(pv.preview)
                              .map((k) => {
                                const info = pv.preview[k]
                                return (
                                  '=== ' + k + '（' + info.chars + ' 字' +
                                  (info.truncated ? '，只显示前 2000 字' : '') + '）===\n' +
                                  (info.head || '')
                                )
                              })
                              .join('\n\n')
                          : '')
                      )
                    : null
                )
              }),
        packMsg ? h('div', { style: { ...S.msg, marginTop: 8 } }, packMsg) : null
      )

      /* ---------------- 语音面板 ---------------- */
      const [voice, setVoice] = React.useState(null)
      const [voiceMsg, setVoiceMsg] = React.useState('')
      // 音量和语速：面板上直接调，存进 state.json（不是记忆文件）
      const [voiceVolume, setVoiceVolume] = React.useState(0)
      const [voiceSpeed, setVoiceSpeed] = React.useState(0.86)

      const loadVoice = React.useCallback(async () => {
        try {
          const res = await fetch(API + '/api/voice')
          const j = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
          setVoice(j)
          // 顺带把存下来的音量和语速读回面板
          if (Number.isFinite(j.volume)) setVoiceVolume(j.volume)
          if (Number.isFinite(j.speed) && j.speed > 0) setVoiceSpeed(j.speed)
        } catch (e) {
          setVoice({ enabled: false })
          setVoiceMsg('读取失败：' + e.message)
        }
      }, [])

      React.useEffect(() => {
        if (tab === 'voice' && !voice) loadVoice()
      }, [tab, voice, loadVoice])

      const toggleVoice = React.useCallback(async () => {
        setVoiceMsg('切换中…')
        try {
          const res = await fetch(API + '/api/voice', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-memory': '1' },
            body: JSON.stringify({ enabled: !(voice && voice.enabled) })
          })
          const j = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
          setVoice(j)
          setVoiceMsg(j.enabled ? '已开启' : '已关闭')
        } catch (e) {
          setVoiceMsg('失败：' + e.message)
        }
      }, [voice])

      /* ---- 环境检测（引导式安装）---- */
      const [doctor, setDoctor] = React.useState(null)
      const [doctorBusy, setDoctorBusy] = React.useState(false)

      const runDoctor = React.useCallback(async () => {
        setDoctorBusy(true)
        setVoiceMsg('正在检测…')
        try {
          const res = await fetch(API + '/api/voice/doctor')
          const j = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
          setDoctor(j)
          setVoiceMsg(
            j.ok ? '环境齐全，语音可以直接用。' : '有项目未就绪，按下面的提示处理。'
          )
        } catch (e) {
          setVoiceMsg('检测失败：' + e.message)
        }
        setDoctorBusy(false)
      }, [])

      /* ---- 试听 ---- */
      const doTest = React.useCallback(async () => {
        setVoiceMsg('试听中…')
        try {
          const res = await fetch(API + '/api/voice/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-memory': '1' },
            body: JSON.stringify({ volume: voiceVolume })
          })
          const j = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
          setVoiceMsg(j.message || '已播放')
        } catch (e) {
          setVoiceMsg('试听失败：' + e.message)
        }
      }, [voiceVolume])

      /* ---- 立刻停止播放 ---- */
      const doStop = React.useCallback(async () => {
        try {
          const res = await fetch(API + '/api/voice/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-memory': '1' },
            body: '{}'
          })
          const j = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
          setVoiceMsg(j.message || '已停止')
          // 刷新一下状态（playing 可能变了）
          loadVoice()
        } catch (e) {
          setVoiceMsg('停止失败：' + e.message)
        }
      }, [loadVoice])

      const voiceView = h(
        'div',
        { style: { ...S.main, display: 'block', overflowY: 'auto' } },
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { ...S.cardTitle, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            '🔊 语音朗读',
            h(
              'span',
              { style: S.pill(voice && voice.playing ? 'warn' : voice && voice.enabled ? 'ok' : undefined) },
              voice && voice.playing ? '🔊 正在播' : voice && voice.enabled ? '已开启' : '已关闭'
            )
          ),
          h(
            'div',
            { style: S.msg },
            '用本机的 GPT-SoVITS 引擎把回复合成成语音。依赖本机装好引擎且 9880 端口在跑——换一台机器就没有，所以默认关闭。开关只影响当前进程，不改记忆文件。'
          ),
          h(
            'div',
            { style: S.row },
            h('button', { style: S.btn(true), onClick: toggleVoice }, voice && voice.enabled ? '关闭语音' : '开启语音'),
            h('button', { style: S.btn(false), onClick: loadVoice }, '刷新状态'),
            h('button', { style: S.btn(false), disabled: doctorBusy, onClick: runDoctor }, doctorBusy ? '检测中…' : '环境检测'),
            h(
              'button',
              { style: S.btn(false), onClick: doStop },
              voice && voice.playing ? '⏹ 停止播放' : '停止播放'
            )
          )
        ),
        /* ---- 检测结果 ---- */
        doctor
          ? h(
              'div',
              { style: S.card },
              h(
                'div',
                { style: { ...S.cardTitle, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                '环境检测',
                h('span', { style: S.pill(doctor.ok ? 'ok' : 'warn') }, doctor.ok ? '齐全' : '有待处理')
              ),
              ...(doctor.items || []).map((it, i) =>
                h(
                  'div',
                  { key: i, style: { ...S.path, marginBottom: 4 } },
                  h('span', { style: { color: it.ok ? C.ok : C.warn } }, it.ok ? '✅ ' : '⚠️ '),
                  h('span', { style: { fontWeight: 600 } }, it.label + '：'),
                  h('span', null, it.detail),
                  it.hint ? h('div', { style: { color: C.dim, marginLeft: 18, marginTop: 2 } }, '↳ ' + it.hint) : null
                )
              )
            )
          : null,
        /* ---- 装不装得上：引导 ---- */
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '还没装引擎？按这个来'),
          h(
            'div',
            { style: S.msg },
            '语音需要本机装 GPT-SoVITS。完整版 27 GB，精简版 10-12 GB，还需要 NVIDIA 显卡。' +
              '插件不会替你下这 10 GB——但每一步都给准确路径。'
          ),
          ...(doctor && doctor.steps ? doctor.steps : []).map((st) =>
            h(
              'div',
              { key: st.n, style: { ...S.path, marginTop: 8, lineHeight: 1.7 } },
              h('span', { style: { fontWeight: 600 } }, `${st.n}. ${st.title}`),
              h('div', { style: { color: C.dim, marginLeft: 12 } }, st.desc),
              st.cmd
                ? h('div', { style: { marginLeft: 12, fontFamily: 'Consolas,monospace', color: C.acc, wordBreak: 'break-all' } }, st.cmd)
                : null,
              st.url
                ? h('div', { style: { marginLeft: 12, color: C.acc, wordBreak: 'break-all' } }, st.url)
                : null,
              st.note ? h('div', { style: { marginLeft: 12, color: C.dim } }, st.note) : null
            )
          )
        ),
        /* ---- 音量 ---- */
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '音量'),
          h(
            'div',
            { style: S.msg },
            '只改波形幅度，不动系统音量。+6 dB 约两倍响，−6 dB 约一半。峰值超了会自动软限幅，不会爆音。'
          ),
          h(
            'div',
            { style: { ...S.row, marginTop: 10 } },
            h('input', {
              type: 'range',
              min: -12,
              max: 12,
              step: 1,
              value: voiceVolume,
              style: { flex: '1 1 200px', minWidth: 140 },
              onChange: (e) => setVoiceVolume(Number(e.target.value))
            }),
            h('span', { style: { ...S.path, minWidth: 70, textAlign: 'right' } },
              (voiceVolume > 0 ? '+' : '') + voiceVolume + ' dB'),
            h(
              'button',
              {
                style: S.btn(false),
                onClick: async () => {
                  setVoiceMsg('试听中…')
                  try {
                    const res = await fetch(API + '/api/voice/test', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json', 'x-dsh-memory': '1' },
                      body: JSON.stringify({ volume: voiceVolume })
                    })
                    const j = await res.json().catch(() => ({}))
                    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status)
                    setVoiceMsg(j.message || '已播放')
                  } catch (e) {
                    setVoiceMsg('试听失败：' + e.message)
                  }
                }
              },
              '试听'
            )
          )
        ),
        /* ---- 语速 ---- */
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '语速'),
          h(
            'div',
            { style: S.row },
            h('input', {
              type: 'range',
              min: 0.6,
              max: 1.4,
              step: 0.01,
              value: voiceSpeed,
              style: { flex: '1 1 200px', minWidth: 140 },
              onChange: (e) => setVoiceSpeed(Number(e.target.value))
            }),
            h('span', { style: { ...S.path, minWidth: 70, textAlign: 'right' } }, voiceSpeed.toFixed(2) + '×')
          )
        ),
        voice
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.cardTitle }, '当前状态'),
              h('div', { style: S.path }, '引擎：' + (voice.engineUrl || '')),
              h('div', { style: S.path }, '模型：' + (voice.model || '') + '　参考：' + (voice.ref || '')),
              h('div', { style: S.path }, '失败连击：' + (voice.failStreak || 0)),
              voice.cooldownUntil
                ? h('div', { style: { ...S.path, color: C.warn } }, '熔断至：' + voice.cooldownUntil)
                : null,
              voice.lastAt ? h('div', { style: S.path }, '上次朗读：' + voice.lastAt) : null
            )
          : null,
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '怎么用'),
          h(
            'div',
            { style: S.path },
            '对话里：memory_file_voice({action:"enable"}) 开 · check 探活 · say 直接合成 · clean 只看清洗效果'
          ),
          h(
            'div',
            { style: S.msg },
            '这一页只管开关。真正合成走 elysia_say.py（带后处理链），网页不重复实现。'
          )
        ),
        voiceMsg ? h('div', { style: { ...S.msg, marginTop: 8 } }, voiceMsg) : null
      )

      const settingsView = h(
        'div',
        { style: { ...S.main, display: 'block' } },
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '质疑度'),
          h(
            'div',
            { style: S.row },
            h('input', {
              type: 'range',
              min: 0,
              max: 10,
              step: 1,
              value: skep.level,
              style: { flex: 1, minWidth: 160 },
              onChange: (e) => setSkep({ ...skep, level: e.target.value })
            }),
            h('strong', null, String(skep.level)),
            h('span', { style: S.hint }, '/ 10')
          ),
          h(
            'div',
            { style: S.row },
            h(
              'label',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', {
                type: 'checkbox',
                checked: skep.auto !== false,
                onChange: (e) => setSkep({ ...skep, auto: e.target.checked })
              }),
              '连续未更优自动降档'
            ),
            h('span', { style: S.hint }, '阈值'),
            h('input', {
              type: 'number',
              min: 1,
              max: 10,
              style: S.num,
              value: skep.decayAfter,
              onChange: (e) => setSkep({ ...skep, decayAfter: e.target.value })
            }),
            h('span', { style: S.hint }, '次'),
            h('button', { style: S.btn(true), onClick: saveSkep, disabled: busy }, '保存质疑度')
          ),
          h(
            'div',
            { style: S.hint },
            '当前 ' +
              (skepState.level ?? '?') +
              '/10，连续未更优 ' +
              (skepState.noGainStreak ?? 0) +
              '/' +
              (skepState.decayAfter ?? 3) +
              ' 次。质疑度越高，检索时越容易去翻归档。'
          )
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '注入档位'),
          h(
            'div',
            { style: S.row },
            ...PROFILES.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  style: S.btn(item.id === profile),
                  onClick: () => saveProfile(item.id),
                  disabled: busy
                },
                item.label
              )
            ),
            h('span', { style: S.hint }, (PROFILES.find((p) => p.id === profile) || {}).hint || '')
          )
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '存储位置（双硬盘分区镜像）'),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.hint }, '主文件'),
            h('input', {
              style: S.mono,
              value: paths.primary,
              spellCheck: false,
              onChange: (e) => setPaths({ ...paths, primary: e.target.value })
            })
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.hint }, '镜像'),
            h('input', {
              style: S.mono,
              value: paths.mirror,
              spellCheck: false,
              placeholder: '留空=不启用镜像',
              onChange: (e) => setPaths({ ...paths, mirror: e.target.value })
            }),
            h('button', { style: S.btn(false), onClick: savePaths, disabled: busy }, '迁移')
          ),
          h('div', { style: S.hint }, '迁移会把记忆文件搬到新位置并双写；旧位置文件会被删除。')
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '流水过期（TTL）'),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.hint }, 'requests'),
            h('input', {
              type: 'number',
              min: 0,
              style: S.num,
              value: ttl.requests,
              onChange: (e) => setTtl({ ...ttl, requests: e.target.value })
            }),
            h('span', { style: S.hint }, '天'),
            h('span', { style: S.hint }, 'sessions'),
            h('input', {
              type: 'number',
              min: 0,
              style: S.num,
              value: ttl.sessions,
              onChange: (e) => setTtl({ ...ttl, sessions: e.target.value })
            }),
            h('span', { style: S.hint }, '天'),
            h('button', { style: S.btn(false), onClick: saveTtl, disabled: busy }, '保存')
          ),
          h('div', { style: S.hint }, '过期后不再注入提示词，但仍可检索到（标「已过期」）；0 = 不过期。')
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '备份与版本'),
          h(
            'div',
            { style: S.row },
            h(
              'a',
              {
                href: API + '/api/export',
                target: '_blank',
                rel: 'noreferrer',
                style: { ...S.btn(false), textDecoration: 'none', color: 'inherit' }
              },
              '导出 JSON'
            ),
            h('button', { style: S.btn(false), onClick: loadHistory, disabled: busy }, '查看历史版本')
          ),
          history.length
            ? h(
                'ul',
                { style: S.match },
                ...history.slice(0, 8).map((item) =>
                  h(
                    'li',
                    { key: item.name, style: S.matchItem },
                    h(
                      'button',
                      {
                        style: { ...S.btn(false), padding: '2px 8px', fontSize: 11 },
                        onClick: () => showDiff(item.name),
                        disabled: busy
                      },
                      item.name.slice(0, 28) + ' · ' + (item.bytes / 1024).toFixed(1) + ' KB'
                    )
                  )
                )
              )
            : null,
          diff
            ? h(
                'div',
                { style: { ...S.hint, maxHeight: 170, overflowY: 'auto', marginTop: 6 } },
                '对比 ' + diff.from + ' → ' + diff.to + '：+' + diff.added.length + ' / -' + diff.removed.length,
                ...diff.added.slice(0, 5).map((line, i) => h('div', { key: 'a' + i, style: { color: C.ok } }, '+ ' + line)),
                ...diff.removed.slice(0, 5).map((line, i) => h('div', { key: 'r' + i, style: { color: C.warn } }, '- ' + line))
              )
            : null
        ),
        (() => {
          const st = (state && state.stickers) || { count: 0, dir: '', items: [] }
          return h(
            'div',
            { style: S.card },
            h('div', { style: S.cardTitle }, '表情包（' + (st.count || 0) + ' 张）'),
            h('div', { style: S.hint }, st.dir || '（目录未就绪）'),
            h(
              'div',
              { style: S.row },
              h(
                'label',
                { style: { ...S.btn(true), cursor: 'pointer', display: 'inline-block' } },
                '导入图片',
                h('input', {
                  type: 'file',
                  accept: 'image/*',
                  multiple: true,
                  style: { display: 'none' },
                  onChange: (e) => {
                    void uploadStickers(e.target.files)
                    e.target.value = ''
                  }
                })
              ),
              h('button', { style: S.btn(false), onClick: () => void load(), disabled: busy }, '刷新')
            ),
            h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
                  gap: 6,
                  marginTop: 8
                }
              },
              ...(st.items || []).slice(0, 60).map((item) =>
                h(
                  'div',
                  { key: item.file, style: { position: 'relative', borderRadius: 6, overflow: 'hidden', background: 'rgba(0,0,0,.06)' } },
                  h('img', {
                    src: item.url,
                    alt: item.file,
                    title: item.file + ' [' + (item.moods || []).join('/') + ']',
                    style: { width: '100%', height: 72, objectFit: 'cover', display: 'block' }
                  }),
                  h(
                    'button',
                    {
                      style: {
                        position: 'absolute',
                        top: 2,
                        right: 2,
                        border: 'none',
                        borderRadius: 4,
                        background: 'rgba(0,0,0,.55)',
                        color: '#fff',
                        fontSize: 10,
                        padding: '1px 4px',
                        cursor: 'pointer'
                      },
                      onClick: () => void deleteSticker(item.file)
                    },
                    '×'
                  )
                )
              )
            )
          )
        })(),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '维护'),
          h(
            'div',
            { style: S.row },
            h('button', { style: S.btn(false), onClick: reconcile, disabled: busy }, '对账回补'),
            h('button', { style: S.btn(false), onClick: rebalance, disabled: busy }, '按命中频率重分层'),
            h('button', { style: S.btn(false), onClick: () => void load(), disabled: busy }, '重新读取')
          )
        ),
        h('div', { style: S.msg }, msg)
      )

      const indexView = h(
        'div',
        { style: { ...S.main, display: 'block' } },
        h(
          'div',
          { style: S.grid },
          h(
            'div',
            { style: S.stat },
            h('div', { style: S.statLabel }, '关键词索引'),
            h('div', { style: S.statValue }, String(indexStats.count ?? 0)),
            h('div', { style: S.statLabel }, '条记录')
          ),
          h(
            'div',
            { style: S.stat },
            h('div', { style: S.statLabel }, '命中合计'),
            h('div', { style: S.statValue }, String(indexStats.hits ?? 0)),
            h('div', { style: S.statLabel }, '从未命中 ' + (indexStats.idle ?? 0))
          ),
          h(
            'div',
            { style: S.stat },
            h('div', { style: S.statLabel }, '联想词'),
            h('div', { style: S.statValue }, String(indexStats.coocTerms ?? 0)),
            h('div', { style: S.statLabel }, '来自共现统计')
          ),
          h(
            'div',
            { style: S.stat },
            h('div', { style: S.statLabel }, '归档'),
            h('div', { style: S.statValue }, String(archive.count ?? 0)),
            h('div', { style: S.statLabel }, ((archive.bytes ?? 0) / 1024).toFixed(1) + ' KB')
          ),
          h(
            'div',
            { style: S.stat },
            h('div', { style: S.statLabel }, '最佳方法库'),
            h('div', { style: S.statValue }, String(settings.methodbooks ?? 0)),
            h('div', { style: S.statLabel }, '个任务')
          ),
          h(
            'div',
            { style: S.stat },
            h('div', { style: S.statLabel }, '分区上限'),
            h('div', { style: S.statValue }, String(settings.entryCap ?? 200)),
            h('div', { style: S.statLabel }, '保护期 ' + (settings.graceDays ?? 3) + ' 天')
          )
        ),
        h(
          'div',
          { style: { ...S.card, marginTop: 10 } },
          h('div', { style: S.cardTitle }, '归档分区'),
          h(
            'div',
            { style: S.hint },
            (archive.sections && archive.sections.length ? archive.sections.join('、') : '（还没有条目进归档）') +
              '  · 归档不注入提示词，主文件命中不足时按质疑度兜底检索'
          )
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '安装自检'),
          settings.selfTest
            ? h(
                'div',
                { style: S.hint },
                (settings.selfTest.ok ? '✅ 通过' : '⚠️ 未通过') +
                  ' · ' +
                  (settings.selfTest.mode || '?') +
                  ' · ' +
                  (settings.selfTest.entries ?? 0) +
                  '/' +
                  (settings.selfTest.expected ?? 0) +
                  ' 条 · ' +
                  (settings.selfTest.ms ?? 0) +
                  'ms · v' +
                  (settings.selfTest.version || settings.version || '?') +
                  (settings.selfTest.detail ? ' · ' + settings.selfTest.detail : '')
              )
            : h('div', { style: S.hint }, '本版本尚未跑过自检（首次启用时自动执行，只写临时目录）')
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '文件位置'),
          h('div', { style: S.path }, '主文件：' + (state ? state.primaryPath : '')),
          h('div', { style: S.path }, '镜像：' + (state && state.mirrorPath ? state.mirrorPath : '（未配置）'))
        ),
        h('div', { style: S.msg }, msg)
      )

      return h(
        'div',
        { style: S.root },
        headBar,
        tabBar,
        tab === 'memory'
          ? memoryView
          : tab === 'packs'
            ? packsView
            : tab === 'voice'
              ? voiceView
              : tab === 'settings'
                ? settingsView
                : indexView
      )
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PLUGIN_ID }, MemoryPanel))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PLUGIN_ID, order: 25, label: () => PANEL_LABEL },
          MemoryIcon
        )
      )
    }

    const plugin = { name: PLUGIN_ID, inject: ['slots'], apply }
    // 只返回插件对象：loader 消费 factory 的返回值。
    // 不要写 module.exports —— 浏览器里没有 CommonJS 的 module。
    return plugin
  }
})
