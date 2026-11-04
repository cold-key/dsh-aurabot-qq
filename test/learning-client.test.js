// 执行实际面板组件和事件处理器；宿主和 React 钩子用最小模拟，不启动真实 DSH。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalize } from '../src/core/config.js'
import { newProfile, YINGBAO } from '../src/personality/engine.js'

function harness(reply) {
  const states = [], refs = [], effects = [], calls = []
  let cursor = 0, refCursor = 0, registration
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) })
  const React = { Component: class {}, Fragment: Symbol(), createElement: h,
    useState: (value) => { const i = cursor++; if (!(i in states)) states[i] = typeof value === 'function' ? value() : value; return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }] },
    useRef: (v) => { const i = refCursor++; return refs[i] ||= { current: v } },
    useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn) }
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
    .replace('exports.AurabotPage = AurabotPage', 'exports.Growth = Growth; exports.Learning = Learning; exports.LearningRecord = LearningRecord; exports.AurabotPage = AurabotPage')
  new Function('window', 'fetch', 'setInterval', 'clearInterval', source)(
    { __ModuleLoader__: { load: (r) => { registration = r } } },
    async (url, options) => { calls.push({ url, ...options }); return { json: async () => reply(url, options) } }, () => 1, () => {})
  const api = registration.factory(() => React)
  const render = (component, props) => { cursor = 0; refCursor = 0; effects.length = 0; return api[component](props) }
  return { render, effects, calls }
}
function nodes(tree) {
  return tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : []
}
const text = (tree) => typeof tree === 'string' ? tree : (tree?.children || []).map(text).join('')
const find = (tree, label) => nodes(tree).find((n) => n.type?.name === 'Btn' && text(n) === label)

test('面板真实组件：配置改草稿、预览发 POST JSON、召回预览不调用提炼', async () => {
  const app = harness((url) => url.endsWith('/learning/status') ? { ok: true, config: { dailyMax: 8 }, quota: { count: 0 }, active: 0, count: 0, busy: false, queued: 0, interests: [], history: [], batches: [{ id: 'b1', platform: 'bili', titles: ['猫咪'] }] }
    : url.includes('/learning/records') || url.endsWith('/learning/recall') ? { ok: true, items: [] } : { ok: true, preview: true, result: { records: [], interests: [], moodDelta: 0 } })
  let draft = normalize({}), updates = 0
  const props = { draft, setDraft: (d) => { draft = d; updates++ }, toast: () => {} }
  let tree = app.render('Learning', props)
  await app.effects[0]()
  await new Promise((r) => setImmediate(r))
  tree = app.render('Learning', props)
  const select = nodes(tree).find((n) => n.type?.name === 'Select' && n.props.options.some((o) => o.value === 'structured'))
  select.props.onChange('structured')
  assert.equal(updates, 1); assert.equal(draft.ext['social-learning'].mode, 'structured')
  assert.ok(app.calls.every((r) => r.method !== 'POST'), '草稿设置不会立即发起提炼')
  await find(tree, '预览，不应用').props.onClick()
  const preview = app.calls.find((r) => r.url.endsWith('/learning/preview'))
  assert.equal(preview.method, 'POST'); assert.equal(preview.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(preview.body), { batchId: 'b1' })
  await find(tree, '预览聊天召回（不调用模型）').props.onClick()
  assert.equal(app.calls.filter((r) => r.url.endsWith('/learning/preview')).length, 1)
  assert.equal(app.calls.filter((r) => r.url.endsWith('/learning/recall')).length, 1)
})

test('面板记录：编辑保存、固定、拒绝、删除准确指向选中记录，正文保持文字', async () => {
  const app = harness(() => ({})), actions = []
  const record = { id: 'r1', title: '猫咪', text: '<script>danger()</script>', kind: 'meme', displayStatus: 'candidate', status: 'candidate', confidence: 0.7, evidence: [], uses: 0, expiresAt: Date.now() }
  const props = { record, act: async (path, body) => { actions.push({ path, body }); return true } }
  let tree = app.render('LearningRecord', props)
  assert.ok(text(tree).includes(record.text))
  assert.ok(!nodes(tree).some((n) => n.props.dangerouslySetInnerHTML))
  await find(tree, '固定').props.onClick()
  assert.deepEqual(actions.at(-1), { path: '/learning/edit', body: { id: 'r1', pinned: true } })
  await find(tree, '拒绝').props.onClick(); assert.equal(actions.at(-1).body.status, 'rejected')
  await find(tree, '删除并屏蔽重学').props.onClick(); assert.equal(actions.at(-1).path, '/learning/delete')
  find(tree, '校订').props.onClick()
  tree = app.render('LearningRecord', props)
  const area = nodes(tree).find((n) => n.type === 'textarea' && n.props.value === record.text)
  area.props.onChange({ target: { value: '主人校订的含义' } })
  tree = app.render('LearningRecord', props)
  await find(tree, '保存校订并设为可用').props.onClick()
  assert.equal(actions.at(-1).body.text, '主人校订的含义')
  assert.equal(actions.at(-1).body.status, 'active')
})

