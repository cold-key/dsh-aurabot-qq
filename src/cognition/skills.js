// 有界数据流技能：生成的是程序数据，永远不 eval，不获得网络、文件或发消息权限。
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ensureMind, keyOf, relevance, text } from './state.js'

const FIELDS = new Set(['id', 'text', 'topic', 'source', 'at', 'url', 'valid', 'score'])
const OPS = new Set(['filter', 'rank', 'unique', 'take', 'project', 'reverse'])
export const SKILL_CONTRACT = {
  task: 'evidence.select', input: '{query:string,records:[{id,text,topic,source,at,url,valid}]}',
  output: '原记录的子集，最多3条，相关、有效、id去重，不能增加事实',
  program: [{ op: 'filter', field: 'valid', test: 'truthy' }, { op: 'filter', field: 'text', test: 'relevant' }, { op: 'rank', field: 'text', by: 'relevance' }, { op: 'unique', field: 'id' }, { op: 'take', count: 3 }],
  operations: 'filter(field,test:truthy|relevant|exists|https);rank(field,by:relevance|number,descending?:boolean);unique(field);take(count:0..20);project(fields);reverse',
  fields: [...FIELDS], limits: { steps: 16, records: 200, inputChars: 100000, outputChars: 30000 },
}
export function validateProgram(program) {
  if (!Array.isArray(program) || !program.length || program.length > 16) throw new Error('技能需要1～16个有界步骤')
  for (const step of program) {
    if (!step || !OPS.has(step.op) || Object.keys(step).some((k) => !['op', 'field', 'test', 'by', 'descending', 'count', 'fields'].includes(k))) throw new Error('未知技能操作')
    if (['filter', 'rank', 'unique'].includes(step.op) && !FIELDS.has(step.field)) throw new Error('未知字段')
    if (step.op === 'filter' && !['truthy', 'relevant', 'exists', 'https'].includes(step.test)) throw new Error('未知筛选条件')
    if (step.op === 'rank' && !['relevance', 'number'].includes(step.by)) throw new Error('未知排序方式')
    if (step.op === 'take' && (!Number.isInteger(step.count) || step.count < 0 || step.count > 20)) throw new Error('超出数量界限')
    if (step.op === 'project' && (!Array.isArray(step.fields) || !step.fields.length || step.fields.some((f) => !FIELDS.has(f)))) throw new Error('未知投影字段')
  }
  return structuredClone(program)
}
export function executeProgram(program, input) {
  validateProgram(program)
  if (!input || !Array.isArray(input.records) || input.records.length > 200 || JSON.stringify(input).length > 100000) throw new Error('技能输入超出预算')
  // 只拷贝数据字段；阻止继承属性和不可信对象影响解释器。
  let rows = input.records.map((r) => Object.fromEntries([...FIELDS].filter((f) => Object.hasOwn(r || {}, f)).map((f) => [f, r[f]])))
  for (const s of program) {
    if (s.op === 'filter') rows = rows.filter((r) => s.test === 'truthy' ? Boolean(r[s.field]) : s.test === 'exists' ? r[s.field] !== undefined && r[s.field] !== '' : s.test === 'https' ? /^https:\/\/[^\s]+$/i.test(String(r[s.field])) : relevance(input.query, r[s.field]) > 0)
    if (s.op === 'rank') rows.sort((a, b) => {
      const score = (r) => s.by === 'relevance' ? relevance(input.query, r[s.field]) : Number(r[s.field]) || 0
      return (score(b) - score(a)) * (s.descending === false ? -1 : 1)
    })
    if (s.op === 'unique') { const seen = new Set(); rows = rows.filter((r) => { const k = JSON.stringify(r[s.field]); if (seen.has(k)) return false; seen.add(k); return true }) }
    if (s.op === 'take') rows = rows.slice(0, s.count)
    if (s.op === 'project') rows = rows.map((r) => Object.fromEntries(s.fields.filter((f) => Object.hasOwn(r, f)).map((f) => [f, r[f]])))
    if (s.op === 'reverse') rows.reverse()
  }
  if (JSON.stringify(rows).length > 30000) throw new Error('技能输出超出预算')
  return rows
}
export const groundedRows = (rows, records) => Array.isArray(rows) && rows.length <= 3 && new Set(rows.map((r) => r.id)).size === rows.length && rows.every((r) => records.some((original) => isDeepStrictEqual(r, original)))

