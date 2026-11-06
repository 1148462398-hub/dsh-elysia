/**
 * DSH-elysia / webui.js
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

import { SECTIONS, SECTION_TITLES, ENTRY_SECTIONS, parseEntries, stamp, DEFAULT_IDENTITY } from './store.js'
import { identityStats, mergeIdentityText, personaOverlap } from './prompt.js'
import { installPack, listPacks, packStatus, previewPack, uninstallPack } from './packs.js'
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

/** 网页上的自我记忆摘要：字数 / 章节 / 四层注入覆盖（算法与工具 status 共用 identityStats） */
function identitySummary(view, hooks) {
  try {
    const opts = hooks?.getIdentityOptions?.() ?? {}
    const st = identityStats(view, opts)
    return {
      chars: st.chars,
      lines: st.lines,
      chapters: st.chapters,
      budget: st.budget,
      configuredBudget: st.configuredBudget,
      budgetRaised: st.budgetRaised,
      injectedChars: st.injectedChars,
      full: st.full,
      empty: st.empty,
      coverage: (st.coverage ?? []).map((c) => ({
        no: c.no,
        label: c.label,
        key: c.key,
        full: c.full,
        shown: c.shown,
        total: c.total,
        count: c.count
      })),
      titles: st.titles.slice(0, 80)
    }
  } catch {
    return null
  }
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
<title>DSH-elysia · 记忆</title>
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
.ident{margin:0 0 14px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#101623}
.ident h2{margin:0 0 6px;font-size:13px;color:var(--fg)}
.ident .meta{color:var(--dim);font-size:12px;line-height:1.7}
.ident .meta b{color:var(--fg)}
.ident .warn{color:#f0b849}
.packs{margin:0 0 14px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#101623}
.packs h2{margin:0 0 8px;font-size:13px;color:var(--fg)}
.packs .sub{color:var(--dim);font-size:12px;margin-bottom:8px;line-height:1.6}
.pack-card{border:1px solid var(--line);border-radius:9px;padding:9px 11px;margin-bottom:8px;background:#0c1017}
.pack-card.on{border-color:#1f4d38;background:#0d1a15}
.pack-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.pack-name{font-size:13px;color:var(--fg);font-weight:600}
.pack-ver{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:0 6px}
.pack-badge{font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.pack-badge.on{color:var(--ok);border-color:#1f4d38}
.pack-desc{color:var(--dim);font-size:12px;margin:4px 0 2px;line-height:1.6}
.pack-meta{color:var(--dim);font-size:11px;line-height:1.7}
.pack-meta b{color:var(--fg)}
.pack-row{display:flex;gap:8px;margin-top:7px;flex-wrap:wrap;align-items:center}
.pack-row button{background:transparent;border:1px solid var(--line);color:var(--dim);padding:4px 12px;border-radius:7px;cursor:pointer;font-size:12px}
.pack-row button.want{border-color:var(--acc);color:var(--fg)}
.pack-row button:disabled{opacity:.45;cursor:not-allowed}
.pack-msg{font-size:11px;color:var(--dim)}
.pack-preview{white-space:pre-wrap;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#0b0d12;border:1px solid var(--line);border-radius:8px;padding:9px;margin-top:7px;max-height:46vh;overflow:auto;color:#c8cede}
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
  <div class="packs">
    <h2>📦 记忆包</h2>
    <div class="sub">插件自带的整份角色记忆与人设。<b>默认不启用</b>：点「安装」才会写入 identity + persona（安装前自动备份，可卸载恢复）。其它分区不会被碰。</div>
    <div id="packList"><span class="pack-msg">读取中…</span></div>
    <div class="pack-msg" id="packMsg"></div>
  </div>
  <div class="packs">
    <h2>🔊 语音朗读</h2>
    <div class="sub">
      用本机的 GPT-SoVITS 引擎，把回复合成成语音。依赖本机装好引擎且在 9880 端口跑着——
      <b>换一台机器就没有，所以默认关闭</b>。开关只影响当前进程，不改记忆文件。
    </div>
    <div class="row" style="margin-bottom:8px">
      <button class="ghost" id="voiceToggle">读取中…</button>
      <span class="pack-msg" id="voiceState"></span>
    </div>
    <div class="pack-msg" id="voiceMsg"></div>
  </div>
  <div class="ident">
    <h2>自我记忆（Identity · 优先级高于人设）</h2>
    <div class="meta" id="identMeta">…</div>
    <div class="row">
      <input type="file" id="identFile" accept=".md,.markdown,.txt">
      <select id="identMode" style="background:#0b0d12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px">
        <option value="replace">整份覆盖</option>
        <option value="merge">按章节合并</option>
      </select>
      <button class="ghost" id="identUp">导入这份 .md</button>
      <span id="identMsg" class="meta"></span>
    </div>
    <div class="meta" style="margin-top:6px">主路径是对话里的 <code>memory_file_identity({action:"import", path:"..."})</code>；网页导入是顺手用的补充（桌面端可能连不上本机端口）。</div>
  </div>
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
/* ---------- 记忆包 ---------- */
let packView = null;          // 最近一次 /api/packs 的响应
let packPreviewId = '';       // 当前正在预览的包

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paintPacks(){
  const box = $('packList');
  if(!box) return;
  const packs = packView?.packs || [];
  if(!packs.length){ box.innerHTML = '<span class="pack-msg">没有可用的记忆包（插件 packs/ 目录为空）。</span>'; return; }
  box.innerHTML = packs.map(function(p){
    const on = p.installed;
    const badge = on
      ? '<span class="pack-badge on">' + (p.fullyInstalled ? '已安装' : '部分已安装') + '</span>'
      : '<span class="pack-badge">未安装</span>';
    const si = p.sections.identity || {}, sp = p.sections.persona || {};
    const previewing = packPreviewId === p.id;
    let html = '<div class="pack-card' + (on ? ' on' : '') + '" data-pack="' + esc(p.id) + '">'
      + '<div class="pack-head"><span class="pack-name">' + esc(p.name) + '</span>'
      + '<span class="pack-ver">v' + esc(p.version) + '</span>' + badge + '</div>'
      + (p.description ? '<div class="pack-desc">' + esc(p.description) + '</div>' : '')
      + '<div class="pack-meta">identity <b>' + (si.packChars || 0) + '</b> 字 · persona <b>' + (sp.packChars || 0) + '</b> 字</div>';
    if(on){
      html += '<div class="pack-meta">当前 identity ' + (si.currentChars || 0) + ' 字 / persona ' + (sp.currentChars || 0) + ' 字'
        + (p.record && p.record.installedAt ? ' · 安装于 ' + esc(p.record.installedAt.slice(0, 19).replace('T',' ')) : '') + '</div>';
    }
    if(!si.isDefault && !si.installed){
      html += '<div class="pack-meta"><span style="color:#f0b849">现有自我记忆是你自己的内容，安装会覆盖（已自动备份，可卸载恢复）</span></div>';
    }
    html += '<div class="pack-row">'
      + '<button data-act="preview" data-id="' + esc(p.id) + '">' + (previewing ? '收起' : '查看') + '</button>'
      + (on
          ? '<button data-act="uninstall" data-id="' + esc(p.id) + '">卸载</button>'
          : '<button class="want" data-act="install" data-id="' + esc(p.id) + '">安装</button>')
      + '<span class="pack-msg" data-msg="' + esc(p.id) + '"></span></div>';
    if(previewing && p.preview){
      html += '<div class="pack-preview">' + esc(p.preview) + '</div>';
    }
    html += '</div>';
    return html;
  }).join('');
  [...box.querySelectorAll('button[data-act]')].forEach(function(b){
    b.onclick = function(){
      const act = b.dataset.act, id = b.dataset.id;
      if(act === 'preview') return togglePackPreview(id);
      if(act === 'install') return doInstallPack(id);
      if(act === 'uninstall') return doUninstallPack(id);
    };
  });
}

function packMsg(id, text){
  const el = document.querySelector('[data-msg="' + id + '"]');
  if(el) el.textContent = text;
}

async function loadPacks(){
  try{
    const r = await fetch('__PREFIX__/api/packs');
    if(!r.ok) throw new Error('HTTP ' + r.status);
    packView = await r.json();
  }catch(e){
    packView = { packs: [] };
    $('packMsg').textContent = '记忆包列表读取失败：' + (e && e.message ? e.message : e);
  }
  paintPacks();
}

/* ---------- 语音朗读开关 ---------- */
let voiceOn = false;

function paintVoice(st){
  const btn = document.getElementById('voiceToggle');
  const state = document.getElementById('voiceState');
  if(!btn || !state) return;
  voiceOn = Boolean(st && st.enabled);
  btn.textContent = voiceOn ? '关闭语音' : '开启语音';
  const parts = [];
  parts.push(voiceOn ? '✅ 已开启' : '· 已关闭');
  if(st){
    if(st.model) parts.push('模型 ' + st.model);
    if(st.ref) parts.push('参考 ' + st.ref);
    if(st.engineUrl) parts.push(st.engineUrl);
    if(st.cooldownUntil) parts.push('熔断至 ' + st.cooldownUntil);
  }
  state.textContent = parts.join('　');
}

async function loadVoice(){
  try{
    const r = await fetch('__PREFIX__/api/voice');
    const j = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    paintVoice(j);
  }catch(e){
    paintVoice(null);
    const m = document.getElementById('voiceMsg');
    if(m) m.textContent = '读取语音状态失败：' + e.message;
  }
}

async function toggleVoice(){
  const m = document.getElementById('voiceMsg');
  try{
    const r = await fetch('__PREFIX__/api/voice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !voiceOn })
    });
    const j = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    paintVoice(j);
    if(m) m.textContent = j.enabled
      ? '已开启。语音依赖本机 GPT-SoVITS 引擎，对话里用 memory_file_voice({action:"check"}) 可以探活。'
      : '已关闭。';
  }catch(e){
    if(m) m.textContent = '切换失败：' + e.message;
  }
}

async function togglePackPreview(id){
  if(packPreviewId === id){ packPreviewId = ''; packView.packs.forEach(function(p){ p.preview = ''; }); paintPacks(); return; }
  packMsg(id, '读取预览…');
  try{
    const r = await fetch('__PREFIX__/api/packs/' + encodeURIComponent(id) + '/preview');
    const j = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    const lines = [];
    lines.push(j.name + '  v' + j.version);
    if(j.description) lines.push(j.description);
    const src = j.source || {};
    [src.audio, src.text, src.note].filter(Boolean).forEach(function(s){ lines.push('来源：' + s); });
    Object.keys(j.preview || {}).forEach(function(name){
      const info = j.preview[name];
      lines.push('');
      lines.push('=== ' + name + '（' + info.chars + ' 字' + (info.truncated ? '，只显示前 2000 字' : '') + '）===');
      if(info.chapters && info.chapters.length) lines.push('章节：' + info.chapters.join(' / '));
      lines.push('');
      lines.push(info.head);
      if(info.truncated) lines.push('…（已截断）');
    });
    packPreviewId = id;
    packView.packs.forEach(function(p){ p.preview = (p.id === id) ? lines.join('\\n') : ''; });
    paintPacks();
  }catch(e){
    packMsg(id, '预览失败：' + (e && e.message ? e.message : e));
  }
}

async function doInstallPack(id){
  const p = (packView?.packs || []).find(function(x){ return x.id === id; });
  const si = p?.sections?.identity || {}, sp = p?.sections?.persona || {};
  const warn = !si.isDefault && !si.installed
    ? '\\n\\n注意：你现在的 identity 是自己的内容，会被覆盖（安装前自动备份，可卸载恢复）。'
    : '';
  if(!confirm('安装「' + (p?.name || id) + '」？\\n\\n将写入 identity（' + (si.packChars||0) + ' 字）与 persona（' + (sp.packChars||0) + ' 字），'
    + '其它分区不受影响。' + warn + '\\n\\n需要重启 DSH 才完全生效。')) return;
  packMsg(id, '安装中…');
  try{
    const r = await fetch('__PREFIX__/api/packs/' + encodeURIComponent(id) + '/install', {
      method:'POST', headers:{'content-type':'application/json','x-dsh-memory':'1'},
      body: JSON.stringify({ confirm: true })
    });
    const j = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    packPreviewId = '';
    if(j.state) { state = j.state; }
    await loadPacks();
    $('packMsg').textContent = j.message || ('已安装 ' + id);
    if(state) paint();
  }catch(e){
    packMsg(id, '安装失败：' + (e && e.message ? e.message : e));
  }
}

async function doUninstallPack(id){
  if(!confirm('卸载「' + id + '」？\\n\\nidentity / persona 会从安装前的备份恢复；没有备份则复位为默认占位。')) return;
  packMsg(id, '卸载中…');
  try{
    const r = await fetch('__PREFIX__/api/packs/' + encodeURIComponent(id) + '/uninstall', {
      method:'POST', headers:{'content-type':'application/json','x-dsh-memory':'1'},
      body: '{}'
    });
    const j = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    packPreviewId = '';
    if(j.state) { state = j.state; }
    await loadPacks();
    $('packMsg').textContent = j.message || ('已卸载 ' + id);
    if(state) paint();
  }catch(e){
    packMsg(id, '卸载失败：' + (e && e.message ? e.message : e));
  }
}

function paintIdent(){
  const d = state?.identity;
  if(!d){ $('identMeta').textContent = '（读不到自我记忆状态）'; return; }
  const parts = [];
  parts.push('<b>' + d.chars + '</b> 字 · <b>' + d.chapters + '</b> 章 · 注入预算 ' + d.budget + ' 字'
    + (d.budgetRaised ? '（已为核心两层抬高，原定 ' + d.configuredBudget + '）' : ''));
  const cov = (d.coverage || []).map((c) => {
    const icon = c.key === 'history' ? '📋 仅目录' : (c.full ? '✅ 完整' : (c.shown > 0 ? '⚠️ 部分' : '❌ 未注入'));
    const amount = c.key === 'history' ? (c.count + ' 章未展开') : (c.shown + '/' + c.total + ' 字');
    return c.no + ' ' + c.label + ' ' + icon + '（' + amount + '）';
  });
  if(cov.length) parts.push(cov.join('<br>'));
  if(d.empty) parts.push('<span class="warn">还没导入真实记忆（当前是默认占位文案）</span>');
  $('identMeta').innerHTML = parts.join('<br>');
}
function paint(){
  if(!state) return;
  const body = state.sections[current] ?? '';
  paintPacks();
  $('editor').value = body;
  const mb = state.methodbook;
  if(mb){
    const cats = (mb.categories || []).slice(0, 6).map((c) => c.category + '×' + c.count).join(' · ');
    $('skep').innerHTML = '质疑度 <b>' + mb.level + ' / ' + mb.max + '</b>' +
      (mb.auto ? '（自动降档，连续 ' + mb.noGainStreak + '/' + mb.decayAfter + ' 次未更优）' : '（手动设定）') +
      ' · 方法库 ' + mb.taskCount + ' 个任务' + (cats ? ' — ' + cats : '');
  }
  syncControls();
  paintIdent();
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
  await loadPacks();   // 记忆包单独一个接口：它要读 packs/ 目录 + 算 hash
  await loadVoice();   // 语音状态
  const vt = document.getElementById('voiceToggle');
  if(vt) vt.onclick = toggleVoice;
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
$('identUp').onclick = async () => {
  const f = $('identFile').files && $('identFile').files[0];
  if(!f){ $('identMsg').textContent = '先选一个 .md 文件'; return; }
  $('identMsg').textContent = '导入中…';
  try {
    const text = await f.text();
    if(!text.trim()){ $('identMsg').textContent = '文件是空的'; return; }
    const r = await fetch('__PREFIX__/api/import-identity', {
      method:'POST', headers:{'content-type':'application/json','x-dsh-memory':'1'},
      body: JSON.stringify({ text, mode: $('identMode').value, name: f.name })
    });
    const j = await r.json().catch(()=>({error:'bad json'}));
    if(!r.ok){ $('identMsg').textContent = '导入失败: ' + (j.error||r.status); return; }
    state = j.state; paint();
    $('identMsg').textContent = '已导入 ' + (j.result?.chars ?? '?') + ' 字 / ' + (j.result?.chapters ?? '?') + ' 章'
      + (j.result?.warning ? '（' + j.result.warning + '）' : '');
  } catch (e) {
    $('identMsg').textContent = '导入失败: ' + (e && e.message ? e.message : e);
  }
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
      identity: identitySummary(view, hooks),
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

      /* ---------- 语音朗读：开关（只影响当前进程，不写记忆文件） ---------- */
      if (req.method === 'GET' && route === '/api/voice') {
        sendJson(res, 200, hooks?.voiceStatus?.() ?? { enabled: false })
        return
      }
      if (req.method === 'POST' && route === '/api/voice') {
        let body = {}
        try {
          body = JSON.parse(await readBody(req) ?? '{}')
        } catch {
          /* 空 body 当作查询 */
        }
        // 带 volume/speed 就调参数；带 enabled 就切开关；两者可以一起来
        if (Number.isFinite(body.volume) || Number.isFinite(body.speed)) {
          hooks?.voiceSetParams?.({ volume: body.volume, speed: body.speed })
        }
        if (typeof body.enabled === 'boolean') {
          sendJson(res, 200, hooks?.voiceSetEnabled?.(body.enabled) ?? { enabled: body.enabled })
        } else {
          sendJson(res, 200, hooks?.voiceStatus?.() ?? { enabled: false })
        }
        return
      }
        /* 立刻停止正在播的声音（不关开关，只停这一段） */
        if (req.method === 'POST' && route === '/api/voice/stop') {
          const r = hooks?.voiceStop?.() ?? { stopped: false, reason: 'unsupported' }
          sendJson(res, 200, {
            ...r,
            message: r.stopped ? '已停止播放' : '当前没有在播放'
          })
          return
        }
      /* 环境检测：显卡 / Python / 磁盘 / 引擎 / 权重（只读） */
      if (req.method === 'GET' && route === '/api/voice/doctor') {
        sendJson(res, 200, (await hooks?.voiceDoctor?.()) ?? { ok: false, items: [], steps: [] })
        return
      }
      /* 试听：用指定音量合成一句固定的话并播放 */
      if (req.method === 'POST' && route === '/api/voice/test') {        let body = {}
        try {
          body = JSON.parse(await readBody(req) ?? '{}')
        } catch {
          /* 没 body 就用当前音量 */
        }
        const r = (await hooks?.voiceTest?.({ volume: body.volume })) ?? { spoke: false, reason: 'unsupported' }
        sendJson(res, 200, {
          ok: Boolean(r.spoke),
          file: r.file ?? null,
          played: Boolean(r.played),
          reason: r.reason ?? null,
          error: r.error ?? null,
          message: r.spoke
            ? `已播放（音量 ${Number(body.volume ?? 0) > 0 ? '+' : ''}${body.volume ?? 0} dB）`
            : `没能出声：${r.reason ?? r.error ?? '未知原因'}`
        })
        return
      }

      /* ---------- 记忆包：列表 / 预览 / 安装 / 卸载（默认不安装，必须显式 confirm） ---------- */
      if (req.method === 'GET' && route === '/api/packs') {
        const status = await packStatus(store)
        const preview = {}
        sendJson(res, 200, {
          packs: status.packs.map((p) => ({ ...p, preview: preview[p.id] ?? '' })),
          backupRoot: status.backupRoot,
          statePath: status.statePath,
          installed: status.installed,
          count: status.packs.length,
          available: listPacks().length
        })
        return
      }

      const packPreviewMatch = /^\/api\/packs\/([^/]+)\/preview$/.exec(route)
      if (req.method === 'GET' && packPreviewMatch) {
        const id = decodeURIComponent(packPreviewMatch[1])
        sendJson(res, 200, await previewPack(id))
        return
      }

      const packInstallMatch = /^\/api\/packs\/([^/]+)\/install$/.exec(route)
      if (req.method === 'POST' && packInstallMatch) {
        if (!requirePost(req, res)) return
        const id = decodeURIComponent(packInstallMatch[1])
        const payload = JSON.parse((await readBody(req)) || '{}')
        /* 网页端按钮就是"用户明确点了"，但仍要求请求体带 confirm:true，避免误触 */
        const r = await installPack(store, id, { confirm: payload.confirm === true })
        sendJson(res, 200, {
          ok: r.ok !== false,
          needsConfirm: r.needsConfirm === true,
          message: r.message,
          backupDir: r.backupDir,
          written: r.written,
          overwritesUserContent: r.overwritesUserContent,
          state: await buildState()
        })
        return
      }

      const packUninstallMatch = /^\/api\/packs\/([^/]+)\/uninstall$/.exec(route)
      if (req.method === 'POST' && packUninstallMatch) {
        if (!requirePost(req, res)) return
        const id = decodeURIComponent(packUninstallMatch[1])
        const r = await uninstallPack(store, id)
        sendJson(res, 200, { ...r, state: await buildState() })
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

      /*
       * 网页导入自我记忆。注意这只是"锦上添花"：
       * 桌面端页面来源是 dsh-app://，向本机端口发请求可能被挂住，
       * 所以真正的主路径是对话里的 memory_file_identity({action:"import"})。
       */
      if (req.method === 'POST' && route === '/api/import-identity') {
        if (!requirePost(req, res)) return
        const payload = JSON.parse((await readBody(req, 4 * 1024 * 1024)) || '{}')
        const text = String(payload.text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
        if (!text) {
          sendJson(res, 400, { error: '内容为空' })
          return
        }
        if (text.length > 4 * 1024 * 1024) {
          sendJson(res, 413, { error: '文件过大（>4MB）' })
          return
        }
        const mode = String(payload.mode ?? 'replace') === 'merge' ? 'merge' : 'replace'
        let next = text
        if (mode === 'merge') {
          const existing = String(store.view().sections.identity ?? '').trim()
          if (existing) next = mergeIdentityText(existing, text).text
        }        const r = await store.setSection('identity', next)
        const st = identityStats(store.view(), hooks?.getIdentityOptions?.() ?? {})
        sendJson(res, 200, {
          ok: true,
          result: {
            changed: r.changed,
            chars: st.chars,
            chapters: st.chapters,
            mode,
            warning: personaOverlap(text)
          },
          state: await buildState()
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
        // renderMethodbook() 按对象读 .from/.to/.reason/.at，写成字符串会渲染出 undefined
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

