// 一个原子文件同时提交额度、档案与版本，避免多文件更新中断后状态错配。
import { readFileSync } from 'node:fs'
import { writeJson } from '../core/store.js'
import { DAY } from './engine.js'

export function createPersonalityStore(file, now = Date.now) {
  function read() {
    let value
    try { value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, activeId: '', profiles: [], quota: { day: '', count: 0 }, running: null, history: [] }
      throw new Error('人格数据无法读取，保留原文件')
    }
    if (value?.version !== 1 || !Array.isArray(value.profiles) || !value.quota) throw new Error('人格数据版本不兼容，保留原文件')
    return value
  }
  function update(fn) {
    const s = read(), result = fn(s)
    for (const p of s.profiles) {
      p.events = p.events.filter((e) => now() - e.at <= 90 * DAY).slice(-5000)
      p.seen = p.seen.slice(-10000); p.processed = p.processed.slice(-10000)
      p.changes = p.changes.slice(-1000); p.snapshots = p.snapshots.slice(-200)
      p.proposals = p.proposals.slice(-50); p.rejected = p.rejected.slice(-200)
    }
    s.history = s.history.slice(-100)
    writeJson(file, s)
    return result
  }
  return { read, update }
}
