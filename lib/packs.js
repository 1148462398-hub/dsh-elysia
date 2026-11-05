/**
 * dsh-shared-memory / packs.js
 *
 * 记忆包（Memory Packs）：插件自带的「整份角色记忆 + 人设」。
 *
 * 设计要点（每一条都是产品决定，改之前先想清楚）：
 *  1. **默认不安装**：插件装好后 identity 仍是默认占位、persona 仍是通用默认。
 *     只有用户主动 install 才写入。不是所有人都要同一个角色，包只是可选「皮肤」。
 *  2. **安装前自动备份**：写到 `<记忆目录>/.packs-backup/<id>-<时间戳>/`，
 *     卸载时从这份备份恢复。试了不喜欢能退回去。
 *  3. **只动 identity 和 persona**：requirements / corrections / lessons / methods /
 *     requests / sessions / docs / methodbook 这八个分区是用户自己的积累，绝不被包覆盖。
 *  4. **冲突检测**：拿 DEFAULT_IDENTITY / DEFAULT_PERSONA 当基准判断"现有内容是不是默认占位"，
 *     不是默认值就明确告诉用户"会覆盖"，但仍然先备份再写。
 *  5. **是否已安装用内容 hash 判断**，不完全依赖状态文件——
 *     用户可能手工改过 identity，状态文件会撒谎，内容不会。
 *
 * 只用 node 内置模块。
 */

import { promises as fsp } from 'node:fs'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_IDENTITY, DEFAULT_PERSONA, hashText, nowIso } from './store.js'

/** 包允许写入的分区。其它分区（用户自己的积累）一律不碰。 */
export const PACK_SECTIONS = ['identity', 'persona']

const DEFAULT_IDENTITY_TEXT = DEFAULT_IDENTITY.join('\n')

/** 包 id 只允许安全字符，避免 ../ 之类的路径穿越 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i

/** 插件根目录（lib/ 的上一级） */
function pluginRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  } catch {
    return process.cwd()
  }
}

/** packs/ 目录；options.packsDir 可覆盖（测试用） */
export function packsDir(options = {}) {
  const custom = String(options.packsDir ?? '').trim()
  return custom ? path.resolve(custom) : path.join(pluginRoot(), 'packs')
}

/** 备份根目录：默认跟记忆主文件同目录，记忆迁移后备份也跟着走 */
export function backupRoot(store, options = {}) {
  const custom = String(options.backupDir ?? '').trim()
  if (custom) return path.resolve(custom)
  const base = store?.primaryPath ? path.dirname(path.resolve(store.primaryPath)) : path.join(pluginRoot(), '.packs-backup')
  return path.join(base, '.packs-backup')
}

/** 安装状态文件：`<记忆目录>/.packs-state.json` */
export function statePath(store, options = {}) {
  const custom = String(options.statePath ?? '').trim()
  if (custom) return path.resolve(custom)
  const base = store?.primaryPath ? path.dirname(path.resolve(store.primaryPath)) : path.join(pluginRoot(), '.packs-backup')
  return path.join(base, '.packs-state.json')
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 统一换行 + 去 BOM + 去首尾空白（store.setSection 也会 trim，两边必须一致才能比 hash） */
export function normalizeBody(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function isDefaultIdentity(text) {
  return normalizeBody(text) === normalizeBody(DEFAULT_IDENTITY_TEXT)
}

function isDefaultPersona(text) {
  return normalizeBody(text) === normalizeBody(DEFAULT_PERSONA)
}

/**
 * 章节列表：优先取 `## ` 标题；没有二级标题时退回 `# `（人设文档常用一级标题分段）。
 */
export function chaptersOf(text) {
  const lines = String(text ?? '').split('\n')
  const level2 = lines.filter((line) => /^##\s+/.test(line)).map((line) => line.replace(/^##\s+/, '').trim())
  if (level2.length) return level2
  return lines.filter((line) => /^#\s+/.test(line)).map((line) => line.replace(/^#\s+/, '').trim())
}

async function readTextIfExists(target) {
  try {
    return await fsp.readFile(target, 'utf8')
  } catch {
    return null
  }
}

async function writeJsonAtomic(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, target)
}

/* ------------------------------------------------------------------ */
/* 读包                                                                */
/* ------------------------------------------------------------------ */

/**
 * 扫描 packs/ 目录，返回所有包（含大小、是否已装）。
 * 不做写入；任何单个包坏掉都只跳过它，不拖垮整个列表。
 */
export function listPacks(options = {}) {
  const root = packsDir(options)
  const out = []
  const entries = readdirSafe(root)
  /** registry 只是索引，真正的元信息永远以各包 manifest.json 为准 */
  const registry = readRegistry(root)
  const candidates = registry.length ? registry : entries.map((name) => ({ id: name, manifest: `${name}/manifest.json` }))

  for (const item of candidates) {
    const id = String(item?.id ?? '').trim()
    if (!ID_RE.test(id)) continue
    const manifestPath = path.join(root, String(item.manifest ?? path.join(id, 'manifest.json')))
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const pack = summarizePack(root, id, manifest)
      if (pack) out.push(pack)
    } catch {
      /* manifest 坏掉 → 跳过这个包，不影响别的 */
    }
  }
  return out
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function readRegistry(root) {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, '_registry.json'), 'utf8'))
    const list = Array.isArray(raw?.packs) ? raw.packs : []
    return list.filter((item) => item && typeof item.id === 'string')
  } catch {
    return []
  }
}

