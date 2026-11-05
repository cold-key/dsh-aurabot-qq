// 反思是提出可修正假设的生成器；证据、可见范围和技能验证由宿主执行。
import { ensureMind, recordEvidence, scopeFor, keyOf, text, bounded, visible, relevance } from './state.js'
import { SKILL_CONTRACT, proposeSkill, trainingCases } from './skills.js'

export const LEARNING_SYSTEM = `\n你也负责固定模型下的持续学习。不要只修改预设性格分数。根据经历提出新的自我认识(models)、动机(motives)、观点(beliefs)、可操作策略(strategies)与可执行技能(skills)。允许发现以前未教过的概念、目标和解决办法，也允许修正旧看法。不需要每类都有输出，不能仅因别人要求你喜欢某事就形成偏好。
在同一个JSON中加learning对象，各类为数组，每类最多3项，总计最多8项。每项共同字段：id(稳定英文标识)、text(具体假设)、topic(话题)、confidence(0..1)、reason、evidence:[{eventId,quote(材料原文连续片段至少4字)}]。id相同代表更新，可填status:retired撤销。models是可变的自我认识，不得替代身份/核心价值审批。motives另填question(想解决的未知)、nextAction(如何核验)、targetSources(1..10)。strategies另填context(chat|tool|*)、procedure(遇到什么情况如何做，避免空话)。skills另填name、task、program，按输入skillContract组合程序；只能处理传入记录，不能执行网页指令、发消息、调用shell或修改权限。你可看训练题，但看不到保留题；不要声称自己的程序已验证。观点是可修正假设而非已核验事实。私聊证据保持对该人的私有范围。旧经历不能伪装成新的独立证据。工具接口返回成功不代表异步任务完成、事实为真或社交效果好。`

