// 抖音「看画面 / 听声音」的纯逻辑测试：播放地址、自带字幕解析、抽帧 + 视觉、音频 + 语音识别。
// 不联网、不调 ffmpeg、不碰浏览器；模型和 ffmpeg 都用假的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickPlayUrl, captionTracks, parseCaption, fetchCaption, lookAt, mediaState } from '../src/douyin/media.js'
import { normalizeAweme, digestOf } from '../src/douyin/site.js'
import { normalize } from '../src/core/config.js'

test('配置：看画面 / 听声音的默认值、夹取和非法值兜底', () => {
  const d = normalize({}).douyin
  assert.equal(d.vision, false, '默认不看画面')
  assert.equal(d.visionFrames, 4)
  assert.equal(d.transcript, 'off', '默认不听声音')
  assert.equal(d.asrMaxSeconds, 120)
  assert.equal(d.ffmpegPath, '')

  const on = normalize({ douyin: { vision: true, visionFrames: 99, transcript: 'auto', asrMaxSeconds: 5, ffmpegPath: ' D:\\ffmpeg\\bin\\ffmpeg.exe ' } }).douyin
  assert.equal(on.vision, true)
  assert.equal(on.visionFrames, 10, '帧数夹在 2~10')
  assert.equal(on.transcript, 'auto')
  assert.equal(on.asrMaxSeconds, 10, '最少 10 秒')
  assert.equal(on.ffmpegPath, 'D:\\ffmpeg\\bin\\ffmpeg.exe', '路径去空格')

  assert.equal(normalize({ douyin: { transcript: '乱写' } }).douyin.transcript, 'off')
  assert.equal(normalize({ douyin: { visionFrames: 1 } }).douyin.visionFrames, 2)
})

test('pickPlayUrl：play_addr 优先，没给就翻 bit_rate；图文 / 空数据返回空串', () => {
  assert.equal(pickPlayUrl({ video: { play_addr: { url_list: ['https://cdn.example/a.mp4'] } } }), 'https://cdn.example/a.mp4')
  assert.equal(pickPlayUrl({ video: { bit_rate: [{ play_addr: { url_list: ['https://cdn.example/b.mp4'] } }] } }), 'https://cdn.example/b.mp4')
  assert.equal(pickPlayUrl({ playUrl: 'https://cdn.example/c.mp4' }), 'https://cdn.example/c.mp4', 'normalize 之后的对象直接用')
  assert.equal(pickPlayUrl({ images: [{ url_list: ['https://x/1.jpg'] }] }), '', '图文没有视频')
  assert.equal(pickPlayUrl(null), '')
  assert.equal(pickPlayUrl({ video: { play_addr: { url_list: ['ftp://x'] } } }), '', '只要 http / https')
})

test('captionTracks：抖音自带 AI 字幕，只留 http(s) 地址', () => {
  const t = captionTracks({ video: { cla_info: { caption_infos: [{ lang: 'zh-CN', url: 'https://cdn.example/c.json' }, { lang: 'en', url: '' }] } } })
  assert.deepEqual(t, [{ lang: 'zh-cn', url: 'https://cdn.example/c.json' }])
  assert.deepEqual(captionTracks({ video: {} }), [])
  assert.deepEqual(captionTracks(null), [])
})

test('parseCaption：JSON 逐句 / SRT / VTT / 纯文本；空 JSON 当没字幕', () => {
  assert.equal(parseCaption('{"utterances":[{"text":"它自己把门"},{"text":"拉开了"}]}'), '它自己把门拉开了')
  assert.equal(parseCaption('1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:04,000 --> 00:00:06,000\n第二句'), '第一句第二句')
  assert.equal(parseCaption('WEBVTT\n\n00:00.000 --> 00:02.000\nhello'), 'hello')
  assert.equal(parseCaption('  一段普通字幕  '), '一段普通字幕')
  assert.equal(parseCaption(''), '')
  assert.equal(parseCaption('{"utterances":[]}'), '', '解析出来没句子，别把 JSON 原样塞进摘要')
  assert.equal(parseCaption('啊'.repeat(3000)).length, 2000, '超长截断')
})

