/**
 * dsh-ocr-local — host half (cordis plugin), Web only.
 *
 * 1. Registers the `ocr_image` tool: local PP-OCRv5 (ONNX Runtime) OCR on an
 *    image path, fully offline. Models cached in ~/.dsh-ocr/models.
 * 2. Registers the `ocr_setup` tool: one-command bootstrap (venv + deps +
 *    models), so first use is automatic instead of a manual pip dance.
 * 3. Auto-OCR (`autoOcr`): watches `user/message` events for image
 *    attachments. The Web composer intakes pasted image files natively, so
 *    the attachment is the single entry point — no client-side interception.
 *    Only when the routed model is **explicitly** declared as not accepting
 *    image input does the plugin save the image to ~/.dsh/ocr/cache and
 *    inject its path, so the text-only model can call `ocr_image` on it.
 *
 *    - model declares `image`  → silent; the vision path handles it, and the
 *      harness already gives the model a read-only copy path it may OCR when
 *      verbatim text matters.
 *    - model declares text only → the harness substitutes an opaque
 *      "[image omitted ...]" placeholder with no path, so this plugin is the
 *      only way the model can read the image.
 *    - cannot be determined      → silent (see dsh/capability.js).
 *
 * 4. Admission bridge: a text-only model declares no `image` capability, and
 *    the Host's prompt admission reads exactly that declaration to reject a
 *    pasted image *before* the message ever reaches the session — which would
 *    make (3) dead code. So this plugin widens `llm.resolveModelInfo`'s
 *    `inputModalities` with `image` and nothing else; request assembly reads
 *    the adapter's own catalog, so the image is still projected to a text
 *    placeholder before it reaches the wire. See `installAdmissionBridge`.
 *
 * Loaded via cordis.patch.yml; zero runtime dependencies (node builtins).
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  attachmentTag,
  autoOcrMode,
  modalityCacheKey,
  pickRoute,
  refTagOf,
  shouldInjectOcrPath,
  withImageCapability,
} from './capability.js'

export const name = 'dsh-ocr-local'
export const inject = ['tools', 'agents']

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..')
const OCR_SCRIPT = join(PLUGIN_ROOT, 'ocr', 'ocr.py')
const SETUP_SCRIPT = join(PLUGIN_ROOT, 'ocr', 'setup.py')
const OCR_HOME = join(homedir(), '.dsh-ocr')
const MODELS_DIR = join(OCR_HOME, 'models')
const VENV_DIR = join(OCR_HOME, 'venv')
/** 图片缓存目录（内容去重 + 按数量/天数清理）。 */
const CACHE_DIR = join(homedir(), '.dsh', 'ocr', 'cache')

/* ------------------------------------------------------------------ */
/* 环境解析                                                             */
/* ------------------------------------------------------------------ */

function venvPythonPath() {
  return process.platform === 'win32'
    ? join(VENV_DIR, 'Scripts', 'python.exe')
    : join(VENV_DIR, 'bin', 'python')
}

/** python 解析链：config.pythonPath → DSH_OCR_PYTHON → 内置 venv → python3 → python */
function resolvePython(config = {}) {
  const candidates = [
    config.pythonPath ? expandHome(String(config.pythonPath)) : undefined,
    process.env.DSH_OCR_PYTHON,
    venvPythonPath(),
    process.platform === 'win32' ? 'python.exe' : 'python3',
    'python',
  ].filter(Boolean)
  for (const c of candidates) {
    if (!/[/\\]/.test(c) || existsSync(c)) return c
  }
  return candidates[0]
}

/**
 * 展开开头的 `~`。
 *
 * 模型（和用户）非常自然地会写 `~/…`，而 node 的 `existsSync` 不认波浪号 ——
 * 不展开就会把明明存在的文件判成「不存在」。实测模型自己找到 harness 的附件对象后
 * 传进来的正是 `~/.dsh/attachments/v1/objects/…`。
 *
 * @param p - 原始路径。
 * @returns 展开后的路径。
 */
