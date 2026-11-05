import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProfile, YINGBAO, DAY, publicPersona } from '../src/personality/engine.js'
import { createPersonality } from '../src/personality/service.js'
import { createPersonalityStore } from '../src/personality/store.js'
import { normalize } from '../src/core/config.js'
import { ensureMind, recordEvidence } from '../src/cognition/state.js'
import { parseLearning, applyLearning, mindContext, outcomeEvents, learningEvents } from '../src/cognition/learning.js'
import { chooseStrategy, startEpisode, settleEpisode, humanFeedback, observeGoals } from '../src/cognition/policy.js'
import { executeProgram, validateProgram, proposeSkill, evaluateProgram, SKILL_CONTRACT, rollbackSkill } from '../src/cognition/skills.js'

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const fresh = () => newProfile(YINGBAO, '10000001', Date.UTC(2026, 10, 5))
const chat = { kind: 'private', chatId: 'private:10000001', userId: '10000001' }
const program = SKILL_CONTRACT.program
const events = (source = 'browse') => [0, 1, 2].map((i) => ({ id: 'e' + i, originId: 'origin' + i, at: Date.UTC(2026, 10, 5 + i), source, text: `天文研究实际材料 ${i}`, userId: source === 'chat' ? '10000001' : '', actor: source === 'chat' ? 'user' : 'agent', direct: source === 'chat' }))
const proposal = (kind, extra = {}, rows = events()) => ({ learning: { [kind]: [{ id: 'new-concept', text: '愿意理解天文研究方法', topic: '天文', reason: '多次接触发现资料需要比较', confidence: 0.8,
  evidence: rows.map((e) => ({ eventId: e.id, quote: e.text })), ...extra }] } })
function apply(p, kind, extra = {}, rows = events()) {
  return applyLearning(p, parseLearning(JSON.stringify(proposal(kind, extra, rows)), p, rows), Date.UTC(2026, 10, 8))
}
function serviceFixture(answer) {
  const d = mkdtempSync(join(tmpdir(), 'aurabot-cognition-')); dirs.push(d)
  const file = join(d, 'state.json'), calls = []
  let now = Date.UTC(2026, 10, 5), cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', ext: { personality: { enabled: true } } })
  const ask = async (o) => { calls.push(o); return answer(o) }
  const service = createPersonality({ file, getConfig: () => cfg, ask, now: () => now })
  const p = service.create(YINGBAO).profile; service.activate(p.id)
  cfg = normalize({ ...cfg, persona: { current: p.personaId } })
  const observe = (i, topic = '天文') => service.observe({ source: 'browse', originId: 'bili:' + i, actor: 'agent', status: 'read', text: `${topic} 观测资料 ${i}`, voluntary: true })
  return { service, file, calls, observe, advance: () => { now += DAY }, cfg: () => cfg, set: (patch) => { cfg = normalize({ ...cfg, ...patch }); service.invalidate() }, restart: () => createPersonality({ file, getConfig: () => cfg, ask, now: () => now }) }
}

