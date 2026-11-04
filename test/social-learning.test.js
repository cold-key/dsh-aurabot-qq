import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LEARNING, DAY, normalizeLearning, normalizeBatch, parseLearning, searchLearning, interestScore, dayKey } from '../src/social-learning/engine.js'
import { createSocialLearning } from '../src/social-learning/service.js'
import { createLearningStore } from '../src/social-learning/store.js'
import { biliObservation, douyinObservation, withLearnedKeyword } from '../src/social-learning/observations.js'
import { normalize } from '../src/core/config.js'
import definition from '../src/modules/social-learning/index.js'

const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'aurabot-learning-')); dirs.push(dir); return dir }
const tick = () => new Promise((r) => setImmediate(r))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const batch = (platform = 'bili', ids = [1], extra = {}) => ({ platform, items: ids.map((i) => ({
  id: platform === 'bili' ? 'BV' + String(i).padStart(10, '0') : '70000000000000000' + String(i).padStart(2, '0'),
  title: '猫咪护理', author: '作者', sections: [{ kind: 'subtitle', text: '猫咪需要定期清洁饮水碗。评论只是网友观点。' }], ...extra,
})) })
function output(items, { kind = 'knowledge', topic = '', mood = 0, text = '猫咪需要定期清洁饮水碗', title = '猫咪护理', topical = false } = {}) {
  return JSON.stringify({ records: [{ kind, title, text, confidence: 0.9, topical, usage: '讨论猫咪时', example: '这是猫咪的日常', avoid: '严肃场合',
    evidence: items.map((i) => ({ sourceId: i.id, quote: '猫咪需要定期清洁饮水碗' })) }],
  interests: topic ? [{ topic, sourceIds: items.map((i) => i.id), value: 1, confidence: 0.9 }] : [],
  mood: { delta: mood, reason: '觉得猫咪可爱', confidence: 0.9 } })
}
function fixture(options = {}) {
  const file = options.file || join(directory(), 'state.json')
  let cfg = normalize({ enabled: true, dryRun: false, ext: { 'social-learning': { ...DEFAULT_LEARNING, mode: 'structured', ...options.config } } })
  let time = Date.now()
  const calls = [], nudges = []
  const ask = options.ask || (async (o) => output(JSON.parse(o.text).items, options.result))
  const service = createSocialLearning({ file, getConfig: () => cfg, now: () => time, timeoutMs: options.timeoutMs,
    ask: (o) => { calls.push(o); return ask(o) }, mood: () => ({ nudge: (n) => nudges.push(n) }) })
  return { service, file, calls, nudges, read: () => JSON.parse(readFileSync(file, 'utf8')),
    advance: (ms) => { time += ms }, set: (patch) => { cfg = normalize({ ...cfg, ...patch }) },
    settings: (patch) => { cfg.ext['social-learning'] = normalizeLearning({ ...cfg.ext['social-learning'], ...patch }) } }
}

test('配置默认兼容、总开关关闭、试运行开启；归一化且保留其他扩展', () => {
  const c = normalize({ ext: { demo: { keep: 1 }, 'social-learning': { mode: 'oops', dailyMax: -1, maxInputChars: 99999 } } })
  assert.equal(c.enabled, false); assert.equal(c.dryRun, true)
  assert.equal(c.ext['social-learning'].mode, 'legacy')
  assert.equal(c.ext['social-learning'].dailyMax, 0)
  assert.equal(c.ext['social-learning'].maxInputChars, 16000)
  assert.equal(c.ext.demo.keep, 1)
})

test('平台绑定真实 ID 和来源，丢弃无效来源且严格限制最终模型输入', () => {
  const raw = batch('bili', [1, 2, 3], { sections: [{ kind: 'subtitle', text: '长文本\n'.repeat(10000) }], url: 'https://evil.example' })
  const normalized = normalizeBatch(raw, Date.now(), 2000)
  assert.ok(JSON.stringify({ platform: normalized.platform, items: normalized.items }).length <= 2000)
  assert.match(normalized.items[0].url, /^https:\/\/www.bilibili.com\/video\/BV/)
  assert.equal(normalizeBatch({ platform: 'tieba', items: raw.items }), null)
  assert.equal(normalizeBatch(batch('bili', [1], { id: 'bad' })), null)
})

