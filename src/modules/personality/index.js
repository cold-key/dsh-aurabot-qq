// 独立人格档案默认关闭，面板明确创建并启用后才采集经历和成长。
import { dataDir, readJson } from '../../core/store.js'
import { savePersona } from '../../persona/personas.js'
import { createPersonality } from '../../personality/service.js'
import { DEFAULT_PERSONALITY, YINGBAO, publicPersona, digest, settingsOf } from '../../personality/engine.js'

export default {
  id: 'personality', name: '人格成长', version: '1.0.0', api: 1, tab: 'growth', defaults: DEFAULT_PERSONALITY,
  description: '独立出生档案、真实经历、每日反思和缓慢人格演化；重大变化先审阅，默认关闭',
  files: ['personality/engine.js', 'personality/store.js', 'personality/service.js'],
  setup(api) {
    const service = createPersonality({ file: dataDir('modules-data', 'personality', 'state.json'), getConfig: api.config, ask: api.ask, log: api.log })
    api.onDispose(service.dispose)
    const signature = (c) => JSON.stringify([settingsOf(c), c.enabled, c.dryRun, c.botQQ, c.ownerQQ, c.persona, c.model])
    api.on('config', (c, before) => { if (signature(c) !== signature(before)) service.invalidate() })
    api.on('experience/recorded', service.observe)
    api.on('activity', (a) => {
      if (a.kind !== 'in') return
      service.observe({ source: 'chat', originId: a.eventId || '', text: a.text, actor: 'user', status: 'received',
        userId: a.userId, chatId: a.chatId, session: a.roundId || a.eventId, direct: a.direct, at: a.at, simulated: a.simulated })
    })
    api.on('browse/observed', (b) => {
      for (const item of b.items || []) {
        const text = (item.sections || []).map((s) => s.text).filter(Boolean).join('\n') || item.text
        service.observe({ source: 'browse', originId: b.platform + ':' + item.id, text, status: 'read', actor: 'agent',
          voluntary: b.voluntary === true, session: b.batchId || digest([b.platform, (b.items || []).map((r) => r.id)]), at: Date.now() })
      }
    })
    api.context(({ chat }) => service.relationship(chat))
    api.every(60_000, () => service.tick(), '人格反思')
    const http = api.core.http
    const write = (fn) => async (req) => {
      if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) return { ok: false, message: '人格管理需要 POST JSON' }
      const b = await http.body(req)
      if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, message: '需要 JSON 对象' }
      if (api.use('personality') !== service) return { ok: false, message: '人格模块实例已变化，请刷新' }
      return fn(b)
    }
    api.route('/personality/status', () => ({ ...service.status(), seed: YINGBAO }))
    api.route('/personality/create', write((b) => {
      const r = service.create(b.seed)
      if (r.ok) savePersona(r.profile.personaId, { name: r.profile.state.identity.name, tags: ['独立档案'], body: publicPersona(r.profile) })
      return r
    }))
    api.route('/personality/activate', write((b) => {
      const r = service.activate(String(b.id || ''))
      if (r.ok) api.setConfig((c) => ({ ...c, persona: { ...c.persona, current: r.personaId }, ext: { ...c.ext, personality: { ...settingsOf(c), enabled: true } } }))
      return r
    }))
    api.route('/personality/reflect', write((b) => service.reflect({ preview: b.preview === true })))
    api.route('/personality/review', write((b) => service.review(Array.isArray(b.ids) ? b.ids.map(String) : [String(b.id || '')], b.approve === true, b.revision)))
    api.route('/personality/edit', write((b) => service.edit(b, b.revision)))
    api.route('/personality/freeze', write((b) => service.freeze(String(b.path || ''), b.frozen === true, b.revision)))
    api.route('/personality/rollback', write((b) => service.rollback(b.targetRevision, b.revision)))
    api.route('/personality/forget-relationship', write((b) => service.forgetRelationship(String(b.userId || ''), b.revision)))
    const legacyFacts = () => (readJson(dataDir('memories.json'), { items: [] }).items || []).filter((m) => !m.invalidAt && ['auto', 'tool', 'panel', 'import'].includes(m.source) && m.about && !/大肥鱼|我在|我喜欢|我和/.test(m.text)).slice(-200)
    api.route('/personality/legacy-memories', () => ({ ok: true, items: legacyFacts() }))
    api.route('/personality/import-memories', write((b) => {
      if (!service.current()) return { ok: false, message: '请先启用目标档案' }
      const memory = api.use('memory')
      if (!memory?.add) return { ok: false, message: '记忆模块未运行' }
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 100) : []
      const items = legacyFacts().filter((m) => ids.includes(m.id))
      for (const m of items) memory.add({ text: m.text, about: m.about, aboutName: m.aboutName, importance: m.importance, source: 'import', tags: ['人工迁移'] })
      return { ok: true, message: `已明确导入${items.length}条人物事实，未导入旧自我经历或关系结论` }
    }))
    api.route('/personality/reset-chat', write((b) => {
      if (!/^(private|group):\d+$/.test(String(b.chatId || ''))) return { ok: false, message: '请选择要独立开始的会话' }
      return { ok: true, reset: api.core.hub.resetChat(b.chatId), message: '该会话已归档，下一条消息重新开始；旧记录保留' }
    }))
    return service
  },
}
