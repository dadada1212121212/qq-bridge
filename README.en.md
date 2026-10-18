# QQ ↔ DeepSeek Bridge

Connects your QQ chats to an AI agent, so it can chat with you in groups and DMs like a real person.

> 📌 This is an **optimized fork** of [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) (unofficial). Protocol and overall structure come from upstream; open issues here.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## ✨ Features

- 🧠 **Remembers** — what you talked about, so chats stay coherent
- 💬 **Proactive** — brings up topics on its own and keeps reminders
- 🔧 **Reliable** — runs for days without dropping or getting stuck
- 🔒 **Safe by default** — conservative defaults, nothing sensitive leaks
- 🎛️ **Local console** — check status, switch modes, manage personas and costs from a web page

## 📦 Installation

You need DeepSeek Harness and SnowLuma (the QQ gateway) running on your machine first, then install the bridge:

```bash
git clone https://github.com/dadada1212121212/qq-bridge.git
cd qq-bridge
npm install
cp config.example.json config.json
```

Install the DSH chat presets and tools (once per machine; restart DSH afterwards):

```bash
node scripts/setup-dsh.mjs
```

## 🚀 Usage

Install SnowLuma, scan the QR code to log into QQ, fill in the `snowluma` section of `config.json` and your QQ/group whitelist, then:

```bash
npm start
```

When you see `SnowLuma 已连接`, it worked — send the bot a message on QQ to try it out.

> Detailed configuration, layout and troubleshooting live in [docs/](docs/).

## 📄 License

This project is licensed under the **MIT License** (see [LICENSE](LICENSE)).

## 🙏 Acknowledgements

- Protocol adaptation and overall structure come from upstream [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)
- The QQ gateway relies on [SnowLuma](https://github.com/SnowLuma/SnowLuma) (a third-party project, not affiliated with Tencent/QQ)

> ⚠️ SnowLuma is for learning and technical research only; please read its EULA and the QQ User Agreement before use.
