import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runReplay } from '../scripts/replay-cognition.mjs'

test('固定生成器前后对比、技能/反馈消融及重启连续性', async () => {
  const report = await runReplay()
  assert.equal(report.modelCalls, 1)
  assert.equal(report.knowledgeSelection.learnedHeldout, 1)
  assert.ok(report.knowledgeSelection.baseline < report.knowledgeSelection.learnedHeldout)
  assert.ok(report.knowledgeSelection.noSkillAblation < report.knowledgeSelection.learnedHeldout)
  assert.equal(report.motivation.before[0], '美食资料')
  assert.equal(report.motivation.after[0], '光谱资料')
  assert.equal(report.motivation.topicAfterRestart, '光谱')
  assert.notEqual(report.strategy.noFeedback, report.strategy.afterExecutionFailures)
  assert.equal(report.execution.verified, true)
  assert.equal(report.execution.groundedItems, 3)
  assert.equal(report.execution.persistedSkills, 1)
})
