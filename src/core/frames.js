// 通用抽帧：ffmpeg 直接从视频地址按时间点截一帧 JPEG（走 stdout，不落盘）。
//
// B 站和抖音都用这一套，差别只在请求头：各家 CDN 认的 Referer / User-Agent 不一样，
// 由调用方把 `-headers` 那一行拼好传进来。失败一律返回 null，不抛。

import { spawn } from 'node:child_process'

/** 抽帧时间点（秒）：跳过开头结尾各 5%，中间均匀铺开。 */
export function frameTimes(durationSec, count) {
  const d = Number(durationSec) || 0
  if (!Number.isFinite(d) || !(d > 0)) return []
  const n = Math.max(1, Math.min(12, Math.round(Number(count) || 6)))
  const out = []
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 0.5 : 0.05 + (0.9 * i) / (n - 1)
    out.push(Math.min(Math.max(0, Math.round(d * p)), Math.max(0, Math.floor(d) - 1)))
  }
  return [...new Set(out)]
}

/**
 * 从流里抽一帧（JPEG）。失败返回 null，不抛。
 * @param {string} ffmpeg ffmpeg 可执行文件
 * @param {string} url 视频地址（http/https）
 * @param {number} at 第几秒
 * @param {{width?:number, timeoutMs?:number, maxBytes?:number, headers?:string}} [o]
 *   headers 原样交给 ffmpeg 的 `-headers`，形如 "Referer: https://…\r\nUser-Agent: …\r\n"
 */
export function grabFrame(ffmpeg, url, at, { width = 512, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, headers = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    let proc
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        // 不开 -headers 的话 B 站 / 抖音的 CDN 会 403
        ...(headers ? ['-headers', headers] : []),
        '-rw_timeout', String(timeoutMs * 1000),
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-ss', String(at), '-i', url,
        '-frames:v', '1', '-an', '-vf', `scale=${width}:-2`,
        '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ], { windowsHide: true })
    } catch (error) {
      return finish(null)
    }
    const out = []
    let bytes = 0
    const stop = () => { try { proc.kill() } catch (error) {} finish(null) }
    timer = setTimeout(stop, timeoutMs)
    proc.stdout.on('data', (d) => {
      if (settled) return
      bytes += d.length
      if (bytes > maxBytes) return stop()
      out.push(d)
    })
    proc.stderr.on('data', () => {}) // 只用来占位，别让管道堵住
    proc.on('error', () => { clearTimeout(timer); finish(null) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const buf = Buffer.concat(out)
      finish(code === 0 && buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null)
    })
  })
}
