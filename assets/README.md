# 截图素材 / Screenshots

这个目录存放 **catalog 详情页用的截图**。`screenshots.json`（仓库根目录，与
`package.json` 同级）声明要展示哪几张，awesome-dsh-plugin 的
`probe-screenshots.mjs` 会抓取：

```
https://raw.githubusercontent.com/grelvan/dsh-ocr-local/HEAD/screenshots.json
```

相对路径按仓库 HEAD 解析，所以图片跟着仓库走；重命名或删除时，断链会在你自己的
仓库里出现，而不是在别人维护的列表里烂掉。

## 在用的 2 个文件

按文件名排序即为展示顺序。**文件名必须完全一致**（`screenshots.json` 里已写好）。

| 文件 | 拍什么 |
|---|---|
| `01-before-text-only.png` | **装插件前**：给纯文本模型发图，它读不到内容（「当前模型不支持图，请切换支持图的模型」那一屏） |
| `02-after-ocr-answer.png` | **装插件后**：同一张图、同一个问题，模型调 `ocr_image` 拿到文字并据此回答。这是主图 |

两张务必**同一张源图、同一个提问**，只差插件装没装，对比才成立。

## 想加更多

上限 8 张。往这个目录加图，并在根目录 `screenshots.json` 里补一行相对路径即可。
当初规划过、目前**没有**采用的两张：

| 文件名 | 拍什么 |
|---|---|
| `03-install-command.png` | `dsh plugin --profile web add dsh-ocr-local` 一行命令 + 成功输出 |
| `04-tool-call-ocr-image.png` | `ocr_image` 工具调用与识别结果（展示它真的在本地跑 PP-OCRv5） |

## 拍摄建议

- **宽度** 1600–2000px，两张保持同一宽度，视觉上才整齐；比例接近 16:10 最稳
- **格式** PNG（截图，不要 JPEG），单张尽量 < 500KB —— 直接从
  `raw.githubusercontent.com` 出图，太大影响详情页加载
- **浅色/深色主题统一**，别一张深一张浅
- 1、2 两张最好**同一张源图、同一个提问**，只差插件装上与否，对比才有说服力
- 用户头像/API key/token 等敏感信息记得打码

## 约束（来自 probe-screenshots.mjs，写错会被丢弃或整条不生效）

- 最多 **8** 张；每项必须是非空字符串
- 三种写法都接受：`["a.png"]`、`{"screenshots":[...]}`、`{"<插件URL>":[...]}`
- 相对路径：不能以 `/` 开头、不能含 `..`
- 绝对 URL：必须 https，且域名只能是 `raw.githubusercontent.com` /
  `user-images.githubusercontent.com` / `camo.githubusercontent.com` / `github.com`
- 图片 404/410 会被**静默丢弃**（不报错、不阻塞），所以 push 后值得确认一下
  raw 链接能打开

## 顺带

`package.json` 的 `files` 白名单只发布 `dsh/ ocr/ models/ cordis.patch.yml
README.en.md`，所以这个目录**不会**进入 npm 包，不会让安装包变大。
