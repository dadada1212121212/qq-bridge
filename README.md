# QQ ↔ DeepSeek 桥接

把 QQ 聊天接上 AI，让它在群里和私聊里像真人一样陪你聊。

> 📌 本项目是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的**优化版本**（衍生分支，非官方发布）。协议与整体结构来自原作者；想用原版请去上游，本仓库的问题请提到这里。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## ✨ 功能

- 🧠 **记得住** —— 聊过的事不会忘，对话更连贯
- 💬 **更主动** —— 会自己找话题，也会按时提醒你
- 🔧 **更稳** —— 长时间挂着不掉线、不卡住
- 🔒 **更省心** —— 默认配置保守，敏感信息不外泄
- 🎛️ **本地控制台** —— 网页里就能看运行状态、调模式、管角色、查花费

## 📦 安装

先把 DeepSeek Harness 和 SnowLuma（QQ 网关）在电脑上跑起来，再安装桥接：

```bash
git clone https://github.com/dadada1212121212/qq-bridge.git
cd qq-bridge
npm install
cp config.example.json config.json   # Windows 用：copy config.example.json config.json
```

然后装好 DSH 端的聊天预设和工具（每台机器只需一次，装完重启 DSH）：

```bash
node scripts/setup-dsh.mjs
```

## 🚀 使用

装好 SnowLuma、扫码登录 QQ，在 `config.json` 里填好 `snowluma` 地址和你的 QQ / 群白名单，然后：

```bash
npm start          # 或双击 start.bat（崩溃自动重启）
```

看到 `SnowLuma 已连接` 就成功了，去 QQ 上给机器人发条消息试试。

> 更详细的配置、目录结构和排错说明都在 [docs/](docs/) 里。

## 📄 许可证

本项目采用 **MIT 许可证**（见 [LICENSE](LICENSE)）。

## 🙏 致谢

- 协议适配与整体架构来自上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)
- QQ 网关依赖 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（第三方项目，与腾讯无隶属关系）

> ⚠️ SnowLuma 仅供学习与技术研究，使用前请阅读其 EULA 与《QQ 用户协议》。