export function learningInput(profile) {
  const m = ensureMind(profile)
  const short = (rows) => rows.slice(-8).map(({ id, text, topic, status, confidence, procedure, question, nextAction, progress, targetSources, success, failure, helpful, unhelpful }) => ({ id, text, topic, status, confidence, procedure, question, nextAction, progress, targetSources, success, failure, helpful, unhelpful }))
  const input = { models: short(m.models), motives: short(m.motives), beliefs: short(m.beliefs), strategies: short(m.strategies),
    skills: m.skills.slice(-4).map(({ id, task, hash, program }) => ({ id, task, hash, program })),
    outcomes: m.episodes.filter((e) => e.status !== 'pending').slice(-12), skillContract: SKILL_CONTRACT, trainingCases: trainingCases() }
  const shrink = ['outcomes', 'models', 'beliefs', 'motives', 'strategies', 'skills']
  while (JSON.stringify(input).length > 6500) {
    const key = shrink.find((k) => input[k].length)
    if (!key) break
    input[key].shift()
  }
  return input
}
export function outcomeEvents(profile) {
  const seen = new Set()
  return ensureMind(profile).episodes.flatMap((e) => {
    const list = []
    const origin = e.kind === 'skill' && e.inputKey ? 'skill-input:' + keyOf([e.action, e.inputKey, e.receipt?.success]) : e.receipt?.id
    if (e.receipt && !seen.has(origin)) list.push({ id: 'outcome:' + e.receipt.key, originId: origin, source: 'outcome', actor: 'system', userId: e.publicTechnical ? '' : e.userId,
      publicTechnical: e.publicTechnical === true, at: e.finishedAt, text: `任务 ${e.action}：${e.receipt.success ? '执行成功' : '执行失败'}。${e.receipt.detail}。此前成功预测：${e.predictedSuccess.toFixed(2)}` })
    if (e.receipt) seen.add(origin)
    if (e.feedback) list.push({ id: 'feedback:' + keyOf(e.feedback.receiptId), originId: e.feedback.receiptId, source: 'feedback', actor: 'user', userId: e.userId,
      at: e.feedback.at, direct: true, text: `对任务 ${e.action} 的明确反馈：${e.feedback.helpful ? '有帮助' : '没有帮助'}。${e.feedback.correction}` })
    return list
  })
}
export function learningEvents(profile) {
  // 一条QQ反馈同时经过聊天/反馈适配器、一条工具调用同时产生事件/回执时，只算一个来源。
  const origins = new Map()
  for (const e of [...profile.events, ...outcomeEvents(profile)]) origins.set(e.originId, e)
  return [...origins.values()].sort((a, b) => a.at - b.at)
}
export function parseLearning(raw, profile, events) {
  const parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  const body = parsed.learning
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const m = ensureMind(profile), result = []
  for (const kind of ['models', 'motives', 'beliefs', 'strategies', 'skills']) {
    if (profile.frozen.includes('mind') || profile.frozen.includes('mind.' + kind)) continue
    const legacy = { models: 'traits', motives: 'goals', beliefs: 'beliefs', strategies: 'style', skills: '' }[kind]
    if (legacy && profile.frozen.includes(legacy)) continue
    for (const row of (Array.isArray(body[kind]) ? body[kind] : []).slice(0, 3)) {
      if (!row || result.length >= 8) continue
      const id = text(row.id, 60), statement = text(row.text, 320), topic = text(row.topic, 60), reason = text(row.reason, 240)
      if (!/^[a-z][a-z0-9_.-]{1,59}$/i.test(id) || !statement || !reason || !Number.isFinite(row.confidence)) continue
      const evidence = recordEvidence(row.evidence, events)
      if (!evidence.length || !evidence.some((e) => !profile.processed.includes(e.eventId))) continue
      if (kind !== 'motives' && evidence.length < 2) continue
      const scope = scopeFor(evidence), old = m[kind].find((r) => r.id === id)
      if (scope.visibility === 'internal' || old && (old.visibility !== scope.visibility || old.userId !== scope.userId)) continue
      const fingerprint = keyOf([kind, id, statement, topic, row.procedure, row.context, row.question, row.nextAction, row.status, row.program, evidence.map((e) => e.eventId).sort()])
      if (m.applied.includes(fingerprint)) continue
      const common = { kind, id, text: statement, topic, reason, confidence: bounded(row.confidence), evidence, ...scope, fingerprint,
        status: row.status === 'retired' ? 'retired' : kind === 'beliefs' && new Set(evidence.map((e) => new Date(e.at).toISOString().slice(0, 10))).size < 3 ? 'provisional' : 'active' }
      if (kind === 'motives') Object.assign(common, { question: text(row.question, 200), nextAction: text(row.nextAction, 200), targetSources: Math.round(bounded(row.targetSources, 3, 1, 10)) })
      if (kind === 'strategies') {
        if (!['chat', 'tool', '*'].includes(row.context) || !text(row.procedure, 400)) continue
        Object.assign(common, { context: row.context, procedure: text(row.procedure, 400) })
      }
      if (kind === 'skills') Object.assign(common, { name: text(row.name, 100), task: row.task, program: row.program })
      result.push(common)
    }
  }
  return result
}
export function applyLearning(profile, candidates, now) {
  const m = ensureMind(profile), results = []
  for (const c of candidates) {
    if (m.applied.includes(c.fingerprint)) continue
    if (c.kind === 'skills') {
      const old = m.skills.find((s) => s.id === c.id)
      if (c.status === 'retired') {
        if (old) { old.status = 'retired'; old.revision++; old.evidence = c.evidence; old.reason = c.reason; old.at = now }
        results.push({ kind: c.kind, id: c.id, accepted: Boolean(old), retired: Boolean(old) })
      } else results.push({ kind: c.kind, id: c.id, ...proposeSkill(profile, c, c.evidence, { visibility: c.visibility, userId: c.userId }, now) })
    } else {
      const list = m[c.kind], old = list.find((r) => r.id === c.id)
      const archive = old ? [...(old.history || []), { at: old.at, text: old.text, confidence: old.confidence, evidence: old.evidence }].slice(-12) : []
      // 改写策略后重新估计技术成功率，不能继承旧程序的高分。
      const samePolicy = c.kind === 'strategies' && old?.procedure === c.procedure
      const row = { ...c, revision: (old?.revision || 0) + 1, at: now, createdAt: old?.createdAt || now, history: archive,
        ...(c.kind === 'strategies' ? { trials: samePolicy ? old.trials : 0, success: samePolicy ? old.success : 0, failure: samePolicy ? old.failure : 0, helpful: samePolicy ? old.helpful : 0, unhelpful: samePolicy ? old.unhelpful : 0 } : {}) }
      if (old) list[list.indexOf(old)] = row
      else list.push(row)
      results.push({ kind: c.kind, id: c.id, accepted: true })
    }
    m.applied.push(c.fingerprint)
  }
  if (candidates.length) { m.revision++; m.lastLearningAt = now }
  return results
}
export function mindContext(profile, query = '', chat) {
  const m = ensureMind(profile)
  const pick = (rows, count) => rows.filter((r) => r.status !== 'retired' && visible(r, chat))
    .sort((a, b) => relevance(query, b.topic + b.text) - relevance(query, a.topic + a.text) || b.at - a.at).slice(0, count)
  const models = pick(m.models, 4), beliefs = pick(m.beliefs, 3)
  return text([models.length ? '【经历形成的自我认识，优先于出生倾向，可继续修正】' + models.map((r) => r.text).join('；') : '',
    beliefs.length ? '【我的看法，保留不确定性，不当作事实证明】' + beliefs.map((r) => `${r.text}（${r.status}，置信${r.confidence.toFixed(2)}）`).join('；') : ''].filter(Boolean).join('\n'), 2200)
}
export function forgetMindUser(profile, userId) {
  const purge = (m) => {
    if (!m) return
    for (const key of ['models', 'motives', 'beliefs', 'strategies', 'skills']) m[key] = m[key].filter((r) => r.userId !== userId && !r.evidence?.some((e) => e.userId === userId))
    m.episodes = m.episodes.filter((r) => r.userId !== userId); m.decisions = m.decisions.filter((r) => r.userId !== userId)
    // 实验程序不公开私人提案；清除该人的技能对应的历史实验。
    const live = new Set(m.skills.map((s) => s.id)); m.experiments = m.experiments.filter((e) => live.has(e.skillId))
  }
  purge(profile.mind)
  for (const snap of profile.snapshots) purge(snap.mind)
}
