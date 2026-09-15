# dsh-ocr-local

[English](README.en.md) · [中文](README.md)

[![license](https://img.shields.io/npm/l/dsh-ocr-local?style=flat-square)](LICENSE) [![GitHub](https://img.shields.io/badge/GitHub-grelvan_dsh--ocr--local-2f81f7?style=flat-square)](https://github.com/grelvan/dsh-ocr-local)

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

### ⚠️ 在 Web 设置页配置的模型，能力声明可能是空的

插件的判定**完全依赖配置里声明的 `inputModalities`**，而不是模型的真实能力。
而 Web 设置页不提供这个字段——这是最容易踩空的一处，单独说清楚。

**声明写在 `~/.dsh/settings.yaml` 的 `llm-deepseek.models[]` 里**：

```yaml
llm-deepseek:
  models:
    - id: deepseek-v4-pro
      name: DeepSeek-V4-Pro
      contextWindow: 1000000
      inputModalities:        # ← 决定插件介入还是静默的就是这一项
        - text
```

**Web 模型编辑器只暴露 4 个字段**：`id` / `name` / `contextWindow` / `maxTokens`。
`inputModalities` 不在其中，所以在页面上**新增**模型时，写回的条目里**没有这一项**，
而配置 schema 会给它兜底成 `['text']`。

| 在 Web 页面上做的事 | 对该模型能力声明的影响 |
| --- | --- |
| **新增**一个模型 | 条目里没有 `inputModalities` → 按**纯文本**处理 |
| **编辑**已有模型的 name / 窗口 / tokens | 原有声明**原样保留**（页面的 patch 是「展开合并」语义，不会删掉它不认识的字段） |

**兜底成纯文本会怎样：**

- 该模型**确实不支持图片** → 正好是插件该介入的场景，不用管。
- 该模型**其实支持图片**（自建 vision 端点，或想把某个多模态模型接进来）→ 插件会多此一举地
  介入，图片被 Harness 投影成 `[image omitted …]` 占位符，**本来能看图却看不到**。
  这时必须手工补声明：

```yaml
      inputModalities:
        - text
        - image
```

**改完不用重启**：`settings.yaml` 是热加载的（文件监听 + 去抖），保存即生效。

**声明要满足的约束**（写错会在加载时直接报错，不会静默忽略）：

- 必须是非空数组，元素只能是 `text` / `image`，且不能重复。
- 声明了 `image` 才能写 `imagePixelBudget`（像素预算，可填 `low` 或正整数）与 `imageMaxBytes`
  （单图字节上限）。**纯文本模型写了这两个字段会直接报错**：
  `text-only catalog model "xxx" cannot declare image request limits`。

> 非 DeepSeek 的 provider 卡片有自己的字段集合，能力声明的字段名以该 adapter 的配置 schema 为准。

> **顺带说清一个相关语义**：`settings.yaml` 里的 `models` 是**整体覆盖**内置目录的，
> 而模型选择器显示的正是这个数组（适配器的 `listModels` 直接映射它）。
> 所以在 Web 页面上动过模型列表之后，选择器里有哪些模型完全以这个数组为准——
> 把 `deepseek-v4-flash-vision-exp` 删掉了，就一个多模态模型都切不过去了
> （本机默认是保留的）。

### 为什么插件要动模型的"能力声明"

Harness 在**你按下发送的那一刻**（prompt 准入阶段）就会读模型声明的图片能力：只要声明里
没有 `image`，它会在消息进入会话**之前**直接拒绝，并提示
「当前模型不支持图片，请切换支持图片的模型」。图片进不了会话，插件也就永远收不到
`user/message` 事件——本地 OCR 兜底在这条路径上就成了一行死代码。

所以插件会在这**一个**方法（`llm.resolveModelInfo`）上给纯文本模型补上 `image` 声明，
把准入放行。这**不会**让图片真的发给纯文本模型：请求由适配器按自己的模型目录构造，
图片在送上 wire 之前仍会被 Harness 投影成
`[image omitted because this model accepts text only; attachment sha256:…]` 文本。
换句话说，插件扩的是「准入」，不是「能力」。

不想要这个行为，把 `autoOcr` 设为 `false`——那时插件连这层包装都不会装。

## 与视觉模型的关系

两条链路互不干扰，因为它们在**不同的层**做事：

- **插件只管本地 OCR**：把图存到本地、提示模型去调 `ocr_image`。
- **图要不要发给模型**由模型能力 / 客户端配置决定，插件不干预。

所以多模态模型下你不需要为本插件做任何事：它会自己退场。想手动让它读图里的字，
随时可以直接对 agent 说「用 ocr_image 读这张图」。

## 快速开始

### 第 1 步：安装插件

DSH 的 profile 互相隔离，插件要装到**你要用的那个 profile**（Web 端通常叫 `web`）。

先确认你能调起 `dsh` CLI——它有几个等价入口，**按你手上有什么选一个**（下面的命令都以此为准）：

| 你的情况 | 怎么调 |
| --- | --- |
| PATH 里有 `dsh` 命令 | `dsh plugin …` |
| 在 harness 源码仓库里（`pnpm dsh` 是仓库自带脚本） | `cd <仓库> && pnpm dsh plugin …` |
| 同上，想走构建产物、不起 tsx | `cd <仓库> && node apps/cli/lib/bin.js plugin …` |
| 直接用 npm 上发布的 CLI 包 | `npx -y @deepseek-ai/dsh@alpha plugin …` |

> ⚠️ **两点容易卡住**：
> 1. `npx -y @deepseek-ai/dsh` 不带版本标签可能调不起来——npm 上这个包的 `latest` 停在预发布
>    的 `0.1.5-rc.1`（而源码仓库已经是 `0.1.6-alpha.1`）。要么显式写 `@alpha`，要么直接用源码
>    仓库的入口；**版本最好与你的 profile 保持一致**。
> 2. `dsh plugin` 内部靠 `pnpm` 转发，**PATH 里必须有 pnpm**（缺了会报 `pnpm not found on PATH`）。

装 npm 上的稳定版：

```sh
dsh plugin --profile web add dsh-ocr-local
```

**也可以直接从 GitHub 安装**（想跟最新提交、或 npm 不可达时）：

```sh
dsh plugin --profile web add github:grelvan/dsh-ocr-local
```

**或本地克隆后安装**：

```sh
git clone https://github.com/grelvan/dsh-ocr-local.git
dsh plugin --profile web add ./dsh-ocr-local
```

> 改代码做开发时，用 `link:` 装软链更快——`dsh plugin --profile web add link:./dsh-ocr-local`，
> 此后改仓库里的文件即刻生效，不用重装。

装完**重启 dsh**，插件才会生效。

### 第 2 步：准备识别引擎（只需一次）

**在自己终端里跑这一条**（把 `web` 换成你的 profile 名；直接指向 clone 下来的仓库也行）：

```sh
python3 ~/.dsh/profiles/web/node_modules/dsh-ocr-local/ocr/setup.py
```

它会自动完成三件事。**识别模型是随插件包一起发布的，不用下载** —— 所以实际只需要装
Python 依赖（onnxruntime / numpy / opencv，约 85MB，走国内镜像通常 1-3 分钟）：

```
[setup] dsh-ocr-local —— 本地 OCR 环境准备
  共 3 步，首次约 2-6 分钟（大头是下载）；每步都会打进度，不用干等。

[setup] 1/3 准备 Python 虚拟环境 ...
[setup] 2/3 安装依赖（约 85MB）...
    Collecting onnxruntime ...
[setup] 3/3 下载识别模型（约 21MB，已下过的会跳过）...
[1/3] PP-OCRv5_mobile_det.onnx
    47% (2MB/4MB) [直连]
```

装完会打印自检命令。之后每次识别都在本地秒级完成，不再需要网络。

**网络不好怎么办**（脚本会自救，剩下的靠这几个开关）：

| 情况 | 怎么办 |
| --- | --- |
| GitHub 拉得动但**很慢** | 会**按速度换源**：持续低于 200KB/s 就换下一个，日志里会写明「源 X 太慢（80KB/s），换下一个」 |
| GitHub 完全拉不动 | 会**自动回退**：直连 → ghproxy → gh-proxy → ghfast。想钉死某一个就设 `DSH_OCR_MODELS_MIRROR=https://ghproxy.com/` |
| 整体都很慢 | **加代理最快**：`https_proxy=http://127.0.0.1:7892 http_proxy=http://127.0.0.1:7892 python3 …/ocr/setup.py` |
| PyPI 慢 | 依赖默认已走清华源；要换源设 `DSH_OCR_PIP_INDEX=<index-url>`（设为空 = 官方源） |
| 想调速度阈值 | `DSH_OCR_MIN_SPEED_KBPS=500`（默认 200） |

> 如果**所有源都慢**，最后一轮会停止换源、直接把它下完 —— 不会永远在换源里打转。
> 中途断掉重跑即可，已下好且 sha256 校验通过的文件会跳过。

> ⚠️ **为什么不建议对 agent 说「用 ocr_setup 装」？**
> 插件执行 Bash 时可能处在**受限沙箱**里（网络、可写目录都收紧），而装环境恰恰要下载依赖、
> 写 venv 和模型目录。实测在沙箱里会卡在「uv 缓存目录只读」之类的坑上，模型反复试错、
> 几分钟还不一定成。让它在**你自己的 shell** 里跑，一次就过。
> `ocr_setup` 工具仍然可用（它调的就是同一个脚本），只是在受限环境下成功率低。

装好后把任意一张图片发给 agent，说「识别这张图片」即可。

### 第 3 步：开始使用

**方式 A：粘贴截图（最常用）**

在 Web 输入框里按 Ctrl+V / Cmd+V。图片走浏览器原生的附件流程进入会话，
之后按上面的表自动分流：纯文本模型 → 本插件兜底；多模态模型 → 模型直接看图。

**方式 B：告诉 agent 图片路径**

把图片文件的绝对路径（或 `~/…`）发给 agent，说「识别这张图片」。

**方式 C：直接用附件 sha256（模型自己会做的事）**

纯文本模型收到的图片会被 harness 换成一句占位符：

```
[image omitted because this model accepts text only; attachment sha256:2cd17c8d…]
```

这串 sha256 就是线索——`ocr_image` 的 `ref` 参数认它（**8 位前缀就够**，如 `2cd17c8d`），
插件据此从本地缓存取图。工具描述里已写明这一点，模型通常第一次就调对，
不需要去 `find` 或者翻 `~/.dsh/attachments/`。

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
        cacheDir: ~/.dsh/ocr/cache                      # 可选：图片缓存目录
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

**Q：发送后弹出「当前模型不支持图片，请切换支持图片的模型」？**
那是 Harness 的 prompt 准入拦下的，发生在插件能看到消息之前。0.4.3 起插件会把这层准入
放行（见上文「为什么插件要动模型的能力声明」），如果你还在旧版本、或把 `autoOcr` 设成了
`false`，就会看到这条提示。装 0.4.3+ 并保持 `autoOcr` 开启即可。

**Q：就想直接看图，不想走本地 OCR？**
Harness 自带多模态模型（如 `DeepSeek-V4-Flash-Vision-Exp`），在模型选择器里切过去就行，
本插件会自动退场。

**Q：我在 Web 页面上加的模型明明能看图，插件却来插一脚？**
页面上**新增**的模型条目没有 `inputModalities`，schema 把它兜底成 `['text']`，插件于是按
「纯文本模型」介入——图片反而被投影成占位符，看不到图了。按上文「在 Web 设置页配置的模型」
一节手工补上 `inputModalities: [text, image]` 即可；保存后热加载生效，不用重启。

**Q：在页面上编辑了模型，之前手写的 `inputModalities` 会丢吗？**
不会。页面的字段补丁是「展开合并」语义，它不认识的字段会原样保留。会被漏掉的只有**新增**的条目。

**Q：提示「环境未就绪」/「缺少依赖」？**
对 agent 说「用 ocr_setup 安装 OCR 环境」即可自动修复；或手动运行
`python3 ~/.dsh/profiles/web/node_modules/dsh-ocr-local/ocr/setup.py`。

**Q：模型下载很慢或一直失败？**
脚本会自己处理，而且**「慢」也会换源**（不只是失败才换）：持续低于 200KB/s 就换下一个，
日志里会写「源 直连 太慢（80KB/s < 200KB/s），换下一个」。
顺序是 直连 → ghproxy → gh-proxy → ghfast，全都拉不动通常是整体网络问题，**加代理最有效**：

```sh
https_proxy=http://127.0.0.1:7892 http_proxy=http://127.0.0.1:7892 \
    python3 ~/dsh/dsh-ocr-local/ocr/setup.py
```

也可以钉死一个镜像（设了就不再自动回退）：
`DSH_OCR_MODELS_MIRROR=https://ghproxy.com/ python3 …/ocr/setup.py`。
已经下好且校验通过的文件会跳过，放心重跑。

**Q：装不到最新版（`No matching version found`）？**
你的 npm/pnpm 配了国内镜像（如 `registry.npmmirror.com`），它的同步有延迟 —— 官方 registry
上已经发布，镜像还在追。三个办法：

1. 临时切官方源装这一次（只影响本次，不改全局配置）：
   `pnpm dsh plugin --profile web add dsh-ocr-local@<版本> --registry=https://registry.npmjs.org/`
2. 查镜像同步到哪了（Win10+ 自带 curl）：
   `curl -s https://registry.npmmirror.com/-/package/dsh-ocr-local/dist-tags`
3. 等它同步完（通常几十分钟内），之后裸 `add` 即可。
4. **不想等**：打开 `https://npmmirror.com/package/dsh-ocr-local`，点右上角 **SYNC** 按钮
   手动触发同步，一般几秒到一两分钟生效（实测有效）。

**Q：安装时看着没反应、像卡住了？**
0.4.3 起每一步都有实时进度——依赖安装会显示 pip 的输出，模型下载会显示
`47% (2MB/4MB) [直连]` 这种进度条和当前用的源。如果**确实**长时间没有任何新行，
那是真在等网络，按上一条加代理；也可能是走到了一个不通的源，30 秒内会自动换下一个。

**Q：系统提示 pip externally-managed-environment（PEP 668）？**
不要加 `--break-system-packages`。直接用 `ocr/setup.py`——它会自动创建虚拟环境，
绕开系统 Python 的限制。

**Q：装环境时报 `No module named 'pip'`，或者 venv 根本建不出来？**
系统缺 `python3-venv`（Deepin / Debian / 部分 Ubuntu 会把 `ensurepip` 剥掉）。这种情况下
`python3 -m venv` 会**报错退出却留下一个没有 pip 的残缺目录**——0.4.3 起 `setup.py` 会实测
`import pip` 把它认出来，删掉重建，并**自动改用 `uv venv --seed`**（uv 自带 pip，不依赖系统
`ensurepip`）。直接重跑一次 `python3 ~/dsh/dsh-ocr-local/ocr/setup.py` 即可。

**Q：`sudo apt install python3-venv` 没权限怎么办？**
不用 sudo，装个 uv 就行：

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
python3 ~/dsh/dsh-ocr-local/ocr/setup.py    # 重跑，会自动走 uv
```

uv 装在 `~/.local/bin`，哪怕那个目录不在 PATH 里，`setup.py` 也会去找。

**Q：识别结果有错字？**
看输出里的 ⚠ 标注。字太小时模型确实会看走眼：把原图放大一点再试，
或让 agent 把对应行再确认一遍。

**Q：为什么插件不拦截我的粘贴了？**
0.4.0 起不再拦截。Web 输入框原生就把粘贴的图片收进附件流程，拦截只会让
本来能看图的模型反而看不到图。旧配置里的 `pasteToPath` 已失效，可以删掉。

## 工作原理（一句话）

Web 端粘贴的图片按原生流程进入会话成为附件 → 插件先把 prompt 准入放行（给纯文本模型补
`image` 声明，否则图片进不了会话）→ 监听 `user/message` 事件 → 查询当前路由模型的
`inputModalities` → **只有明确不支持图片时**，把图片存到 `~/.dsh/ocr/cache` 并向模型注入
路径提示 → 模型调 `ocr_image` → 本地 PP-OCRv5 模型（ONNX Runtime，纯 CPU）→ 文字。
模型第一次使用时下载到 `~/.dsh-ocr/models`，之后完全离线。
更多细节见 [docs/usage.md](docs/usage.md)。

## 升级

```sh
dsh plugin --profile web update dsh-ocr-local
```

`dsh` 可以用第 1 步表格里的任一入口（源码仓库里就是 `pnpm dsh plugin --profile web update dsh-ocr-local`）。

从本地目录安装的话，`git pull` 后在插件目录重跑一次 `add` 即可；用 `link:` 装的连这步都省了——
改完文件重启 dsh 就是最新代码。

## 许可

MIT（代码）。识别模型 Apache-2.0（PaddleOCR），安装时自动下载。见 [LICENSE](LICENSE)。
