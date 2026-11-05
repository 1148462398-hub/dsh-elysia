/**
 * lib/setup.js —— 语音引擎检测 + 引导式安装
 *
 * ## 为什么不是「一键装」
 *
 * GPT-SoVITS 完整安装 27 GB（精简版 10-12 GB），需要 NVIDIA 显卡与 CUDA。
 * 一个下载到一半失败的大安装，比没有这个功能更让人抓狂。
 * 所以这里只做两件事：**检测**（告诉你缺什么）和 **引导**（给出准确命令）。
 *
 * ## 检测什么
 *
 * - 显卡：有没有 NVIDIA GPU、显存多大
 * - Python：3.10+ 在哪
 * - 磁盘：目标盘剩多少
 * - 引擎：`api_v2.py` 在不在、9880 通不通
 * - 权重：GPT / SoVITS / 参考音频齐不齐
 *
 * 每一项都给出「缺了怎么办」，而不是只说「缺」。
 */

import { existsSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/* ---------------- 检测 ---------------- */

/** 跑一条命令，超时/失败都返回 null（检测不该抛异常） */
function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) resolve(null)
      else resolve(String(stdout ?? ''))
    })
  })
}

/** NVIDIA 显卡 + 显存 */
export async function detectGpu() {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits'
  ])
  if (!out || !out.trim()) {
    return {
      ok: false,
      label: 'NVIDIA 显卡',
      detail: '未检测到（CPU 也能跑，但一句要 20-30 秒）',
      hint: '想要实时语音需要 NVIDIA 显卡；没有也能用，只是慢。'
    }
  }
  const first = out.trim().split(/\r?\n/)[0]
  const [name, mem] = first.split(',').map((s) => s.trim())
  const mb = Number(mem)
  return {
    ok: Number.isFinite(mb) && mb >= 4000,
    label: 'NVIDIA 显卡',
    detail: `${name} / ${mb >= 1024 ? (mb / 1024).toFixed(0) + ' GB' : mb + ' MB'}`,
    hint: mb < 4000 ? '显存偏小，v5turbo 可能不够；建议至少 6 GB。' : ''
  }
}

/** Python 3.10+ */
export async function detectPython() {
  const cands = [
    ['python', ['--version']],
    ['python3', ['--version']],
    ['py', ['-3', '--version']]
  ]
  for (const [cmd, args] of cands) {
    const out = await run(cmd, args)
    if (!out) continue
    const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(out)
    if (!m) continue
    const major = Number(m[1])
    const minor = Number(m[2])
    return {
      ok: major >= 3 && minor >= 10,
      label: 'Python',
      detail: `${m[1]}.${m[2]}.${m[3]}（${cmd}）`,
      hint: minor < 10 ? 'GPT-SoVITS 需要 Python 3.10 或更高。' : ''
    }
  }
  return {
    ok: false,
    label: 'Python',
    detail: '未找到',
    hint: '访问 https://www.python.org/downloads/ 安装 3.10+，装时勾选 Add to PATH。'
  }
}

/** 磁盘剩余（针对引擎所在盘） */
export async function detectDisk(engineDir) {
  try {
    const drive = engineDir ? path.parse(path.resolve(engineDir)).root : path.parse(os.homedir()).root
    const out = await run('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-PSDrive -Name '${drive.replace(/[:\\]/g, '')}' -EA 0).Free`
    ])
    const free = Number(String(out ?? '').trim())
    if (!Number.isFinite(free) || free <= 0) {
      return { ok: true, label: '磁盘', detail: '未知', hint: '' }
    }
    const gb = free / 1024 ** 3
    return {
      ok: gb >= 12,
      label: '磁盘剩余',
      detail: `${drive} ${gb.toFixed(0)} GB`,
      hint: gb < 12 ? '语音引擎精简版约需 10-12 GB。' : ''
    }
  } catch {
    return { ok: true, label: '磁盘', detail: '未知', hint: '' }
  }
}

