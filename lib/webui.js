/**
 * dsh-shared-memory / webui.js
 *
 * 一个自包含的记忆查看/编辑页，挂在宿主自带的 HTTP 端口上：
 *   GET  /dsh-shared-memory              页面
 *   GET  /dsh-shared-memory/api/state    当前记忆（分区 + 元信息 + 备份状态）
 *   POST /dsh-shared-memory/api/save     保存某个分区
 *   POST /dsh-shared-memory/api/reconcile 立刻对账回补
 *
 * 为什么不用 client bundle：客户端插件要单独构建、依赖 dsh-client-* 包，
 * 对“看一眼、改一段”的需求太重；直接吐 HTML 零依赖、零构建。
 */

import { SECTIONS, SECTION_TITLES, ENTRY_SECTIONS, parseEntries, stamp } from './store.js'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { IMAGE_EXT, scanStickers, stickersDir, ensureStickersDir, matchSticker, recordUsage, setTags, classifyByFilename } from './stickers.js'
import {
  clampDecayAfter,
  clampLevel,
  defaultMethodbook,
  parseMethodbook,
  renderMethodbook,
  summarizeSkepticism
} from './methodbook.js'

/** 网页用的质疑度 + 方法库摘要（解析失败时回退默认值，不让页面 500） */
function methodbookSummary(view) {
  const state = parseMethodbook(view?.sections?.methodbook ?? '') ?? defaultMethodbook()
  return summarizeSkepticism(state)
}

const PREFIX = '/dsh-shared-memory'

function send(res, code, type, body, extraHeaders = {}) {
  res.statusCode = code
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  res.end(body)
}

