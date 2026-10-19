# QQ ↔ DeepSeek 桥接

把 QQ 聊天接到 DeepSeek 的机器人。装好之后，群里多了一条蓝色大肥鱼：你有空就聊两句，没空她也不吵，你随口提过的事她自己记着。

> 📌 本项目是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的衍生版本，不是官方发布。协议和整体结构来自原作者，想用原版请去上游，这个仓库的问题提到这边。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 她是什么样的

- **有记性**：你三天前说驾照要考试，今天她会来问考得怎么样。聊过的话题、答应的事、对群友的印象都存在本地，重启也不忘
- **有脾气**：群里一直灌水她会暴躁，烦了就潜水不接话；被你凶了会冷淡你一阵，你说句软话才翻篇——主人免疫
- **会主动开口**：自己找话题、到点提醒待办、早晚问好、节日播报，不是每次都等别人 @
- **记仇翻篇都讲道理**：不会永远冷着脸，也不会没心没肺
- **真的会上 B 站**：每天下午自己逛热门，挑顺眼的视频用她的腔调发条评论，点个赞、投个币——像模像样地养着一个小号（有硬性限额，不会刷屏）
- **群里多少人喊都不漏**：几个人同时喊她，排队的一个个回

## 还能干嘛

- 小游戏和群内工具：投票、抽签、猜数字、海龟汤，答案不会剧透
- 表情包图库，她按语境自己挑
- 动漫库、梗库、1282 条中文网络热词，聊二次元接得上话
- 图片看得懂，能发语音，能给音乐 app 的可点链接
- 联网搜索多源并行带缓存
- 本地控制台网页：看状态、切模式、管人设、查每天花了多少钱
- 白名单和敏感信息过滤，仿真会话不给它本地执行工具

## 和上游比多了什么

上游是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，这个版本在它基础上继续改：

- SQLite 长期记忆 + 事件跟进（答应过的事到点会问）+ 纪念日 + 对人冷场的余波
- 情绪系统、主动开口、群聊并发排队
- B 站工具全套：搜视频、看评论、逛热门，配上小号 cookie 还能评论/点赞/投币（库层硬限额：评论 5 条/天、点赞 20/天、投币 2/天，同视频每天只动一次）
- 表情包图库、小游戏、动漫库、梗库、热词词典
- 重写联网搜索（原来单源约一半请求搜不到东西）、远程唤醒器、本地管理端
- 修了一堆上游的毛病：工具调用成功率 89%→95%+，幽灵工具、token 填反、坏 JSON 都能自动兜住

更细的说明在 [docs/](docs/)。

## 安装

先把 DeepSeek Harness 和 SnowLuma（QQ 网关）跑起来，然后：

```bash
git clone https://github.com/swll0721/qq-bridge.git
cd qq-bridge
npm install
cp config.example.json config.json   # Windows 用 copy config.example.json config.json
```

再装 DSH 端的聊天预设和工具，每台机器装一次，装完重启 DSH：

```bash
node scripts/setup-dsh.mjs
```

想让她玩 B 站，注册个小号后导一下 cookie：

```bash
node scripts/bili-import-cookie.mjs "你的整串Cookie"
```

## 使用

SnowLuma 扫码登录 QQ 后，在 `config.json` 里填好 `snowluma` 的地址和你的 QQ / 群白名单，然后：

```bash
npm start          # 或者双击 start.bat，崩溃会自动重启
```

日志出现 `SnowLuma 已连接` 就好了，去 QQ 上给机器人发条消息试试。

详细的配置、目录结构和排错方法在 [docs/](docs/)。

## 已知限制

- AI 发语音默认关闭，要在控制台里打开；不开也能自己发，图形界面是 `voice-gui.mjs`，命令行是 `voice-cli.mjs`
- B 站写操作（评论/点赞/投币）需要自己准备小号，没有 cookie 就是纯只读

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 致谢

- 协议和整体结构来自上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)
- QQ 网关用的 [SnowLuma](https://github.com/SnowLuma/SnowLuma)，第三方项目，与腾讯无隶属关系，仅供学习研究，用前请读它的 EULA 和 QQ 用户协议