test('观察仅含已读材料，抖音分段数组与评论原文保留', () => {
  const b = biliObservation([{ info: { bvid: 'BV0000000001', title: '猫咪', desc: '介绍' }, subtitle: '猫咪需要定期清洁饮水碗', comments: [] }])
  assert.equal(b.items[0].sections[2].kind, 'subtitle')
  const d = douyinObservation([{ v: { awemeId: '7000000000000000001', chapters: ['开头', '正文'] }, comments: [{ name: '网友', text: '妙啊' }] }], 'watch')
  assert.equal(d.origin, 'watch')
  assert.equal(d.items[0].sections[0].text, '开头\n正文')
})

test('证据校验拒绝编造来源、编造摘录；知识不能引用热评，即使同视频也有正文', () => {
  const b = normalizeBatch(batch('bili', [1], { sections: [{ kind: 'subtitle', text: '确实存在的字幕内容' }, { kind: 'comments', text: '猫咪需要定期清洁饮水碗' }] }))
  assert.equal(parseLearning(output(b.items), b, DEFAULT_LEARNING).records.length, 0)
  const p = JSON.parse(output(b.items)); p.records[0].evidence[0].sourceId = 'other'
  assert.equal(parseLearning(JSON.stringify(p), b, DEFAULT_LEARNING).records.length, 0)
  p.records[0].evidence[0] = { sourceId: b.items[0].id, quote: '根本不存在的摘录' }
  assert.equal(parseLearning(JSON.stringify(p), b, DEFAULT_LEARNING).records.length, 0)
  assert.throws(() => parseLearning('不是 JSON', b, DEFAULT_LEARNING))
})

test('表达须有情境、例句和两个内容来源；过时新闻不会因重读变新', () => {
  const now = Date.now(), b = normalizeBatch(batch('bili', [1, 2], { publishedAt: now - 20 * DAY }), now)
  assert.equal(parseLearning(output(b.items.slice(0, 1), { kind: 'meme' }), b, DEFAULT_LEARNING, now).records[0].status, 'candidate')
  assert.equal(parseLearning(output(b.items, { kind: 'meme' }), b, DEFAULT_LEARNING, now).records[0].status, 'active')
  const r = parseLearning(output(b.items, { topical: true }), b, DEFAULT_LEARNING, now).records[0]
  assert.ok(r.expiresAt < now)
})

test('串行处理两个平台，每轮一次调用，失败也扣共享预算，重启保留额度', async () => {
  const f = fixture({ config: { dailyMax: 2 } })
  f.service.observe(batch()); f.service.observe(batch('douyin')); f.service.observe(batch('bili', [2]))
  await f.service.waitForIdle()
  assert.equal(f.calls.length, 2)
  assert.equal(f.service.status().quota.count, 2)
  assert.equal(f.calls[0].maxTokens, 1500); assert.equal(f.calls[0].maxAttempts, 1)
  f.service.dispose()
  const again = fixture({ file: f.file, config: { dailyMax: 2 } })
  again.service.observe(batch('bili', [3])); await again.service.waitForIdle()
  assert.equal(again.calls.length, 0)
  again.advance(DAY); again.service.observe(batch('bili', [4])); await again.service.waitForIdle()
  assert.equal(again.calls.length, 1)
})

test('失败不重试且相同内容不自动重复请求，内容变化后可以学习', async () => {
  const f = fixture({ ask: async () => { throw new Error('API failed') } })
  f.service.observe(batch()); await f.service.waitForIdle()
  assert.equal(f.service.observe(batch()).reason, 'duplicate')
  f.service.observe(batch('bili', [1], { sections: [{ kind: 'subtitle', text: '内容发生了明显变化' }] })); await f.service.waitForIdle()
  assert.equal(f.calls.length, 2); assert.equal(f.service.status().quota.count, 2)
  assert.equal(f.service.list().length, 0)
})

test('兼容、关闭、来源停用、试运行和总开关关闭不自动提炼', async () => {
  for (const mode of ['legacy', 'off']) {
    const f = fixture({ config: { mode } }); f.service.observe(batch()); await f.service.waitForIdle()
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.file), false)
  }
  const f = fixture(); f.set({ dryRun: true }); f.service.observe(batch()); await f.service.waitForIdle()
  assert.equal(f.calls.length, 0); assert.equal(existsSync(f.file), false)
  f.set({ dryRun: false, enabled: false }); assert.equal(f.service.observe(batch()).reason, 'plugin-off')
  f.set({ enabled: true }); f.settings({ sources: { bili: false } })
  assert.equal(f.service.modeFor('bili'), 'legacy'); assert.equal(f.service.observe(batch()).reason, 'disabled')
})