function sendJson(res, code, value) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(value))
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 只接受同源请求，避免任意网页跨站改记忆 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // 同源 fetch 在某些浏览器上不带 Origin
  try {
    const o = new URL(String(origin))
    const host = String(req.headers.host ?? '')
    return o.host === host
  } catch {
    return false
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>共享记忆 · dsh-shared-memory</title>
<style>
:root{--bg:#0f1115;--fg:#e6e8ee;--dim:#8b93a7;--line:#242a36;--acc:#5b8cff;--ok:#3ecf8e;--warn:#f5a524}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600}
.pill{font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--dim)}
.pill.ok{color:var(--ok);border-color:#1f4d38}
.pill.bad{color:var(--warn);border-color:#4d3d1f}
main{padding:16px 20px;max-width:1100px}
.skep{font-size:12px;color:var(--dim);background:#161a20;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.6}
.skep b{color:var(--fg);font-size:13px}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dim);margin:0 0 12px}
.controls label{display:flex;gap:6px;align-items:center}
.controls .grow{flex:1;min-width:260px}
.controls input[type=number]{width:58px;background:#161a20;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:3px 6px}
.controls input[type=text]{width:100%;background:#161a20;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:4px 8px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tabs button{background:transparent;border:1px solid var(--line);color:var(--dim);padding:5px 11px;border-radius:8px;cursor:pointer;font-size:13px}
.tabs button.on{color:var(--fg);border-color:var(--acc);background:#17203a}
textarea{width:100%;min-height:46vh;background:#0b0d12;color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:12px;font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
.row{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
button.primary{background:var(--acc);border:0;color:#fff;padding:7px 16px;border-radius:8px;cursor:pointer;font-size:13px}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px}
#msg{font-size:12px;color:var(--dim)}
.tip{color:var(--dim);font-size:12px;margin:6px 0 12px}
code{background:#171b24;padding:1px 5px;border-radius:5px;font-size:12px}
</style></head><body>
<header>
  <h1>共享记忆</h1>
  <span class="pill" id="rev">…</span>
  <span class="pill" id="sync">…</span>
  <span class="pill" id="paths"></span>
  <span style="flex:1"></span>
  <button class="ghost" id="reconcile">对账回补</button>
  <button class="ghost" id="reload">重新读取</button>
</header>
<main>
  <div class="skep" id="skep"></div>
  <div class="controls">
    <label>质疑度 <input id="lv" type="number" min="0" max="10" step="1"></label>
    <label><input id="au" type="checkbox"> 自动降档</label>
    <label>阈值 <input id="da" type="number" min="1" max="10" step="1"></label>
    <button class="ghost" id="sk">保存质疑度</button>
  </div>
  <div class="controls">
    <label class="grow">主文件 <input id="pp" type="text" spellcheck="false"></label>
    <label class="grow">镜像文件 <input id="mp" type="text" spellcheck="false" placeholder="留空=不启用镜像"></label>
    <button class="ghost" id="sp">迁移保存位置</button>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="tip" id="tip"></div>
  <textarea id="editor" spellcheck="false"></textarea>
  <div class="row">
    <button class="primary" id="save">保存到双备份</button>
    <span id="msg"></span>
  </div>
</main>
<script>
const SECTIONS = __SECTIONS__;
let state = null, current = 'persona';
const $ = (id) => document.getElementById(id);
function renderTabs(){
  $('tabs').innerHTML = SECTIONS.map(([k,t]) =>
    '<button data-k="'+k+'" class="'+(k===current?'on':'')+'">'+t+'</button>').join('');
  [...document.querySelectorAll('#tabs button')].forEach(b => b.onclick = () => { current = b.dataset.k; renderTabs(); paint(); });
}
function syncControls(){
  if(!state) return;
  const mb = state.methodbook || {};
  $('lv').value = mb.level ?? 5;
  $('au').checked = mb.auto !== false;
  $('da').value = mb.decayAfter ?? 3;
  $('pp').value = state.primaryPath || '';
  $('mp').value = state.mirrorPath || '';
}
function paint(){
  if(!state) return;
  const body = state.sections[current] ?? '';
  $('editor').value = body;
  const mb = state.methodbook;
  if(mb){
    const cats = (mb.categories || []).slice(0, 6).map((c) => c.category + '×' + c.count).join(' · ');
    $('skep').innerHTML = '质疑度 <b>' + mb.level + ' / ' + mb.max + '</b>' +
      (mb.auto ? '（自动降档，连续 ' + mb.noGainStreak + '/' + mb.decayAfter + ' 次未更优）' : '（手动设定）') +
      ' · 方法库 ' + mb.taskCount + ' 个任务' + (cats ? ' — ' + cats : '');
  }
  syncControls();
  const n = state.counts?.[current];
  $('tip').innerHTML = '分区 <code>'+current+'</code>' + (n===undefined?'':' · '+n+' 条') +
    ' · 直接改正文后保存，插件下次拼提示词就会用新内容。';
  $('rev').textContent = 'revision ' + (state.meta?.revision ?? '?');
  $('sync').textContent = '双备份 ' + (state.mirrorPath ? (state.inSync ? '一致' : '不一致') : '未配置');
  $('sync').className = 'pill ' + (state.inSync ? 'ok' : 'bad');
  $('paths').textContent = state.primaryPath + (state.mirrorPath ? '  ⇄  ' + state.mirrorPath : '');
}
async function load(){
  $('msg').textContent = '读取中…';
  const r = await fetch('__PREFIX__/api/state');
  if(!r.ok){ $('msg').textContent = '读取失败: ' + r.status; return; }
  state = await r.json();
  renderTabs(); paint();
  $('msg').textContent = '已读取';
}
$('sk').onclick = async () => {
  $('msg').textContent = '保存质疑度…';
  const r = await fetch('__PREFIX__/api/skepticism', {
    method:'POST', headers:{'content-type':'application/json','x-dsh-memory':'1'},
    body: JSON.stringify({ level: Number($('lv').value), auto: $('au').checked, decayAfter: Number($('da').value) })
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok){ $('msg').textContent = '质疑度保存失败: ' + (j.error||r.status); return; }
  state = j.state; paint();
  $('msg').textContent = '质疑度已设为 ' + (j.state?.methodbook?.level ?? '?') + ' / ' + (j.state?.methodbook?.max ?? 10);
};
$('sp').onclick = async () => {
  $('msg').textContent = '迁移中…';
  const r = await fetch('__PREFIX__/api/paths', {
    method:'POST', headers:{'content-type':'application/json','x-dsh-memory':'1'},
    body: JSON.stringify({ primaryPath: $('pp').value.trim(), mirrorPath: $('mp').value.trim() })
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok){ $('msg').textContent = '迁移失败: ' + (j.error||r.status); return; }
  state = j.state; paint();
  $('msg').textContent = '保存位置已迁移并双写';
};
$('save').onclick = async () => {
  $('msg').textContent = '保存中…';
  const r = await fetch('__PREFIX__/api/save', {
    method:'POST', headers:{'content-type':'application/json','x-dsh-memory':'1'},
    body: JSON.stringify({ section: current, text: $('editor').value })
  });
  const j = await r.json().catch(()=>({error:'bad json'}));
  if(!r.ok){ $('msg').textContent = '保存失败: ' + (j.error||r.status); return; }
  state = j.state; paint();
  $('msg').textContent = '已保存到主文件与镜像（revision ' + (j.state?.meta?.revision??'?') + '）';
};
$('reconcile').onclick = async () => {
  $('msg').textContent = '对账中…';
  const r = await fetch('__PREFIX__/api/reconcile', { method:'POST', headers:{'x-dsh-memory':'1'} });
  const j = await r.json().catch(()=>({}));
  $('msg').textContent = r.ok ? ('对账完成：' + (j.action ?? '')) : ('失败: ' + (j.error||r.status));
  if(r.ok) load();
};
$('reload').onclick = load;
load();
</script></body></html>`

function renderPage() {
  const list = SECTIONS.map((s) => [s, SECTION_TITLES[s] ?? s])
  return PAGE
    .replace('__SECTIONS__', JSON.stringify(list))
    .replaceAll('__PREFIX__', PREFIX)
}

export { renderPage }

/**
 * @param {object} ctx  plugin context
 * @param {object} deps { store, log }
 * @returns {() => void} disposer
 */
export function registerMemoryPage(ctx, { store, log, extra, hooks }) {
  const safeExtra = () => {
    try {
      const value = extra ? extra() : undefined
      return value && typeof value === 'object' ? value : undefined
    } catch {
      return undefined
    }
  }

  const settingsOf = () => {
    try {
      const base = hooks?.getSettings?.() ?? {}
      const ar = store.archiveStats()
      const mb = methodbookSummary(store.view())
      return {
        profile: base.profile ?? 'standard',
        entryCap: base.entryCap ?? 200,
        graceDays: base.graceDays ?? 3,
        ttlBySection: base.ttlBySection ?? {},
        version: base.version ?? '',
        selfTest: base.selfTest ?? null,
        skills: base.skills ?? { count: 0, names: [], top: [] },
        archive: { count: ar.count, bytes: ar.bytes, exists: ar.exists, sections: ar.sections },
        index: ar.index,
        methodbooks: mb.taskCount,
        skepticism: {
          level: mb.level,
          max: mb.max,
          auto: mb.auto,
          decayAfter: mb.decayAfter,
          noGainStreak: mb.noGainStreak
        }
      }
    } catch {
      return {}
    }
  }

  /** 统一的 state 组装：所有写接口都返回它，前端统一 refresh */
  /* ---------- 表情包：目录扫描 + 图片直链 ---------- */
  const stickerOptions = () => hooks?.getStickerOptions?.() ?? {}
  const stickerUrl = (file) => `${PREFIX}/sticker/${encodeURIComponent(file)}`
  /* 把「图片直链的完整地址」告诉插件，工具挑图时直接给可渲染的 URL */
  const notifyBase = () => {
    try {
      const origin = getServer()?.getOrigin?.() ?? ''
      if (origin) hooks?.onStickerBase?.(`${origin}${PREFIX}`)
    } catch {
      /* 端口还没绑定 */
    }
  }
  const stickerState = () => {
    let items = []
    try {
      items = scanStickers(stickerOptions()).map((item) => ({
        file: item.file,
        url: stickerUrl(item.file),
        moods: item.moods,
        used: item.used,
        bytes: item.bytes
      }))
    } catch {
      items = []
    }
    let dir = ''
    try {
      dir = ensureStickersDir(stickerOptions())
    } catch {
      dir = stickersDir(stickerOptions())
    }
    return { count: items.length, dir, items }
  }

  const buildState = async () => {    await store.reload(true)
    const view = store.view()
    const st = await store.status()
    return {
      raw: view.raw,
      sections: view.sections,
      meta: view.meta,
      counts: st.counts,
      primaryPath: st.primaryPath,
      mirrorPath: st.mirrorPath,
      inSync: st.inSync,
      methodbook: methodbookSummary(view),
      settings: settingsOf(),
      stickers: stickerState(),
      ...(safeExtra() ?? {}),
      scopeNote: '编辑时请只改分区正文，分隔标记由插件维护'
    }
  }

  const requirePost = (req, res) => {
    if (req.headers['x-dsh-memory'] !== '1') {
      sendJson(res, 400, { error: 'missing x-dsh-memory header' })
      return false
    }
    return true
  }

  const handle = async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    const route = url.pathname.slice(PREFIX.length) || '/'
    try {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'cross-origin blocked' })
        return
      }

      if (req.method === 'GET' && (route === '/' || route === '')) {
        send(res, 200, 'text/html; charset=utf-8', renderPage())
        return
      }

      if (req.method === 'GET' && route === '/api/state') {
        sendJson(res, 200, await buildState())
        return
      }

      /* ---------- 表情包：图片直链（回复里的 ![](<url>) 靠它渲染） ---------- */
      if (req.method === 'GET' && route.startsWith('/sticker/')) {
        const raw = decodeURIComponent(route.slice('/sticker/'.length))
        const name = path.basename(raw).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
        const dir = stickersDir(stickerOptions())
        const file = path.join(dir, name)
        const ext = path.extname(name).toLowerCase()
        if (!existsSync(file) || !IMAGE_EXT.includes(ext) || !path.resolve(file).startsWith(path.resolve(dir) + path.sep)) {
          sendJson(res, 404, { error: 'sticker not found' })
          return
        }
        const mime =
          ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
        send(res, 200, mime, readFileSync(file), { 'cache-control': 'public, max-age=300' })
        return
      }

      if (req.method === 'GET' && route === '/api/stickers') {
        sendJson(res, 200, stickerState())
        return
      }

      if (req.method === 'POST' && route === '/api/sticker/upload') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req, 12 * 1024 * 1024)) || '{}')
        const name = path.basename(String(payload.name ?? ''))
        const ext = path.extname(name).toLowerCase()
        if (!IMAGE_EXT.includes(ext)) {
          sendJson(res, 400, { error: '只支持 webp / png / gif / jpg' })
          return
        }
        const buf = Buffer.from(String(payload.data ?? ''), 'base64')
        if (!buf.length) {
          sendJson(res, 400, { error: '空的文件内容' })
          return
        }
        if (buf.length > 8 * 1024 * 1024) {
          sendJson(res, 413, { error: '单张图超过 8MB' })
          return
        }
        const dir = ensureStickersDir(stickerOptions())
        const target = path.join(dir, name)
        if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
          sendJson(res, 400, { error: '路径越界' })
          return
        }
        writeFileSync(target, buf)
        sendJson(res, 200, {
          ok: true,
          file: name,
          moods: classifyByFilename(name),
          url: stickerUrl(name),
          state: { stickers: stickerState() }
        })
        return
      }

      if (req.method === 'POST' && route === '/api/sticker/delete') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req)) || '{}')
        const name = path.basename(String(payload.name ?? ''))
        const dir = stickersDir(stickerOptions())
        const target = path.join(dir, name)
        if (!existsSync(target) || !path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
          sendJson(res, 404, { error: '没有这张图' })
          return
        }
        rmSync(target, { force: true })
        sendJson(res, 200, { ok: true, state: { stickers: stickerState() } })
        return
      }

      if (req.method === 'POST' && route === '/api/sticker/tag') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req)) || '{}')
        const name = path.basename(String(payload.name ?? ''))
        if (!name) {
          sendJson(res, 400, { error: '缺少 name' })
          return
        }
        setTags(name, payload.moods ?? [], stickerOptions())
        sendJson(res, 200, { ok: true, file: name, state: { stickers: stickerState() } })
        return
      }

      if (req.method === 'GET' && route === '/api/export') {
        await store.reload(true)
        const snapshot = store.exportSnapshot()
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot, null, 2), {
          'content-disposition': `attachment; filename="shared-memory-${Date.now()}.json"`
        })
        return
      }

      if (req.method === 'GET' && route === '/api/history') {
        const list = await store.listHistory(20)
        const from = url.searchParams.get('from') || ''
        const to = url.searchParams.get('to') || ''
        const diff = from || to ? await store.diffHistory(from, to) : null
        sendJson(res, 200, {
          versions: list.map((h) => ({ name: h.name, bytes: h.bytes, mtime: h.mtime })),
          diff
        })
        return
      }

      if (req.method === 'POST' && route === '/api/save') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req)) || '{}')
        const section = String(payload.section ?? '')
        if (!SECTIONS.includes(section)) {
          sendJson(res, 400, { error: `unknown section: ${section}` })
          return
        }
        const text = String(payload.text ?? '')
        if (text.length > 200_000) {
          sendJson(res, 413, { error: '内容过长（>200k 字符）' })
          return
        }
        await store.setSection(section, text)
        sendJson(res, 200, { ok: true, state: await buildState() })
        return
      }

      if (req.method === 'POST' && route === '/api/skepticism') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req)) || '{}')
        const mb = parseMethodbook(store.view()?.sections?.methodbook ?? '') ?? defaultMethodbook()
        const beforeLevel = mb.skepticism.level
        if (payload.level !== undefined && payload.level !== null && payload.level !== '') {
          mb.skepticism.level = clampLevel(payload.level)
        }
        if (payload.auto !== undefined) mb.skepticism.auto = payload.auto === true || payload.auto === 'true'
        if (payload.decayAfter !== undefined && payload.decayAfter !== null && payload.decayAfter !== '') {
          mb.skepticism.decayAfter = clampDecayAfter(payload.decayAfter)
        }
        mb.skepticism.noGainStreak = 0
        if (beforeLevel !== mb.skepticism.level || payload.auto !== undefined || payload.decayAfter !== undefined) {
          mb.skepticism.lastChange = {
            at: stamp(),
            from: beforeLevel,
            to: mb.skepticism.level,
            reason: '面板手动设定'
          }
        }
        await store.setSection('methodbook', renderMethodbook(mb))
        sendJson(res, 200, { ok: true, state: await buildState() })
        return
      }

      if (req.method === 'POST' && route === '/api/profile') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req)) || '{}')
        if (typeof hooks?.setProfile !== 'function') {
          sendJson(res, 500, { error: 'setProfile 不可用' })
          return
        }
        const next = await hooks.setProfile(payload.profile)
        sendJson(res, 200, { ok: true, profile: next, state: await buildState() })
        return
      }

      if (req.method === 'POST' && route === '/api/ttl') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req)) || '{}')
        if (typeof hooks?.setTtl !== 'function') {
          sendJson(res, 500, { error: 'setTtl 不可用' })
          return
        }
        const ttl = await hooks.setTtl({ requests: payload.requests, sessions: payload.sessions })
        sendJson(res, 200, { ok: true, ttl, state: await buildState() })
        return
      }

      if (req.method === 'POST' && route === '/api/rebalance') {
        if (!requirePost(req, res)) return
        await store.reload(true)
        const results = []
        for (const section of ENTRY_SECTIONS) {
          const r = await store.rebalance(section)
          results.push({ section, kept: r.kept, dropped: r.dropped })
        }
        sendJson(res, 200, { ok: true, results, state: await buildState() })
        return
      }

      if (req.method === 'POST' && route === '/api/paths') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req)) || '{}')
        const primary = String(payload.primaryPath ?? '').trim()
        const mirrorInput = String(payload.mirrorPath ?? '').trim()
        if (!primary) {
          sendJson(res, 400, { error: '需要主文件完整路径' })
          return
        }
        if (!primary.toLowerCase().endsWith('.md')) {
          sendJson(res, 400, { error: '主文件路径必须是 .md' })
          return
        }
        if (typeof hooks?.relocate !== 'function') {
          sendJson(res, 500, { error: 'relocate 不可用' })
          return
        }
        const mirror = mirrorInput === '' ? store.mirrorPath : mirrorInput
        const migrated = await hooks.relocate(primary, mirror)
        sendJson(res, 200, {
          ok: true,
          action: migrated?.action ?? 'relocated',
          state: await buildState()
        })
        return
      }

      if (req.method === 'POST' && route === '/api/reconcile') {
        if (!requirePost(req, res)) return
        const result = await store.reconcile()
        sendJson(res, 200, { ok: true, action: result.action, state: await buildState() })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      log('warn', `记忆网页请求失败：${error?.message ?? error}`)
      try {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      } catch {
        /* 响应已经发出 */
      }
    }
  }

  /*
   * webServer 可能在插件 apply 之后才就绪（启动顺序不固定），所以不能只查一次：
   * 没拿到就每秒重试，最多等 180 秒；拿到后立刻注册，重复调用不会注册两次。
   */
  let disposePage = null
  let timer = null
  let attempts = 0

  const getServer = () => {
    try {
      return ctx.get('webServer')
    } catch {
      return undefined
    }
  }

  const stopRetry = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const tryRegister = () => {
    if (disposePage) return
    const server = getServer()
    if (!server || typeof server.register !== 'function') {
      attempts += 1
      if (attempts === 5) log('info', 'webServer 还没就绪，继续等待记忆网页注册')
      if (attempts > 180) {
        log('warn', 'webServer 180 秒仍不可用，放弃注册记忆网页')
        stopRetry()
      }
      return
    }
    try {
      disposePage = server.register({ kind: 'prefix', path: PREFIX, handler: handle })
      stopRetry()
      notifyBase()
      let origin = ''
      try {
        origin = server.getOrigin?.() ?? ''
      } catch {
        /* 端口可能还没绑定 */
      }
      log('info', `记忆网页：${origin || 'http://127.0.0.1:<port>'}${PREFIX}`)
    } catch (error) {
      log('warn', `记忆网页注册失败：${error?.message ?? error}`)
      stopRetry()
    }
  }

  tryRegister()
  if (!disposePage) timer = setInterval(tryRegister, 1000)

  return () => {
    stopRetry()
    if (typeof disposePage === 'function') {
      try {
        disposePage()
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 供测试直接引用，避免把 HTML 写死在断言里 */
export const MEMORY_PAGE_PREFIX = PREFIX
export { parseEntries }
