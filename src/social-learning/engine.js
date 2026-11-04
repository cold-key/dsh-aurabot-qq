// 浏览学习的纯逻辑：来源绑定、输出校验、时效、召回与缓慢变化的兴趣。
import { createHash } from 'node:crypto'
import { tokenize, similarity } from '../features/memory.js'
import { redact } from '../core/redact.js'

export const DEFAULT_LEARNING = {
  mode: 'legacy', sources: { bili: true, douyin: true },
  dailyMax: 8, maxInputChars: 16000, maxRecords: 2000,
  affectInterests: true, affectMood: true, purpose: true,
  knowledgeDays: 90, memeDays: 30, topicalDays: 7,
}
export const DAY = 86400_000
const number = (v, d, lo, hi) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d
export const clip = (s, n = 200) => redact(String(s ?? '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n)
export const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24)
export const dayKey = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)

export function normalizeLearning(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    mode: ['legacy', 'structured', 'off'].includes(r.mode) ? r.mode : 'legacy',
    sources: { bili: r.sources?.bili !== false, douyin: r.sources?.douyin !== false },
    dailyMax: number(r.dailyMax, 8, 0, 100), maxInputChars: number(r.maxInputChars, 16000, 2000, 16000),
    maxRecords: number(r.maxRecords, 2000, 50, 2000),
    affectInterests: r.affectInterests !== false, affectMood: r.affectMood !== false, purpose: r.purpose !== false,
    knowledgeDays: number(r.knowledgeDays, 90, 1, 365), memeDays: number(r.memeDays, 30, 1, 90), topicalDays: number(r.topicalDays, 7, 1, 30),
  }
}
export const learningConfig = (cfg) => normalizeLearning(cfg?.ext?.['social-learning'])

/** 链接由平台和内容 ID 构造，不接受模型提供的来源。 */
export function normalizeBatch(raw, now = Date.now(), maxChars = 16000) {
  if (!raw || !['bili', 'douyin'].includes(raw.platform) || !Array.isArray(raw.items)) return null
  let room = maxChars
  const seen = new Set()
  const items = []
  for (const value of raw.items.slice(0, 10)) {
    if (room < 100) break
    if (!value) continue
    const id = clip(value.id, 32)
    if (!(raw.platform === 'bili' ? /^BV[\da-zA-Z]{10}$/.test(id) : /^\d{5,25}$/.test(id))) continue
    const allowed = ['title', 'description', 'subtitle', 'comments', 'vision', 'summary', 'chapters']
    const sections = (Array.isArray(value.sections) ? value.sections : []).slice(0, 7)
      .filter((s) => allowed.includes(s?.kind)).map((s) => ({ kind: s.kind, text: clip(s.text, 8000) })).filter((s) => s.text)
    const text = clip(sections.length ? sections.map((s) => s.text).join('\n') : value.text, Math.min(8000, room))
    if (!text || seen.has(id)) continue
    seen.add(id)
    const kinds = [...new Set(sections.length ? sections.map((s) => s.kind) : (Array.isArray(value.kinds) ? value.kinds : []).filter((k) => allowed.includes(k)))]
    if (!kinds.length) continue
    const item = {
      id, title: clip(value.title, 160), author: clip(value.author, 80), text, kinds, sections,
      url: raw.platform === 'bili' ? `https://www.bilibili.com/video/${id}` : `https://www.douyin.com/video/${id}`,
      publishedAt: number(value.publishedAt, 0, 0, now), observedAt: now,
    }
    items.push(item)
    // 限制最终 JSON 输入长度，计入来源元数据、分段与转义字符。
    while (JSON.stringify({ platform: raw.platform, items }).length + 80 > maxChars && item.text.length) {
      item.text = item.text.slice(0, -100)
      let left = item.text.length
      item.sections = sections.map((s) => {
        const text = s.text.slice(0, Math.max(0, left))
        left -= text.length + 1
        return { kind: s.kind, text }
      }).filter((s) => s.text)
    }
    if (!item.text) { items.pop(); break }
    item.fingerprint = hash(JSON.stringify([raw.platform, id, item.text, item.sections, [...kinds].sort()]))
    room = maxChars - JSON.stringify({ platform: raw.platform, items }).length
  }
  if (!items.length) return null
  return { id: hash(raw.platform + items.map((x) => x.fingerprint).sort().join('|')), platform: raw.platform, at: now, origin: raw.origin === 'watch' ? 'watch' : 'browse', items }
}

const strings = (xs, count = 6, length = 40) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => clip(x, length)).filter(Boolean))].slice(0, count)

