/**
 * 能力判定纯函数单测（node --test，零依赖）。
 *
 * 覆盖 0.4.0 的核心契约：**只有明确接入不支持图片输入的模型时才介入**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  attachmentTag,
  autoOcrMode,
  isExplicitlyTextOnly,
  modalityCacheKey,
  pickRoute,
  refTagOf,
  shouldInjectOcrPath,
  withImageCapability,
} from '../dsh/capability.js'

test('autoOcrMode: 默认 auto，false 关闭，always 无条件介入', () => {
  assert.equal(autoOcrMode({}), 'auto')
  assert.equal(autoOcrMode({ autoOcr: true }), 'auto')
  assert.equal(autoOcrMode({ autoOcr: false }), 'off')
  assert.equal(autoOcrMode({ autoOcr: 'always' }), 'always')
  // 未知值退回默认，不放大成 always
  assert.equal(autoOcrMode({ autoOcr: 'yes' }), 'auto')
})

test('isExplicitlyTextOnly: 只有明确声明才为真', () => {
  assert.equal(isExplicitlyTextOnly(['text']), true)
  assert.equal(isExplicitlyTextOnly(['text', 'image']), false)
  assert.equal(isExplicitlyTextOnly(['image']), false)
  // 无法确定 → 不算「明确不支持」
  assert.equal(isExplicitlyTextOnly(undefined), false)
  assert.equal(isExplicitlyTextOnly(null), false)
  assert.equal(isExplicitlyTextOnly([]), false)
})

test('shouldInjectOcrPath: 视觉模型静默', () => {
  assert.equal(shouldInjectOcrPath('auto', ['text', 'image']), false)
})

test('shouldInjectOcrPath: 明确 text-only 时介入', () => {
  assert.equal(shouldInjectOcrPath('auto', ['text']), true)
})

test('shouldInjectOcrPath: 无法确定时静默（不打扰可能能看图的模型）', () => {
  assert.equal(shouldInjectOcrPath('auto', undefined), false)
  assert.equal(shouldInjectOcrPath('auto', []), false)
})

test('shouldInjectOcrPath: off 永不介入，always 无条件介入', () => {
  assert.equal(shouldInjectOcrPath('off', ['text']), false)
  assert.equal(shouldInjectOcrPath('off', ['text', 'image']), false)
  assert.equal(shouldInjectOcrPath('always', ['text', 'image']), true)
  assert.equal(shouldInjectOcrPath('always', undefined), true)
})

test('pickRoute: 按 待生效选择 → 请求头 → 创建路由 排序', () => {
  const options = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const header = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const pending = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

  assert.deepEqual(pickRoute({ pending, header, options }), { ...pending, source: 'pending' })
  assert.deepEqual(pickRoute({ header, options }), { ...header, source: 'header' })
  assert.deepEqual(pickRoute({ options }), { ...options, source: 'options' })
  assert.equal(pickRoute({}), undefined)
})

test('pickRoute: 跳过残缺候选，不把空串当路由', () => {
  assert.deepEqual(
    pickRoute({ pending: { provider: 'deepseek-official' }, options: { provider: 'p', model: 'm' } }),
    { provider: 'p', model: 'm', source: 'options' },
  )
  assert.deepEqual(
    pickRoute({ pending: { provider: '  ', model: 'm' } }),
    undefined,
  )
  assert.deepEqual(
    pickRoute({ header: { provider: ' p ', model: ' m ' } }),
    { provider: 'p', model: 'm', source: 'header' },
  )
})

test('pickRoute: 容忍 null（requestHeader 可能没有 config）', () => {
  assert.deepEqual(
    pickRoute({ pending: null, header: null, options: { provider: 'p', model: 'm' } }),
    { provider: 'p', model: 'm', source: 'options' },
  )
})

test('modalityCacheKey: provider/model 不互相串味', () => {
  assert.notEqual(modalityCacheKey('a', 'b'), modalityCacheKey('b', 'a'))
  assert.notEqual(modalityCacheKey('a', 'b'), modalityCacheKey('a', 'bc'))
})

test('端到端判定表: 各模型路由下的介入行为', () => {
  const cases = [
    ['deepseek-flash（声明 text+image）', 'auto', ['text', 'image'], false],
    ['deepseek-v4-pro（声明 text）', 'auto', ['text'], true],
    ['未登记 model id（适配器显式返回 text）', 'auto', ['text'], true],
    ['provider 未注册（查询失败 → undefined）', 'auto', undefined, false],
    ['强制 always', 'always', ['text', 'image'], true],
    ['强制 off', 'off', ['text'], false],
  ]
  for (const [label, mode, modalities, expected] of cases) {
    assert.equal(shouldInjectOcrPath(mode, modalities), expected, label)
  }
})

/* ------------------------------------------------------------------ */
/* 准入视图（0.4.3）：给 prompt 准入补 image，只影响 resolveModelInfo 这一层 */
/* ------------------------------------------------------------------ */

