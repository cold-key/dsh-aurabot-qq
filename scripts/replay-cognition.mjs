// 离线、确定性机制回放：生成器为脚本夹具，不使用在线模型，不触碰真实QQ/浏览器。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPersonality } from '../src/personality/service.js'
import { normalize } from '../src/core/config.js'
import { SKILL_CONTRACT } from '../src/cognition/skills.js'
import { chooseStrategy, startEpisode, settleEpisode } from '../src/cognition/policy.js'

export async function runReplay() {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-cognition-replay-')), file = join(root, 'state.json')
  let cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', model: { provider: 'fixture', model: 'unchanged-generator-v1' }, ext: { personality: { enabled: true } } }), calls = 0
  const now = () => Date.UTC(2026, 10, 5, 4)
  const ask = async ({ text }) => {
    calls++
    const input = JSON.parse(text), rows = input.events.filter((e) => e.source === 'browse').slice(-3)
    const common = { text: '想弄清光谱观测如何排除误差', topic: '光谱', reason: '读过多个不同来源后产生问题', confidence: 0.8, evidence: rows.map((e) => ({ eventId: e.id, quote: e.text })) }
    return JSON.stringify({ learning: {
      models: [{ ...common, id: 'compare-before-believe', text: '我开始更愿意对照材料再形成看法' }],
      motives: [{ ...common, id: 'spectra-question', question: '光谱信号如何区分噪声', nextAction: '比较不同观测方法', targetSources: 3 }],
      beliefs: [{ ...common, id: 'spectra-view', text: '光谱观测中的误差值得进一步核验' }],
      strategies: [{ ...common, id: 'compare-first', context: 'tool', procedure: '先筛选相关材料、对照不同来源，再回答问题' }],
      skills: [{ ...common, id: 'evidence-selector', name: '相关证据筛选', task: 'evidence.select', program: SKILL_CONTRACT.program }],
    } })
  }
  let service
  try {
    service = createPersonality({ file, getConfig: () => cfg, ask, now })
    const p = service.create().profile; service.activate(p.id); cfg = normalize({ ...cfg, persona: { current: p.personaId } })
    const before = service.rank(['美食资料', '光谱资料'], (r) => r)
    for (let i = 0; i < 8; i++) service.observe({ source: 'browse', originId: 'replay:' + i, actor: 'agent', status: 'read', voluntary: true, text: `光谱 观测误差的材料来源 ${i}` })
    const reflection = await service.reflect()
    if (!reflection.ok) throw new Error(reflection.message)
    const after = service.rank(['美食资料', '光谱资料'], (r) => r)
    const selected = service.useSkill('evidence-selector', '光谱', { kind: 'private', userId: '10000001', chatId: 'private:10000001' })
    const experiment = service.current().mind.experiments[0]
    service.dispose()
    service = createPersonality({ file, getConfig: () => cfg, ask, now })
    const mind = service.current().mind
    // 同一固定决策函数，消融掉执行反馈后维持原策略；有失败记录后转向替代策略。
    const policy = structuredClone(service.current()), seed = structuredClone(policy.mind.strategies[0])
    policy.mind.strategies = [{ ...seed, id: 'a-old-policy' }, { ...seed, id: 'b-alternative' }]
    const chat = { kind: 'private', userId: '10000001', chatId: 'private:10000001' }
    const policyBefore = chooseStrategy(policy, { context: 'tool', chat }).strategyId
    for (let i = 0; i < 6; i++) {
      const d = chooseStrategy(policy, { context: 'tool', chat, candidates: ['a-old-policy'] })
      const e = startEpisode(policy, { decisionId: d.id, chat, action: 'fixture-task' })
      settleEpisode(policy, e.id, { authority: 'execution', success: false, receiptId: 'fixture-result-' + i })
    }
    return { experiment: 'fixed-model-system-learning/v1', generator: 'scripted fixture; no online LLM or weight updates', modelCalls: calls,
      knowledgeSelection: { baseline: experiment.baseline, learnedHeldout: experiment.heldout.score, noSkillAblation: experiment.baseline, heldoutCases: experiment.heldout.cases.length },
      motivation: { before, after, topicAfterRestart: service.topics()[0]?.topic },
      strategy: { noFeedback: policyBefore, afterExecutionFailures: chooseStrategy(policy, { context: 'tool', chat }).strategyId },
      execution: { groundedItems: selected.items?.length || 0, verified: selected.ok, persistedSkills: mind.skills.length },
      limits: ['Synthetic local tasks only; not evidence of consciousness or human personality.', 'The generator fixture verifies wiring, not the discovery ability of a production model.', 'Held-out fixtures are excluded from model input, but are public in source code.'] }
  } finally { service?.dispose(); rmSync(root, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runReplay(), null, 2))
