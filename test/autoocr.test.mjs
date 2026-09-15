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
/**
 * 每个 host 一个独立缓存目录。
 *
 * node:test 会并发跑顶层用例，而缓存目录默认落在 HOME 下——共用一个目录时
 * `pruneCacheIn` 的 readdir/unlink 会互相打架，落盘异常又被 autoOcr 的
 * try/catch 吞掉，结果表现为「随机不注入」。隔离后结果与并发度无关。
 */
const CACHE_ROOT = mkdtempSync(join(HOME, 'caches-'))
let hostSeq = 0

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
  const cacheDir = options.cacheDir ?? join(CACHE_ROOT, `h${++hostSeq}`)

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

  plugin.apply(ctx, { ...config, cacheDir })

  return {
    tools,
    injected,
    stats,
    llm: llmService,
    ctx,
    cacheDir,
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

function cacheFiles(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 缓存目录文件快照，用于断言「这次事件有没有新增落盘」。 */
function cacheSnapshot(dir) {
  return new Set(cacheFiles(dir))
}

function newCacheFiles(dir, before) {
  return cacheFiles(dir).filter(name => !before.has(name))
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
  const before = cacheSnapshot(host.cacheDir)
  await host.emit(host.imageMessage('a-text'))

  assert.equal(host.injected.length, 1, '应当注入一条提示')
  assert.match(injectedText(host), /ocr_image/)

  const path = injectedPath(host)
  assert.ok(path, '提示里应含图片路径')
  assert.ok(path.startsWith(host.cacheDir), `路径应落在缓存目录：${path}`)
  assert.ok(existsSync(path), '提示里的路径必须真实存在')
  assert.equal(newCacheFiles(host.cacheDir, before).length, 1, '应当新增一张图片')
})

test('支持图片的模型：完全静默，不读附件不落盘不注入', needsPeer, async () => {
  const host = createHost({ modalities: ['text', 'image'] })
  const before = cacheSnapshot(host.cacheDir)
  await host.emit(host.imageMessage('a-vision'))

  assert.equal(host.injected.length, 0, '视觉模型下不应注入')
  assert.equal(host.stats.readImage, 0, '不应读取附件')
  assert.equal(newCacheFiles(host.cacheDir, before).length, 0, '不应写入缓存')
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

/* ------------------------------------------------------------------ */
/* 准入桥：让纯文本模型收下粘贴的图片（0.4.3）                             */
/*                                                                     */
/* Host 在 prompt 准入阶段读 llm.resolveModelInfo 判定图片能力，声明里没有  */
/* image 就抛 MODEL_DOES_NOT_SUPPORT_IMAGES —— 那时 user/message 还没发生。 */
/* 桥只在这一个公开方法上补 image，用于放行；请求构造走适配器自己的 catalog， */
/* 所以图片仍会被服务层投影成文本占位符，适配器拿不到图片字节。             */
/* ------------------------------------------------------------------ */

test('准入桥：对外把 text-only 补成含 image', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  const info = await host.llm.resolveModelInfo('p', 'm')
  assert.deepEqual(info.inputModalities, ['text', 'image'], '准入视图应含 image')
})

test('准入桥：声明 image 的模型原样透传，不重复追加', needsPeer, async () => {
  const host = createHost({ modalities: ['text', 'image'] })
  const info = await host.llm.resolveModelInfo('p', 'm')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('准入桥：无模态声明原样返回（准入本就放行）', needsPeer, async () => {
  const host = createHost({ modalities: undefined })
  const info = await host.llm.resolveModelInfo('p', 'm')
  assert.equal(info.inputModalities, undefined)
})

test('准入桥：插件自身判定仍读桥之前的真实能力，text-only 照常介入', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  const before = cacheSnapshot(host.cacheDir)
  await host.emit(host.imageMessage('b-bridge'))
  assert.equal(host.injected.length, 1, '桥放行准入，不应让插件误判成视觉模型而静默')
  assert.equal(newCacheFiles(host.cacheDir, before).length, 1)
})

test('准入桥：视觉模型在桥下依旧静默', needsPeer, async () => {
  const host = createHost({ modalities: ['text', 'image'] })
  await host.emit(host.imageMessage('b-vision'))
  assert.equal(host.injected.length, 0)
})

test("autoOcr: false 时不安装准入桥（不留下对 Host 准入的改动）", needsPeer, async () => {
  const host = createHost({ config: { autoOcr: false }, modalities: ['text'] })
  const info = await host.llm.resolveModelInfo('p', 'm')
  assert.deepEqual(info.inputModalities, ['text'], '关掉插件就不该改准入行为')
})

test("autoOcr: 'always' 时也装桥，且不查询能力", needsPeer, async () => {
  const host = createHost({ config: { autoOcr: 'always' }, modalities: ['text', 'image'] })
  const info = await host.llm.resolveModelInfo('p', 'm')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('准入桥：同一 llm 实例重复 apply 不叠加包装', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  const first = host.llm.resolveModelInfo
  plugin.apply(host.ctx, {})
  const second = host.llm.resolveModelInfo
  assert.equal(first === second, true, '已装过就不该重新包装')
  const info = await second('p', 'm')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('注入的消息带 id（Message.id 必需）', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  await host.emit(host.imageMessage('b-id'))
  assert.equal(host.injected.length, 1)
  assert.ok(host.injected[0].id, '注入消息必须有 id')
  assert.equal(host.injected[0].role, 'user')
  assert.equal(host.injected[0].source.kind, 'plugin')
})

/* ------------------------------------------------------------------ */
/* 0.4.3：让「占位符里的 sha256」直接可用 + 展开 ~                       */
/*                                                                     */
/* 注入路径要等下一个 step 才进上下文，模型第一个请求只看到 harness 的     */
/* [image omitted … attachment sha256:XXXX] 占位符 —— 所以让这个占位符    */
/* 本身就能用：文件名里写 sha256 短标识，ocr_image 用 ref 回查。          */
/* ------------------------------------------------------------------ */

test('缓存文件名带上附件短标识，可按 sha256 前缀回查', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  const before = cacheSnapshot(host.cacheDir)
  await host.emit(host.imageMessage(`sha256:${'cd'.repeat(32)}`))
  const added = newCacheFiles(host.cacheDir, before)
  assert.equal(added.length, 1, '应当新增一张图片')
  assert.match(added[0], /-cdcdcdcd\.png$/, `文件名应带附件短标识：${added[0]}`)
})

test('ocr_image: ref 是首选参数，path 不再必需，描述点名占位符', needsPeer, async () => {
  const host = createHost()
  const tool = host.tools.find(t => t.name === 'ocr_image')
  // defineTool 会把参数 spec 编译成 JSON Schema：看 properties / required。
  const props = tool.parameters.properties ?? {}
  const required = tool.parameters.required ?? []
  assert.ok(props.ref, '应有 ref 参数')
  assert.ok(props.path, 'path 参数应保留')
  assert.ok(!required.includes('path'), 'path 不应再是必需参数')
  assert.ok(!required.includes('ref'), 'ref 也不强制（单独给 path 也要能用）')
  assert.match(tool.description, /image omitted/, '描述里要点名「[image omitted …]」这个信号')
})

test('ocr_image: 用占位符里的 sha256 前缀能定位到刚缓存的图片', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  await host.emit(host.imageMessage(`sha256:${'ef'.repeat(32)}`))
  const tool = host.tools.find(t => t.name === 'ocr_image')
  const result = await tool.execute({ ref: 'efefefef' })
  // 测试机多半没装 OCR 引擎，result 会带「环境未就绪」；关键是**不该**报「没找到」。
  assert.ok(!/本地缓存里没有/.test(result.error ?? ''), `不应报找不到：${result.error}`)
  assert.ok(String(result.path).startsWith(host.cacheDir), `应解析到缓存路径：${result.path}`)
})

test('ocr_image: 未知 ref 给出可执行的下一步，而不是一句空白', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  const tool = host.tools.find(t => t.name === 'ocr_image')
  const result = await tool.execute({ ref: 'ffffffff' })
  assert.match(result.error ?? '', /重新发送/, '应提示让用户重发图片')
})

test('ocr_image: 展开 ~（模型很自然会传 ~/… 路径）', needsPeer, async () => {
  const host = createHost()
  const tool = host.tools.find(t => t.name === 'ocr_image')
  const result = await tool.execute({ path: '~/definitely-not-here-xyz.png' })
  assert.ok(!String(result.error).includes('：~/'), `报错里不该留着波浪号：${result.error}`)
  assert.match(result.error ?? '', /图片文件不存在：\//, '应报展开后的绝对路径')
})

test('ocr_image: ref 里塞了路径也当路径处理（容错）', needsPeer, async () => {
  const host = createHost()
  const tool = host.tools.find(t => t.name === 'ocr_image')
  const result = await tool.execute({ ref: '~/nope-xyz.png' })
  assert.match(result.error ?? '', /图片文件不存在：\//, '带分隔符的 ref 应按路径处理')
})

test('ocr_image: 两个参数都不给时明确要一个', needsPeer, async () => {
  const host = createHost()
  const tool = host.tools.find(t => t.name === 'ocr_image')
  const result = await tool.execute({})
  assert.match(result.error ?? '', /需要 ref/, result.error)
})

test('ocr_image: 同内容图片在不同 attachmentId 下各自可回查', needsPeer, async () => {
  const host = createHost({ modalities: ['text'] })
  const before = cacheSnapshot(host.cacheDir)
  await host.emit(host.imageMessage(`sha256:${'11'.repeat(32)}`))
  await host.emit(host.imageMessage(`sha256:${'22'.repeat(32)}`))
  const added = newCacheFiles(host.cacheDir, before)
  // 同一份字节（PNG_BYTES）被两次粘贴：内容去重不该让第二张丢掉自己的回查标识。
  assert.equal(added.length, 2, `两个 attachmentId 都应能回查：${added.join(', ')}`)
  assert.ok(added.some(n => n.includes('-11111111.')), added.join(', '))
  assert.ok(added.some(n => n.includes('-22222222.')), added.join(', '))
})