function summarizePack(root, id, manifest) {
  const sections = manifest?.sections && typeof manifest.sections === 'object' ? manifest.sections : {}
  const dir = path.join(root, id)
  const files = {}
  for (const name of PACK_SECTIONS) {
    const rel = String(sections[name] ?? '')
    if (!rel) continue
    const target = path.join(dir, rel)
    try {
      const text = readFileSync(target, 'utf8')
      files[name] = {
        file: rel,
        chars: normalizeBody(text).length,
        bytes: Buffer.byteLength(text, 'utf8'),
        hash: hashText(normalizeBody(text)),
        exists: true
      }
    } catch {
      files[name] = { file: rel, chars: 0, bytes: 0, hash: '', exists: false }
    }
  }
  return {
    id,
    name: String(manifest?.name ?? id),
    version: String(manifest?.version ?? '0.0.0'),
    description: String(manifest?.description ?? ''),
    author: String(manifest?.author ?? ''),
    license: String(manifest?.license ?? ''),
    source: manifest?.source ?? {},
    warnings: Array.isArray(manifest?.warnings) ? manifest.warnings : [],
    dir,
    sections: files
  }
}

/** 读某个包的完整内容（identity / persona 正文 + 章节表）；包不存在抛错 */
export async function readPack(id, options = {}) {
  const safe = String(id ?? '').trim()
  if (!ID_RE.test(safe)) throw new Error(`非法的记忆包 id：${id}`)
  const root = packsDir(options)
  const manifestPath = path.join(root, safe, 'manifest.json')
  const raw = await readTextIfExists(manifestPath)
  if (raw === null) throw new Error(`没有这个记忆包：${safe}（${manifestPath}）`)
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new Error(`记忆包 manifest.json 不是合法 JSON：${error?.message ?? error}`)
  }
  const summary = summarizePack(root, safe, manifest)
  const sections = {}
  for (const name of PACK_SECTIONS) {
    const info = summary.sections[name]
    if (!info?.exists) continue
    const text = await readTextIfExists(path.join(summary.dir, info.file))
    if (text === null) continue
    sections[name] = normalizeBody(text)
  }
  const readme = (await readTextIfExists(path.join(summary.dir, 'README.md'))) ?? ''
  return {
    ...summary,
    manifest,
    contents: sections,
    chapters: Object.fromEntries(
      Object.entries(sections).map(([name, text]) => [name, chaptersOf(text)])
    ),
    readme
  }
}

/** 预览：前 2000 字 + 章节列表（工具与网页共用） */
export async function previewPack(id, options = {}) {
  const pack = await readPack(id, options)
  const preview = {}
  for (const name of PACK_SECTIONS) {
    const text = pack.contents[name]
    if (text === undefined) continue
    preview[name] = {
      chars: text.length,
      head: text.slice(0, 2000),
      truncated: text.length > 2000,
      chapters: pack.chapters[name] ?? []
    }
  }
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    description: pack.description,
    source: pack.source,
    warnings: pack.warnings,
    preview
  }
}

/* ------------------------------------------------------------------ */
/* 安装状态                                                            */
/* ------------------------------------------------------------------ */

