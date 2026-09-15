# Changelog

All notable changes to this project are documented in this file.

## [0.4.3] - 2026-09-15

### 修复

- **接入纯文本模型后插件完全失效（`当前模型不支持图片，请切换支持图片的模型`）**。
  真正的闸门在 Host 的 **prompt 准入阶段**：`api-session-controller` 的 `prompt()` 在
  `agent.followup()` **之前**就读 `ctx.llm.resolveModelInfo()` 判定图片能力，声明里没有
  `image` 就直接抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`。图片**从未进入会话**，所以
  `user/message` 事件永不触发——0.4.0 起的 autoOcr 在这条路径上是**结构性死代码**，
  用户只会看到一条 toast。
  - 修法：新增**准入桥**（`installAdmissionBridge`），只包装 `llm.resolveModelInfo`
    这一个公开方法，给声明里没有 `image` 的模型补上 `image`，让准入放行。
  - **为什么这是安全的（不是谎报能力）**：请求构造走的是适配器自己的 catalog
    （`adapter.prepareCall` / `adapter.resolveModel`），**不经过** `resolveModelInfo`。
    图片进了会话后，LLM 服务层仍会按适配器的真实能力把它投影成
    `[image omitted because this model accepts text only; attachment sha256:…]`
    文本，适配器永远拿不到图片字节。已用 harness 源码 + 真实 `LlmRuntime` 实例实测：
    补丁后 `resolveModelInfo` 返回 `['text','image']`，而 adapter 收到的是占位符文本，
    全程不抛错。
  - 副作用（正是本插件要的结果）：任何用 `resolveModelInfo` 做能力预检的消费者
    （子代理续跑、acp、`read-image` 等）也一并放行。
- **插件自身判定不能读被包装后的方法**：准入桥对外把 text-only 报成含 `image`，
  若 autoOcr 沿用它判「该不该介入」，纯文本模型会被误判成视觉模型而**继续静默**——
  补丁等于白打。现由桥保留原实现（`bridge.real`），插件内部一律用它读真实能力。
  这条有专门单测：`isExplicitlyTextOnly(withImageCapability(['text'])) === false`
  而 `isExplicitlyTextOnly(['text']) === true`。
- `autoOcr: false` 时不安装准入桥，不留下任何对 Host 准入行为的改动。
- 桥的安装通过 `ctx.inject(['llm'], …)`，等 llm 服务就绪再装；卸载时按 disposer 还原
  （同一实例重复 `apply` 不叠加包装）。
- **`ocr/setup.py` 在缺 `ensurepip` 的系统上根本装不出环境**（Deepin / Debian / 部分 Ubuntu）。
  系统没装 `python3.x-venv` 时，`python3 -m venv` 会**报错退出却留下一个残缺目录**
  （只有 `bin/python` 软链、没有 pip），而旧的 `ensure_venv()` 只判断 `bin/python`
  是否存在就认定「venv 已存在」→ 后续 `python -m pip install` 一律
  `ModuleNotFoundError: No module named 'pip'`，用户看到的是「依赖装不上」，
  真因（这环境根本装不进东西）被完全盖住。现在：
  - 建完 venv 一律**实测 `import pip`**，不只看退出码；
  - 发现半成品就删除重建；标准 venv 依旧没 pip 时**自动回退 `uv venv --seed`**
    （uv 自带 pip，不依赖系统 ensurepip）；
  - 解释器没 pip 时，装依赖改走 `uv pip install --python <venv>`；
  - `npm test`/`setup.py --check` 会明确报 `pip（venv 缺 pip，重建即可：python setup.py）`；
  - 两条路都不通时，报错里直接给三条可执行解法（apt / uv / conda），
    并从 stderr 里挑出点名真因的那几行（Debian 的报错末尾只剩 `Failing command:`）。
  实测（在同样缺 ensurepip 的环境里从零跑）：自动识别半成品 → 重建 → 回退 uv → 依赖装好，
  输出 `{"ok": true, …"venv": "venv 已创建（uv venv --seed）","dependencies": "依赖安装完成"}`。
- `find_uv()` 不再只信 `shutil.which`：插件以子进程拉起时 PATH 常被精简
  （Web 服务 / 沙箱 / systemd），`~/.local/bin` 不在其中，uv 明明装着却找不到。
  现在会补查 `~/.local/bin` 与 `~/.cargo/bin`（Windows 认 `uv.exe`）。
- **冷启动「一直卡在下载」**——三件事叠在一起，逐条拆掉：

  1. **进度被吞**。`setup.py` 的 `run()` 一律 `capture_output=True`，把 pip 与
     `download_models.py` 的进度条全部吃掉，用户看到的就是「毫无反应、像卡死」。
     现在只在 `--json`（插件调用）时捕获；人跑时改用 `Popen` **实时转发**，按 `\r`
     和 `\n` 双分隔切分以便进度条正常刷新、尾部日志还能留给报错引用。
  2. **`--json` 模式 stdout 被污染**。`[setup] …` 这些诊断行与最终 JSON 混在同一个
     stdout，插件 `JSON.parse(stdout)` **必然失败**，只会回「setup 输出无法解析」
     —— 也就是说 `ocr_setup` 工具实际上一直不可用。现在诊断一律走 stderr，
     stdout 只留最后那一行 JSON；插件侧另加 `parseLastJson()` 逐行倒查兜底
     （`ocr.py` 的读取也换成了它）。
  3. **下载源只有一个，拉不动就整体失败**。`download_models.py` 现在按
     **直连 → ghproxy → gh-proxy → ghfast** 依次回退，每轮换源都标出来；
     单次连接/读取超时从 120s 收到 30s，坏源快速让位。
     **更要紧的是「慢」不等于「失败」**：只按失败回退的话，一个 80KB/s 的直连能把
     21MB 磨成五分钟，而换个镜像可能只要几秒。所以现在按**速度**判断 ——
     持续低于 200KB/s（`DSH_OCR_MIN_SPEED_KBPS` 可调）就换源，并说明换掉的是谁、速度多少。
     三个边界都处理了：**最后一轮不再嫌慢**（万一所有源都慢，也得把文件下完，
     而不是永远在换源空转）；**小文件不会因为「慢」被丢弃重下**（74KB 的字典一次就读完了，
     采样窗口却刚过期）；`DSH_OCR_MODELS_MIRROR` 设了则钉死单源，不再自动回退。
     另外检测到没有代理变量时会提示一句：本机若有代理，加上它通常最快。

- **把 jsDelivr 提到公共代理之前**。模型候选源现在是：
  **GitHub 直连 → jsDelivr（gh 端点）→ jsDelivr（npm 端点）→ ghproxy → gh-proxy → ghfast**。
  理由：jsDelivr 把 GitHub 仓库 / npm 包做成了 CDN，国内通常比直连快一到两个数量级，
  也不像公共代理那样时好时坏（限流、跑路是常态）。公共代理降级为兜底。
  **要让它真正命中，下面二选一**（代码侧两条路都已备好，没做时会 404 并立刻回退，零成本）：
  - 把三个模型文件放进本仓库 `ocr/models/`，并让该目录不再被 `.gitignore` 排除；
  - 或者把模型发成一个独立 npm 包 `dsh-ocr-models`（jsDelivr 会自动为 npm 包提供 CDN）。
  两种托管都一样能被 `source_urls()` 命中；gh 端点使用 `@main`，npm 端点使用 `@1`。

- **依赖默认走清华源**（`DSH_OCR_PIP_INDEX` 可覆盖，设为空则回官方源）：
  onnxruntime + opencv 加起来近百 MB，官方源在国内常常只有几 KB/s。
- **首次安装给足预期**：分三步打印 `1/3 准备 Python 虚拟环境` /
  `2/3 安装依赖（约 85MB）` / `3/3 下载识别模型（约 21MB）`，并说明
  「首次约 2-6 分钟，每步都会打进度，不用干等」；失败时直接给出可复制的
  代理命令与换源命令，而不是一句「失败了」。
- `ensurepip` 缺失时**不再先跑一遍注定失败的标准 venv**（那会先喷一屏 ensurepip
  报错、再留个没有 pip 的空壳），直接改用 `uv venv --seed`。

### 新增

- **`ocr_image` 支持 `ref` 参数**：直接吃 harness 占位符
  `[image omitted because this model accepts text only; attachment sha256:2cd17c8d…]`
  里的那串 sha256（8 位前缀就够）。为什么需要——注入的路径提示要等**下一个 step**
  才进上下文（时序原因见「修复」一节），模型第一个请求只看到占位符；与其跟时序赛跑，
  不如让**占位符本身成为可执行线索**。配合缓存文件名带附件短标识，模型一步就能拿到图，
  不必再去 `find` / 搜 `$TMPDIR` / 翻 `~/.dsh/attachments/`。
  实测模型确实会这么绕：一次会话里连做 6 步才摸到图片。
- **缓存文件名带附件短标识**：`…-<sha1(内容)[:8]>-<attachmentId[:8]>.png`。
  内容去重照旧按 sha1 前缀匹配；`-<refTag>` 那一节让 `ref` 能按 sha256 前缀回查。
  同内容的图片若带了不同的 attachmentId，会各存一份（容量换可用性，值得）。
- **路径支持 `~` 展开**（`path` / `ref` / `config.pythonPath` / `config.modelDir` /
  `config.cacheDir`）：node 的 `existsSync` 不认波浪号，而模型和用户都非常自然会写 `~/…`
  —— 实测模型自己找到 harness 的附件对象后传进来的正是
  `~/.dsh/attachments/v1/objects/…`，旧代码会直接判「图片文件不存在」。
  另外 `ref` 里塞了路径也能work（带分隔符就按路径处理），少一种失败姿势。
- **识别模型随 npm 包一起发布 —— 冷启动不再需要下载模型**。
  模型原本放在 GitHub releases，那是「一直卡在下载」的源头：21MB 在国内动辄磨 4-5 分钟，
  还容易断。现在跟着 npm 包走，`dsh plugin add` 时就已经在本地了
  （包从 1MB 变 18.6MB，走 npm/镜像很快），跑 `setup.py` 时**直接复制就位，零下载**。
  - 模型落在包根的 `models/`，**不进 git**（21MB 不该压在仓库里），由
    `prepublishOnly` 在发布时准备；
  - **`.npmignore` 是必需的**：npm 在没有它时会拿 `.gitignore` 当忽略规则，
    于是 `.gitignore` 里的 `/models/` 会把随包模型排除掉 —— `package.json` 的
    `files` 白名单也救不回来；
  - `setup.py` 先试 `copy_bundled_models()`（校验 sha256 后才复制），包里没有
    （例如本地开发、或从 git 直接跑）才回退到下载器，行为不变。
- 下载器加入 **jsDelivr** 作为直连之外的首选加速源（gh 端点 / npm 端点两种托管都保留），
  之后才是公共代理；源名直接显示 host，一眼能看出当前在走哪条路。
- 配置项 `cacheDir`：覆盖图片缓存目录（默认 `~/.dsh/ocr/cache`），多实例并存时各自独立。
  之前 `saveImageToCache` 已支持该参数，但 autoOcr 调用时没传，等于无法覆盖。
- 注入的消息补上 `id`（`Message.id` 是 harness 的必需字段，此前一直是缺的）。

### 文档

- README 补一节「**在 Web 设置页配置的模型，能力声明可能是空的**」。这是最容易踩空的一处：
  Web 模型编辑器只暴露 `id` / `name` / `contextWindow` / `maxTokens` 四个字段
  （`packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx:20`），
  **`inputModalities` 不在其中**——所以在页面上**新增**模型时，写回的条目没有这一项，
  配置 schema 兜底成 `['text']`。若该模型其实支持图片，插件会被误导而多此一举地介入，
  图片反被投影成占位符，**本来能看图却看不到**。
  文档写清了：声明落在 `~/.dsh/settings.yaml` 的 `llm-deepseek.models[]`；手工补
  `inputModalities: [text, image]` 的方法；**编辑已有模型不会丢该字段**（页面的 patch 是
  展开合并语义，它不认识的字段会保留，只有新增条目会漏）；`settings.yaml` 由
  `settings-file` 用 chokidar 热加载（默认 `watch: true`），**保存即生效、不用重启**；
  以及 schema 约束——声明 `image` 才能写 `imagePixelBudget` / `imageMaxBytes`，
  纯文本模型写了这两个字段会在加载时直接报错
  （`text-only catalog model "xxx" cannot declare image request limits`）。
- 补齐英文 README 此前漏掉的两条 FAQ（准入 toast 的成因、想看图的替代路径），
  并与中文同步新增上面两条（Web 页新增模型导致误判、编辑是否会丢字段）。
- **修正安装 / 升级命令**：原文（以及更早的 0.4.x）一律写
  `npx -y @deepseek-ai/dsh plugin …`，实测在**源码版**环境下会报 `sh: 1: dsh: not found`
  —— npm 上 `@deepseek-ai/dsh` 的 `latest` 标签停在预发布的 `0.1.5-rc.1`，与源码仓库的
  `0.1.6-alpha.1` 不是一回事（`next` = `0.1.5-rc.2`、`alpha` = `0.1.6-alpha.1`），
  且 `npx` 不带 tag 的行为不可靠。现改为按「你手上有什么」给出四种等价入口：
  PATH 里的 `dsh`、源码仓库的 `pnpm dsh plugin …` 或 `node apps/cli/lib/bin.js plugin …`、
  npm 包的 `npx -y @deepseek-ai/dsh@alpha plugin …`；并提醒 `dsh plugin` 内部靠
  `spawnSync('pnpm')` 转发，**PATH 里必须有 pnpm**（`dsh: pnpm not found on PATH`）。
  中英文 README 与 `docs/usage.md` 三处同步。
- 命令示例里的 `python` 统一为 `python3`（Deepin / Ubuntu 22+ 上没有 `python` 这个名字；
  脚本内部会自建 venv，入口用哪个解释器都行，但命令行得先能跑起来）。

### 测试

- 单测 26 → **39**：新增准入桥 8 例（放行 / 透传 / 无模态 / 不污染介入判定 /
  `autoOcr:false` 不装 / 幂等）+ `withImageCapability` 5 例。
- **修掉测试的并发脆弱性**：`node:test` 并发跑顶层用例，此前所有 host 共用
  `~/.dsh/ocr/cache`（模块级常量），`pruneCacheIn` 的 readdir/unlink 互相打架，
  异常又被 autoOcr 的 try/catch 吞掉，表现为「随机不注入」。现每个 host 独立
  `cacheDir`，结果与并发度无关。
- CI 增加 `setup.py` 检测助手的回归测试（`has_pip` 对当前解释器为真、对不存在的路径为假），
  以及一条「`ocr/` 下不许留字节码」的守卫（`PYTHONDONTWRITEBYTECODE` 一旦漏设就红）。
- CI 再加**三条冷启动守卫**：`setup.py --json` 的 stdout 必须能被 `json.load`
  （诊断信息回流就会被拦下）；`_run_streaming` 里不得出现 `capture_output`
  （防止有人把进度重新吞掉）；以及用假响应验证下载器的速度自适应 ——
  慢源必须被换掉、所有源都慢时最后一轮必须忍着下完、小文件不得因「慢」被丢弃重下。

## [0.4.2] - 2026-09-15

### 修复

- **peer 范围与当前 harness 脱节**：`@deepseek-ai/dsh-tools` 原声明 `^0.0.1-rc.1`
  （等价于 `>=0.0.1-rc.1 <0.0.2`），而 harness 已经走到
  `@deepseek-ai/dsh@0.1.5-rc.1` → `dsh-base@0.1.5-rc.1` → `dsh-tools ^0.1.5-rc.1`，
  该范围**匹配不到任何 0.1.x**。本机之所以一直没报错，是因为 npm 上 `dsh-tools`
  的 `latest` tag 仍停在 `0.0.1-rc.1`（`next` 才是 `0.1.5-rc.2`），安装时解析到了旧包。
  现改为 `>=0.0.1-rc.1 <0.1.0 || >=0.1.5-rc.1 <0.2.0-0`。
- 顺带记下 node-semver 的预发布规则：带预发布标签的版本，只有当范围内**同一
  `major.minor.patch` 元组**上存在同样带预发布标签的比较符时才会放行。所以
  `^0.0.1-rc.1` 这类写法会静默排除 harness 的全部预发布构建；`*` 也不行——实测
  连 `0.1.5-rc.2` 都匹配不上。必须用 `||` 显式给出预发布分支（这也是
  awesome-dsh-plugin 贡献指南推荐的形式）。
- `@deepseek-ai/cordis` 保持 `^4.0.1` 不动：当前 harness 依赖 `cordis ^4.0.2`，
  实测 `4.0.2` 满足该范围。

## [0.4.1] - 2026-09-15

### 文档

- 修复 README 的 GitHub 徽章。静态 badge 用 `%2F` 转义斜杠时，GitHub 与 npm 页面的图片
  都会经图片代理（camo）取图，而该代理会把 `%2F` 还原成路径分隔符——shields.io 的路由因此
  匹配失败，返回兜底图 `404 badge not found`（浏览器直连却能正常显示，所以此前不易察觉）。
  现改为下划线写法 `GitHub-grelvan_dsh--ocr--local-2f81f7`，渲染为 `GitHub: grelvan dsh-ocr-local`。
- 提示：README 随 tarball 一起发布，已发布版本的 README 不可修改，npm 页面上的徽章
  需要发新版本才会同步。

## [0.4.0] - 2026-09-11

**定位变更（BREAKING）**：从「给文本模型装眼睛」改为「**只在接入明确不支持多模态的
模型时兜底**」。模型能看图时插件完全静默，不再抢在视觉链路前面做事。

### 行为变更（BREAKING）

- **不再拦截 Web 端粘贴**。浏览器输入框原生就会把粘贴的图片收进附件流程
  （`clipboardData.items` → `intakeFiles`），拦截只会让本来能看图的模型反而看不到图。
  - 删除浏览器半身 `dsh/client.js`、host 的 `/ocr/paste` 路由、`dsh.client` 清单。
  - 配置项 `pasteToPath` 失效（可删除）；`package.json` 的 `./client` export 移除。
- **`autoOcr` 按模型能力自动判定**，三态：
  - `true`（默认）—— 仅当路由模型**明确**声明不支持图片输入时介入；
  - `false` —— 完全关闭；
  - `'always'` —— 无条件介入（0.3.x 旧行为，排查用）。
- **判定不出来时静默**（provider 未注册 / 查询失败 / 无模态声明）。宁可不打扰，
  也不在一个可能能看图的模型上多塞一条 OCR 提示。
- 判定逻辑抽为纯函数模块 `dsh/capability.js`（`autoOcrMode` / `isExplicitlyTextOnly` /
  `shouldInjectOcrPath` / `pickRoute` / `modalityCacheKey`），附 11 个单测。
- 路由来源按可信度排序：`model/selection` 事件 → `session.requestHeader().config` →
  `agent.options`；模态查询按 `provider/model` 缓存，全程 try/catch，
  任何异常都不会打断 `user/message` 处理链。
- **修复（0.3.3 遗留 bug）**：图片附件的稳定标识字段是 `attachmentId`，
  旧代码读的是 `ref.id`（恒为 undefined），导致「防事件重放重复注入」的守卫
  从未生效。现按 `attachmentId` 去重，并以 `ref.id` 兜底。
- 可选服务读取改为 strict → 非 strict 兜底（`optionalService()`），
  避免因 cordis 作用域判定拿不到 `llm`/`attachments` 而永久静默。
- 新增 `test/autoocr.test.mjs`：用假 cordis 宿主加载真实 `dsh/index.js`，
  覆盖 14 个行为分支（介入/静默/兜底/缓存/去重/工具注册）。
- **打包修复**：`python -m py_compile` 会留下 `ocr/__pycache__`，而
  `files: ["ocr"]` 不理会 `.gitignore`，导致 `.pyc` 被打进 npm 包。
  现加 `!ocr/__pycache__` 排除项，CI 改用 `ast.parse` 做语法检查（不写字节码）
  并断言包里不含 `.pyc`。

### 范围收缩（BREAKING）

- **只支持 Web 端**，移除终端客户端（TUI）支持：
  - 删除 `install.sh` / `install.ps1`（粘图键与终端键绑定改写）；
  - 删除 `patch/`（终端客户端补丁、终端键绑定）；
  - 删除对应的 `test/patch-smoke.mjs` 与 fixture，新增 `test/capability.test.mjs`。

### 文档

- README（中/英）重写：新增「插件什么时候生效，什么时候静默」判定表、
  与视觉模型的分层关系、能力边界诚实说明（检测 736px vs 视觉链路约 1066px）。
- 安装说明改为本地克隆 / GitHub 安装（npm 旧版本已下架，重新发布后可恢复
  `add dsh-ocr-local`）。
- docs/usage.md 同步重写。
- CI：移除补丁 dry-run 与已删文件检查，新增 `npm test`；包校验新增
  「`dsh.client` 清单必须不存在」断言。

### 未变

- `ocr_image` / `ocr_setup` 工具、PP-OCRv5 引擎、模型下载与缓存机制、
  包名 `dsh-ocr-local`。

## [0.3.3] - 2026-08-19

- **自动识别（autoOcr）**：监听会话 `user/message` 事件，任何端（TUI 终端
  客户端、web、subagent）粘贴/附带的图片附件自动保存到 `~/.dsh/ocr/cache`
  并向模型注入路径提示 → 文本模型调 `ocr_image` 本地识别。
  与视觉模型/视觉桥并存；可用 `autoOcr: false` 关闭。
- 图片缓存保存逻辑抽为共用函数（去重/类型命名/清理），供粘贴路由与 autoOcr 复用。
- README/文档：多端支持表更新（TUI 端识别链路）、识别方式与开关说明
  （`autoOcr` 与视觉模型路径互不干预）、Linux 剪贴板工具说明（wl-clipboard/xclip）。

## [0.3.2] - 2026-08-18

- README（中/英）重写为小白友好的快速上手：三步安装（插件 → ocr_setup 引擎 →
  粘贴使用）、多端支持（TUI + Web）说明、粘图键对照表、能力/限制、FAQ。
- docs/usage.md 同步更新。
- CI：修复 doctor smoke 步骤的 YAML 语法错误（多行 -c 未缩进导致整个工作流
  解析失败）。

## [0.3.1] - 2026-08-18

### 首次使用体验（P0）
- 新增 `ocr/setup.py` 一键自举：自动建 venv → 装依赖 → 下模型，全程幂等；
  `install.sh` / `install.ps1` / 新 `ocr_setup` 工具统一走它，不再裸 pip install
  （兼容 PEP 668 / 无 root 环境）。
- `ocr.py --doctor` 环境诊断：逐项报告 python / onnxruntime / numpy / opencv /
  模型 sha256 校验，缺依赖时也能运行；`ocr_image` 报错时自动附带诊断与修复指引。
- `download_models.py` 升级：sha256 清单校验（损坏自动重下）、原子写入、重试、
  `DSH_OCR_MODELS_MIRROR` 镜像支持。

### 识别质量（P2）
- 识别增强：暗底图片自动反色 + Otsu 多候选取最高置信度；小字裁剪区自动放大；
  去除 320px 宽度上限（长行不再压扁，上限放宽到 2048）。
- 检测框按视觉行合并，碎片文本拼成完整行并去重。
- 输出带每行置信度；低置信度行在渲染中标注，`--full` 返回结构化
  `{lines, blocks}`。

### 其它
- python 解析链：`config.pythonPath` → `DSH_OCR_PYTHON` → 内置 venv → python3/python
  （解决 PATH 里没有 `python` 或解析到 Store 存根的问题）。
- 粘贴路由：按内容 sha1 去重（同图不重复落盘）、按真实类型命名、缓存按数量/天数清理。
- 客户端：目标输入框已有相同路径时不重复插入。
- 文档与 CI 更新（`--doctor` 冒烟、setup.py 语法检查）。

## [0.2.2] - 2026-08-17

- README: add EN/中文 language switch links.

## [0.2.1] - 2026-08-17

- README: badges + real npx install commands after npm release.

## [0.2.0] - 2026-08-17

- Multi-end support: TUI (paste patch, configurable paste key) + Web
  (`dsh/client.js` injected via `dsh.client` manifest, `/ocr/paste` host route).
- Cross-platform clipboard dispatch: win32 (PowerShell) / darwin (osascript)
  / linux (xclip).
- Published to npm as `dsh-ocr-local`.

## [0.1.0] - 2026-08-15

- Local OCR engine: PP-OCRv5 mobile det+rec (ONNX Runtime), DB post-processing,
  CTC greedy decode, ~200 lines, no framework.
- `ocr_image` tool registration (cordis plugin via `dsh-tools`).
- Model auto-download script (`ocr/download_models.py`, Apache-2.0 models
  cached in `~/.dsh-ocr/models`).