test('withImageCapability: text-only 补上 image', () => {
  assert.deepEqual(withImageCapability(['text']), ['text', 'image'])
})

test('withImageCapability: 已含 image 时原样返回（同引用，避免无谓复制）', () => {
  const modalities = ['text', 'image']
  assert.equal(withImageCapability(modalities), modalities)
})

test('withImageCapability: 无法确定（undefined/非数组）时不动', () => {
  // 准入只拦「显式声明了模态且不含 image」的情形，undefined 本就放行。
  assert.equal(withImageCapability(undefined), undefined)
  assert.equal(withImageCapability(null), null)
})

test('withImageCapability: 不修改入参', () => {
  const modalities = ['text']
  withImageCapability(modalities)
  assert.deepEqual(modalities, ['text'])
})

test('准入视图与介入判定互不污染', () => {
  const declared = ['text']
  // 对外（准入）看含 image → 放行；对内（判定）看真实声明 → 介入。
  assert.equal(isExplicitlyTextOnly(withImageCapability(declared)), false)
  assert.equal(isExplicitlyTextOnly(declared), true)
})

/* ------------------------------------------------------------------ */
/* 附件短标识（0.4.3）：让占位符里的 sha256 直接能定位到本地图片            */
/*                                                                     */
/* harness 给纯文本模型的占位符形如                                      */
/*   [image omitted because this model accepts text only; attachment sha256:2cd17c8d…] */
/* 把 sha256 前 8 位写进缓存文件名，模型把它当 ref 传回来就能找到图 ——      */
/* 不必去猜 harness 把附件对象存在哪。                                   */
/* ------------------------------------------------------------------ */

test('attachmentTag: 从附件 id 取 8 位小写 hex', () => {
  assert.equal(attachmentTag(`sha256:${'AB'.repeat(32)}`), 'abababab')
  assert.equal(attachmentTag('sha256:2cd17c8d9eec4c17'), '2cd17c8d')
  assert.equal(attachmentTag({ attachmentId: 'sha256:2cd17c8d9eec4c17' }), '2cd17c8d')
})

test('attachmentTag: 拿不到合法 id 时返回空串（不瞎编）', () => {
  assert.equal(attachmentTag(undefined), '')
  assert.equal(attachmentTag(''), '')
  assert.equal(attachmentTag('sha256:xyz'), '')
  assert.equal(attachmentTag({}), '')
})

test('refTagOf: 容忍 sha256: 前缀、完整值与 8 位前缀', () => {
  assert.equal(refTagOf('sha256:2cd17c8d9eec4c17'), '2cd17c8d')
  assert.equal(refTagOf('2cd17c8d9eec4c17'), '2cd17c8d')
  assert.equal(refTagOf('2cd17c8d'), '2cd17c8d')
  assert.equal(refTagOf('  2CD17C8D  '), '2cd17c8d')
})

test('refTagOf: 不足 8 位或非 hex 时判为不可用（宁可不匹配，也不误配到别的图）', () => {
  assert.equal(refTagOf('2cd1'), '')
  assert.equal(refTagOf('zzzzzzzz'), '')
  assert.equal(refTagOf(''), '')
  assert.equal(refTagOf(undefined), '')
})

test('attachmentTag 与 refTagOf 对同一张图给出同一个 key（回查闭环）', () => {
  const id = 'sha256:2cd17c8d9eec4c179ee0519eb34184435f19d1800921dc9c8e92b610ea819a5e'
  assert.equal(attachmentTag({ attachmentId: id }), refTagOf(id))
  assert.equal(attachmentTag({ attachmentId: id }), refTagOf('2cd17c8d'))
})