test('显式模型预览消耗额度，但不写知识、兴趣、心情或已处理标记', async () => {
  const f = fixture({ config: { mode: 'legacy' }, result: { topic: '猫咪', mood: 2 } })
  f.set({ dryRun: true }); f.service.observe(batch())
  const b = f.service.status().batches[0]
  const r = await f.service.preview(b.id); await f.service.waitForIdle()
  assert.equal(r.ok, true); assert.equal(r.result.records.length, 1)
  assert.equal(f.calls.length, 1); assert.equal(f.service.status().quota.count, 1)
  assert.equal(f.read().records.length, 0); assert.deepEqual(f.read().interests, {})
  assert.equal(f.read().seen.length, 0); assert.deepEqual(f.nudges, [])
})

test('配置变更清理排队，忽略在途旧结果；旧请求未退出前不启动新请求', async () => {
  const hold = deferred(); let first = true
  const f = fixture({ ask: async (o) => { if (first) { first = false; await hold.promise }; return output(JSON.parse(o.text).items) } })
  f.service.observe(batch()); await tick()
  f.service.observe(batch('douyin'))
  f.service.invalidate(); f.service.observe(batch('bili', [3])); await tick()
  assert.equal(f.calls.length, 1); assert.equal(f.service.status().queued, 1)
  hold.resolve(); await f.service.waitForIdle()
  assert.equal(f.calls.length, 2)
  assert.equal(f.service.list()[0].evidence[0].sourceId, 'BV0000000003')
})

test('热重载跨实例仍串行，卸载后旧结果不落盘', async () => {
  const hold = deferred(), f = fixture({ ask: () => hold.promise })
  f.service.observe(batch()); await tick(); f.service.dispose()
  const again = fixture({ file: f.file })
  again.service.observe(batch('douyin')); await tick(); assert.equal(again.calls.length, 0)
  hold.resolve(output(normalizeBatch(batch()).items)); await f.service.waitForIdle(); await again.service.waitForIdle()
  assert.equal(again.calls.length, 1)
  assert.ok(again.service.list().every((r) => r.evidence.every((e) => e.platform === 'douyin')))
})

test('卸载后预览立即返回中断；等待旧物理通道时取消预览也不挂住管理请求', async () => {
  const hold = deferred(), f = fixture({ ask: () => hold.promise })
  f.service.observe(batch()); await tick(); f.service.dispose()
  assert.equal((await f.service.preview(batch())).reason, 'interrupted')
  const again = fixture({ file: f.file })
  const preview = again.service.preview(batch('douyin')); await tick()
  again.service.invalidate()
  assert.equal((await preview).reason, 'interrupted')
  hold.resolve('ignored'); await f.service.waitForIdle(); await again.service.waitForIdle()
  assert.equal(again.calls.length, 0)
})

test('手动预览超时先返回错误，迟到结果不应用且不并发开下一次', async () => {
  const hold = deferred(), f = fixture({ ask: () => hold.promise, timeoutMs: 15 })
  const keeping = setTimeout(() => hold.resolve('late'), 1000)
  const result = await f.service.preview(batch())
  assert.equal(result.reason, 'timeout')
  f.service.observe(batch('douyin')); await tick(); assert.equal(f.calls.length, 1)
  hold.resolve('late'); clearTimeout(keeping); await f.service.waitForIdle()
  assert.equal(f.calls.length, 2); assert.equal(f.service.list().length, 0)
})

test('队列有界，重复批次不入队，非法 JSON 不导致部分应用', async () => {
  const hold = deferred(), f = fixture({ ask: () => hold.promise })
  f.service.observe(batch()); assert.equal(f.service.observe(batch()).reason, 'duplicate')
  await tick()
  for (let i = 2; i <= 21; i++) assert.equal(f.service.observe(batch('bili', [i])).ok, true)
  assert.equal(f.service.observe(batch('bili', [22])).reason, 'full')
  f.service.invalidate(); hold.resolve('malformed'); await f.service.waitForIdle()
  assert.equal(f.service.list().length, 0)
})