test('自我认识和观点使用开放概念，实际改变上下文而不改写身份', () => {
  const p = fresh(), original = structuredClone(p.state.identity)
  assert.equal(apply(p, 'models')[0].accepted, true)
  assert.equal(apply(p, 'beliefs', { id: 'compare-sources', text: '比较不同观测方法更可靠' })[0].accepted, true)
  assert.match(publicPersona(p), /愿意理解天文研究方法/)
  assert.match(mindContext(p, '天文', chat), /比较不同观测/)
  assert.deepEqual(p.state.identity, original)
  assert.equal(p.mind.beliefs[0].status, 'active')
})
test('私聊概念不会进入公共人格、群聊、其他用户；混合用户证据不外传', () => {
  const p = fresh(), privateRows = events('chat')
  apply(p, 'models', { text: '面对这位朋友愿意多解释' }, privateRows)
  assert.match(mindContext(p, '', chat), /多解释/)
  assert.doesNotMatch(publicPersona(p), /多解释/)
  assert.equal(mindContext(p, '', { kind: 'group' }), '')
  assert.equal(mindContext(p, '', { kind: 'private', userId: '999' }), '')
  privateRows[1].userId = '999'
  assert.equal(parseLearning(JSON.stringify(proposal('models', {}, privateRows)), p, privateRows).length, 0)
})
test('证据需实际原文、新材料且不是自言自语；反思幂等', () => {
  const p = fresh(), rows = events(), input = proposal('models')
  input.learning.models[0].evidence = [{ eventId: 'e0', quote: '模型捏造的内容' }, { eventId: 'missing', quote: rows[1].text }]
  assert.equal(parseLearning(JSON.stringify(input), p, rows).length, 0)
  assert.equal(recordEvidence([{ eventId: 'e0', quote: rows[0].text }], rows.map((e) => ({ ...e, source: 'purpose' }))).length, 0)
  const candidates = parseLearning(JSON.stringify(proposal('models')), p, rows)
  applyLearning(p, candidates, Date.now()); applyLearning(p, candidates, Date.now())
  assert.equal(p.mind.models.length, 1); assert.equal(p.mind.models[0].revision, 1)
  p.processed = rows.map((e) => e.id)
  assert.equal(parseLearning(JSON.stringify(proposal('models', { text: '用旧证据刷出新结论' })), p, rows).length, 0)
})
test('同一概念可反向修正和撤销，保留历史，不被六维分数限制', () => {
  const p = fresh(); apply(p, 'models')
  apply(p, 'models', { text: '比起独自观察，我现在更享受一起探索', confidence: 0.6 })
  assert.equal(p.mind.models[0].revision, 2)
  assert.equal(p.mind.models[0].history[0].text, '愿意理解天文研究方法')
  apply(p, 'models', { text: '暂时不再采用这个认识', status: 'retired' })
  assert.equal(mindContext(p), '')
})
test('真实结果更新策略，反馈不接受自评、模拟、重复回执和错误用户', () => {
  const p = fresh(); apply(p, 'strategies', { context: 'tool', procedure: '资料冲突时先核验来源' })
  const d = chooseStrategy(p, { context: 'tool', query: '天文', chat })
  const e = startEpisode(p, { decisionId: d.id, action: 'watch', chat })
  for (const bad of [{ authority: 'model', success: true, receiptId: 'x' }, { authority: 'execution', success: true, receiptId: 'x', simulated: true }, { authority: 'execution', success: undefined, receiptId: 'x' }]) assert.equal(settleEpisode(p, e.id, bad).ok, false)
  assert.equal(settleEpisode(p, e.id, { authority: 'execution', success: false, receiptId: 'x' }).ok, true)
  assert.equal(p.mind.strategies[0].failure, 1); assert.equal(p.mind.strategies[0].unhelpful, 0)
  const second = startEpisode(p, { decisionId: d.id, action: 'watch', chat })
  assert.equal(settleEpisode(p, second.id, { authority: 'execution', success: true, receiptId: 'x' }).ok, false)
  assert.equal(humanFeedback(p, { episodeId: e.id, userId: '999', helpful: true, receiptId: 'f0' }).ok, false)
  assert.equal(humanFeedback(p, { episodeId: e.id, userId: chat.userId, helpful: true, receiptId: 'f1' }).ok, true)
  assert.equal(p.mind.strategies[0].helpful, 1)
  assert.equal(humanFeedback(p, { episodeId: e.id, userId: chat.userId, helpful: true, receiptId: 'f2' }).ok, false)
})
test('策略修订不继承旧程序成功率，迟到旧版本回执不能奖励新版本', () => {
  const p = fresh(); apply(p, 'strategies', { context: '*', procedure: '先验证再答复' })
  const d = chooseStrategy(p, { context: 'tool', chat }), e = startEpisode(p, { decisionId: d.id, chat })
  apply(p, 'strategies', { context: '*', procedure: '先澄清问题再验证' })
  settleEpisode(p, e.id, { authority: 'execution', success: true, receiptId: 'old' })
  assert.equal(p.mind.strategies[0].success, 0)
})
test('积累可靠执行结果后改变策略选择；没有反馈的沉默不会改变评分', () => {
  const p = fresh()
  apply(p, 'strategies', { id: 'a-strategy', context: 'tool', procedure: '策略甲' })
  apply(p, 'strategies', { id: 'b-strategy', context: 'tool', procedure: '策略乙' })
  const first = chooseStrategy(p, { context: 'tool', chat }).strategyId
  for (let i = 0; i < 8; i++) {
    const d = chooseStrategy(p, { context: 'tool', chat, candidates: ['a-strategy'] }), e = startEpisode(p, { decisionId: d.id, chat })
    settleEpisode(p, e.id, { authority: 'execution', success: false, receiptId: 'failure-' + i })
  }
  assert.equal(first, 'a-strategy')
  assert.equal(chooseStrategy(p, { context: 'tool', chat }).strategyId, 'b-strategy')
  assert.equal(p.mind.strategies[1].failure, 0)
})
test('动机由经历产生，记录新来源进度；重复曝光不刷目标进度', () => {
  const p = fresh(); apply(p, 'motives', { question: '天文观测如何排除误差', nextAction: '比较不同来源', targetSources: 2 })
  const row = { source: 'browse', originId: 'x', text: '天文材料', at: Date.now() }
  observeGoals(p, row); observeGoals(p, row)
  assert.equal(p.mind.motives[0].progress, 1)
  observeGoals(p, { ...row, originId: 'y' })
  assert.equal(p.mind.motives[0].status, 'ready-to-reflect')
})
test('可执行技能通过训练与保留题，改进真实输出；无改进/退步版本不替换冠军', () => {
  const p = fresh(), scope = { visibility: 'public', userId: '' }, base = evaluateProgram(null)
  const r = proposeSkill(p, { id: 'source-select', name: '比较材料', task: 'evidence.select', program }, [], scope)
  assert.equal(r.accepted, true); assert.ok(r.experiment.heldout.score > base.score)
  assert.equal(r.experiment.heldout.score, 1)
  const old = p.mind.skills[0].hash
  const bad = proposeSkill(p, { id: 'source-select', name: '坏版本', task: 'evidence.select', program: [{ op: 'take', count: 1 }] }, [], scope)
  assert.equal(bad.accepted, false); assert.equal(p.mind.skills[0].hash, old)
  assert.equal(proposeSkill(p, { id: 'source-select', name: '重复刷分', task: 'evidence.select', program }, [], scope).accepted, false)
  assert.equal(rollbackSkill(p, 'source-select', old).ok, true)
  assert.equal(rollbackSkill(p, 'source-select', 'not-tested').ok, false)
})
test('解释器拒绝代码/能力越界、超长输入，不修改输入，支持跨话题与空输入', () => {
  for (const bad of [[{ op: 'eval', code: 'process.exit()' }], [{ op: 'filter', field: '__proto__', test: 'truthy' }], Array(17).fill({ op: 'reverse' }), [{ op: 'take', count: 1000 }]]) assert.throws(() => validateProgram(bad))
  const input = { query: '考古', records: [{ id: 'a', text: '广告', valid: true }, { id: 'b', text: '考古材料', valid: true }, { id: 'c', text: '考古猜测', valid: false }] }, before = structuredClone(input)
  assert.deepEqual(executeProgram(program, input).map((r) => r.id), ['b'])
  assert.deepEqual(input, before); assert.deepEqual(executeProgram(program, { query: 'x', records: [] }), [])
  assert.throws(() => executeProgram(program, { records: Array(201).fill({}) }))
})
test('相同技能输入反复验证不变成独立新经历', () => {
  const p = fresh()
  for (let i = 0; i < 4; i++) {
    const e = startEpisode(p, { kind: 'skill', action: 'selector', inputKey: 'same', chat })
    settleEpisode(p, e.id, { authority: 'validator', success: true, receiptId: 'receipt-' + i })
  }
  assert.equal(p.mind.counters.outcomes, 4)
  assert.equal(outcomeEvents(p).length, 1)
  const result = outcomeEvents(p)[0]
  p.events.push({ ...result, id: 'generic-adapter', source: 'tool' })
  assert.equal(learningEvents(p).length, 1)
})
test('可以凭新证据撤下已验证技能，保留程序与实验供回滚', () => {
  const p = fresh()
  apply(p, 'skills', { id: 'selector', name: '筛选', task: 'evidence.select', program })
  const hash = p.mind.skills[0].hash
  apply(p, 'skills', { id: 'selector', text: '目前不再采用这个办法', status: 'retired' })
  assert.equal(p.mind.skills[0].status, 'retired')
  assert.equal(rollbackSkill(p, 'selector', hash).ok, true)
  assert.equal(p.mind.skills[0].status, 'active')
})
test('每日同一次模型调用同时生成动机、策略和技能，自动复用、重启保留、回滚恢复', async () => {
  const f = serviceFixture((o) => {
    const input = JSON.parse(o.text), rows = input.events.filter((e) => e.source === 'browse')
    const common = { id: 'source-select', text: '想比较天文材料', topic: '天文', confidence: 0.85, reason: '材料存在多个来源', evidence: rows.slice(-2).map((e) => ({ eventId: e.id, quote: e.text })) }
    return JSON.stringify({ learning: { motives: [{ ...common, id: 'astronomy-question', question: '如何核验观测', nextAction: '查找不同观测方法', targetSources: 3 }],
      strategies: [{ ...common, id: 'verify-first', context: 'tool', procedure: '先用已验证技能比较不同材料，再回答' }], skills: [{ ...common, name: '选择相关材料', task: 'evidence.select', program }] } })
  })
  for (let i = 0; i < 8; i++) f.observe(i)
  assert.equal((await f.service.reflect()).ok, true)
  assert.equal(f.calls.length, 1); assert.equal(f.service.current().mind.skills.length, 1)
  assert.equal(f.service.topics()[0].topic, '天文')
  assert.deepEqual(f.service.rank(['美食材料', '天文材料'], (v) => v), ['天文材料', '美食材料'])
  assert.match(f.service.prepare({ query: '天文', chat }), /通过已学技能筛选/)
  assert.ok(f.service.current().mind.skills[0].uses > 0)
  const restarted = f.restart(); assert.equal(restarted.current().mind.skills[0].uses, 1)
  const p = restarted.current(), episodes = p.mind.episodes.length
  assert.equal(restarted.rollback(1, p.revision).ok, true)
  assert.equal(restarted.current().mind.skills.length, 0)
  assert.equal(restarted.current().mind.episodes.length, episodes)
})
test('真实失败回执单独触发学习，失败材料能被引用，预览不应用', async () => {
  const f = serviceFixture((o) => {
    const rows = JSON.parse(o.text).events.filter((e) => e.source === 'outcome')
    return JSON.stringify(proposal('strategies', { context: 'tool', procedure: '遇到失败先检查参数并停止重复调用' }, rows))
  })
  for (let i = 0; i < 8; i++) {
    const token = f.service.beginAction({ action: 'read-' + i, chat })
    assert.equal(f.service.endAction(token, { authority: 'execution', success: false, receiptId: 'err-' + i, detail: '参数不合法，执行失败' }).ok, true)
  }
  assert.equal((await f.service.reflect()).ok, true)
  assert.equal(f.service.current().mind.strategies.length, 1)
  assert.equal(f.service.current().events.length, 0)
  assert.equal(f.service.status().newEvents, 0)
})
test('切换档案/试运行/总开关关闭不归入迟到结果；旧档案保留原数据', () => {
  const f = serviceFixture(() => '{}'), token = f.service.beginAction({ action: 'read', chat })
  const reloaded = f.restart()
  assert.equal(reloaded.endAction(token, { authority: 'execution', success: true, receiptId: 'old-module' }).ok, false)
  reloaded.dispose()
  f.set({ dryRun: true })
  assert.equal(f.service.endAction(token, { authority: 'execution', success: true, receiptId: 'late' }).ok, false)
  assert.equal(f.service.beginAction({ action: 'simulated', chat }), null)
  assert.equal(f.service.current().mind.counters.outcomes, 0)
})
test('旧数据无损补充认知状态，未来未知版本拒绝覆盖；遗忘清除私有模型与快照', () => {
  const f = serviceFixture(() => '{}')
  const raw = JSON.parse(readFileSync(f.file, 'utf8')); delete raw.profiles[0].mind
  writeFileSync(f.file, JSON.stringify(raw))
  assert.equal(f.service.current().mind.version, 1)
  const store = createPersonalityStore(f.file)
  store.update((s) => {
    const p = s.profiles[0]; apply(p, 'models', { text: '这位朋友的私密交流' }, events('chat'))
    p.snapshots.push({ revision: 0, state: structuredClone(p.state), mind: structuredClone(p.mind) })
  })
  assert.equal(f.service.forgetRelationship(chat.userId, f.service.current().revision).ok, true)
  assert.equal(f.service.current().mind.models.length, 0)
  assert.equal(f.service.current().snapshots[0].mind.models.length, 0)
  const future = JSON.parse(readFileSync(f.file, 'utf8')); future.profiles[0].mind.version = 999
  writeFileSync(f.file, JSON.stringify(future))
  const before = readFileSync(f.file, 'utf8')
  assert.throws(() => store.read())
  assert.equal(readFileSync(f.file, 'utf8'), before)
})
test('冻结认知分区阻止相应学习，预览只返回候选，预算仍共享每日一次', async () => {
  const f = serviceFixture((o) => JSON.stringify(proposal('models', {}, JSON.parse(o.text).events)))
  for (let i = 0; i < 8; i++) f.observe(i)
  const result = await f.service.reflect({ preview: true })
  assert.equal(result.learning.length, 1); assert.equal(f.service.current().mind.models.length, 0)
  assert.equal((await f.service.reflect()).ok, false); assert.equal(f.calls.length, 1)
  const p = fresh(); p.frozen = ['mind.models']
  assert.equal(parseLearning(JSON.stringify(proposal('models')), p, events()).length, 0)
})
test('保留题通过但真实运行失败的技能暂停，下一次同模型反思可据失败修复并重新验证', async () => {
  const f = serviceFixture((o) => {
    const input = JSON.parse(o.text), failed = input.events.find((e) => e.source === 'outcome' && e.text.includes('执行失败'))
    const rows = input.events.filter((e) => e.source === 'browse' && e.fresh).slice(-2)
    if (failed) rows.push(failed)
    return JSON.stringify(proposal('skills', { id: 'source-select', name: '筛选来源', task: 'evidence.select',
      text: failed ? '取消不适用于原材料记录的URL条件' : '用带网址的相关材料',
      program: failed ? program : [{ op: 'filter', field: 'url', test: 'https' }, ...program] }, rows))
  })
  for (let i = 0; i < 8; i++) f.observe(i)
  await f.service.reflect()
  assert.equal(f.service.current().mind.skills.length, 1)
  for (let i = 0; i < 3; i++) assert.equal(f.service.useSkill('source-select', '天文', chat).ok, false)
  assert.equal(f.service.current().mind.skills[0].status, 'quarantined')
  f.advance()
  for (let i = 8; i < 16; i++) f.observe(i)
  assert.equal((await f.service.reflect()).ok, true)
  const skill = f.service.current().mind.skills[0]
  assert.equal(skill.revision, 2); assert.equal(skill.status, 'active'); assert.equal(skill.failures, 0)
  assert.equal(f.service.useSkill('source-select', '天文', chat).ok, true)
  assert.equal(f.calls.length, 2)
})