/** 读 `.packs-state.json`（不存在返回空结构） */
export async function readState(store, options = {}) {
  const target = statePath(store, options)
  const raw = await readTextIfExists(target)
  if (!raw) return { version: 1, packs: {} }
  try {
    const parsed = JSON.parse(raw)
    return {
      version: Number(parsed?.version) || 1,
      packs: parsed?.packs && typeof parsed.packs === 'object' ? parsed.packs : {}
    }
  } catch {
    return { version: 1, packs: {} }
  }
}

async function writeState(store, state, options = {}) {
  await writeJsonAtomic(statePath(store, options), state)
}

/**
 * 某个包在当前记忆里的安装状态。
 * **以内容 hash 为准**：包里的 identity.md 与当前 identity 分区一致才算已装，
 * 用户手工改过就会显示"已装但被改过"（hash 不匹配）。
 */
export async function packStatusOf(store, pack, options = {}) {
  if (!store) throw new Error('packStatus 需要 store')
  if (typeof store.reload === 'function') await store.reload(true)
  const view = store.view()
  const state = await readState(store, options)

  const sections = {}
  for (const name of PACK_SECTIONS) {
    const packSection = pack.sections?.[name]
    if (!packSection?.exists) {
      sections[name] = { available: false }
      continue
    }
    const current = normalizeBody(view.sections?.[name] ?? '')
    const currentHash = hashText(current)
    const isDefault = name === 'identity' ? isDefaultIdentity(current) : isDefaultPersona(current)
    sections[name] = {
      available: true,
      installed: currentHash === packSection.hash,
      currentChars: current.length,
      packChars: packSection.chars,
      currentHash,
      packHash: packSection.hash,
      isDefault,
      /** 有用户自己的内容（不是默认占位，也不是包里那份） */
      customized: !isDefault && currentHash !== packSection.hash
    }
  }
  const installedSections = PACK_SECTIONS.filter((name) => sections[name]?.installed)
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    description: pack.description,
    installed: installedSections.length > 0,
    fullyInstalled: installedSections.length === PACK_SECTIONS.filter((n) => sections[n]?.available).length,
    installedSections,
    sections,
    record: state.packs?.[pack.id] ?? null,
    backupRoot: backupRoot(store, options),
    statePath: statePath(store, options)
  }
}

/** 所有包的状态（网页 / 工具 list 用） */
export async function packStatus(store, options = {}) {
  const packs = listPacks(options)
  const out = []
  for (const pack of packs) {
    out.push(await packStatusOf(store, pack, options))
  }
  const state = await readState(store, options)
  return {
    packs: out,
    backupRoot: backupRoot(store, options),
    statePath: statePath(store, options),
    installed: out.filter((p) => p.installed).map((p) => p.id),
    records: state.packs ?? {}
  }
}

/* ------------------------------------------------------------------ */
/* 安装 / 卸载                                                         */
/* ------------------------------------------------------------------ */

