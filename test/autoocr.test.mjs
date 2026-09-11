/**
 * autoOcr 行为集成测试：用假 cordis 宿主加载真实的 `dsh/index.js`，验证
 * 「只在模型明确不支持图片输入时介入」这条契约在真实代码路径上成立。
 *
 * 需要 peer 依赖 `@deepseek-ai/dsh-tools`（`defineTool` 的来源）。缺失时整组跳过：
 *
 *   npm install --no-save @deepseek-ai/dsh-tools@0.0.1-rc.1
 *
 * 注意：HOME 被指向临时目录，测试写入的图片缓存不会碰真实家目录。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// 必须在 import 插件之前设置：插件在模块顶层用 os.homedir() 计算缓存目录。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-ocr-home-'))
process.env.HOME = HOME
const CACHE_DIR = join(HOME, '.dsh', 'ocr', 'cache')

let plugin
let importError
try {
  plugin = await import('../dsh/index.js')
} catch (error) {
  importError = error
}

const needsPeer = importError
  ? { skip: `缺少 peer 依赖 @deepseek-ai/dsh-tools：${importError.message}` }
  : {}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** 造一个最小可用的假宿主，返回事件发射器与观测点。 */
function createHost(options = {}) {
  const {
    config = {},
    modalities, // 数组 → resolveModelInfo 返回它；Error 实例 → 抛错；undefined → 返回无模态
    llm = true,
    attachments = true,
    agentRoute = { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    headerRoute,
    // 模拟 cordis 的 strict 语义：llm 的提供 fiber 未处于活动状态，
    // 此时 reflect.get('llm') 返回 undefined，reflect.get('llm', false) 才拿得到。
    llmInactiveFiber = false,
  } = options

  const handlers = []
  const tools = []
  const injected = []
  const stats = { resolveModelInfo: 0, readImage: 0 }

  const agent = {
    options: agentRoute,
    session: {
      id: 's1',
      requestHeader: () => (headerRoute === undefined ? undefined : { config: headerRoute }),
    },
    inject: message => injected.push(message),
  }

  const llmService = llm
    ? {
        resolveModelInfo: async () => {
          stats.resolveModelInfo += 1
          if (modalities instanceof Error) throw modalities
          return modalities === undefined ? { provider: 'p', id: 'm', name: 'm' } : { inputModalities: modalities }
        },
      }
    : undefined

  const attachmentService = attachments
    ? {
        readImage: async ref => {
          stats.readImage += 1
          return { ref, data: PNG_BYTES }
        },
      }
    : undefined

  const ctx = {
    on: (type, handler) => handlers.push([type, handler]),
    tools: { register: tool => tools.push(tool) },
    agents: { get: id => (id === 's1' ? agent : undefined), list: () => [agent] },
    reflect: {
      get: (name, strict = true) => {
        if (name === 'llm' && llmInactiveFiber && strict === true) return undefined
        return name === 'attachments' ? attachmentService : name === 'llm' ? llmService : undefined
      },
    },
  }

  plugin.apply(ctx, config)

  return {
    tools,
    injected,
    stats,
    session: agent.session,
    async emit(event) {
      for (const [type, handler] of handlers) {
        if (type === 'session/event') await handler(agent.session, event)
      }
    },
    imageMessage: (id = 'sha256:aaaa1111') => ({
      type: 'user/message',
      data: {
        content: [{
          type: 'image',
          attachment: { attachmentId: id, mediaType: 'image/png', bytes: PNG_BYTES.length, width: 8, height: 8 },
        }],
      },
    }),
    selectionEvent: route => ({ type: 'model/selection', data: route }),
  }
}

function cacheFiles() {
  try {
    return readdirSync(CACHE_DIR)
  } catch {
    return []
  }
}

/** 缓存目录文件快照，用于断言「这次事件有没有新增落盘」。 */
function cacheSnapshot() {
  return new Set(cacheFiles())
}

function newCacheFiles(before) {
  return cacheFiles().filter(name => !before.has(name))
}

function injectedText(host) {
  return host.injected.map(m => m.content.map(b => b.text ?? '').join('')).join('\n')
}

/** 从注入文本里取出第一行绝对路径。 */
function injectedPath(host) {
  const match = injectedText(host).match(/^(\/[^\s]+|\S:\\[^\s]+)$/m)
  return match ? match[1] : undefined
}

test('明确 text-only 的模型：注入路径并把图片写进缓存', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  const before = cacheSnapshot()
  await host.emit(host.imageMessage('a-text'))

  assert.equal(host.injected.length, 1, '应当注入一条提示')
  assert.match(injectedText(host), /ocr_image/)

  const path = injectedPath(host)
  assert.ok(path, '提示里应含图片路径')
  assert.ok(path.startsWith(CACHE_DIR), `路径应落在缓存目录：${path}`)
  assert.ok(existsSync(path), '提示里的路径必须真实存在')
  assert.equal(newCacheFiles(before).length, 1, '应当新增一张图片')
})

