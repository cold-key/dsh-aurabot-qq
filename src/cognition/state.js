// 固定模型下的学习状态。概念由经历形成，不限定为固定的人格维度。
import { createHash } from 'node:crypto'
import { redact } from '../core/redact.js'

export const text = (v, max = 400) => redact(typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max)
export const keyOf = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24)
export const bounded = (v, fallback = 0, min = 0, max = 1) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback
export const terms = (v) => String(v || '').toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]/g) || []
export function relevance(query, value) {
  const words = [...new Set(terms(query))], hay = new Set(terms(value))
  return words.length ? words.filter((w) => hay.has(w)).length / words.length : 0
}
export function emptyMind() {
  return { version: 1, revision: 0, models: [], motives: [], beliefs: [], strategies: [], skills: [], episodes: [], decisions: [], experiments: [],
    applied: [], lastLearningAt: 0, modelFingerprint: '', counters: { outcomes: 0, predictionError: 0, surprises: 0 } }
}
export function ensureMind(profile) {
  if (!profile.mind) profile.mind = emptyMind()
  const m = profile.mind
  if (m.version !== 1) throw new Error('认知状态版本不兼容，保留原档案')
  if (!Number.isInteger(m.revision) || m.revision < 0 || !m.counters || ['outcomes', 'predictionError', 'surprises'].some((k) => !Number.isFinite(m.counters[k]) || m.counters[k] < 0)) throw new Error('认知统计结构损坏，保留原档案')
  for (const k of ['models', 'motives', 'beliefs', 'strategies', 'skills', 'episodes', 'decisions', 'experiments', 'applied']) if (!Array.isArray(m[k])) throw new Error('认知状态结构损坏，保留原档案')
  return m
}
export function trimMind(profile) {
  const m = ensureMind(profile)
  for (const [k, max] of Object.entries({ models: 200, motives: 100, beliefs: 200, strategies: 100, skills: 100, episodes: 1000, decisions: 500, experiments: 200, applied: 1000 })) m[k] = m[k].slice(-max)
}
export function visible(row, chat) {
  return row.visibility === 'public' || chat?.kind === 'private' && row.userId && String(chat.userId || chat.chatId?.split(':')[1]) === row.userId
}
export function recordEvidence(raw, events) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  return raw.slice(0, 12).flatMap((r) => {
    const event = events.find((e) => e.id === r?.eventId)
    const quote = text(r?.quote, 200)
    if (!event || quote.length < 4 || !event.text.includes(quote) || seen.has(event.originId) || event.source === 'purpose' || event.source === 'chat' && (!event.direct || event.actor !== 'user')) return []
    seen.add(event.originId)
    return [{ eventId: event.id, originId: event.originId, source: event.source, userId: event.userId || '', at: event.at, quote, voluntary: event.voluntary === true, publicTechnical: event.publicTechnical === true }]
  })
}
export function scopeFor(evidence) {
  if (evidence.every((e) => e.source === 'browse' || e.source === 'outcome' && e.publicTechnical)) return { visibility: 'public', userId: '' }
  const users = [...new Set(evidence.map((e) => e.userId).filter(Boolean))]
  return users.length === 1 ? { visibility: 'private', userId: users[0] } : { visibility: 'internal', userId: '' }
}
