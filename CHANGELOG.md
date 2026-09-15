# Changelog

All notable changes to this project are documented in this file.

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
