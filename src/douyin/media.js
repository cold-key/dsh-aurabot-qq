// 抖音的「看画面」和「听声音」——两条可选旁路，失败一律当没读到，不影响原来的文字流程。
//
// 画面：ffmpeg 从 video.play_addr 里按时间点抽几帧，交给视觉模型描述（和 B 站那套一样，抽帧在 core/frames.js）。
// 声音：先看抖音有没有自带字幕（video.cla_info.caption_infos，免费、秒回）；没有就把音频交给本机语音识别
//       （DSH 自带 SenseVoice，或者用户自己接的 ASR）。
//
// 视频地址和字幕地址都是页面接口里的（带登录态），但下载 / 解码由 Node 直接发，不碰浏览器。

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameTimes, grabFrame } from '../core/frames.js'
import { findFfmpeg } from '../core/img.js'
import { askModel, canSeeImages } from '../core/llm.js'
import { assertPublicUrl } from '../core/net.js'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
/** 抖音的 CDN 要 Referer，否则 403。 */
export const HEADERS = `Referer: https://www.douyin.com/\r\nUser-Agent: ${UA}\r\n`

const MAX_TRANSCRIPT = 2000
const MAX_VISION = 900

const clip = (t, max = MAX_TRANSCRIPT) => [...String(t ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')
const urlsOf = (list) => (Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))

/** 从接口原始数据里挑一路能播的视频地址；图文 / 直播 / 没地址返回 ''。 */
export function pickPlayUrl(a) {
  if (!a || typeof a !== 'object') return ''
  if (typeof a.playUrl === 'string' && /^https?:\/\//i.test(a.playUrl)) return a.playUrl
  const v = a.video || a
  const direct = urlsOf(v.play_addr && v.play_addr.url_list)
  if (direct.length) return direct[0]
  // 有的只给分档的 bit_rate，每档各带一个 play_addr
  for (const b of Array.isArray(v.bit_rate) ? v.bit_rate : []) {
    const u = urlsOf(b && b.play_addr && b.play_addr.url_list)
    if (u.length) return u[0]
  }
  return ''
}

/** 抖音自带字幕（AI 字幕）：[{ lang, url }]。没有就是空数组。 */
export function captionTracks(a) {
  if (!a || typeof a !== 'object') return []
  const info = (a.video && a.video.cla_info) || a.cla_info || a.caption_info || {}
  return (Array.isArray(info.caption_infos) ? info.caption_infos : [])
    .map((c) => ({
      lang: String((c && (c.lang || c.language)) || '').trim().toLowerCase(),
      url: String((c && (c.url || c.caption_url)) || '').trim(),
    }))
    .filter((c) => /^https?:\/\//i.test(c.url))
}

/**
 * 字幕正文 → 一段连续的文字。
 * 抖音给的是 JSON（{"utterances":[{"text":…}]}），也兼容 SRT / VTT 和纯文本。
 */
export function parseCaption(text) {
  const s = String(text || '').trim()
  if (!s) return ''
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const j = JSON.parse(s)
      const items = Array.isArray(j) ? j : j.utterances || j.captions || j.body || j.data || []
      const lines = (Array.isArray(items) ? items : [])
        .map((x) => String((x && (x.text ?? x.content ?? x.utterance ?? x.caption)) || '').trim())
        .filter(Boolean)
      return lines.length ? clip(lines.join('')) : '' // 是 JSON 但没句子：当没字幕，别把 JSON 原样塞进去
    } catch (error) {}
  }
  if (/-->/.test(s) || /^WEBVTT/.test(s)) {
    const lines = s.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/-->/.test(l) && !/^\d+$/.test(l) && !/^WEBVTT/.test(l))
    return clip(lines.join(''))
  }
  return clip(s)
}

