# dsh-ocr-local

[English](README.en.md) · [中文](README.md)

[![license](https://img.shields.io/npm/l/dsh-ocr-local?style=flat-square)](LICENSE) [![GitHub](https://img.shields.io/badge/GitHub-grelvan%2Fdsh--ocr-local-2f81f7?style=flat-square)](https://github.com/grelvan/dsh-ocr-local)

给 DeepSeek Harness（Web 端）装一个**本地 OCR 兜底**：当会话路由到的模型**不支持图片输入**时，
把图片里的文字读出来给模型；模型能看图时，插件完全静默、不插手。

识别引擎是 PP-OCRv5 + ONNX Runtime，**纯 CPU、完全离线**，图片不会离开你的电脑。

## 插件什么时候生效，什么时候静默

这是理解本插件最重要的一张表。判定基于当前会话实际路由到的模型**声明的输入能力**
（`inputModalities`），而不是猜：

| 会话路由到的模型 | 插件行为 | 模型实际拿到什么 |
| --- | --- | --- |
| **明确声明不支持图片**（如纯文本模型） | ✅ **生效**：图片存到本地缓存，并注入路径提示 → 模型调 `ocr_image` 识别 | 文字。Harness 对这类模型只给一句 `[image omitted because this model accepts text only; …]`，**没有任何路径**，所以没有本插件模型就完全读不到图 |
| **明确声明支持图片**（多模态模型） | 🔇 **静默**：不存缓存、不注入提示 | 图片本身。Harness 还会在图片前附一条**只读副本路径**，模型想逐字核对时可以直接对那个路径调 `ocr_image` |
| **无法确定**（provider 未注册 / 查询失败 / 没声明模态） | 🔇 **静默** | 按 Harness 原样处理。宁可不打扰，也不在一个可能能看图的模型上多塞提示 |

"无法确定就静默"是刻意的。如果你确实需要无条件介入，把 `autoOcr` 设成 `'always'`（见下方配置）。

> 关于「未登记的 model id」：DeepSeek 适配器对没写进模型目录的 id 会**显式**返回
> `inputModalities: ["text"]`，所以这类纯文本路由会被上表第一行正确覆盖。
> 其它 provider 若对未声明模型返回「无模态信息」，则落到第三行（静默）。

## 与视觉模型的关系

两条链路互不干扰，因为它们在**不同的层**做事：

- **插件只管本地 OCR**：把图存到本地、提示模型去调 `ocr_image`。
- **图要不要发给模型**由模型能力 / 客户端配置决定，插件不干预。

所以多模态模型下你不需要为本插件做任何事：它会自己退场。想手动让它读图里的字，
随时可以直接对 agent 说「用 ocr_image 读这张图」。

## 快速开始

### 第 1 步：安装插件

DSH 的 profile 互相隔离，插件要装到**你要用的那个 profile**（Web 端通常叫 `web`）。

**从本地克隆安装：**

```sh
git clone https://github.com/grelvan/dsh-ocr-local.git
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-ocr-local
```

**或直接从 GitHub 安装：**

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:grelvan/dsh-ocr-local
```

> npm 上的旧版本已下架。重新发布后也可以用 `... plugin --profile web add dsh-ocr-local`。

装完**重启 dsh**，插件才会生效。

### 第 2 步：准备识别引擎（只需一次）

把任意一张图片发给 agent，说：

> 识别这张图片

如果引擎还没装好，工具会告诉你缺什么。这时再对 agent 说：

> 用 ocr_setup 工具安装 OCR 环境

插件会自动完成三件事：**建虚拟环境 → 装 Python 依赖 → 下载识别模型**（约 20MB），
之后每次识别都在本地秒级完成。

> 想手动装也可以（把 `<profile>` 换成你的 profile 名，如 `web`）：
>
> ```sh
> python ~/.dsh/profiles/<profile>/node_modules/dsh-ocr-local/ocr/setup.py
> ```

### 第 3 步：开始使用

**方式 A：粘贴截图（最常用）**

在 Web 输入框里按 Ctrl+V / Cmd+V。图片走浏览器原生的附件流程进入会话，
之后按上面的表自动分流：纯文本模型 → 本插件兜底；多模态模型 → 模型直接看图。

**方式 B：告诉 agent 图片路径**

把图片文件的绝对路径发给 agent，说「识别这张图片」。

## 能识别什么 / 有什么限制

| ✅ 擅长 | ⚠️ 效果一般 |
| --- | --- |
| 截图、报错弹窗、聊天记录 | 极小的字（如 4px）可能有个别错字 |
| 中文 + 英文混排、长段落 | 复杂背景、艺术字、手写体 |
| 暗色主题截图（自动反色处理） | 模糊或严重压缩的图片 |

识别结果里，**字太小或置信度低的行会标注 ⚠**，方便你判断哪些字不能全信。

### 为什么"逐字保真"这件事仍然值得用本地 OCR

多模态模型看图和本地 OCR 读图，拿到的**信息量不一样**：

| | 多模态模型直接看图 | 本地 OCR |
| --- | --- | --- |
| 送进模型的分辨率 | 受限于 Harness 的每图像素预算（默认 640,000 px）。1920×1080 的截图会被压到约 1066×600 | 检测阶段最长边 736px，但**识别阶段是从原图裁块**，小字还会先放大（字高下限 20px，最多 6×） |
| 输出 | 模型的一段转述，**不告诉你它哪里不确定** | 逐行文本 + 每行置信度 / 字高 / 坐标框，低置信行标 ⚠ |
| 适合 | 看懂截图里发生了什么 | 抄代码、对报错信息、核 hash、读表格数字 |

诚实的边界说明：检测阶段的最长边限制是 736px，**比多模态链路的约 1066px 更保守**，
所以 4K 全屏截图里极小的字，本插件也可能漏检。准确的说法是
**"检得到的行，认得更准"**，而不是"分辨率无上限"。

## 配置（可选，默认不用动）

配置文件：`~/.dsh/profiles/web/cordis.patch.yml`

```yaml
- insert:
    - id: ocr
      name: 'dsh-ocr-local'
      config:
        autoOcr: true                                   # 见下表
        pythonPath: ~/miniconda3/envs/ocr/bin/python   # 可选：指定 Python
        modelDir: ~/.dsh-ocr/models                     # 可选：模型目录
        maxCacheFiles: 300                              # 可选：图片缓存最多文件数
        maxCacheAgeDays: 30                             # 可选：图片缓存保留天数
```

`autoOcr` 三态：

| 值 | 行为 |
| --- | --- |
| `true`（默认） | 自动判定：**只有模型明确不支持图片输入时**才介入 |
| `false` | 完全关闭自动介入。仍可手动让模型调 `ocr_image` |
| `'always'` | 无条件介入（即使模型能看图也注入提示）。旧版 0.3.x 的行为，排查问题时可用 |

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_OCR_MODELS_MIRROR` | 模型下载镜像前缀（国内下载慢时设，如 `https://ghproxy.com/`） |
| `DSH_OCR_PYTHON` | 指定 OCR 用哪个 Python（默认自动找） |
| `DSH_OCR_MODELS` | 模型存放目录（默认 `~/.dsh-ocr/models`） |

## 常见问题

**Q：粘贴了图片，但模型说看不到图？**
先确认当前模型是不是纯文本模型（这是本插件唯一该生效的场景）。如果是，检查引擎是否就绪
（对 agent 说「用 ocr_setup 检查 OCR 环境」）。如果用的是多模态模型，模型直接看图即可，
本插件按设计就是静默的。

**Q：提示「环境未就绪」/「缺少依赖」？**
对 agent 说「用 ocr_setup 安装 OCR 环境」即可自动修复；或手动运行
`python ~/.dsh/profiles/web/node_modules/dsh-ocr-local/ocr/setup.py`。

**Q：模型下载很慢或失败？**
设镜像后重试（幂等，可反复跑）：
`DSH_OCR_MODELS_MIRROR=https://ghproxy.com/ python .../ocr/setup.py`

**Q：系统提示 pip externally-managed-environment（PEP 668）？**
不要加 `--break-system-packages`。直接用 `ocr/setup.py`——它会自动创建虚拟环境，
绕开系统 Python 的限制。

**Q：识别结果有错字？**
看输出里的 ⚠ 标注。字太小时模型确实会看走眼：把原图放大一点再试，
或让 agent 把对应行再确认一遍。

**Q：为什么插件不拦截我的粘贴了？**
0.4.0 起不再拦截。Web 输入框原生就把粘贴的图片收进附件流程，拦截只会让
本来能看图的模型反而看不到图。旧配置里的 `pasteToPath` 已失效，可以删掉。

## 工作原理（一句话）

Web 端粘贴的图片按原生流程进入会话成为附件 → 插件监听 `user/message` 事件 →
查询当前路由模型的 `inputModalities` → **只有明确不支持图片时**，把图片存到
`~/.dsh/ocr/cache` 并向模型注入路径提示 → 模型调 `ocr_image` → 本地 PP-OCRv5 模型
（ONNX Runtime，纯 CPU）→ 文字。模型第一次使用时下载到 `~/.dsh-ocr/models`，
之后完全离线。更多细节见 [docs/usage.md](docs/usage.md)。

## 升级

```sh
npx -y @deepseek-ai/dsh plugin --profile web update dsh-ocr-local
```

从本地目录安装的话，`git pull` 后在插件目录重跑一次 `add` 即可。

## 许可

MIT（代码）。识别模型 Apache-2.0（PaddleOCR），安装时自动下载。见 [LICENSE](LICENSE)。