test('fetchCaption：优先中文轨；HTTP 错误 / 网络异常 / 没有轨都返回空串', async () => {
  const seen = []
  const ok = async (url) => { seen.push(url); return { ok: true, text: async () => '{"utterances":[{"text":"你好"}]}' } }
  assert.equal(await fetchCaption([{ lang: 'en', url: 'https://cdn/e' }, { lang: 'zh', url: 'https://cdn/z' }], { fetchImpl: ok }), '你好')
  assert.equal(seen[0], 'https://cdn/z', '中文轨优先')
  const bad = async () => ({ ok: false, status: 403, text: async () => '' })
  assert.equal(await fetchCaption([{ lang: 'zh', url: 'https://cdn/z' }], { fetchImpl: bad }), '')
  const boom = async () => { throw new Error('网络断了') }
  assert.equal(await fetchCaption([{ lang: 'zh', url: 'https://cdn/z' }], { fetchImpl: boom }), '')
  assert.equal(await fetchCaption([], { fetchImpl: ok }), '')
})

/** 一套假的依赖：记下谁被调用，方便断言「没开开关就不该动」。 */
function pipeline(o = {}) {
  const calls = []
  const cfg = { model: {}, douyin: { vision: true, visionFrames: 2, transcript: 'caption', asrMaxSeconds: 120, ffmpegPath: '', ...(o.douyin || {}) } }
  const info = {
    title: '猫开门', author: '猫', duration: 30, playUrl: 'https://cdn.example/v.mp4',
    captions: [{ lang: 'zh', url: 'https://cdn.example/c.json' }], ...(o.info || {}),
  }
  const stt = o.stt === undefined ? { resolve: () => ({ audio: 1 }), transcribe: async () => ({ text: '听见的话' }) } : o.stt
  const deps = {
    findFfmpeg: () => 'ffmpeg',
    assertPublicUrl: async () => { calls.push('assert') },
    canSeeImages: async () => true,
    grabFrame: async (_exe, _url, at) => { calls.push(['frame', at]); return Buffer.from('jpeg') },
    describeFrames: async (_dsh, { frames }) => { calls.push(['describe', frames.length]); return '一只猫在扒门。' },
    fetchCaption: async () => { calls.push('caption'); return '它自己把门拉开了' },
    transcribeAudio: async () => { calls.push('asr'); return '识别出来的话' },
    ...(o.deps || {}),
  }
  const dsh = { get: () => (stt === null ? null : stt) }
  return { cfg, info, deps, dsh, calls }
}

test('看画面 / 听声音：两个开关都关着时不发请求、不碰 ffmpeg', async () => {
  const { cfg, info, deps, dsh, calls } = pipeline({ douyin: { vision: false, transcript: 'off' } })
  assert.deepEqual(await lookAt({ dsh, cfg, info, log: { debug() {} }, deps }), { transcript: '', vision: '' })
  assert.deepEqual(calls, [])
})

test('看画面 / 听声音：字幕 + 抽帧都拿到，两段各自返回', async () => {
  const { cfg, info, deps, dsh, calls } = pipeline()
  const r = await lookAt({ dsh, cfg, info, log: { debug() {} }, deps })
  assert.equal(r.transcript, '它自己把门拉开了')
  assert.equal(r.vision, '一只猫在扒门。')
  assert.deepEqual(calls.filter((x) => Array.isArray(x) && x[0] === 'frame').length, 2, '按 visionFrames 抽两帧')
  assert.ok(calls.some((x) => Array.isArray(x) && x[0] === 'describe' && x[1] === 2), '两帧一起交给视觉模型')
})

test('听声音：只读字幕模式没有字幕就空着，不会去抽音频', async () => {
  const { cfg, info, deps, dsh, calls } = pipeline({ info: { captions: [] }, douyin: { vision: false, transcript: 'caption' } })
  assert.deepEqual(await lookAt({ dsh, cfg, info, log: { debug() {} }, deps }), { transcript: '', vision: '' })
  assert.ok(!calls.includes('asr'), '没字幕也不该去找语音识别')
  assert.ok(!calls.includes('caption'), '没有字幕轨就不该去下载')
})

