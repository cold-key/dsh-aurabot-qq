// 策略根据实际结果在线更新；模型自评和对方没有回复不当作奖励。
import { randomUUID } from 'node:crypto'
import { ensureMind, relevance, visible, bounded, text, keyOf } from './state.js'

const successMean = (s, context) => context === 'chat' ? (1 + (s.helpful || 0)) / (2 + (s.helpful || 0) + (s.unhelpful || 0)) : (1 + (s.success || 0)) / (2 + (s.success || 0) + (s.failure || 0))
export function chooseStrategy(profile, { query = '', context = 'chat', chat, candidates } = {}, now = Date.now()) {
  const m = ensureMind(profile)
  const pool = m.strategies.filter((s) => s.status === 'active' && (s.context === context || s.context === '*') && visible(s, chat) && (!candidates || candidates.includes(s.id)))
  const trials = (s) => context === 'chat' ? (s.helpful || 0) + (s.unhelpful || 0) : (s.success || 0) + (s.failure || 0)
  const total = pool.reduce((n, s) => n + trials(s), 0)
  const ranked = pool.map((s) => {
    const match = s.topic ? relevance(query, s.topic) : 0.3
    const uncertainty = Math.sqrt(Math.log(total + 2) / (trials(s) + 1))
    return { s, score: match + successMean(s, context) + 0.3 * uncertainty - 0.1 * bounded(s.cost, 0.2) }
  }).sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
  const chosen = ranked[0]?.s
  if (!chosen) return null
  const decision = { id: randomUUID(), strategyId: chosen.id, strategyRevision: chosen.revision, context, at: now,
    chatId: text(chat?.chatId, 80),
    userId: chat?.kind === 'private' ? String(chat.userId || chat.chatId?.split(':')[1] || '') : '',
    predictedSuccess: successMean(chosen, context), query: text(query, 200), status: 'pending', explanation: chosen.procedure }
  m.decisions.push(decision)
  return decision
}
export function startEpisode(profile, { decisionId = '', kind = 'tool', action = '', chat, inputKey = '', goalId = '' } = {}, now = Date.now()) {
  const m = ensureMind(profile), decision = m.decisions.find((d) => d.id === decisionId && ['pending', 'observed'].includes(d.status))
  const episode = { id: randomUUID(), at: now, profileId: profile.id, decisionId: decision?.id || '', strategyId: decision?.strategyId || '',
    goalId, kind, action: text(action, 100), inputKey: text(inputKey, 100), status: 'pending',
    userId: chat?.kind === 'private' ? String(chat.userId || chat.chatId?.split(':')[1] || '') : '', predictedSuccess: decision?.predictedSuccess ?? 0.5, receipt: null }
  m.episodes.push(episode)
  return episode
}
export function settleEpisode(profile, id, outcome, now = Date.now()) {
  const m = ensureMind(profile), e = m.episodes.find((e) => e.id === id)
  if (!e || e.status !== 'pending' || !outcome || outcome.simulated) return { ok: false, message: '任务不存在、已结算或是模拟结果' }
  if (!['execution', 'validator'].includes(outcome.authority) || typeof outcome.success !== 'boolean' || !text(outcome.receiptId, 160)) return { ok: false, message: '需要实际执行或验证器回执' }
  const receipt = keyOf([outcome.authority, outcome.receiptId])
  if (m.episodes.some((other) => other.id !== id && other.receipt?.key === receipt)) return { ok: false, message: '同一回执不能重复计分' }
  e.status = outcome.success ? 'succeeded' : 'failed'
  e.finishedAt = now
  e.receipt = { key: receipt, authority: outcome.authority, id: text(outcome.receiptId, 160), success: outcome.success,
    detail: text(outcome.detail, 200), cost: bounded(outcome.cost, 0) }
  const error = (e.predictedSuccess - Number(outcome.success)) ** 2
  m.counters.outcomes++; m.counters.predictionError += error
  if (error > 0.3) m.counters.surprises++
  const s = m.strategies.find((s) => s.id === e.strategyId)
  if (s && s.revision === m.decisions.find((d) => d.id === e.decisionId)?.strategyRevision) { s.trials = (s.trials || 0) + 1; s[outcome.success ? 'success' : 'failure'] = (s[outcome.success ? 'success' : 'failure'] || 0) + 1; s.lastUsedAt = now }
  const d = m.decisions.find((d) => d.id === e.decisionId)
  if (d) d.status = 'observed'
  m.revision++
  return { ok: true, predictionError: error }
}
export function humanFeedback(profile, { episodeId, userId, helpful, correction = '', receiptId }, now = Date.now()) {
  if (typeof helpful !== 'boolean' || !text(receiptId, 120) || !String(userId || '')) return { ok: false, message: '需要明确反馈及真实消息回执' }
  const m = ensureMind(profile)
  let e = m.episodes.find((e) => e.id === episodeId)
  const d = m.decisions.find((d) => d.id === episodeId && d.context === 'chat' && d.userId === String(userId))
  if (!e && d) {
    e = { id: d.id, decisionId: d.id, userId: d.userId, strategyId: d.strategyId, at: d.at, status: 'reported', kind: 'dialogue', action: '用户对对话策略的明确反馈' }
    m.episodes.push(e); d.status = 'reported'
  }
  if (!e || !e.userId || e.userId !== String(userId) || typeof helpful !== 'boolean' || !receiptId || e.feedback) return { ok: false, message: '只能对与你相关的任务提交一次明确反馈' }
  e.feedback = { helpful, correction: text(correction, 300), at: now, receiptId: text(receiptId, 120) }
  const s = m.strategies.find((s) => s.id === e.strategyId)
  // 交互帮助程度与执行成功分开，不由管理员身份获得额外权重。
  if (s && s.revision === m.decisions.find((x) => x.id === e.decisionId)?.strategyRevision) { s.helpful = (s.helpful || 0) + Number(helpful); s.unhelpful = (s.unhelpful || 0) + Number(!helpful); if (d) s.trials = (s.trials || 0) + 1 }
  m.revision++
  return { ok: true, message: '已记录你的反馈；它不会自动证明观点真伪或改变技术权限' }
}
export function chooseMotive(profile, query = '', chat, now = Date.now()) {
  const m = ensureMind(profile)
  const candidates = m.motives.filter((g) => ['active', 'provisional'].includes(g.status) && visible(g, chat))
  return candidates.map((g) => {
    const age = Math.max(0, now - g.createdAt) / 86400000
    const novelty = 1 / (1 + (g.encounters || 0))
    const progress = (g.progress || 0) / Math.max(1, g.targetSources || 3)
    const uncertainty = 1 - bounded(g.confidence, 0.5)
    return { goal: g, score: relevance(query, g.topic) + 0.4 * novelty + 0.3 * uncertainty + 0.2 * Math.min(1, age / 7) - 0.2 * progress }
  }).sort((a, b) => b.score - a.score || a.goal.id.localeCompare(b.goal.id))[0]?.goal || null
}
export function observeGoals(profile, event) {
  if (event.source !== 'browse') return
  for (const g of ensureMind(profile).motives) {
    if (g.visibility !== 'public' || !['active', 'provisional'].includes(g.status) || relevance(g.topic, event.text) < 0.4) continue
    g.encounters = (g.encounters || 0) + 1
    g.observations ||= []
    if (!g.observations.includes(event.originId)) { g.observations.push(event.originId); g.progress = g.observations.length; g.lastProgressAt = event.at }
    if (g.progress >= (g.targetSources || 3)) g.status = 'ready-to-reflect'
  }
}