function stampDir(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 安装一个记忆包。
 *
 * `options.confirm` 不为 true 时**只返回计划，不写任何文件**（工具侧要求二次确认）。
 *
 * @returns {Promise<object>} 计划或结果
 */
export async function installPack(store, id, options = {}) {
  if (!store) throw new Error('installPack 需要 store')
  const pack = await readPack(id, options)
  if (typeof store.reload === 'function') await store.reload(true)
  const before = store.view()
  const plan = []
  for (const name of PACK_SECTIONS) {
    const text = pack.contents[name]
    if (text === undefined) continue
    const current = normalizeBody(before.sections?.[name] ?? '')
    const isDefault = name === 'identity' ? isDefaultIdentity(current) : isDefaultPersona(current)
    plan.push({
      section: name,
      willWrite: true,
      currentChars: current.length,
      packChars: text.length,
      currentIsDefault: isDefault,
      /** true = 用户现有内容会被覆盖（已备份，可卸载恢复） */
      overwritesUserContent: !isDefault
    })
  }
  if (!plan.length) throw new Error(`记忆包 ${pack.id} 里没有任何可写分区`)

  const confirmed = options.confirm === true
  const result = {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    plan,
    overwritesUserContent: plan.some((p) => p.overwritesUserContent),
    backupDir: '',
    written: [],
    skipped: []
  }

  if (!confirmed) {
    return {
      needsConfirm: true,
      ...result,
      message:
        `将要安装「${pack.name}」v${pack.version}：` +
        plan.map((p) => `${p.section} ${p.currentChars} 字 → ${p.packChars} 字`).join('；') +
        (result.overwritesUserContent ? '（现有内容不是默认占位，会被覆盖；安装前自动备份，可卸载恢复）' : '（现有内容是默认占位，不会丢失任何东西）') +
        '。确认请再调一次带 confirm:true。'
    }
  }

  /* ---- 1) 备份现有 identity / persona ---- */
  const dir = path.join(backupRoot(store, options), `${pack.id}-${stampDir()}`)
  await fsp.mkdir(dir, { recursive: true })
  const meta = {
    id: pack.id,
    name: pack.name,
    packVersion: pack.version,
    installedAt: nowIso(),
    primaryPath: store.primaryPath ?? '',
    mirrorPath: store.mirrorPath ?? '',
    sections: {}
  }
  for (const name of PACK_SECTIONS) {
    const current = normalizeBody(before.sections?.[name] ?? '')
    await fsp.writeFile(path.join(dir, `${name}.md`), current, 'utf8')
    meta.sections[name] = {
      chars: current.length,
      hash: hashText(current),
      wasDefault: name === 'identity' ? isDefaultIdentity(current) : isDefaultPersona(current)
    }
  }
  await fsp.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  result.backupDir = dir

  /* ---- 2) 逐分区写入 ---- */
  for (const item of plan) {
    try {
      const r = await store.setSection(item.section, pack.contents[item.section])
      if (r?.changed === false) result.skipped.push(`${item.section}（内容已相同）`)
      else result.written.push(item.section)
    } catch (error) {
      result.error = `${item.section}: ${error?.message ?? error}`
      break
    }
  }

  /* ---- 3) 记账 ---- */
  const state = await readState(store, options)
  state.version = 1
  state.packs = state.packs ?? {}
  state.packs[pack.id] = {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    installedAt: nowIso(),
    backupDir: dir,
    sections: result.written.slice(),
    overwrote: plan.filter((p) => p.overwritesUserContent).map((p) => p.section)
  }
  await writeState(store, state, options)

  result.ok = !result.error
  result.message =
    (result.ok ? `已安装「${pack.name}」v${pack.version}` : `安装「${pack.name}」未完成`) +
    `：写入 ${(result.written.length ? result.written : ['（无）']).join('、')}` +
    (result.skipped.length ? `；跳过 ${result.skipped.join('、')}` : '') +
    `；备份在 ${dir}`
  return result
}

/**
 * 卸载：从安装时的备份恢复 identity / persona；没有备份就恢复默认占位。
 * 卸载本身之前也会再备份一次（防止"备份被删了 → 卸载即永久丢失"）。
 */
export async function uninstallPack(store, id, options = {}) {
  if (!store) throw new Error('uninstallPack 需要 store')
  const safe = String(id ?? '').trim()
  if (!ID_RE.test(safe)) throw new Error(`非法的记忆包 id：${id}`)
  if (typeof store.reload === 'function') await store.reload(true)

  const state = await readState(store, options)
  const record = state.packs?.[safe] ?? null
  const before = store.view()

  const restored = []
  const defaults = []
  const missing = []

  for (const name of PACK_SECTIONS) {
    const backupFile = record?.backupDir ? path.join(record.backupDir, `${name}.md`) : ''
    let body = backupFile ? await readTextIfExists(backupFile) : null
    if (body !== null && body !== undefined) {
      restored.push(name)
    } else {
      body = name === 'identity' ? DEFAULT_IDENTITY_TEXT : DEFAULT_PERSONA
      defaults.push(name)
      if (record?.backupDir) missing.push(name)
    }
    const current = normalizeBody(before.sections?.[name] ?? '')
    if (current === normalizeBody(body)) continue
    try {
      await store.setSection(name, body)
    } catch (error) {
      throw new Error(`恢复 ${name} 失败：${error?.message ?? error}`)
    }
  }

  if (state.packs) delete state.packs[safe]
  await writeState(store, state, options)

  return {
    ok: true,
    id: safe,
    restoredFromBackup: restored,
    restoredToDefault: defaults,
    backupMissing: missing,
    backupDir: record?.backupDir ?? '',
    message:
      `已卸载「${record?.name ?? safe}」：` +
      (restored.length ? `从备份恢复 ${restored.join('、')}` : '没有可用备份') +
      (defaults.length ? `；${defaults.join('、')} 已复位为默认占位` : '')
  }
}