test('面板接口不可用时展示错误，保留配置和空库视图', async () => {
  const app = harness(() => ({ ok: false, message: '学习模块没有运行' }))
  const props = { draft: normalize({}), setDraft: () => {}, toast: () => {} }
  app.render('Learning', props); await app.effects[0](); await new Promise((r) => setImmediate(r))
  const tree = app.render('Learning', props)
  assert.match(text(tree), /学习模块没有运行/)
  assert.ok(nodes(tree).some((n) => n.props.role === 'alert'))
})

test('人格面板：出生预览明确创建与启用分开，启用保留其他未保存配置', async () => {
  const profile = newProfile(YINGBAO, '10000001', Date.now())
  const status = { ok: true, seed: YINGBAO, config: { dailyMax: 1 }, quota: { count: 0 }, active: false, busy: false, newEvents: 0, profile: null, profiles: [{ id: profile.id, name: '萤宝', revision: 1 }], history: [] }
  const app = harness((url) => url.endsWith('/personality/status') ? status : { ok: true, message: '已完成', personaId: profile.personaId })
  let draft = normalize({ ownerName: '未保存的称呼' })
  const props = { draft, setDraft: (d) => { draft = d }, toast: () => {} }
  app.render('Growth', props); await app.effects[0](); await new Promise((r) => setImmediate(r))
  const tree = app.render('Growth', props)
  assert.match(nodes(tree).find((n) => n.type === 'textarea' && n.props.value === YINGBAO.selfView).props.value, /生命有限/)
  await find(tree, '创建独立出生档案（不调用模型）').props.onClick()
  const creation = app.calls.find((r) => r.url.endsWith('/personality/create'))
  assert.equal(creation.method, 'POST'); assert.equal(JSON.parse(creation.body).seed.name, '萤宝')
  assert.equal(app.calls.some((r) => r.url.endsWith('/personality/activate')), false)
  await find(tree, '选择并启用').props.onClick()
  assert.equal(draft.persona.current, profile.personaId); assert.equal(draft.ext.personality.enabled, true)
  assert.equal(draft.ownerName, '未保存的称呼')
})

test('人格面板：重大提案审批和回滚均携带当前版本，模型预览标记不应用', async () => {
  const profile = newProfile(YINGBAO, '10000001', Date.now())
  profile.revision = 12
  profile.proposals.push({ id: 'proposal', path: 'identity.mission', before: '原使命', after: '新使命', reason: '多日经历', evidence: [], outcome: 'pending', baseRevision: 12 })
  profile.snapshots.push({ revision: 11, reason: '原状态', at: Date.now() })
  const status = { ok: true, seed: YINGBAO, config: { dailyMax: 1 }, quota: { count: 0 }, active: true, busy: false, newEvents: 8, profile, profiles: [], history: [], publicText: '萤宝' }
  const app = harness((url) => url.endsWith('/personality/status') ? status : { ok: true, message: '完成', candidates: [] })
  const props = { draft: normalize({}), setDraft: () => {}, toast: () => {} }
  app.render('Growth', props); await app.effects[0](); await new Promise((r) => setImmediate(r))
  const tree = app.render('Growth', props)
  await find(tree, '批准').props.onClick()
  const approval = JSON.parse(app.calls.find((r) => r.url.endsWith('/personality/review')).body)
  assert.deepEqual(approval, { revision: 12, id: 'proposal', approve: true })
  await find(tree, '恢复此版本状态').props.onClick()
  assert.deepEqual(JSON.parse(app.calls.find((r) => r.url.endsWith('/personality/rollback')).body), { revision: 12, targetRevision: 11 })
  await find(tree, '模型预览（占今日额度，不应用）').props.onClick()
  assert.equal(JSON.parse(app.calls.find((r) => r.url.endsWith('/personality/reflect')).body).preview, true)
})