test('知识合并来源，主人校订不会被旧在途结果覆盖，删除与拒绝屏蔽重学', async () => {
  const f = fixture()
  f.service.observe(batch()); await f.service.waitForIdle()
  const id = f.service.list()[0].id
  f.service.edit(id, { text: '主人确认的猫咪护理方法', pinned: true })
  f.service.observe(batch('douyin')); await f.service.waitForIdle()
  assert.equal(f.service.list().find((r) => r.id === id).text, '主人确认的猫咪护理方法')
  f.service.remove(id); f.service.observe(batch('bili', [3])); await f.service.waitForIdle()
  assert.ok(!f.service.list().some((r) => r.text === '猫咪需要定期清洁饮水碗'))
  const g = fixture(); g.service.observe(batch()); await g.service.waitForIdle()
  g.service.edit(g.service.list()[0].id, { status: 'rejected' })
  g.service.observe(batch('douyin')); await g.service.waitForIdle()
  assert.equal(g.service.list().length, 1); assert.equal(g.service.list()[0].status, 'rejected')
})

test('聊天召回有数量和字符预算，只用一个表达且不延长有效期；试运行不增加计数', async () => {
  const f = fixture()
  f.service.observe(batch()); await f.service.waitForIdle()
  const expiry = f.service.list()[0].expiresAt
  assert.match(f.service.prompt('猫咪护理'), /单来源说法，未核实/)
  assert.equal(f.service.list()[0].expiresAt, expiry)
  const uses = f.service.list()[0].uses
  f.set({ dryRun: true }); f.service.prompt('猫咪护理'); assert.equal(f.service.list()[0].uses, uses)
  const record = f.service.list()[0]
  const records = Array.from({ length: 8 }, (_, i) => ({ ...record, id: String(i), kind: i < 2 ? 'meme' : 'knowledge', usage: '聊天', example: '猫咪真可爱', avoid: '' }))
  const found = searchLearning(records, '猫咪护理', Date.now())
  assert.ok(found.length <= 3); assert.ok(found.filter((r) => r.kind === 'meme').length <= 1)
  f.advance(91 * DAY); assert.equal(f.service.recall('猫咪护理').length, 0)
  f.service.edit(record.id, { pinned: true }); assert.equal(f.service.recall('猫咪护理').length, 1)
})

test('模型改了标题但正文相同仍受删除屏蔽，不能靠换标题自动重学', async () => {
  let title = '猫咪护理'
  const f = fixture({ ask: async (o) => output(JSON.parse(o.text).items, { title }) })
  f.service.observe(batch()); await f.service.waitForIdle()
  f.service.remove(f.service.list()[0].id)
  title = '日常习惯的小提醒'
  f.service.observe(batch('douyin')); await f.service.waitForIdle()
  assert.deepEqual(f.service.list(), [])
})

test('同主题不同说法保持候选，重复来源不能自动解开冲突，主人选定后才恢复召回', async () => {
  let wording = '猫咪需要定期清洁饮水碗'
  const f = fixture({ ask: async (o) => output(JSON.parse(o.text).items, { text: wording }) })
  f.service.observe(batch()); await f.service.waitForIdle()
  wording = '这是一个完全不同的说法，不能自动选择哪个成立'
  f.service.observe(batch('douyin')); await f.service.waitForIdle()
  assert.equal(f.service.list().length, 2)
  assert.ok(f.service.list().every((r) => r.status === 'candidate'))
  wording = '猫咪需要定期清洁饮水碗'
  f.service.observe(batch('bili', [3])); await f.service.waitForIdle()
  assert.equal(f.service.recall('猫咪护理').length, 0)
  f.service.edit(f.service.list().find((r) => r.text === wording).id, { status: 'active' })
  assert.equal(f.service.recall('猫咪护理').length, 1)
})

test('单来源表达逐轮积累第二个来源后转可用，正文原样保留来源信息', async () => {
  const f = fixture({ result: { kind: 'meme' } })
  f.service.observe(batch()); await f.service.waitForIdle()
  assert.equal(f.service.list()[0].status, 'candidate')
  f.service.observe(batch('douyin')); await f.service.waitForIdle()
  const r = f.service.list()[0]
  assert.equal(r.status, 'active'); assert.equal(r.evidence.length, 2)
  assert.equal(r.evidenceStatus, 'corroborated')
})

