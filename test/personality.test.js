import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createPersonality } from '../src/personality/service.js'
import { createPersonalityStore } from '../src/personality/store.js'
import { YINGBAO, DAY, publicPersona, newProfile, normalizeExperience, parseReflection } from '../src/personality/engine.js'
import { createMemoryStore } from '../src/features/memory.js'
import { createMood } from '../src/features/companion.js'

const dirs = []
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'aurabot-personality-')); dirs.push(d); return d }
after(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })) })
const tick = () => new Promise((r) => setImmediate(r))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const quietLog = { info() {}, warn() {}, debug() {} }
function fixture(options = {}) {
  const file = options.file || join(dir(), 'state.json')
  let time = Date.UTC(2026, 10, 4, 4), serial = 0
  let cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', ext: { personality: { enabled: true } } })
  const calls = []
  let changes = options.changes || [{ path: 'traits.curiosity', delta: 0.9 }]
  const answer = (o) => {
    const input = JSON.parse(o.text)
    return JSON.stringify({ changes: changes.map((c) => ({ confidence: 0.95, reason: '多次真实交互支持适度改变', evidenceIds: input.events.map((e) => e.id), ...c })) })
  }
  const service = createPersonality({ file, getConfig: () => cfg, now: () => time, timeoutMs: options.timeoutMs, ask: (o) => { calls.push(o); return options.ask ? options.ask(o, answer) : answer(o) } })
  function activate(p) { service.activate(p.id); cfg = normalize({ ...cfg, persona: { current: p.personaId }, ext: { ...cfg.ext, personality: { ...cfg.ext.personality, enabled: true } } }) }
  const p = options.existing ? null : service.create(YINGBAO).profile
  if (p) activate(p)
  const observe = (extra = {}) => service.observe({ source: 'chat', originId: 'message-' + serial++, at: time, text: `真实交互内容 ${serial}`, actor: 'user', status: 'received', direct: true, userId: '10000001', chatId: 'private:10000001', session: 'session-' + serial % 2, ...extra })
  return { service, file, calls, observe, activate, cfg: () => cfg, advance: (ms = DAY) => { time += ms }, now: () => time,
    set: (patch) => { cfg = normalize({ ...cfg, ...patch }); service.invalidate() },
    settings: (patch) => { cfg = normalize({ ...cfg, ext: { ...cfg.ext, personality: { ...cfg.ext.personality, ...patch } } }); service.invalidate() },
    changes: (v) => { changes = v }, day: (count = 8, extra = {}) => { for (let i = 0; i < count; i++) observe(extra) } }
}
async function mature(f) {
  for (let day = 0; day < 2; day++) { f.day(); await f.service.reflect(); f.advance() }
  f.day()
}

test('默认关闭、最多一次额度；萤宝出生底色、朋友关系和有限时间观独立保存', () => {
  const cfg = normalize({ ext: { personality: { dailyMax: 500 } } })
  assert.equal(cfg.ext.personality.enabled, false); assert.equal(cfg.ext.personality.dailyMax, 1)
  const f = fixture(), p = f.service.current()
  assert.equal(p.state.identity.name, '萤宝'); assert.equal(p.state.identity.mission, '好好地过好每一天')
  assert.equal(p.state.relationships['10000001'].kind, '好朋友')
  assert.match(f.service.text(), /没有实际寿命倒计时/)
  assert.ok(!f.service.text().includes('大肥鱼')); assert.ok(!f.service.text().includes('10000001'))
  assert.equal(f.calls.length, 0)
})

test('档案彼此隔离，切换普通人格不套用成长状态，重新选择后恢复连续性', () => {
  const f = fixture(), original = f.service.current()
  f.day()
  const other = f.service.create({ ...YINGBAO, name: '另一个个体' }).profile
  f.activate(other)
  assert.equal(f.service.current().events.length, 0)
  assert.equal(f.service.name(), '另一个个体')
  f.set({ persona: { current: 'dafeiyu' } }); assert.equal(f.service.current(), null)
  f.activate(original); assert.equal(f.service.current().events.length, 8)
})

test('新经历不足不调用，单日多次夸奖不立即重塑性格', async () => {
  const f = fixture(); f.day(7)
  assert.equal((await f.service.reflect()).ok, false); assert.equal(f.calls.length, 0)
  f.observe(); await f.service.reflect()
  assert.equal(f.calls.length, 1); assert.equal(f.service.current().state.traits.curiosity, 0.5)
  assert.equal((await f.service.reflect()).ok, false); assert.equal(f.calls.length, 1)
})

