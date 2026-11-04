import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

let root, fake, api, mock, profile
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn) { for (let i = 0; i < 120; i++) { if (await fn()) return; await sleep(50) }; throw new Error('等待模拟结果超时') }
const post = (path, body) => api.modules.handle('/aurabot/api/personality/' + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body) },
})
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-personality-host-'))
  process.env.AURABOT_DATA_DIR = root; process.env.AURABOT_WORKSPACE = join(root, 'ws')
  mock = await startMockOneBot({ selfId: '20000002' })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', setupDone: true,
    model: { provider: 'fake', model: 'fake-1' }, merge: { waitSec: 0.2, maxSec: 1 }, stickers: { autoChance: 0 }, voice: { autoChance: 0 },
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'none'), httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token } }))
  const probe = join(root, 'modules', 'personality-probe'); mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'index.mjs'), `export default { id: 'personality-probe', setup(api) {
    api.on('persona', (t) => t + '\\n[共同扩展]')
    api.route('/current', () => ({ ok: true, text: api.core.personas.current(), name: api.core.personas.name() }))
    api.tool(() => api.defineTool({ name: 'personality_probe_tool', description: '模拟成功工具', execute: async () => ({ ok: true }) }))
  } }`)
  fake = createFakeDsh({ brain: async () => '收到啦' })
  fake.ctx.llm.stream = async function* (params) {
    const input = JSON.parse(params.messages[0].content[0].text)
    yield { type: 'text-delta', text: JSON.stringify({ changes: [{ path: 'identity.mission', value: '认真观察并好好过每一天', reason: '近期真实交流后的使命表述候选', confidence: 0.9, evidenceIds: input.events.map((e) => e.id) }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  api = (await import('../src/host.js')).apply(fake.ctx); await api.ready
  await fake.call('/onebot/reconnect'); await until(() => mock.connected() > 0)
})
after(async () => { fake?.dispose(); await mock?.close(); if (root) rmSync(root, { recursive: true, force: true }) })

test('真实宿主：默认保持旧人格，POST创建后仍未启用，显式选择才使用独立人格', async () => {
  assert.match(fake.variables.get('aurabot_persona')(), /大肥鱼/)
  const getAttempt = await api.modules.handle('/aurabot/api/personality/create', { method: 'GET', headers: {} })
  assert.equal(getAttempt.ok, false)
  const created = await post('create', {})
  assert.equal(created.ok, true); profile = created.profile
  assert.match(fake.variables.get('aurabot_persona')(), /大肥鱼/)
  assert.equal((await post('activate', { id: profile.id })).ok, true)
  assert.match(fake.variables.get('aurabot_persona')(), /萤宝/)
  assert.ok(!fake.variables.get('aurabot_persona')().includes('大肥鱼'))
  assert.equal(api.getConfig().persona.current, profile.personaId)
  const current = (await fake.call('/ext/personality-probe/current')).json()
  assert.equal(current.text, fake.variables.get('aurabot_persona')())
  assert.equal(current.text.split('[共同扩展]').length, 2, '扩展只执行一次，不产生递归')
  assert.equal(current.name, '萤宝')
  assert.match(fake.variables.get('aurabot_rules_private')(), /朋友/)
})

test('真实消息入成长经历，发送回执单独通知；模拟调用工具不会变成真实经历', async () => {
  const receipts = []
  const off = api.modules.listen('activity', (a) => { if (a.kind === 'receipt') receipts.push(a) })
  mock.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10000001, message_id: 101,
    sender: { user_id: 10000001, nickname: '朋友' }, message: [{ type: 'text', data: { text: '萤宝，今天一起聊点有意思的事' } }] })
  const personality = api.modules.use('personality')
  await until(() => personality.current().events.some((e) => e.originId.endsWith(':101')))
  await until(() => receipts.length > 0)
  assert.ok(receipts[0].messageId !== undefined)
  const before = personality.current().events.length
  const tool = api.modules.buildTools({ chat: { kind: 'private', chatId: 'private:10000001', userId: '10000001' }, level: 'act', sessionId: 'test' }).find((t) => t.name === 'personality_probe_tool')
  await api.hub.capture(() => tool.execute({}))
  assert.equal(personality.current().events.length, before)
  await tool.execute({}); assert.equal(personality.current().events.length, before + 1)
  off()
})

test('集成反思：重大提案审批前后，前台变量和后台入口同步更新；旧版本拒绝覆盖', async () => {
  const personality = api.modules.use('personality')
  for (let i = 0; i < 8; i++) api.modules.emit('activity', { kind: 'in', eventId: 'fixture-' + i, chatId: 'private:10000001', userId: '10000001', direct: true, text: '有关日常生活的真实交互' + i })
  const reflected = await post('reflect', {})
  assert.equal(reflected.ok, true, reflected.message)
  let p = personality.current(); assert.equal(p.state.identity.mission, '好好地过好每一天')
  const proposal = p.proposals.find((x) => x.outcome === 'pending')
  assert.ok(proposal)
  assert.equal((await post('review', { id: proposal.id, approve: true, revision: p.revision })).ok, true)
  p = personality.current()
  assert.equal(p.state.identity.mission, '认真观察并好好过每一天')
  assert.match(fake.variables.get('aurabot_persona')(), /认真观察并好好过每一天/)
  assert.equal((await fake.call('/ext/personality-probe/current')).json().text, fake.variables.get('aurabot_persona')())
  assert.equal((await post('edit', { revision: p.revision - 1, identity: { name: '旧修改' } })).ok, false)
})

test('切回普通人格后不再使用萤宝状态；直接编辑出生卡会关闭成长覆盖以尊重人工修改', async () => {
  const personality = api.modules.use('personality')
  const oldState = personality.current().state.identity.mission
  await fake.call('/persona/use', { id: 'dafeiyu' })
  assert.equal(personality.current(), null); assert.match(fake.variables.get('aurabot_persona')(), /大肥鱼/)
  await post('activate', { id: profile.id })
  assert.equal(personality.current().state.identity.mission, oldState)
  const result = (await fake.call('/persona/save', { id: profile.personaId, name: '人工卡', body: '你是人工编辑的新身份', tags: [] })).json()
  assert.equal(result.ok, true); assert.equal(personality.current(), null)
  assert.match(fake.variables.get('aurabot_persona')(), /人工编辑的新身份/)
})
