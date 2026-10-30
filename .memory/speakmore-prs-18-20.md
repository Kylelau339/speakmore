---
name: speakmore-prs-18-20
description: "外部贡献者 Kylelau339 的 #18（听写可选繁体）、#20（繁体界面）、#19（录音时预览）都已合并并发布；合并前都精简过"
metadata:
  node_type: memory
  type: project
  originSessionId: abb1c590-5137-4efe-b88f-657a8192a95e
  modified: 2026-10-30T08:02:22.923Z
---

同一位外部贡献者（Kylelau339，测试录音是粤语，用香港字形）10-29、10-30 连发三个 PR，都由我们精简后合并：

- **#18 听写成品可选简体或繁体**：10-29 随 0.17.2 发布。合并时三步收尾保持原样，繁体才在外面包一层转换。
- **#20 繁体中文界面**：10-30 合并。他手写的 1706 行 zh-TW 文案换成 `scripts/dev/make-zh-tw.mjs` 从简体自动生成（opencc twp，台湾用字，修了几处错字），改了简体文案要运行 `npm run i18n:zh-tw`，有测试守着。他把语言名字改成按界面语言写，退回成各自语言的写法。
- **#19 录音时在悬浮条上预览文字（本机识别）**：10-30 合并。他每块都从头重新转写，Mac 上只用 CPU 时 136 秒的话一次要 9.7 秒，条上两行截掉的又是结尾；改成只转写最近 8 秒（0.16 到 0.69 秒）。去掉了序号、转写进程里的排队和标签，`barHint`、`livePreview` 合成 `shownSetting`。他在开发版里试过一段 30 秒的话，说没问题。

#19、#20 随 0.18.0（10-30）发布。相关：[[review-includes-conciseness]]、[[speakmore-release-on-cos]]