/** 拉一段自带字幕；优先中文轨。拿不到返回 ''。 */
export async function fetchCaption(tracks, { fetchImpl = fetch, log } = {}) {
  const list = (Array.isArray(tracks) ? tracks : []).filter((t) => t && t.url)
  if (!list.length) return ''
  const pick = list.find((t) => /zh|chi|cn/i.test(t.lang)) || list[0]
  try {
    const r = await fetchImpl(pick.url, { headers: { referer: 'https://www.douyin.com/', 'user-agent': UA }, signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return parseCaption(await r.text())
  } catch (error) {
    log?.debug('抖音字幕没拿到：', error.message)
    return ''
  }
}

const SYSTEM = '你在看一个抖音短视频的几张截图（手机竖屏，可能有黑边）。只写画面上确实能看到的东西：场景、人物、物体、动作、字幕条 / 贴纸 / 画面里的文字。不要猜剧情，不要编造没出现的内容，不要发表感想。用 3~6 句中文写。'

/**
 * 把几帧交给视觉模型，换一段画面描述。
 * 思考强度关掉：描述画面用不上推理，开着会把 token 先花在思考上，正文可能是空的（实测有视频没描述）。
 * 万一还是空，就加大预算再来一次；两次都空就算了，不让这一条拖住整轮。
 */
export async function describeFrames(dsh, { info, frames, cfg, log } = {}) {
  const images = frames.map((f) => ({ data: f.toString('base64'), mediaType: 'image/jpeg' }))
  const ask = (maxTokens) => askModel(dsh, {
    cfg,
    system: SYSTEM,
    text: `这些截图来自抖音短视频《${info.title || '（无标题）'}》（作者 ${info.author || '?'}，时长 ${Math.round(Number(info.duration) || 0)} 秒），按时间先后排列，大致分布在全片 5%~95% 的位置。\n把它们当成「我看到了什么」如实记下来。`,
    images,
    maxTokens,
    temperature: 0.3,
    reasoningEffort: 'off',
  })
  let text = await ask(1200)
  if (!String(text || '').trim()) {
    log?.debug('看画面：第一次没写出描述，加大预算重试一次')
    text = await ask(1800)
  }
  const out = clip(text, MAX_VISION)
  if (!out) log?.debug('看画面：模型两次都没给出描述')
  return out
}

/**
 * 抽音频转成 16kHz 单声道 WAV（先写临时文件再读回来：管道里的 WAV 头长度是占位值，
 * 有的识别器会当成坏文件）。失败返回 null，不抛。
 */
export function extractAudio(ffmpeg, url, { maxSeconds = 120, timeoutMs = 90000, headers = HEADERS } = {}) {
  return new Promise((resolve) => {
    let dir = ''
    try { dir = mkdtempSync(join(tmpdir(), 'aurabot-dy-asr-')) } catch (error) { return resolve(null) }
    const out = join(dir, 'audio.wav')
    let settled = false
    let timer
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
      resolve(v)
    }
    let proc
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...(headers ? ['-headers', headers] : []),
        '-rw_timeout', String(timeoutMs * 1000),
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-i', url,
        '-t', String(Math.max(1, Math.round(maxSeconds))),
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', out,
      ], { windowsHide: true })
    } catch (error) {
      return finish(null)
    }
    timer = setTimeout(() => { try { proc.kill() } catch (error) {} finish(null) }, timeoutMs)
    proc.stdout.on('data', () => {})
    proc.stderr.on('data', () => {}) // 只用来占位，别让管道堵住
    proc.on('error', () => finish(null))
    proc.on('close', (code) => {
      if (code !== 0) return finish(null)
      try {
        const buf = readFileSync(out)
        finish(buf.length > 1000 ? buf : null)
      } catch (error) {
        finish(null)
      }
    })
  })
}

/** 抽音频 → 本机语音识别。没开 / 模型没准备好 / 出错都返回 ''。 */
export async function transcribeAudio({ stt, ffmpeg, url, maxSeconds = 120, log, deps = {} }) {
  if (!stt || !ffmpeg || !url) return ''
  try {
    // 模型还没准备好：顺手催一下下载，这一条先放弃
    const snap = typeof stt.snapshot === 'function' ? stt.snapshot() : null
    const pid = snap && snap.selection && snap.selection.providerId
    const prov = (snap && snap.providers || []).find((p) => p.id === pid)
    if (prov && prov.preparation && !['ready', 'standby'].includes(prov.preparation.phase)) {
      try { stt.prepare(pid) } catch (error) {}
      log?.debug(`语音识别模型还没准备好（${prov.preparation.phase}）`)
      return ''
    }
    const wav = await (deps.extractAudio || extractAudio)(ffmpeg, url, { maxSeconds })
    if (!wav) {
      log?.debug('抖音音频没抽出来')
      return ''
    }
    const spec = stt.resolve({ audio: new Uint8Array(wav) })
    const r = await stt.transcribe(spec, AbortSignal.timeout(120000))
    return clip(typeof r === 'string' ? r : (r && (r.text || r.transcript)) || '')
  } catch (error) {
    log?.debug('抖音语音识别失败：', error.message)
    return ''
  }
}