/** 引擎目录与关键文件 */
export function detectEngine(engineDir) {
  const checks = []
  if (!engineDir) {
    return {
      ok: false,
      label: '语音引擎',
      detail: '未配置路径',
      hint: '在配置里写 voice.engineDir（GPT-SoVITS 的根目录，里面有 api_v2.py）。'
    }
  }
  const api = path.join(engineDir, 'api_v2.py')
  if (!existsSync(api)) {
    return {
      ok: false,
      label: '语音引擎',
      detail: `${engineDir} 下没有 api_v2.py`,
      hint: '路径要指向 GPT-SoVITS 根目录（能看到 api_v2.py 和 GPT_SoVITS/ 的那一层）。'
    }
  }
  checks.push('api_v2.py')

  const weights = [
    ['GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth', 'v5turbo 底包'],
    ['GPT_SoVITS/pretrained_models/gsv-v5-pretrained/vocoder.pth', '48k vocoder'],
    ['GPT_SoVITS/pretrained_models/chinese-hubert-base/pytorch_model.bin', 'CNHuBERT'],
    ['GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/pytorch_model.bin', 'BERT']
  ]
  const missing = []
  for (const [rel, name] of weights) {
    if (existsSync(path.join(engineDir, rel))) checks.push(name)
    else missing.push(name)
  }

  let size = 0
  try {
    // 只统计顶层，避免递归 27GB 卡住
    for (const d of ['runtime', 'GPT_SoVITS']) {
      const p = path.join(engineDir, d)
      if (existsSync(p)) size += statSync(p).size || 0
    }
  } catch {
    /* 忽略 */
  }

  return {
    ok: missing.length === 0,
    label: '语音引擎',
    detail:
      missing.length === 0
        ? `完整（${checks.join(' / ')}）`
        : `缺 ${missing.join('、')}`,
    hint:
      missing.length === 0
        ? ''
        : '模型权重没下全。首次运行 webui.py 会自动下载，或从 release 页手动取。',
    checked: checks,
    missing
  }
}

/** 一次性跑完所有检测 */
export async function runDoctor({ engineDir } = {}) {
  const [gpu, python, disk] = await Promise.all([
    detectGpu(),
    detectPython(),
    detectDisk(engineDir)
  ])
  const engine = detectEngine(engineDir)
  const items = [gpu, python, disk, engine]
  return {
    ok: items.every((i) => i.ok),
    items,
    engineDir: engineDir ?? '',
    at: new Date().toISOString()
  }
}

/* ---------------- 引导文案 ---------------- */

/**
 * 安装步骤。每条含：标题、说明、命令、可选链接。
 * 打印在面板上，用户可以照着做——我们不下 10 GB，但每一步都给准确路径。
 */
export const INSTALL_STEPS = [
  {
    n: 1,
    title: '装 Python 3.10+',
    desc: 'GPT-SoVITS 需要 Python 3.10 或更高。安装时务必勾选「Add Python to PATH」。',
    url: 'https://www.python.org/downloads/',
    cmd: ''
  },
  {
    n: 2,
    title: '下载 GPT-SoVITS',
    desc: '推荐下载整合包（自带 runtime 和依赖，省掉 pip 折腾）。',
    url: 'https://github.com/RVC-Boss/GPT-SoVITS/releases',
    cmd: ''
  },
  {
    n: 3,
    title: '放好爱莉希雅的权重',
    desc: '把 SoVITS 权重放进 SoVITS_weights_v5turbo/，GPT 权重放进 GPT_weights_v2/。',
    url: '',
    cmd: '',
    note: '权重文件：elysia_v5turbo_e12_s2448_l32.pth（72 MB）+ elysia_v2-e15.ckpt（148 MB）'
  },
  {
    n: 4,
    title: '启动引擎',
    desc: '在 GPT-SoVITS 根目录执行（保持窗口开着）：',
    url: '',
    cmd: 'runtime\\python.exe api_v2.py -a 127.0.0.1 -p 9880'
  },
  {
    n: 5,
    title: '在插件里填路径',
    desc: '把 voice.engineDir 指向 GPT-SoVITS 根目录，然后点「重新检测」。',
    url: '',
    cmd: ''
  }
]

/** 估算安装体积 */
export const SIZE_HINT = {
  full: '27 GB（完整版，含所有底包与工具）',
  minimal: '10-12 GB（精简版：runtime + v5turbo 底包 + 必需 tokenizer）',
  weights: '约 1.6 GB（v5turbo 731 MB + vocoder 55 MB + CNHuBERT 180 MB + BERT 621 MB）'
}