/** 证据必须是实际输入的连续摘录；评论 / 标题不能单独支撑知识事实。 */
export function parseLearning(raw, batch, config, now = Date.now()) {
  const body = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.records)) throw new Error('学习结果不是有效的 records 对象')
  const records = []
  for (const r of parsed.records.slice(0, 6)) {
    if (!r || !['knowledge', 'meme'].includes(r.kind) || !Array.isArray(r.evidence)) continue
    const evidence = []
    for (const e of r.evidence.slice(0, 8)) {
      const item = batch.items.find((x) => x.id === String(e?.sourceId))
      const quote = clip(e?.quote, 300)
      if (!item || quote.length < 4 || !item.text.includes(quote)) continue
      if (r.kind === 'knowledge' && !item.kinds.some((k) => ['description', 'subtitle', 'summary', 'chapters', 'vision'].includes(k))) continue
      if (r.kind === 'knowledge' && item.sections?.length && !item.sections.some((s) => ['description', 'subtitle', 'summary', 'chapters', 'vision'].includes(s.kind) && s.text.includes(quote))) continue
      evidence.push({ platform: batch.platform, sourceId: item.id, url: item.url, title: item.title, quote, kinds: item.kinds, observedAt: now, publishedAt: item.publishedAt, batchId: batch.id })
    }
    const title = clip(r.title, 80)
    const text = clip(r.text, 800)
    if (!title || !text || !evidence.length) continue
    const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0))
    const usage = clip(r.usage, 240)
    const example = clip(r.example, 160)
    const avoid = clip(r.avoid, 200)
    const evidenceCount = new Set(evidence.map((e) => e.platform + ':' + e.sourceId)).size
    const active = confidence >= 0.8 && (r.kind === 'knowledge' || (usage && example && evidenceCount >= 2))
    const days = r.topical === true ? config.topicalDays : r.kind === 'meme' ? config.memeDays : config.knowledgeDays
    // 旧内容不因今天重新读取而变成刚发生的新闻。
    const published = evidence.map((e) => e.publishedAt).filter(Boolean)
    const anchor = r.topical === true && published.length ? Math.max(...published) : now
    records.push({ kind: r.kind, title, text, aliases: strings(r.aliases), tags: strings(r.tags), usage, example, avoid,
      confidence, status: active ? 'active' : 'candidate', evidence, evidenceStatus: evidenceCount > 1 ? 'corroborated' : 'single-source',
      topical: r.topical === true, firstSeenAt: now, evidenceAt: now, expiresAt: anchor + days * DAY, uses: 0, lastUsedAt: 0,
      fingerprint: hash(r.kind + ':' + title.toLowerCase()),
    })
  }
  const interests = []
  for (const r of (Array.isArray(parsed.interests) ? parsed.interests : []).slice(0, 6)) {
    const topic = clip(r?.topic, 30)
    const ids = strings(r?.sourceIds, 10, 32).filter((id) => batch.items.some((x) => x.id === id))
    if (topic && ids.length && Number(r.confidence) >= 0.8) interests.push({ topic, sourceIds: ids, value: Number(r.value) < 0 ? -1 : 1 })
  }
  const mood = parsed.mood
  return { records, interests, moodDelta: Number(mood?.confidence) >= 0.8 ? Math.min(2, Math.max(-2, Math.round(Number(mood.delta) || 0))) : 0, moodReason: clip(mood?.reason, 80) }
}

export function usable(record, now) {
  return record.status === 'active' && (record.pinned || record.expiresAt > now)
}

export function searchLearning(records, query, now, { limit = 3, maxChars = 800 } = {}) {
  const q = new Set(tokenize(clip(query, 1000)))
  if (!q.size) return []
  const ranked = records.filter((r) => usable(r, now)).map((r) => {
    const terms = new Set(tokenize([r.title, r.text, ...(r.aliases || []), ...(r.tags || []), r.usage].join(' ')))
    let hits = 0
    for (const t of q) if (terms.has(t)) hits++
    const recentPenalty = r.kind === 'meme' && now - r.lastUsedAt < DAY ? 0.15 : 1
    return { record: r, score: hits / Math.sqrt(q.size) * recentPenalty }
  }).filter((r) => r.score >= 0.6).sort((a, b) => b.score - a.score)
  const picked = []
  let chars = 0
  let meme = false
  for (const { record } of ranked) {
    if (picked.length >= limit) break
    if (record.kind === 'meme' && meme) continue
    const line = learningLine(record)
    if (chars + line.length > maxChars) continue
    picked.push(record)
    chars += line.length
    meme ||= record.kind === 'meme'
  }
  return picked
}

export function learningLine(r) {
  const proof = r.ownerEdited ? '主人已校订' : r.evidenceStatus === 'corroborated' ? '多个内容来源提及，仍非事实核验' : '单来源说法，未核实'
  return `#${r.id} ${r.kind === 'meme' ? '表达' : '知识'}「${r.title}」：${r.text.slice(0, r.kind === 'meme' ? 180 : 280)}（${proof}；记录于 ${new Date(r.evidenceAt).toISOString().slice(0, 10)}）` +
    (r.kind === 'meme' ? ` 情境：${r.usage.slice(0, 80)}；例：${r.example.slice(0, 60)}；避免：${(r.avoid || '无关时不要硬用').slice(0, 60)}。只是可选表达，不要照搬或频繁使用。` : '') +
    ` 来源：${r.evidence[0]?.url || ''}`
}

export function similarRecord(a, b) {
  return a.kind === b.kind && (a.fingerprint === b.fingerprint || similarity(a.text, b.text) >= 0.85 || (similarity(a.title, b.title) >= 0.75 && similarity(a.text, b.text) >= 0.75))
}

export function interestScore(r, now) {
  return (r.score || 0) * Math.pow(0.5, Math.max(0, now - r.at) / (14 * DAY))
}
export function activeInterests(interests, now) {
  return Object.values(interests).filter((r) => new Set(r.evidence.map((e) => e.source)).size >= 3 && new Set(r.evidence.map((e) => e.batch)).size >= 2)
    .map((r) => ({ ...r, score: interestScore(r, now) })).filter((r) => Math.abs(r.score) > 0.02).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 10)
}