function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** 图片缓存目录：config.cacheDir 优先（支持 `~`），否则用默认。 */
function resolveCacheDir(config = {}) {
  return config.cacheDir ? expandHome(String(config.cacheDir)) : CACHE_DIR
}

/** 模型目录参数：config.modelDir 优先（支持 `~`），没配就不传。 */
function modelDirArg(config = {}) {
  return config.modelDir ? ['--model-dir', expandHome(String(config.modelDir))] : []
}

/* ------------------------------------------------------------------ */
/* OCR 执行与诊断                                                        */
/* ------------------------------------------------------------------ */

/**
 * 从可能带杂音的 stdout 里取出最后一个 JSON 对象。
 *
 * 两个 Python 脚本都会打进度和诊断行，机器要读的那份 JSON 约定放在最后一行。
 * 逐行倒着找比整段 `JSON.parse` 稳得多 —— 后者一旦被前导的 `[setup] …` 打乱就
 * 整个失败，用户拿到的只是「输出无法解析」这种毫无信息量的错。
 *
 * @param stdout - 子进程的完整 stdout。
 * @returns 解析出的对象；找不到时返回 null。
 */
function parseLastJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      return JSON.parse(line)
    } catch { /* 这行不是合法 JSON，继续往前找 */ }
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function runDoctor(config = {}) {
  return new Promise(resolve => {
    const python = resolvePython(config)
    execFile(
      python,
      ['-X', 'utf8', OCR_SCRIPT, '--doctor', ...modelDirArg(config)],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, python: { ok: false, error: 'python 不可用：' + String(error.message || error).slice(0, 120) } })
          return
        }
        resolve(parseLastJson(stdout) ?? { ok: false, python: { ok: true, error: 'doctor 输出无法解析' } })
      },
    )
  })
}

function runOcr(path, config = {}) {
  return new Promise(resolve => {
    const python = resolvePython(config)
    const args = [OCR_SCRIPT, path, '--full', ...modelDirArg(config)]
    execFile(
      python,
      ['-X', 'utf8', ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const pyErr = parseLastJson(stdout)
          const reason = pyErr && pyErr.error ? pyErr.error : String(error.message || error).slice(0, 300)
          runDoctor(config).then(doctor => resolve({ text: '', path, error: reason, doctor }))
          return
        }
        const data = parseLastJson(stdout)
        if (!data || !Array.isArray(data.lines)) {
          resolve({ text: '', path, error: 'OCR 输出无法解析' })
          return
        }
        resolve({
          text: data.lines.map(l => l.text).join('\n'),
          lines: data.lines,
          blocks: data.blocks || [],
          path,
          engine: 'ppocrv5',
        })
      },
    )
  })
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function missingNames(doctor) {
  const missing = []
  if (doctor.python && doctor.python.ok === false) missing.push('python')
  for (const [k, v] of Object.entries(doctor.dependencies || {})) if (!v.ok) missing.push(k)
  for (const [k, v] of Object.entries(doctor.models || {})) {
    if (!v.present) missing.push(k)
    else if (v.sha256_ok === false) missing.push(`${k}(损坏)`)
  }
  return missing
}

function renderText(value) {
  if (value.error) {
    const doc = value.doctor
    let hint
    if (doc && doc.ok === false) {
      const missing = missingNames(doc).join('、')
      hint = `环境未就绪，缺少: ${missing}。\n调用 ocr_setup 工具可一键安装（建 venv + 装依赖 + 下模型），或手动运行:\n  ${SETUP_SCRIPT}`
    } else {
      hint = `可调用 ocr_setup 工具检查/安装环境。`
    }
    return `[dsh-ocr] ${value.error}\n${hint}`
  }
  const head = `图片识别结果（${value.path}）：`
  const lines = value.lines || []
  const body = lines.map(l => l.text).join('\n').trim()
  const low = lines.filter(l => l.low_confidence)
  let tail = ''
  if (low.length) {
    const names = low.map(l => `「${l.text.slice(0, 10)}」(字高${l.font_px ?? '?'}px/置信${Math.round((l.confidence ?? 0) * 100)}%)`).join('、')
    tail = `\n\n⚠ 以下 ${low.length} 行字太小或检测置信度低，可能有误: ${names}`
  }
  return body ? `${head}\n${body}${tail}` : `${head}\n（未识别到文字）`
}

