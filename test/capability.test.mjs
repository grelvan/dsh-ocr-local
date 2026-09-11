/**
 * 能力判定纯函数单测（node --test，零依赖）。
 *
 * 覆盖 0.4.0 的核心契约：**只有明确接入不支持图片输入的模型时才介入**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  autoOcrMode,
  isExplicitlyTextOnly,
  modalityCacheKey,
  pickRoute,
  shouldInjectOcrPath,
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
