# QQ ↔ DeepSeek Bridge

A QQ bot that plugs QQ chats into DeepSeek Harness (DSH). Group and private messages go to the AI, and its replies go back to QQ.

> 📌 This is a derivative of [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge), not an official release. The protocol and overall structure come from the original author; go upstream for the original, and open issues here.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- Works in both groups and private chats; messages are forwarded to DSH and replies are sent back
- Has memory: past topics, promises and impressions of members are stored locally and survive restarts
- Talks first: brings up topics on its own, reminds you of to-dos, says good morning/good evening, posts festival greetings and recaps of the group
- Has moods: it gets grumpy when flooded with messages, and goes quiet when it has had enough
- Handles concurrency in groups, so nobody who @'d it gets dropped
- Group games and tools: polls, drawing lots, guessing games, turtle soup and other turn-based games. Randomness is rolled server-side, so no spoilers
- A local sticker library, picked by context
- An anime/meme knowledge base plus 1282 Chinese internet slang entries, so it keeps up on that stuff
- Reads images in the chat, can send voice messages, and can give working links for music apps
- Web search across multiple sources in parallel, with caching
- A local web console for status, mode switching, persona management and token costs
- Whitelists and sensitive-information filtering; simulation sessions get no local execution tools

## What changed since upstream

Upstream is [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge). This version keeps working on top of it:

New:

- A local SQLite long-term memory for facts, events, moods, impressions and to-dos, across sessions and restarts
- Proactive behaviour: due to-dos, scheduled greetings, group recaps and private notes
- A mood system that can be tuned; it does get grumpy and it does clam up
- Group concurrency with an @-ledger, since one DSH session runs one turn at a time and everyone in the queue is tracked
- Games, polls/lots and turn-based games
- A sticker library
- Anime/meme knowledge bases and the slang dictionary
- A rewritten web search that races multiple sources and caches results (the old single Bing source came back empty about half the time)
- A QQ wake script so the bridge can be started remotely with a slash command in the owner's DM when the bridge is down
- A local admin web page

Fixes and improvements:

- The main program was split into modules, from 18099 down to 12235 lines; the console, prompt builder and social state machine are now separate
- Tool-call success rate went from about 89% to above 95%; the ghost-tool retry loop is fixed
- "agent token invalid" happened when the session key was filled in as a token; it now detects and corrects that automatically
- A stuck sticker-library sync used to hang the prompt endpoint; there is now a 3 second timeout that just skips the sync for that turn
- Bad JSON in tool arguments occasionally failed the whole turn; a last-resort repair retry was added
- Test scripts went from 54 to 84, plus a module-wiring check so a missing import crashes in CI instead of in production

> 222 files here versus 148 upstream. Details on the architecture and reasoning live in [docs/](docs/).

## Installation

Get DeepSeek Harness and SnowLuma (the QQ gateway) running first, then:

```bash
git clone https://github.com/dadada1212121212/qq-bridge.git
cd qq-bridge
npm install
cp config.example.json config.json
```

Install the DSH-side chat presets and tools once per machine, then restart DSH:

```bash
node scripts/setup-dsh.mjs
```

## Usage

After logging into QQ with SnowLuma, fill in the `snowluma` section of `config.json` along with your QQ / group whitelist, then:

```bash
npm start          # or double-click start.bat, which restarts on crash
```

Once `SnowLuma 已连接` shows up in the log, send the bot a message on QQ to try it out.

Configuration, folder layout and troubleshooting are in [docs/](docs/).

## Known limitations

- Sending voice messages is off by default for the AI; turn it on in the console. Manual sending works either way: `voice-gui.mjs` for the GUI, `voice-cli.mjs` for the command line

## License

MIT, see [LICENSE](LICENSE).

## Acknowledgements

- The protocol and overall structure come from upstream [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)
- The QQ gateway is [SnowLuma](https://github.com/SnowLuma/SnowLuma), a third-party project not affiliated with Tencent, for learning and research only; read its EULA and the QQ user agreement before use