function renderSetup(value) {
  if (value.error) return `[dsh-ocr] 安装失败: ${value.error}`
  if (value.checkOnly) return `[dsh-ocr] ${value.ok ? '环境就绪 ✓' : '环境未就绪 ✗'}`
  const steps = Object.entries(value.steps || {})
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n')
  return `[dsh-ocr] 安装${value.ok ? '完成 ✓' : '未完成 ✗'}\n${steps}`
}

/* ------------------------------------------------------------------ */
/* 图片缓存：去重 + 类型感知命名 + 清理                                    */
/* ------------------------------------------------------------------ */

/** 附件媒体类型 → 落盘扩展名。 */
const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
}

/** timestamped cache filename: yyyyMMdd-HHmmss.fffffff-<hash8>[-<refTag8>]<ext> */
function pasteName(ext, hash, refTag, now = new Date()) {
  const p = (n, w) => String(n).padStart(w, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1, 2)}${p(now.getDate(), 2)}-` +
    `${p(now.getHours(), 2)}${p(now.getMinutes(), 2)}${p(now.getSeconds(), 2)}.` +
    `${p(now.getMilliseconds() * 10000, 7)}`
  const tail = refTag ? `${hash}-${refTag}` : hash
  return `${stamp}-${tail}${ext}`
}

/** 按内容哈希查重：返回已存在的相同图片路径（兼容带/不带 refTag 两种命名）。 */
function findByHashIn(hash, dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const n of names) {
    if (!n.includes(`-${hash}.`) && !n.includes(`-${hash}-`)) continue
    const p = join(dir, n)
    if (existsSync(p)) return p
  }
  return null
}

/** 按附件短标识查图：文件名形如 `…-<hash8>-<refTag8>.png`。 */
function findByRefTagIn(tag, dir) {
  if (!tag) return null
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const n of names) {
    if (!n.includes(`-${tag}.`)) continue
    const p = join(dir, n)
    if (existsSync(p)) return p
  }
  return null
}

function pruneCacheIn(dir, maxFiles, maxAgeDays) {
  if (maxFiles <= 0 && maxAgeDays <= 0) return
  let entries
  try {
    entries = readdirSync(dir)
      .map(n => {
        try {
          const s = statSync(join(dir, n))
          return s.isFile() ? { n, m: s.mtimeMs } : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return
  }
  const now = Date.now()
  if (maxAgeDays > 0) {
    for (const e of entries) {
      if (now - e.m > maxAgeDays * 864e5) {
        try {
          unlinkSync(join(dir, e.n))
        } catch { /* ignore */ }
      }
    }
  }
  if (maxFiles > 0) {
    const remaining = readdirSync(dir).length
    const excess = remaining - maxFiles
    if (excess > 0) {
      const alive = entries
        .sort((a, b) => a.m - b.m)
        .slice(0, excess)
      for (const e of alive) {
        try {
          unlinkSync(join(dir, e.n))
        } catch { /* ignore */ }
      }
    }
  }
}

/**
 * 保存图片字节到缓存目录（内容去重 + 类型命名 + 按 sha256 短标识回查 + 清理）。
 *
 * `opts.refTag` 是附件的 sha256 短标识，会拼进文件名。有它，模型只要把
 * `[image omitted … attachment sha256:XXXX]` 里的 XXXX 交给 `ocr_image` 的 `ref`
 * 就能定位到这张图 —— 不用去猜 harness 把附件存在哪。
 *
 * @param buffer - 图片字节。
 * @param mediaType - 声明的媒体类型。
 * @param opts - 缓存目录、清理策略、refTag。
 * @returns `{ path, deduped }`。
 */
function saveImageToCache(buffer, mediaType, opts = {}) {
  const dir = opts.cacheDir || CACHE_DIR
  const maxFiles = Number(opts.maxFiles ?? 300)
  const maxAgeDays = Number(opts.maxAgeDays ?? 30)
  const refTag = opts.refTag ? String(opts.refTag).slice(0, 8).toLowerCase() : ''
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 8)
  const existing = findByHashIn(hash, dir)
  // 内容命中还不够：得确认文件名里已经有这次要用的 refTag，否则模型按
  // sha256 前缀仍然搜不到。缺就另存一份带 tag 的（容量换可用性，值得）。
  if (existing && (refTag === '' || existing.includes(`-${refTag}.`))) {
    return { path: existing, deduped: true }
  }
  mkdirSync(dir, { recursive: true })
  const ext = IMAGE_EXT[mediaType] || '.png'
  const target = join(dir, pasteName(ext, hash, refTag))
  writeFileSync(target, buffer)
  pruneCacheIn(dir, maxFiles, maxAgeDays)
  return { path: target, deduped: false }
}

/**
 * 读取一个**可选**服务，不写进 inject 契约。
 *
 * `ctx.reflect.get(name)` 默认 strict：只返回「提供该服务的 fiber 当前处于活动
 * 状态」的实现。这里再退一步用 strict=false 兜底，避免因为作用域判定而让插件
 * 永久静默——静默本身是本插件的正常行为，但它必须来自「模型能力判定」，
 * 而不是来自「我们拿不到服务」。
 *
 * @param ctx - cordis 上下文。
 * @param name - 服务名。
 * @returns 服务实例，取不到时 undefined。
 */
function optionalService(ctx, name) {
  const reflect = ctx?.reflect
  if (!reflect || typeof reflect.get !== 'function') return undefined
  try {
    return reflect.get(name) ?? reflect.get(name, false)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* 准入桥：让纯文本模型也能收下粘贴的图片                                  */
/* ------------------------------------------------------------------ */

/** 挂在 llm 服务上的标记，存桥装好之前的 `resolveModelInfo`（已绑定 this）。 */
const BRIDGE_SLOT = Symbol.for('dsh-ocr-local.admission-bridge')

/**
 * 把 `llm.resolveModelInfo` 包装成「准入视图」：声明里没有 `image` 的模型补上
 * `image`，其余原样透传。
 *
 * 动机见 {@link withImageCapability} —— Host 的 prompt 准入用这个方法判定图片
 * 能力，`MODEL_DOES_NOT_SUPPORT_IMAGES` 抛在 `user/message` 事件之前，本插件的
 * autoOcr 因此在这条路径上永不触发（图片压根没进会话）。
 *
 * 安全性由两件事共同保证：
 *   1. 请求构造走适配器自己的 catalog（`adapter.prepareCall` /
 *      `adapter.resolveModel`），**不经过这个方法**，所以补出来的 `image`
 *      不会让适配器去发图片字节；
 *   2. LLM 服务层按适配器的真实能力把图片投影成
 *      `[image omitted because this model accepts text only; attachment sha256:…]`
 *      文本，适配器收到的消息里已经没有图片块。
 *
 * 所以这是「放行准入」，不是「谎报能力」。副作用是任何用 `resolveModelInfo`
 * 做能力预检的消费者（子代理续跑、acp、`read-image` 等）也会一并放行 —— 这
 * 恰恰是本插件要的结果。
 *
 * @param ctx - cordis 上下文。
 * @returns `{ real }`：桥之前的实现（已绑定 this），供插件自身判定真实能力；
 *   没装上时为 `{ real: undefined }`。
 */
function installAdmissionBridge(ctx) {
  const state = { real: undefined }
  const install = llmCtx => {
    const llm = llmCtx?.llm ?? optionalService(ctx, 'llm')
    if (!llm || typeof llm.resolveModelInfo !== 'function') return
    const existing = llm[BRIDGE_SLOT]
    if (typeof existing === 'function') {
      state.real = existing
      return
    }
    const original = llm.resolveModelInfo
    const real = original.bind(llm)
    const bridged = async (provider, model, signal) => {
      const info = await real(provider, model, signal)
      if (!info) return info
      const modalities = withImageCapability(info.inputModalities)
      return modalities === info.inputModalities ? info : { ...info, inputModalities: modalities }
    }
    llm.resolveModelInfo = bridged
    llm[BRIDGE_SLOT] = real
    state.real = real
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (llm.resolveModelInfo === bridged) {
          llm.resolveModelInfo = original
          delete llm[BRIDGE_SLOT]
        }
      })
    }
  }
  // 真实 cordis：等 llm 服务就绪再装（已就绪则立即执行）。
  // 极简宿主（单测的假 ctx）：没有 inject，直接按可选服务取。
  if (typeof ctx.inject === 'function') ctx.inject(['llm'], install)
  else install(undefined)
  return state
}

/**
 * Auto-OCR: 监听 user/message 里的图片附件，**只在路由到的模型明确不支持
 * 图片输入时**把图片存到 ~/.dsh/ocr/cache 并把路径注入 agent 上下文，让该模型
 * 调 ocr_image 本地识别。
 *
 * Web 端粘贴的图片由 composer 原生收进附件流程，插件不做任何客户端拦截。
 * 视觉模型下插件完全静默：harness 自己会在图片前附带只读副本路径，模型需要
 * 逐字核对时可直接调 ocr_image。判定逻辑见 dsh/capability.js。
 */
function registerAutoOcr(ctx, config = {}, bridge = {}) {
  const mode = autoOcrMode(config)
  if (mode === 'off') return
  const maxFiles = Number(config.maxCacheFiles ?? 300)
  const maxAgeDays = Number(config.maxCacheAgeDays ?? 30)
  // 缓存目录可覆盖（默认 ~/.dsh/ocr/cache，config 里支持 ~）；多实例并存时各自独立。
  const cacheDir = resolveCacheDir(config)
  // 已处理过的附件引用（防事件重放重复注入）；有界缓存。
  const seen = new Set()
  // session.id → 用户刚切换、尚未发请求的模型选择（来源优先级见 pickRoute）。
  const pendingRoutes = new Map()
  // `${provider}\0${model}` → inputModalities 数组 | null（查询失败）。
  const modalityCache = new Map()

  /** 解析某个 provider/model 声明的输入模态；失败或服务缺失返回 undefined。 */
  async function resolveModalities(route) {
    if (!route) return undefined
    const key = modalityCacheKey(route.provider, route.model)
    if (modalityCache.has(key)) return modalityCache.get(key) ?? undefined
    let modalities
    try {
      const llm = optionalService(ctx, 'llm')
      // ⚠ 必须读「准入桥之前」的实现：桥对外把 text-only 补成含 image，
      // 拿它判定会把纯文本模型误判成视觉模型 → 永久静默 → 本插件失效。
      const resolve = bridge.real
        ?? (llm && typeof llm.resolveModelInfo === 'function' ? llm.resolveModelInfo.bind(llm) : undefined)
      if (resolve) {
        const info = await resolve(route.provider, route.model)
        if (Array.isArray(info?.inputModalities) && info.inputModalities.length > 0) {
          modalities = [...info.inputModalities]
        }
      }
    } catch { /* 未注册 provider / 未知模型 / 适配器报错 → 视为无法确定 */ }
    modalityCache.set(key, modalities ?? null)
    return modalities
  }

  ctx.on('session/event', async (session, event) => {
    // 用户在客户端切换模型 → 记下待生效路由，供下一次判定优先采用。
    if (event.type === 'model/selection') {
      const route = pickRoute({ pending: event.data })
      if (route) pendingRoutes.set(session.id, route)
      return
    }
    if (event.type !== 'user/message') return
    const content = Array.isArray(event.data?.content) ? event.data.content : []
    const refs = content
      .filter(b => b && b.type === 'image' && b.attachment)
      .map(b => b.attachment)
    if (refs.length === 0) return

    const agent = ctx.agents?.get?.(session.id) || ctx.agents?.list?.().find(a => a.session?.id === session.id)
    if (!agent || typeof agent.inject !== 'function') return

    // 'always' 模式无条件介入，不必查询模型能力。
    if (mode !== 'always') {
      let header
      try {
        header = session.requestHeader?.()?.config
      } catch { /* 无请求头则退回其它来源 */ }
      const route = pickRoute({ pending: pendingRoutes.get(session.id), header, options: agent.options })
      const modalities = await resolveModalities(route)
      if (!shouldInjectOcrPath(mode, modalities)) return
    }

    const attachments = optionalService(ctx, 'attachments')
    if (!attachments || typeof attachments.readImage !== 'function') return
    const paths = []
    for (const ref of refs) {
      // 稳定标识是 attachmentId（sha256:…）；ref.id 只是兼容兜底。
      const refKey = ref.attachmentId ?? ref.id
      if (refKey && seen.has(refKey)) continue
      try {
        const stored = await attachments.readImage(ref)
        const bytes = Buffer.from(stored.data ?? stored)
        if (bytes.length === 0) continue
        const saved = saveImageToCache(bytes, ref.mediaType || 'image/png', {
          maxFiles,
          maxAgeDays,
          cacheDir,
          refTag: attachmentTag(ref),
        })
        if (refKey) seen.add(refKey)
        paths.push(saved.path)
      } catch { /* 附件读取失败则跳过，不影响其它图片 */ }
    }
    if (seen.size > 5000) seen.clear()
    if (paths.length === 0) return
    agent.inject({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: '用户附上了图片，当前模型不支持图片输入，图片已保存到本地缓存。'
          + '请用 ocr_image 工具读取其中的文字：\n' + paths.join('\n'),
      }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-ocr-local',
        form: 'notice',
        summary: `已保存 ${paths.length} 张图片到本地 OCR 缓存`,
      },
    })
  })
}

/* ------------------------------------------------------------------ */
/* 工具注册                                                             */
/* ------------------------------------------------------------------ */

function runSetup(python, argv) {
  return new Promise(resolve => {
    execFile(
      python,
      ['-X', 'utf8', ...argv],
      { encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // `--json` 模式下机器要读的那份 JSON 一定在 stdout 最后一行；诊断信息走 stderr。
        const data = parseLastJson(stdout)
        if (data) {
          resolve(data)
          return
        }
        const detail = String(error?.message || error || '').slice(0, 200)
        const tail = String(stderr || '').trim().split('\n').slice(-4).join('\n')
        resolve({ ok: false, error: [detail, tail].filter(Boolean).join('\n') || 'setup 输出无法解析' })
      },
    )
  })
}

export function apply(ctx, config = {}) {
  // autoOcr 关闭时连准入桥都不装：不留下任何对 Host 准入行为的改动。
  const bridge = autoOcrMode(config) === 'off' ? {} : installAdmissionBridge(ctx)
  registerAutoOcr(ctx, config, bridge)

  ctx.tools.register(defineTool({
    name: 'ocr_image',
    description:
      'Run local OCR (PP-OCRv5, fully offline) on an image and return its text — no vision model required. ' +
      'PRIMARY USE: when the conversation contains a placeholder like ' +
      '"[image omitted because this model accepts text only; attachment sha256:2cd17c8d…]", ' +
      'that placeholder IS the signal to call this tool: pass that sha256 as `ref` ' +
      '(the bare 8-character prefix is enough, e.g. ref: "2cd17c8d"). The plugin already saved that ' +
      'image locally when the message arrived, so do NOT go hunting the filesystem for it — just call ' +
      'this tool with the sha256 from the placeholder. ' +
      'Also usable with an explicit `path` (absolute, or ~/…) for any image file on disk, and — with a ' +
      'model that accepts image input — on the read-only copy path the harness sends beside the image, ' +
      'when you need verbatim characters (code, error messages, logs, table numbers) or per-line confidence ' +
      'instead of a visual reading. ' +
      'Returns the recognized text lines with per-line confidence, or a diagnosis (plus a hint to run the ' +
      'ocr_setup tool) when the OCR engine is not installed yet.',
    parameters: {
      ref: {
        type: 'string',
        description:
          'The "sha256:…" value (or its 8-character prefix) from an "[image omitted …]" placeholder. ' +
          'Preferred for images the user just sent. A file path is also accepted.',
      },
      path: {
        type: 'string',
        description: 'Absolute path of an image file (png/jpg/webp); ~/… is expanded. Use when there is no placeholder to read.',
      },
      full: {
        type: 'boolean',
        description: 'Return structured JSON (lines + blocks with confidence and box coordinates) instead of plain text.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    execute: async args => {
      const rawRef = String(args.ref ?? '').trim()
      const rawPath = String(args.path ?? '').trim()
      let target = ''
      let tag = ''
      if (rawPath) {
        target = expandHome(rawPath)
      } else if (rawRef) {
        // 容错：模型可能把路径塞进 ref。带分隔符的一律按路径处理。
        if (/[/\\]/.test(rawRef)) target = expandHome(rawRef)
        else tag = refTagOf(rawRef)
      }
      if (!target && !tag) {
        return {
          text: '',
          path: '',
          error: '需要 ref（"[image omitted …]" 占位符里的附件 sha256，如 2cd17c8d）或 path（图片文件路径）',
        }
      }
      if (!target && tag) {
        const dir = resolveCacheDir(config)
        const found = findByRefTagIn(tag, dir) || findByHashIn(tag, dir)
        if (!found) {
          return {
            text: '',
            path: '',
            error: `本地缓存里没有与 "${rawRef}" 对应的图片（缓存可能已被清理，或这张图不是本次会话收到的那张）。`
              + '请让用户重新发送一次图片后重试；也可以直接用 path 指定文件。',
          }
        }
        target = found
      }
      if (!existsSync(target)) {
        return { text: '', error: `图片文件不存在：${target}`, path: target }
      }
      const result = await runOcr(target, config)
      if (args.full) result.full = { lines: result.lines || [], blocks: result.blocks || [] }
      return result
    },
    timeoutMs: 120000,
  }))

  ctx.tools.register(defineTool({
    name: 'ocr_setup',
    description:
      'Install or verify the local OCR engine (creates a venv, installs onnxruntime/numpy/opencv, ' +
      'downloads the PP-OCRv5 models with sha256 verification). Use when ocr_image reports the engine ' +
      'is not ready. Idempotent — safe to run repeatedly. Supports a mirror via DSH_OCR_MODELS_MIRROR.',
    parameters: {
      checkOnly: {
        type: 'boolean',
        description: 'Only check readiness (python + deps + models), do not install anything.',
      },
      noModels: {
        type: 'boolean',
        description: 'Install dependencies only, skip model download.',
      },
      force: {
        type: 'boolean',
        description: 'Force reinstall dependencies even if imports succeed.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSetup(value) }],
    },
    execute: async args => {
      const python = resolvePython(config)
      const argv = [SETUP_SCRIPT, '--json']
      if (args.checkOnly) argv.push('--check')
      if (args.noModels) argv.push('--no-models')
      if (args.force) argv.push('--force')
      argv.push(...modelDirArg(config))
      const result = await runSetup(python, argv)
      result.checkOnly = Boolean(args.checkOnly)
      return result
    },
    timeoutMs: 900000,
  }))
}