test('兴趣需三内容两批次，每日变化上限、14 天半衰、B站最多一个学习词，重置不影响原配置', async () => {
  const f = fixture({ result: { topic: '猫咪' } })
  f.service.observe(batch('bili', [1, 2])); await f.service.waitForIdle()
  assert.deepEqual(f.service.interests(), [])
  f.service.observe(batch('douyin', [3, 4, 5, 6])); await f.service.waitForIdle()
  assert.equal(f.service.interests().length, 1)
  const r = f.service.interests()[0]
  assert.ok(r.changed <= 0.05); assert.ok(Math.abs(interestScore(r, r.at + 14 * DAY) - r.score / 2) < 1e-9)
  assert.deepEqual(withLearnedKeyword(['主人兴趣1', '主人兴趣2', '其他'], f.service.interests()), ['主人兴趣1', '主人兴趣2', '猫咪'])
  assert.deepEqual(f.service.rank([{ text: '无关' }, { text: '猫咪视频' }], (r) => r.text).map((r) => r.text), ['猫咪视频', '无关'])
  f.set({ group: { interests: ['天文'] } })
  assert.deepEqual(f.service.rank([{ text: '猫咪视频' }, { text: '天文内容' }], (r) => r.text).map((r) => r.text), ['天文内容', '猫咪视频'], '主人配置的兴趣优先于学习兴趣')
  f.service.resetInterests(); assert.deepEqual(f.service.interests(), [])
})

test('心情每批最多 2、每日累计最多 6，关闭联动不产生变化', async () => {
  const f = fixture({ result: { mood: 99 } })
  for (let i = 1; i <= 5; i++) f.service.observe(batch('bili', [i]))
  await f.service.waitForIdle(); assert.deepEqual(f.nudges, [2, 2, 2])
  f.settings({ affectMood: false }); f.service.observe(batch('bili', [6])); await f.service.waitForIdle()
  assert.deepEqual(f.nudges, [2, 2, 2])
})

test('目的引擎只提供有效知识，关配置立即停止；无额外模型调用', async () => {
  const f = fixture(); f.service.observe(batch()); await f.service.waitForIdle()
  assert.equal(f.service.materials().length, 1); assert.match(f.service.materials()[0].text, /未核实/)
  f.settings({ purpose: false }); assert.deepEqual(f.service.materials(), [])
  assert.equal(f.calls.length, 1)
})

test('重启不重放在途，未知版本和损坏数据保留原文件', () => {
  const file = join(directory(), 'state.json'), store = createLearningStore(file)
  store.update((s) => { s.running = { id: 'old', at: Date.now() }; s.quota = { day: dayKey(Date.now()), count: 3, mood: 0 } })
  const f = fixture({ file }); assert.equal(f.service.status().running, null); assert.equal(f.calls.length, 0)
  assert.equal(f.service.status().quota.count, 3)
  for (const raw of ['{"version":99}', '{broken']) {
    writeFileSync(file, raw, 'utf8'); assert.throws(() => fixture({ file })); assert.equal(readFileSync(file, 'utf8'), raw)
  }
})

test('管理路由只读查询可用；修改、删除、预览要求 POST JSON；系统轮不注入', async () => {
  const routes = new Map(), events = new Map(), dispose = [], builders = []
  let cfg = normalize({ enabled: true, dryRun: false, ext: { 'social-learning': { mode: 'structured' } } })
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = directory()
  try {
    const service = definition.setup({ config: () => cfg, ask: async (o) => output(JSON.parse(o.text).items), log: {},
      core: { personas: { current: () => '稳定人格' }, http: { body: async (r) => r.body, query: () => ({}) } },
      use: () => null, onDispose: (fn) => dispose.push(fn), on: (e, fn) => events.set(e, fn),
      tool: (fn) => builders.push(fn), defineTool: (o) => o, route: (p, fn) => routes.set(p, fn) })
    events.get('browse/observed')(batch()); await service.waitForIdle()
    const id = service.list()[0].id
    assert.equal((await routes.get('/learning/edit')({ method: 'GET', headers: {}, body: { id, status: 'rejected' } })).ok, false)
    assert.equal(service.list()[0].status, 'active')
    assert.equal((await routes.get('/learning/edit')({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: { id, status: 'rejected' } })).ok, true)
    const content = [{ type: 'text', text: '猫咪护理' }]
    assert.equal(events.get('prompt')(content, { chat: { kind: 'system' }, queryText: '猫咪护理' }), content)
    assert.deepEqual(builders[0]({ chat: { kind: 'system' } }), [])
    const old = cfg; cfg = normalize({ ...cfg, dryRun: true }); events.get('config')(cfg, old)
    dispose.forEach((fn) => fn())
  } finally { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous }
})