// 训练题公开；保留题不送入生成模型。二者都是宿主拥有的确定性验证器。
function fixture(topic, serial, harder = false) {
  const good = [1, 2, 3].map((n) => ({ id: `${serial}-${n}`, text: `${topic} 独立材料${n}`, valid: true, source: `source-${n}`, url: `https://example.org/${serial}/${n}` }))
  const noise = { id: `${serial}-noise`, text: '无关的广告内容', valid: true, url: 'https://example.org/ad' }
  const invalid = { id: `${serial}-invalid`, text: `${topic} 未核验草稿`, valid: false }
  return { query: topic, records: harder ? [invalid, noise, good[1], good[1], good[2], good[0]] : [noise, invalid, good[0], good[0], good[1], good[2]], expected: good.map((r) => r.id) }
}
function edges(serial) {
  const single = fixture('古籍', serial, true)
  single.expected = single.expected.slice(0, 1)
  single.records = single.records.filter((r) => !r.valid || !r.id.endsWith('-2') && !r.id.endsWith('-3'))
  return [single, { query: 'ocean currents', records: [{ id: serial + '-x', text: 'unrelated', valid: true }], expected: [] }, { query: '空输入', records: [], expected: [] }]
}
export const trainingCases = () => [...['天文', '摄影', 'gardening'].map((t, i) => fixture(t, 'train-' + i)), ...edges('train-edge')]
const heldoutCases = () => [...['材料科学', '爵士音乐', 'urban ecology', '烘焙'].map((t, i) => fixture(t, 'hold-' + i, true)), ...edges('hold-edge')]
export function evaluateProgram(program, cases = trainingCases()) {
  const scores = cases.map((c) => {
    try {
      const output = program ? executeProgram(program, { query: c.query, records: c.records }) : c.records.slice(0, 3)
      if (!groundedRows(output, c.records)) return 0
      if (!c.expected.length) return Number(output.length === 0)
      return output.filter((r) => c.expected.includes(r.id)).length / Math.max(1, c.expected.length)
    } catch { return 0 }
  })
  return { score: scores.reduce((a, b) => a + b, 0) / scores.length, cases: scores }
}
export function proposeSkill(profile, proposal, evidence, scope, now = Date.now()) {
  const m = ensureMind(profile)
  const id = text(proposal.id, 60), name = text(proposal.name, 100)
  if (!/^[a-z][a-z0-9_.-]{1,59}$/i.test(id) || !name || proposal.task !== 'evidence.select') return { accepted: false, reason: '没有匹配的宿主验证任务' }
  let program
  try { program = validateProgram(proposal.program) } catch (e) { return { accepted: false, reason: e.message } }
  const hash = keyOf(program)
  if (m.experiments.some((e) => e.skillId === id && e.hash === hash)) return { accepted: false, reason: '该版本已评估，不重复刷分' }
  const old = m.skills.find((s) => s.id === id)
  if (old && (old.visibility !== scope.visibility || old.userId !== scope.userId)) return { accepted: false, reason: '不能跨可见范围覆盖技能' }
  const train = evaluateProgram(program), heldout = evaluateProgram(program, heldoutCases())
  const base = evaluateProgram(old?.program, heldoutCases())
  const noRegression = heldout.cases.every((score, i) => score >= base.cases[i])
  const accepted = train.score >= 0.99 && heldout.score >= 0.99 && noRegression && (heldout.score > base.score + 0.01 || !!old && program.length < old.program.length)
  const experiment = { id: randomUUID(), at: now, skillId: id, task: proposal.task, hash, parentHash: old?.hash || '', program,
    train, heldout, baseline: base.score, accepted, suite: 'evidence.select/v1', reason: accepted ? '保留题不退步且质量或步骤效率改进' : '未通过保留题、无改进或有退步' }
  m.experiments.push(experiment)
  if (accepted) {
    const skill = { id, name, task: proposal.task, program, hash, revision: (old?.revision || 0) + 1, ...scope, evidence,
      at: now, status: 'active', score: heldout.score, uses: 0, failures: 0 }
    if (old) m.skills[m.skills.indexOf(old)] = skill
    else m.skills.push(skill)
  }
  return { accepted, experiment }
}
export function rollbackSkill(profile, id, hash) {
  const m = ensureMind(profile), skill = m.skills.find((s) => s.id === id)
  const experiment = m.experiments.find((e) => e.skillId === id && e.hash === hash && e.accepted)
  if (!skill || !experiment) return { ok: false, message: '只能恢复已通过验证的版本' }
  skill.program = structuredClone(experiment.program); skill.hash = hash; skill.revision++; skill.status = 'active'; skill.uses = 0; skill.failures = 0; m.revision++
  return { ok: true, message: '已恢复验证过的技能版本' }
}
