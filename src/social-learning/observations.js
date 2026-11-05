// 只转交平台已经读到的材料，不额外访问网页；各段保留类型以区分正文与评论。
export function biliObservation(looked, origin = 'browse') {
  return { platform: 'bili', origin, items: looked.map(({ info: v, subtitle, comments = [], vision }) => {
    const sections = [
      { kind: 'title', text: v.title }, { kind: 'description', text: v.desc },
      { kind: 'subtitle', text: subtitle }, { kind: 'vision', text: vision },
      { kind: 'comments', text: comments.slice(0, 8).map((c) => `${c.name}：${c.text}`).join('\n') },
    ].filter((s) => s.text)
    return { id: v.bvid, title: v.title, author: v.author, publishedAt: v.pubdate, sections }
  }) }
}

export function douyinObservation(looked, origin = 'browse') {
  return { platform: 'douyin', origin, items: looked.map(({ v, comments = [], transcript = '', vision = '' }) => ({
    id: v.awemeId, title: v.title, author: v.author, publishedAt: v.createdAt,
    sections: [
      { kind: 'title', text: v.title }, { kind: 'description', text: v.desc },
      { kind: 'summary', text: v.summary },
      { kind: 'chapters', text: typeof v.chapters === 'string' ? v.chapters : (v.chapters || []).map((c) => typeof c === 'string' ? c : c.title || c.desc || '').join('\n') },
      { kind: 'subtitle', text: transcript }, { kind: 'vision', text: vision },
      { kind: 'comments', text: comments.slice(0, 8).map((c) => `${c.name || c.nickname || ''}：${c.text || ''}`).join('\n') },
    ].filter((s) => s.text),
  })) }
}

export function withLearnedKeyword(keywords, interests = []) {
  const base = [...new Set(keywords)]
  const topic = interests.find((r) => r.score > 0 && !base.includes(r.topic))?.topic
  return topic ? [...base.slice(0, 2), topic] : base.slice(0, 3)
}