test('7天回放：跨日证据才小步成长，每日和滚动7天上限由代码限制', async () => {
  const f = fixture()
  for (let day = 0; day < 7; day++) {
    f.day(); await f.service.reflect(); f.advance()
  }
  const p = f.service.current()
  assert.ok(p.state.traits.curiosity > 0.5 && p.state.traits.curiosity <= 0.540001)
  assert.equal(f.calls.length, 7)
  assert.equal(f.calls[0].maxAttempts, 1); assert.equal(f.calls[0].maxTokens, 5000)
  assert.ok(f.calls.every((c) => c.text.length <= 16000))
  const value = p.state.traits.curiosity
  f.advance(30 * DAY); assert.equal(f.service.current().state.traits.curiosity, value)
  const restart = createPersonality({ file: f.file, getConfig: f.cfg, now: f.now, ask: async () => { throw new Error('不能重放') } })
  assert.equal(restart.current().state.traits.curiosity, value)
})

test('多个维度每天总变化不超过0.03，反向变化须有两个活跃日新支持', async () => {
  const f = fixture({ changes: ['curiosity', 'sociability', 'optimism', 'courage', 'assertiveness'].map((k) => ({ path: 'traits.' + k, delta: 1 })) })
  await mature(f); await f.service.reflect()
  const p = f.service.current(), sum = p.changes.reduce((n, c) => n + Math.abs(c.after - c.before), 0)
  assert.ok(sum <= 0.030001)
  const curiosity = p.state.traits.curiosity
  f.advance(); f.changes([{ path: 'traits.curiosity', delta: -1 }]); f.day(); await f.service.reflect()
  assert.equal(f.service.current().state.traits.curiosity, curiosity)
})

test('重复事件与同日重复内容去重；草稿、失败、模拟和出生前经历不参与成长', () => {
  const f = fixture()
  assert.equal(f.observe({ originId: 'a', text: '同样的内容' }), true)
  assert.equal(f.observe({ originId: 'a', text: '同样的内容' }), false)
  assert.equal(f.observe({ originId: 'b', text: '同样的内容' }), false)
  for (const extra of [{ simulated: true }, { status: 'failed' }, { status: 'proposed' }, { actor: 'agent' }, { generated: true }, { at: f.now() - DAY }]) assert.equal(f.observe(extra), false)
  assert.equal(f.service.current().events.length, 1)
})

test('曝光不等于自主偏好，真实选择只补充原事件，不增加独立证据数', async () => {
  const f = fixture({ changes: [{ path: 'preferences', value: '喜欢了解天文', topic: '天文' }] })
  for (let day = 0; day < 3; day++) { f.day(8, { source: 'browse', actor: 'agent', status: 'read', voluntary: false }); await f.service.reflect(); f.advance() }
  assert.equal(f.service.current().state.preferences.length, 0)
  const event = f.service.current().events[0]
  f.observe({ source: 'browse', actor: 'agent', status: 'read', originId: event.originId, voluntary: true })
  assert.equal(f.service.current().events.length, 24)
  assert.equal(f.service.current().events[0].voluntary, true)
})

test('自主浏览形成长期偏好、观点和小目标，行为排序尊重主人明确配置', async () => {
  const f = fixture({ changes: [{ path: 'preferences', value: '喜欢了解天文', topic: '天文' }, { path: 'beliefs', value: '讨论天文时愿意先核对资料' }, { path: 'goals', value: '进一步了解星云' }] })
  for (let day = 0; day < 2; day++) { f.day(8, { source: 'browse', actor: 'agent', status: 'read', voluntary: true }); await f.service.reflect(); if (!day) f.advance() }
  assert.equal(f.service.current().state.preferences.length, 1)
  assert.equal(f.service.materials().length, 1)
  assert.deepEqual(f.service.rank(['猫咪', '天文'], (x) => x), ['天文', '猫咪'])
  f.set({ group: { interests: ['猫咪'] } }); assert.deepEqual(f.service.rank(['天文', '猫咪'], (x) => x), ['猫咪', '天文'])
  assert.match(f.service.text(), /不等同事实核验/)
})

test('身份与重大关系先审阅，程序忽略模型自报小变化；审批绑定版本', async () => {
  const f = fixture({ changes: [{ path: 'identity.name', value: '新的名字', major: false }, { path: 'relationships.10000001.kind', value: '另一个关系' }] })
  f.day(); await f.service.reflect()
  let p = f.service.current()
  assert.equal(p.state.identity.name, '萤宝'); assert.equal(p.proposals.length, 2)
  assert.equal(f.service.review(p.proposals.map((x) => x.id), true, p.revision - 1).ok, false)
  assert.equal(f.service.review(p.proposals.map((x) => x.id), true, p.revision).ok, true)
  p = f.service.current(); assert.equal(p.state.identity.name, '新的名字')
  assert.equal(p.state.relationships['10000001'].kind, '另一个关系')
  assert.ok(!f.service.text().includes('10000001'))
})

