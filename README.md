# QQ ↔ DeepSeek 桥接

把 QQ 聊天接到 DeepSeek Harness（DSH）的机器人。群里和私聊的消息转给 AI，回复再发回 QQ。

> 📌 本项目是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的衍生版本，不是官方发布。协议和整体结构来自原作者，想用原版请去上游，这个仓库的问题提到这边。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 功能

- 群聊、私聊都能接，消息自动转给 DSH，AI 回复后发回 QQ
- 有记忆：聊过的话题、答应的事、群友印象都存本地，重启不丢
- 会主动开口：自己找话题、提醒待办、早晚问好、节日播报、群里小总结
- 有情绪：被灌水会暴躁，烦了会潜水不接话
- 群聊并发：几个人同时 @ 也不会漏
- 小游戏和群内工具：投票、抽签、猜数字、海龟汤这类，随机数由服务端算，不会剧透
- 表情包图库，AI 按语境挑表情
- 动漫库、梗库、中文网络热词词典（1282 条），聊二次元接得上话
- 聊天里的图片看得懂，能发语音，也能给音乐 app 的可点链接
- 联网搜索多源并行，带缓存
- 本地控制台是网页，看状态、切模式、管人设、查 token 花费
- 白名单和敏感信息过滤，仿真会话不给它本地执行工具

## 和上游比多了什么

上游是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，这个版本在它基础上继续改，主要是下面这些。

新增：

- 本地 SQLite 长期记忆，事实、事件、心情、印象、待办都记，跨会话跨重启
- 主动行为：到期待办提醒、定时播报、群聊小总结、私人小记
- 情绪系统，会暴躁会潜水，阈值可调
- 群聊并发和点名台账，一个 DSH 会话一轮只能跑一个回合，排队的人都记着账
- 小游戏、投票抽签、回合制游戏
- 表情包图库
- 动漫库、梗库、热词词典
- 重写联网搜索，多源并行竞速加缓存（原来单源 Bing 约一半请求搜不到东西）
- QQ 唤醒器，桥接没跑的时候主人在私聊发条斜杠命令就能远程拉起
- 本地管理端网页

修复和优化：

- 主程序拆模块，18099 行拆到 12235 行，控制台、提示词构建、社交状态机各自独立
- 工具调用成功率从约 89% 提到 95% 以上，幽灵工具反复调用的问题修了
- 「agent token 无效」是会话 key 被误填成令牌，现在能自动认出来并纠正
- 表情库同步卡死会拖垮提问接口，现在 3 秒超时就跳过本轮
- 工具参数偶发写成坏 JSON 会让整轮回合并失败，加了最后一层修复重试
- 测试脚本从 54 个加到 84 个，另外加了个模块接线检查，防止漏写 import 只在生产环境崩

> 文件数 222，上游是 148。更细的架构和原理解释在 [docs/](docs/)。

## 安装

先把 DeepSeek Harness 和 SnowLuma（QQ 网关）跑起来，然后：

```bash
git clone https://github.com/dadada1212121212/qq-bridge.git
cd qq-bridge
npm install
cp config.example.json config.json   # Windows 用 copy config.example.json config.json
```

再装 DSH 端的聊天预设和工具，每台机器装一次，装完重启 DSH：

```bash
node scripts/setup-dsh.mjs
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

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 致谢

- 协议和整体结构来自上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)
- QQ 网关用的 [SnowLuma](https://github.com/SnowLuma/SnowLuma)，第三方项目，与腾讯无隶属关系，仅供学习研究，用前请读它的 EULA 和 QQ 用户协议
