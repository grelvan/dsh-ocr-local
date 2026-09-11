# 使用指南 / Usage

## 快速开始 / Quick start

```sh
# 1. 安装插件（Web 端 profile，通常是 web）
git clone https://github.com/grelvan/dsh-ocr-local.git
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-ocr-local
# 或：npx -y @deepseek-ai/dsh plugin --profile web add github:grelvan/dsh-ocr-local

# 2. 准备识别引擎（一次即可：venv + 依赖 + 模型，幂等）
python ~/.dsh/profiles/web/node_modules/dsh-ocr-local/ocr/setup.py

# 3. 重启 dsh，在 Web 输入框粘贴图片
```

## 核心：插件什么时候介入

判定依据是**当前会话实际路由到的模型**声明的输入能力（`inputModalities`），
判定实现在 `dsh/capability.js`（纯函数，有单测覆盖）。

| 模型声明的输入能力 | 是否介入 | 依据 |
| --- | --- | --- |
| 只支持 `text` | ✅ 介入 | `isExplicitlyTextOnly()` 为真 |
| 支持 `text` + `image` | 🔇 静默 | 视觉链路负责，且 harness 已附只读路径 |
| 无法确定（未注册 / 查询失败 / 无模态声明） | 🔇 静默 | `shouldInjectOcrPath()` 对未确定值返回 false |

路由来源按可信度排序（`pickRoute()`）：

1. `session/event` 的 `model/selection` 事件 —— 用户刚切换、尚未发请求的选择
2. `session.requestHeader().config` —— 上一次真实请求用的 provider/model
3. `agent.options` —— 会话创建时的路由

任一来源取不到就顺延；全都取不到时视为「无法确定」→ 静默。

## 接入的是纯文本模型时

图片进入会话后，插件监听 `user/message` 事件：

1. 保存图片附件到 `~/.dsh/ocr/cache`（按内容 sha1 去重、按真实类型命名、按数量/天数清理）
2. 向 agent 上下文注入一条提示，含保存路径
3. 模型调用 `ocr_image` → 本地 PP-OCRv5 识别 → 返回文字

> 为什么必须由插件来做：harness 对不支持图片的模型只给一句
> `[image omitted because this model accepts text only; attachment sha256:…]`，
> **不含任何路径**，所以模型无法自行找到这张图。

## 接入的是多模态模型时

插件全程静默，不做任何事。图片原样发给模型；harness 会在图片前附加一条
**只读副本路径**，模型需要逐字核对（抄代码、对报错、核 hash、读表格数字）时
可以直接对那个路径调 `ocr_image`。

你也可以随时手动要求：

> 用 ocr_image 读一下 /path/to/image.png，逐字给我，标出低置信的行

## Web 端粘贴行为

0.4.0 起**不再拦截粘贴**。浏览器输入框原生就会把粘贴的图片文件收进附件流程
（`clipboardData.items` → `intakeFiles`），插件只在 host 侧监听会话事件。

因此：

- 旧配置里的 `pasteToPath` **已失效**，可以删除；插件不再注册 `/ocr/paste` 路由，
  也不再提供浏览器半身（`dsh.client` 清单已移除）。
- 升级后如果 `~/.dsh/profiles/web/node_modules/dsh-ocr-local/dsh/client.js` 还在，
  那是残留文件，不会被执行。

## ocr_image 工具

```json
{ "path": "C:/path/to/image.png", "full": false }
```

- `path`：图片绝对路径，必填
- `full`：可选，输出结构化 JSON（行/块 + 置信度 + 坐标）

引擎未就绪时工具返回**诊断**（缺哪个依赖 / 哪个模型损坏）并提示修复；
同一会话可调用 `ocr_setup` 一键安装：

```json
{ "checkOnly": true }   // 只检查不安装；false 则执行完整安装
```

## 配置 / Configuration

配置文件：`~/.dsh/profiles/web/cordis.patch.yml`