test('拒绝提案后，旧证据不会反复提出；未知字段、假证据和权限路径不生效', async () => {
  const f = fixture({ changes: [{ path: 'identity.mission', value: '新使命' }, { path: '__proto__.polluted', value: true }, { path: 'profilePerms.qqAvatar', value: 'all' }, { path: 'identity.name', value: '假名字', evidenceIds: ['fake'] }] })
  f.day(); await f.service.reflect()
  const p = f.service.current(); assert.equal(p.proposals.length, 1)
  f.service.review([p.proposals[0].id], false, p.revision)
  assert.equal({}.polluted, undefined); assert.equal(f.cfg().profilePerms.qqAvatar, 'owner')
  const candidates = parseReflection(JSON.stringify({ changes: [{ path: 'identity.mission', value: '新使命', confidence: 0.9, reason: '再提一次', evidenceIds: p.events.map((e) => e.id) }] }), { ...f.service.current(), processed: [] }, p.events, f.now())
  assert.equal(candidates.length, 0)
})

test('关系证据归属正确的人，私密关系不进入公共人格或群聊上下文', async () => {
  const f = fixture({ changes: [{ path: 'relationships.10000001.trust', delta: 1 }] })
  f.day(8, { userId: '20000002', chatId: 'private:20000002' }); await f.service.reflect(); f.advance()
  f.day(8, { userId: '20000002', chatId: 'private:20000002' }); await f.service.reflect()
  assert.equal(f.service.current().state.relationships['10000001'].trust, 0.6)
  assert.match(f.service.relationship({ kind: 'private', userId: '10000001' }), /好朋友/)
  assert.ok(!f.service.relationship({ kind: 'private', userId: '20000002' }).includes('好朋友'))
  assert.equal(f.service.relationship({ kind: 'group', userId: '10000001' }), '')
  assert.ok(!f.service.text().includes('20000002'))
})

test('短期心情与长期人格分开，新人格不无条件因白米饭开心，效果保持窄范围', () => {
  const f = fixture(), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir()
  try {
    const mood = createMood({ getConfig: f.cfg, personality: () => f.service })
    const before = mood.current()
    mood.observe('白米饭', '用户', { direct: true, owner: true })
    assert.equal(mood.current(), before)
    mood.nudge(-10, '暂时失落')
    assert.equal(f.service.current().state.traits.optimism, 0.75)
    for (const value of Object.values(f.service.effects())) assert.ok(value >= 0.8 && value <= 1.2)
  } finally { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous }
})

test('冻结成长仍可采集，关闭采集不增加经历；字段冻结阻止自动变化和旧提案审批', async () => {
  const f = fixture(); f.settings({ paused: true }); f.day()
  assert.equal(f.service.current().events.length, 8); assert.equal((await f.service.reflect()).ok, false)
  f.settings({ collect: false }); assert.equal(f.observe(), false)
  f.settings({ collect: true, paused: false })
  const rev = f.service.current().revision
  f.service.freeze('traits', true, rev)
  await f.service.reflect(); f.advance(); f.day(); await f.service.reflect(); f.advance(); f.day(); await f.service.reflect()
  assert.equal(f.service.current().state.traits.curiosity, 0.5)
})

test('试运行、总开关关闭和关闭成长模式时不采集或调用', async () => {
  const f = fixture()
  for (const patch of [{ dryRun: true }, { dryRun: false, enabled: false }]) { f.set(patch); assert.equal(f.observe(), false); assert.equal((await f.service.reflect()).ok, false) }
  f.set({ enabled: true }); f.settings({ enabled: false }); assert.equal(f.observe(), false)
  assert.equal(f.calls.length, 0)
})

test('手动模型预览计入每日额度，但不改变人格或处理标记', async () => {
  const f = fixture({ changes: [{ path: 'identity.name', value: '预览名字' }] }); f.observe()
  const r = await f.service.reflect({ preview: true })
  assert.equal(r.ok, true); assert.equal(r.candidates.length, 1)
  assert.equal(f.service.current().state.identity.name, '萤宝')
  assert.equal(f.service.current().processed.length, 0); assert.equal(f.service.current().proposals.length, 0)
  assert.equal((await f.service.reflect({ preview: true })).ok, false); assert.equal(f.calls.length, 1)
})

test('失败也扣额度、不自动重试；重启和次日不重放失败材料', async () => {
  const f = fixture({ ask: async () => { throw new Error('失败') } }); f.day()
  assert.equal((await f.service.reflect()).ok, false); assert.equal(f.calls.length, 1)
  f.advance(); assert.equal((await f.service.reflect()).ok, false); assert.equal(f.calls.length, 1)
  const store = createPersonalityStore(f.file, f.now)
  store.update((s) => { s.running = { profileId: f.service.current().id } })
  const restarted = createPersonality({ file: f.file, getConfig: f.cfg, now: f.now, ask: () => { throw new Error('不能补发') } })
  assert.equal(restarted.status().running, null); assert.equal((await restarted.reflect()).ok, false)
})

