// 学习数据独立于人物记忆；每次事务读最新文件，避免覆盖面板刚做的修改。
import { readFileSync } from 'node:fs'
import { writeJson } from '../core/store.js'
import { DAY } from './engine.js'

export function emptyLearningState() {
  return { version: 1, records: [], blocked: [], seen: [], batches: [], interests: {}, quota: { day: '', count: 0, mood: 0 }, running: null, history: [] }
}
export function createLearningStore(file) {
  function read() {
    let s
    try { s = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
      if (error.code === 'ENOENT') return emptyLearningState()
      throw new Error('学习数据无法读取，保留原文件：' + error.message)
    }
    if (!s) return emptyLearningState()
    if (s.version !== 1) throw new Error('学习数据版本不兼容，保留原文件')
    const out = { ...emptyLearningState(), ...s }
    for (const key of ['records', 'blocked', 'seen', 'batches', 'history']) if (!Array.isArray(out[key])) out[key] = []
    if (!out.interests || typeof out.interests !== 'object' || Array.isArray(out.interests)) out.interests = {}
    out.quota = { ...emptyLearningState().quota, ...out.quota }
    return out
  }
  function update(fn) {
    const s = read()
    const value = fn(s)
    s.seen = s.seen.slice(-4000)
    s.batches = s.batches.filter((b) => Date.now() - b.at < 7 * DAY).slice(-20)
    s.history = s.history.slice(-50)
    // 屏蔽标记与主人固定记录不因普通容量清理而消失。
    writeJson(file, s)
    return value
  }
  return { read, update }
}