/** 听声音：自带字幕优先，没字幕（且开了 auto）才抽音频识别。 */
async function hear({ dsh, c, mode, info, url, ffmpeg, log, deps }) {
  if (info.captions && info.captions.length) {
    const text = await (deps.fetchCaption || fetchCaption)(info.captions, { log })
    if (text) return text
  }
  if (mode !== 'auto' || !ffmpeg) {
    if (mode === 'auto' && !ffmpeg) log?.debug('听声音跳过：没找到 ffmpeg，没法抽音频')
    return ''
  }
  let stt = deps.stt
  if (!stt && dsh && typeof dsh.get === 'function') stt = dsh.get('speechToText')
  if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') {
    log?.debug('听声音跳过：宿主没开语音输入')
    return ''
  }
  return (deps.transcribeAudio || transcribeAudio)({ stt, ffmpeg, url, maxSeconds: c.asrMaxSeconds, log, deps })
}

/** 看画面：抽几帧交给视觉模型。 */
async function see({ dsh, cfg, c, info, url, ffmpeg, log, deps }) {
  if (!dsh) return ''
  if (!ffmpeg) {
    log?.debug('看画面跳过：没找到 ffmpeg')
    return ''
  }
  if (await (deps.canSeeImages || canSeeImages)(dsh, cfg) === false) {
    log?.debug('看画面跳过：当前模型不支持图片')
    return ''
  }
  const times = frameTimes(info.duration, c.visionFrames)
  if (!times.length) return ''
  const frames = []
  const deadline = Date.now() + 45_000 // 整段抽帧最多 45 秒，别让坏流把一轮拖死
  for (const t of times) {
    const left = deadline - Date.now()
    if (left <= 0) break
    const buf = await (deps.grabFrame || grabFrame)(ffmpeg, url, t, { width: 480, timeoutMs: Math.min(15000, left), headers: HEADERS })
    if (buf) frames.push(buf)
  }
  if (!frames.length) {
    log?.debug('看画面跳过：一帧都没抽出来')
    return ''
  }
  const text = await (deps.describeFrames || describeFrames)(dsh, { info, frames, cfg, log })
  if (text) log?.debug(`看画面：${frames.length} 帧 → ${String(text).length} 字`)
  return text
}

/**
 * 看画面 + 听声音。两件事并行做（互不依赖），任何一件失败都只是那一项空着。
 * @returns {Promise<{transcript:string, vision:string}>}
 */
export async function lookAt({ dsh, cfg, info, log, deps = {} }) {
  const empty = { transcript: '', vision: '' }
  if (!info) return empty
  const root = cfg || {}
  const c = root.douyin || {}
  const mode = ['caption', 'auto'].includes(c.transcript) ? c.transcript : 'off'
  const wantVision = Boolean(c.vision)
  if (mode === 'off' && !wantVision) return empty
  const url = pickPlayUrl(info)
  if (!url) {
    log?.debug('看画面 / 听声音跳过：没有可用的视频地址')
    return empty
  }
  const ffmpegPath = c.ffmpegPath || (root.bili && root.bili.ffmpegPath) || ''
  const ffmpeg = (deps.findFfmpeg || findFfmpeg)(ffmpegPath)
  try {
    await (deps.assertPublicUrl || assertPublicUrl)(url)
  } catch (error) {
    log?.debug('看画面 / 听声音跳过：地址不可用（', error.message, '）')
    return empty
  }
  const base = { dsh, cfg: root, c, info, url, ffmpeg, log, deps }
  const jobs = []
  if (mode !== 'off') jobs.push(hear({ ...base, mode }).catch((error) => { log?.debug('听声音失败：', error.message); return '' }))
  if (wantVision) jobs.push(see(base).catch((error) => { log?.debug('看画面失败：', error.message); return '' }))
  const [transcript = '', vision = ''] = await Promise.all(jobs)
  return { transcript: clip(transcript, MAX_TRANSCRIPT), vision: clip(vision, MAX_VISION) }
}

/** 面板用：本机能不能抽帧 / 听声音。 */
export function mediaState(cfg, dsh) {
  const root = cfg || {}
  const c = root.douyin || {}
  const ffmpeg = findFfmpeg(c.ffmpegPath || (root.bili && root.bili.ffmpegPath) || '')
  let asr = false
  try {
    const s = dsh && typeof dsh.get === 'function' ? dsh.get('speechToText') : null
    asr = Boolean(s && typeof s.resolve === 'function' && typeof s.transcribe === 'function')
  } catch (error) {}
  return {
    ffmpeg: Boolean(ffmpeg),
    asr,
    vision: Boolean(c.vision),
    transcript: ['caption', 'auto'].includes(c.transcript) ? c.transcript : 'off',
  }
}