test('配置变化立即取消管理等待，迟到结果不应用；跨热重载不并发物理请求', async () => {
  const hold = deferred(), f = fixture({ ask: (o, answer) => hold.promise.then(() => answer(o)) })
  f.day(); const pending = f.service.reflect(); await tick(); f.service.dispose()
  assert.equal((await pending).ok, false)
  const next = createPersonality({ file: f.file, getConfig: f.cfg, now: f.now, ask: () => { throw new Error('旧请求没有退出') } })
  const request = next.reflect({ preview: true }); await tick(); assert.equal(next.status().busy, true)
  next.invalidate(); assert.equal((await request).ok, false)
  hold.resolve(); await f.service.waitForIdle(); await next.waitForIdle()
  assert.equal(next.current().state.identity.name, '萤宝')
})

test('超时先返回错误，旧模型忽略取消时通道仍忙；迟到输出不入库', async () => {
  const hold = deferred(), f = fixture({ timeoutMs: 15, ask: () => hold.promise })
  f.observe()
  const keeping = setTimeout(() => hold.resolve('late'), 1000)
  const r = await f.service.reflect({ preview: true })
  assert.match(r.message, /超时/); assert.equal(f.service.status().busy, true)
  hold.resolve('late'); clearTimeout(keeping); await f.service.waitForIdle()
  assert.equal(f.service.current().proposals.length, 0)
})

test('人工校订与回滚使用新版本，旧证据不会立即把回滚状态再次改回', async () => {
  const f = fixture(); await mature(f); await f.service.reflect()
  let p = f.service.current(); assert.ok(p.state.traits.curiosity > 0.5)
  const rev = p.snapshots[0].revision
  assert.equal(f.service.rollback(rev, p.revision).ok, true)
  p = f.service.current(); assert.equal(p.state.traits.curiosity, 0.5)
  f.advance(); assert.equal((await f.service.reflect()).ok, false)
  assert.equal(f.service.edit({ identity: { name: '校订名字' } }, p.revision).ok, true)
  assert.equal(f.service.name(), '校订名字')
})

test('独立记忆与旧记忆隔离，切换档案不串库', async () => {
  const f = fixture(), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir()
  try {
    const memory = createMemoryStore({ getConfig: f.cfg, personality: () => f.service, log: quietLog, hub: {} })
    memory.add({ text: '萤宝的记忆', about: '10000001' })
    const first = f.service.current()
    const second = f.service.create({ name: '另一个个体' }).profile; f.activate(second)
    assert.equal(memory.list('').length, 0)
    f.activate(first); assert.equal(memory.list('')[0].text, '萤宝的记忆')
    f.set({ persona: { current: 'dafeiyu' } }); assert.equal(memory.list('').length, 0)
  } finally { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous }
})

test('记忆整理在等待模型时切换个体，结果仍写入原档案，不删除共享聊天历史', async () => {
  const f = fixture(), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir()
  try {
    f.set({ model: { provider: 'fake', model: 'fake-1' } })
    const first = f.service.current(), hold = deferred()
    let started = false, removed = false
    const day = new Date().toLocaleDateString('en-CA')
    const dsh = { llm: { resolveModelInfo: async () => ({}), async *stream(params) {
      if (params.system.includes('整理长期记忆')) {
        started = true; await hold.promise
        yield { type: 'text-delta', text: '[{"text":"朋友喜欢研究星云","about":"朋友","about_qq":"10000001"}]' }
      } else yield { type: 'text-delta', text: '{"insights":[],"style":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } }
    const memory = createMemoryStore({ getConfig: f.cfg, personality: () => f.service, dsh, log: quietLog,
      hub: { chatLogDays: () => [day], chatLogOf: () => [1, 2, 3].map((i) => ({ profileId: first.id, t: Date.now() + DAY, chatId: 'private:10000001', who: '朋友', uid: '10000001', text: '谈论星云的真实内容' + i })), deleteChatLog: () => { removed = true } } })
    const pending = memory.consolidate({ includeToday: true })
    await tick(); assert.equal(started, true)
    const second = f.service.create({ name: '另一个个体' }).profile; f.activate(second)
    hold.resolve(); await pending
    assert.equal(memory.list('').length, 0)
    f.activate(first); assert.ok(memory.list('').some((r) => r.text === '朋友喜欢研究星云'))
    assert.equal(removed, false)
  } finally { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous }
})

test('未知版本和损坏人格文件保持原样，不能自动覆盖', () => {
  const file = join(dir(), 'bad.json')
  for (const raw of ['{"version":99}', '{broken']) {
    writeFileSync(file, raw, 'utf8')
    assert.throws(() => createPersonality({ file, getConfig: () => normalize({}), ask: async () => '' }))
    assert.equal(readFileSync(file, 'utf8'), raw)
  }
})
