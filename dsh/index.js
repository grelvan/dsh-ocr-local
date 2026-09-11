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
 * Loaded via cordis.patch.yml; zero runtime dependencies (node builtins).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { autoOcrMode, modalityCacheKey, pickRoute, shouldInjectOcrPath } from './capability.js'

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
    config.pythonPath,
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

/* ------------------------------------------------------------------ */
/* OCR 执行与诊断                                                        */
/* ------------------------------------------------------------------ */

function runDoctor(config = {}) {
  return new Promise(resolve => {
    const python = resolvePython(config)
    execFile(
      python,
      ['-X', 'utf8', OCR_SCRIPT, '--doctor', ...(config.modelDir ? ['--model-dir', config.modelDir] : [])],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, python: { ok: false, error: 'python 不可用：' + String(error.message || error).slice(0, 120) } })
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve({ ok: false, python: { ok: true, error: 'doctor 输出无法解析' } })
        }
      },
    )
  })
}

function runOcr(path, config = {}) {
  return new Promise(resolve => {
    const python = resolvePython(config)
    const args = [OCR_SCRIPT, path, '--full', ...(config.modelDir ? ['--model-dir', config.modelDir] : [])]
    execFile(
      python,
      ['-X', 'utf8', ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          let pyErr = null
          try {
            pyErr = JSON.parse(stdout.trim())
          } catch { /* stdout 不是 JSON */ }
          const reason = pyErr && pyErr.error ? pyErr.error : String(error.message || error).slice(0, 300)
          runDoctor(config).then(doctor => resolve({ text: '', path, error: reason, doctor }))
          return
        }
        let data = null
        try {
          data = JSON.parse(stdout)
        } catch { /* ignore */ }
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

/** timestamped cache filename: yyyyMMdd-HHmmss.fffffff-<hash8><ext> */
function pasteName(ext, hash, now = new Date()) {
  const p = (n, w) => String(n).padStart(w, '0')
  const base = `${now.getFullYear()}${p(now.getMonth() + 1, 2)}${p(now.getDate(), 2)}-` +
    `${p(now.getHours(), 2)}${p(now.getMinutes(), 2)}${p(now.getSeconds(), 2)}.` +
    `${p(now.getMilliseconds() * 10000, 7)}-${hash}`
  return `${base}${ext}`
}

/** 按内容哈希查重：返回已存在的相同图片路径 */
function findByHashIn(hash, dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const n of names) {
    if (n.includes(`-${hash}.`)) {
      const p = join(dir, n)
      if (existsSync(p)) return p
    }
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

/** 保存图片字节到缓存目录（内容去重 + 类型命名 + 清理）。返回路径。 */
function saveImageToCache(buffer, mediaType, opts = {}) {
  const dir = opts.cacheDir || CACHE_DIR
  const maxFiles = Number(opts.maxFiles ?? 300)
  const maxAgeDays = Number(opts.maxAgeDays ?? 30)
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 8)
  const existing = findByHashIn(hash, dir)
  if (existing) return { path: existing, deduped: true }
  mkdirSync(dir, { recursive: true })
  const ext = IMAGE_EXT[mediaType] || '.png'
  const target = join(dir, pasteName(ext, hash))
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

/**
 * Auto-OCR: 监听 user/message 里的图片附件，**只在路由到的模型明确不支持
 * 图片输入时**把图片存到 ~/.dsh/ocr/cache 并把路径注入 agent 上下文，让该模型
 * 调 ocr_image 本地识别。
 *
 * Web 端粘贴的图片由 composer 原生收进附件流程，插件不做任何客户端拦截。
 * 视觉模型下插件完全静默：harness 自己会在图片前附带只读副本路径，模型需要
 * 逐字核对时可直接调 ocr_image。判定逻辑见 dsh/capability.js。
 */
function registerAutoOcr(ctx, config = {}) {
  const mode = autoOcrMode(config)
  if (mode === 'off') return
  const maxFiles = Number(config.maxCacheFiles ?? 300)
  const maxAgeDays = Number(config.maxCacheAgeDays ?? 30)
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
      if (llm && typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(route.provider, route.model)
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
        const saved = saveImageToCache(bytes, ref.mediaType || 'image/png', { maxFiles, maxAgeDays })
        if (refKey) seen.add(refKey)
        paths.push(saved.path)
      } catch { /* 附件读取失败则跳过，不影响其它图片 */ }
    }
    if (seen.size > 5000) seen.clear()
    if (paths.length === 0) return
    agent.inject({
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
        if (error) {
          let data = null
          try {
            data = JSON.parse(stdout.trim())
          } catch { /* ignore */ }
          resolve(data || { ok: false, error: (data?.error) || String(error.message || error).slice(0, 300) + (stderr ? ' / ' + stderr.slice(-200) : '') })
          return
        }
        try {
          resolve(JSON.parse(stdout.trim()))
        } catch {
          resolve({ ok: false, error: 'setup 输出无法解析' })
        }
      },
    )
  })
}

export function apply(ctx, config = {}) {
  registerAutoOcr(ctx, config)

  ctx.tools.register(defineTool({
    name: 'ocr_image',
    description:
      'Run local OCR (PP-OCRv5, fully offline) on an image file and return its text content. ' +
      'Use it when the user references an image file and you need the text in it — no vision model ' +
      'required. With a model that accepts image input the harness also sends the image itself plus a ' +
      'read-only copy path; call this tool on that path when you need verbatim characters (code, error ' +
      'messages, logs, table numbers) or per-line confidence instead of a visual reading. ' +
      'Returns the recognized text lines with per-line confidence, or a diagnosis (plus a hint to run ' +
      'the ocr_setup tool) when the OCR engine is not installed yet.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path of the image file (png/jpg/webp).',
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
      const path = String(args.path ?? '').trim()
      if (!path) return { text: '', error: '缺少 path 参数（图片文件路径）', path: '' }
      if (!existsSync(path)) {
        return { text: '', error: `图片文件不存在：${path}`, path }
      }
      const result = await runOcr(path, config)
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
      if (config.modelDir) argv.push('--model-dir', config.modelDir)
      const result = await runSetup(python, argv)
      result.checkOnly = Boolean(args.checkOnly)
      return result
    },
    timeoutMs: 900000,
  }))
}