test('支持图片的模型：完全静默，不读附件不落盘不注入', needsPeer, async () => {
  const host = createHost({ modalities: ['text', 'image'] })
  const before = cacheSnapshot()
  await host.emit(host.imageMessage('a-vision'))

  assert.equal(host.injected.length, 0, '视觉模型下不应注入')
  assert.equal(host.stats.readImage, 0, '不应读取附件')
  assert.equal(newCacheFiles(before).length, 0, '不应写入缓存')
  assert.equal(host.stats.resolveModelInfo, 1, '应查询过一次能力')
})

test('无法确定模态（服务返回无模态信息）：静默', needsPeer, async () => {
  const host = createHost({ modalities: undefined })
  await host.emit(host.imageMessage('a-unknown'))
  assert.equal(host.injected.length, 0)
})

test('没有 llm 服务：静默且不抛错', needsPeer, async () => {
  const host = createHost({ llm: false })
  await host.emit(host.imageMessage('a-nollm'))
  assert.equal(host.injected.length, 0)
  assert.equal(host.stats.resolveModelInfo, 0)
})

test('能力查询抛错（provider 未注册）：静默吞掉，不打断消息流', needsPeer, async () => {
  const host = createHost({ modalities: new Error('llm: unknown provider') })
  await host.emit(host.imageMessage('a-throw'))
  assert.equal(host.injected.length, 0)
})

test("autoOcr: 'always'：视觉模型下也无条件介入", needsPeer, async () => {
  const host = createHost({ config: { autoOcr: 'always' }, modalities: ['text', 'image'] })
  await host.emit(host.imageMessage('a-always'))
  assert.equal(host.injected.length, 1)
  assert.equal(host.stats.resolveModelInfo, 0, 'always 模式无需查询能力')
})

test('autoOcr: false：完全不介入，且不查询能力', needsPeer, async () => {
  const host = createHost({ config: { autoOcr: false }, modalities: ['text'] })
  await host.emit(host.imageMessage('a-off'))
  assert.equal(host.injected.length, 0)
  assert.equal(host.stats.resolveModelInfo, 0)
})

test('model/selection 事件把路由切到 text-only 时，优先于 agent.options', needsPeer, async () => {
  // agent 创建时是视觉模型，但用户刚切到纯文本模型。
  const host = createHost({
    modalities: ['text'],
    agentRoute: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  await host.emit(host.selectionEvent({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
  await host.emit(host.imageMessage('a-switch'))

  assert.equal(host.injected.length, 1, '应按切换后的纯文本模型介入')
})

test('没有图片的消息：不触碰任何服务', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  await host.emit({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } })
  assert.equal(host.injected.length, 0)
  assert.equal(host.stats.resolveModelInfo, 0)
})

test('同一路由的模态查询按 provider/model 缓存', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  await host.emit(host.imageMessage('a-cache-1'))
  await host.emit(host.imageMessage('a-cache-2'))
  assert.equal(host.injected.length, 2, '两条消息都应介入')
  assert.equal(host.stats.resolveModelInfo, 1, '第二次应命中缓存')
})

test('附件服务缺失：静默跳过，不抛错', needsPeer, async () => {
  const host = createHost({ modalities: ['text'], attachments: false })
  await host.emit(host.imageMessage('a-noattach'))
  assert.equal(host.injected.length, 0)
})

test('同一 attachmentId 的事件重放：只介入一次（防重复注入）', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  await host.emit(host.imageMessage('sha256:replay00'))
  await host.emit(host.imageMessage('sha256:replay00'))
  assert.equal(host.injected.length, 1, '重放不应重复注入')
  assert.equal(host.stats.readImage, 1, '重放不应重复读取附件')
})

test('llm 提供 fiber 非活动（strict 取不到）：退回 strict=false 仍能判定并介入', needsPeer, async () => {
  const host = createHost({ modalities: ['text'], llmInactiveFiber: true })
  await host.emit(host.imageMessage('a-strict'))
  assert.equal(host.injected.length, 1, '不应因为 strict 作用域判定而永久静默')
})

test('工具照常注册（ocr_image / ocr_setup）', needsPeer, async () => {
  const host = createHost()
  const names = host.tools.map(t => t.name).sort()
  assert.deepEqual(names, ['ocr_image', 'ocr_setup'])
})
