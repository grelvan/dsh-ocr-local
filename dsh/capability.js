/**
 * dsh-ocr-local — 能力判定（纯函数，零依赖，可单测）。
 *
 * 插件只在**明确接入不支持多模态的模型**时才介入：把进入会话的图片存到本地
 * 缓存并向模型注入路径提示，让它调用 `ocr_image` 本地识别。
 *
 * 判定三态：
 *   - 模型明确声明支持 image（`inputModalities` 含 `image`）→ 静默，交给视觉链路
 *   - 模型明确声明只支持 text（含未登记的 model id，适配器按其显式返回处理）→ 介入
 *   - 无法确定（没有 llm 服务 / provider 未注册 / 查询失败 / 没返回模态）→ 静默
 *
 * 「无法确定时静默」是有意为之：宁可不打扰，也不要在一个其实能看图的模型上
 * 多塞一条 OCR 提示。需要无条件介入时用 `autoOcr: 'always'`。
 */

/** autoOcr 生效模式。 */
export const AUTO_OCR_MODES = ['off', 'auto', 'always']

/**
 * 把插件配置解析成生效模式。
 * @param config - 插件配置对象。
 * @returns `off`（关闭）| `auto`（仅明确不支持多模态时介入，默认）| `always`（总是介入）。
 */
export function autoOcrMode(config = {}) {
  if (config.autoOcr === false) return 'off'
  if (config.autoOcr === 'always') return 'always'
  return 'auto'
}

/**
 * 给定模型声明的输入模态，判断是否**明确**不支持图片输入。
 * @param modalities - `inputModalities` 数组；undefined / 空数组表示无法确定。
 * @returns 明确只支持文本时为 true。
 */
export function isExplicitlyTextOnly(modalities) {
  if (!Array.isArray(modalities) || modalities.length === 0) return false
  return !modalities.includes('image')
}

/**
 * 是否为一张刚进入会话的图片注入本地 OCR 路径提示。
 * @param mode - {@link autoOcrMode} 的返回值。
 * @param modalities - 解析到的 `inputModalities`；undefined 表示无法确定。
 * @returns 应当注入时为 true。
 */
export function shouldInjectOcrPath(mode, modalities) {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return isExplicitlyTextOnly(modalities)
}

/**
 * **准入视图**：把声明里没有 `image` 的模态补上 `image`。
 *
 * 为什么要这样骗一次：Web 端提交带图 prompt 时，Host 在**准入阶段**
 * （admission，见 `api-session-controller` 的 `prompt()`）就读
 * `ctx.llm.resolveModelInfo()` 判定图片能力，声明里没有 `image` 就直接抛
 * `MODEL_DOES_NOT_SUPPORT_IMAGES`。那个错误发生在 `agent.followup()` 之前，
 * 图片**从未进入会话**，于是本插件监听的 `user/message` 事件永不触发——
 * 本地 OCR 兜底在这条路径上是结构性地无法生效。
 *
 * 只在 `llm.resolveModelInfo` 这一个公开方法上补 `image`，是安全的：
 * 真正构造请求的是适配器自己的 catalog（`adapter.prepareCall` /
 * `adapter.resolveModel`），不经过这个方法。图片进入会话后仍会被 LLM 服务层
 * 按适配器的真实能力降级成
 * `[image omitted because this model accepts text only; attachment sha256:…]`
 * 占位符文本，适配器永远拿不到图片字节。
 *
 * 反过来，插件自身判定「该不该介入」必须读**补丁之前**的真实能力
 * （见 `dsh/index.js` 的 `bridge.real`），否则会误判成视觉模型而保持静默。
 *
 * @param modalities - 适配器声明的输入模态。
 * @returns 含 `image` 的新数组；无需改动时原样返回入参。
 */
export function withImageCapability(modalities) {
  if (!Array.isArray(modalities)) return modalities
  if (modalities.includes('image')) return modalities
  return [...modalities, 'image']
}

/**
 * 从候选来源里选出「下一条请求会用哪个 provider/model」。
 * 按可信度排序：用户刚切换的待生效选择 → 上一次真实请求的请求头 → 会话创建时的路由。
 * @param candidates - `{ pending, header, options }`，每项可为 undefined 或
 *   `{ provider, model }` 形状的对象。
 * @returns `{ provider, model, source }`，都取不到时返回 undefined。
 */
export function pickRoute(candidates = {}) {
  const order = [
    ['pending', candidates.pending],
    ['header', candidates.header],
    ['options', candidates.options],
  ]
  for (const [source, value] of order) {
    if (!value) continue
    const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
    const model = typeof value.model === 'string' ? value.model.trim() : ''
    if (provider && model) return { provider, model, source }
  }
  return undefined
}

/**
 * 跨会话共用的模态缓存键。
 * @param provider - provider 路由 id。
 * @param model - 模型 id。
 * @returns 稳定的缓存键。
 */
export function modalityCacheKey(provider, model) {
  return `${provider}\u0000${model}`
}

/**
 * 取附件 id 的短标识，写进缓存文件名里，供日后按 sha256 前缀回查。
 *
 * Harness 的 text-only 占位符是
 * `[image omitted because this model accepts text only; attachment sha256:2cd17c8d…]`——
 * 里面那串就是附件的 sha256。把它的前 8 位放进文件名，模型只要把占位符里的
 * 值传给 `ocr_image` 的 `ref`，插件就能直接定位到图，不必去猜 harness 的附件存储布局。
 *
 * @param ref - 附件引用对象，或直接的 `sha256:…` 字符串。
 * @returns 8 位小写 hex；拿不到时返回空串。
 */
export function attachmentTag(ref) {
  const raw = typeof ref === 'string' ? ref : String(ref?.attachmentId ?? '')
  const hex = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
  const clean = hex.trim().toLowerCase()
  return /^[0-9a-f]{8}/.test(clean) ? clean.slice(0, 8) : ''
}

/**
 * 从模型给的 `ref` 里取出可匹配的 8 位 hex。
 *
 * 容忍几种写法：`sha256:2cd17c8d…`、`2cd17c8d…`、`2cd17c8d`。
 * 长度不足 8 位就没有区分度，直接判为不可用（宁可不匹配，也不误配到别的图）。
 *
 * @param input - `ocr_image` 的 `ref` 参数原值。
 * @returns 8 位小写 hex；解析不出来时返回空串。
 */
export function refTagOf(input) {
  const raw = String(input ?? '').trim().replace(/^sha256:/i, '')
  const clean = raw.toLowerCase()
  return /^[0-9a-f]{8}/.test(clean) ? clean.slice(0, 8) : ''
}
