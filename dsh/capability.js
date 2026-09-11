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