test('听声音：auto 模式没有字幕时把音频交给本机识别', async () => {
  const { cfg, info, deps, dsh, calls } = pipeline({ info: { captions: [] }, douyin: { vision: false, transcript: 'auto' } })
  const r = await lookAt({ dsh, cfg, info, log: { debug() {} }, deps })
  assert.equal(r.transcript, '识别出来的话')
  assert.ok(calls.includes('asr'))
  assert.ok(calls.includes('assert'), '抽音频前照样校验地址')
})

test('看画面：模型不支持图片 / 没 ffmpeg 时不抽帧，但字幕照常', async () => {
  for (const over of [{ deps: { canSeeImages: async () => false } }, { deps: { findFfmpeg: () => '' } }]) {
    const { cfg, info, deps, dsh, calls } = pipeline({ douyin: { transcript: 'caption' }, ...over })
    const r = await lookAt({ dsh, cfg, info, log: { debug() {} }, deps })
    assert.equal(r.vision, '')
    assert.equal(r.transcript, '它自己把门拉开了')
    assert.ok(!calls.some(Array.isArray), '不抽帧、不调视觉模型')
  }
})

test('看画面 / 听声音：没地址、地址不合法、抽不到帧、模型报错都只是空着，不抛', async () => {
  const cases = [
    { info: { playUrl: '' } },
    { deps: { assertPublicUrl: async () => { throw new Error('内网地址') } } },
    { deps: { grabFrame: async () => null } },
    { deps: { describeFrames: async () => { throw new Error('模型挂了') } } },
  ]
  for (const over of cases) {
    const { cfg, info, deps, dsh } = pipeline({ douyin: { transcript: 'caption' }, ...over })
    const r = await lookAt({ dsh, cfg, info, log: { debug() {} }, deps })
    assert.equal(r.vision, '', '画面这一项应该是空的')
    assert.equal(typeof r.transcript, 'string')
  }
  // 字幕挂了不影响画面
  const { cfg, info, deps, dsh } = pipeline({ douyin: { transcript: 'caption' }, deps: { fetchCaption: async () => { throw new Error('字幕 403') } } })
  const r = await lookAt({ dsh, cfg, info, log: { debug() {} }, deps })
  assert.equal(r.transcript, '')
  assert.equal(r.vision, '一只猫在扒门。')
})

test('mediaState：本机能力和配置分开报，乱填的档位归 off', () => {
  const st = mediaState({ douyin: { transcript: 'caption' } }, null)
  assert.equal(st.transcript, 'caption')
  assert.equal(st.asr, false, '没有宿主语音输入')
  assert.equal(typeof st.ffmpeg, 'boolean')
  assert.equal(mediaState({ douyin: { transcript: '乱写' } }, null).transcript, 'off')
  assert.equal(mediaState({}, null).vision, false)
  assert.equal(mediaState({ douyin: { transcript: 'auto' } }, { get: () => ({ resolve() {}, transcribe() {} }) }).asr, true)
})

test('digestOf：字幕 / 画面写进摘要，位置在热评前面', () => {
  const v = { title: '猫开门', author: '猫', likes: 1, comments: 2, category: [], chapters: [], desc: '文案' }
  const plain = digestOf(v, [{ name: '路人', text: '好看', likes: 1 }])
  assert.ok(!plain.includes('画面（抽帧）'), '没开就不该有这一行')
  assert.ok(!plain.includes('字幕 / 语音'))
  const d = digestOf(v, [{ name: '路人', text: '好看', likes: 1 }], { transcript: '它自己把门拉开了', vision: '一只猫在扒门。' })
  assert.match(d, /字幕 \/ 语音（节选）：它自己把门拉开了/)
  assert.match(d, /画面（抽帧）：一只猫在扒门。/)
  assert.ok(d.indexOf('画面（抽帧）') < d.indexOf('热评'), '画面在热评前')
})

test('normalizeAweme：带上可抽帧的播放地址和字幕轨', () => {
  const v = normalizeAweme({
    aweme_id: '7000000000000000001',
    video: { duration: 30000, play_addr: { url_list: ['https://cdn.example/v.mp4'] }, cla_info: { caption_infos: [{ lang: 'zh', url: 'https://cdn.example/c.json' }] } },
  })
  assert.equal(v.playUrl, 'https://cdn.example/v.mp4')
  assert.deepEqual(v.captions, [{ lang: 'zh', url: 'https://cdn.example/c.json' }])
  assert.equal(v.duration, 30)
})