```yaml
- insert:
    - id: ocr
      name: 'dsh-ocr-local'
      config:
        autoOcr: true                 # true（默认，自动判定）| false（关闭）| 'always'（无条件介入）
        pythonPath: /path/to/python   # 可选：指定 Python
        modelDir: ~/.dsh-ocr/models   # 可选：模型目录
        maxCacheFiles: 300            # 可选：缓存文件数上限
        maxCacheAgeDays: 30           # 可选：缓存保留天数
```

| 开关 | 说明 |
| --- | --- |
| `autoOcr: true`（默认） | 仅当模型**明确不支持图片输入**时介入 |
| `autoOcr: false` | 完全关闭自动介入，仍可手动调用 `ocr_image` |
| `autoOcr: 'always'` | 无条件介入（即使模型能看图）。0.3.x 的旧行为，排查用 |

环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_OCR_MODELS_MIRROR` | 模型下载镜像前缀 |
| `DSH_OCR_PYTHON` | 指定 OCR 用哪个 Python |
| `DSH_OCR_MODELS` | 模型存放目录（默认 `~/.dsh-ocr/models`） |

## 模型与缓存 / Models and cache

- 模型位置：`~/.dsh-ocr/models`
- 模型来源：PaddleOCR v5（Apache-2.0），`ocr/download_models.py` 自动下载
  （sha256 校验、损坏自动重下、原子写入）
- 图片缓存：`~/.dsh/ocr/cache`，命名 `yyyyMMdd-HHmmss.fffffff-<hash8>.png`
  （同图自动去重，按 `maxCacheFiles` / `maxCacheAgeDays` 清理）

## 诊断命令 / Diagnostics

```sh
# 逐项检查：python / 依赖 / 模型 sha256（无需依赖即可运行）
python ~/.dsh/profiles/web/node_modules/dsh-ocr-local/ocr/ocr.py --doctor

# 只检查不安装
python ~/.dsh/profiles/web/node_modules/dsh-ocr-local/ocr/setup.py --check

# 插件自身的判定逻辑单测（零依赖）
npm test
```

## 能力边界（诚实说明）

| | 多模态模型直接看图 | 本地 OCR |
| --- | --- | --- |
| 送进模型的分辨率 | harness 每图像素预算（默认 640,000 px）；1920×1080 → 约 1066×600 | 检测最长边 736px，但识别阶段从**原图**裁块，小字先放大（字高下限 20px，最多 6×） |
| 输出 | 模型转述，无不确定度信息 | 逐行文本 + 置信度 / 字高 / 坐标框，低置信标 ⚠ |

检测阶段的 736px 比多模态链路的约 1066px 更保守，所以 4K 全屏截图里极小的字
也可能漏检。准确说法是**「检得到的行认得更准」**，不是「分辨率无上限」。

## FAQ

**Q: 粘贴图片后模型说看不到图？**
确认当前模型是纯文本模型（本插件唯一该生效的场景），并检查引擎是否就绪
（`ocr_setup` 的 `checkOnly`）。

**Q: 提示「环境未就绪 / OCR 引擎未就绪」？**
调用 `ocr_setup` 工具一键安装，或手动：
`python .../ocr/setup.py`（建 venv + 装依赖 + 下模型，幂等）。
先用 `python .../ocr/ocr.py --doctor` 看具体缺什么。

**Q: pip 报 externally-managed-environment（PEP 668）？**
不要用 `--break-system-packages`，直接跑 `ocr/setup.py`（会自动建 venv）。

**Q: 模型下载失败/慢？**
设 `DSH_OCR_MODELS_MIRROR=https://ghproxy.com/` 后重跑 setup（幂等）。

**Q: 升级插件后功能没变化？**
重启 dsh 让插件重新加载。

> 文档约定：README / CHANGELOG / 提交消息不出现其他插件的名称，
> 统一使用「视觉模型」「视觉桥」等通用表述。
