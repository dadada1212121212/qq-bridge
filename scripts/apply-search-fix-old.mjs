#!/usr/bin/env node
// [查证] 让「需要查证的问题」必须自己搜、不许推脱。
//
// 现象：她有时把问题原样推回去（「你自己搜」「懒得查」）。根因是提示词里只有
// 「反 AI 味 / 不有求必应」那套规则，没有任何一句说「事实类问题要先查再答」，
// 而工具描述只在 schema 里，提示词里不出现 → 她想不到用。
//
// 改动：
//   H1 新增 searchLine（查证与回答规则）
//   H2 把 searchLine 拼进 stableSeg / slimSeg / 成本探针
//   H3 qq_get_prompt 的工具清单里补 qq_web_search / qq_kb_add
//
// 用法：node scripts/apply-search-fix.mjs [--dry-run|--revert]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = path.join(ROOT, 'src', 'bridge.js');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const REVERT = args.has('--revert');

const SEARCH_LINE = [
  '    // [查证] 事实类问题必须自己查，不许把问题推回去（用户 2026-10-18 反馈）。',
  '    const searchLine = \'【查证与回答】群里问的如果是事实、时间、价格、赛事、新闻、番剧/游戏/工具的背景、某个梗的出处，或者你自己没把握——先自己查：web_search 搜（多搜两步，别只搜一个词），需要细节就 web_fetch 打开最相关的正文看。查到就两三句给结论＋关键依据，链接只留最相关一条；查不到就直说「没搜到可靠的」，别编。⛔ 不许用「你自己搜」「懒得查」「不关我事」这类话把问题推回去——「不有求必应」只针对使唤你干活，不针对回答一个问题。时效性内容（今天/最新/价格/新闻）必须现查，别拿记忆里的旧数据糊弄。\\n\\n\';',
  '',
];

const HUNKS = [
  {
    name: 'H1 新增 searchLine（查证规则）',
    marker: 'const searchLine =',
    count: 1,
    find: [
      '    const memoryText = formatMemoryV2(st);',
    ],
    replace: [
      ...SEARCH_LINE,
      '    const memoryText = formatMemoryV2(st);',
    ],
  },
  {
    name: 'H2a stableSeg 带上 searchLine',
    marker: 'accountLine + tokenLine + searchLine + preSleepLine;',
    count: 1,
    find: [
      '    const stableSeg = cardLine + roleLine + personaLine + antiAiLine + countLine',
      '      + proactiveLine + stickerStrategyLine + memeLine + accountLine + tokenLine + preSleepLine;',
    ],
    replace: [
      '    const stableSeg = cardLine + roleLine + personaLine + antiAiLine + countLine',
      '      + proactiveLine + stickerStrategyLine + memeLine + accountLine + tokenLine + searchLine + preSleepLine;',
    ],
  },
  {
    name: 'H2b slimSeg 带上 searchLine',
    marker: 'tokenLine + searchLine + preSleepLine + askLine',
    count: 1,
    find: [
      '    const slimSeg = cardLine + roleLine + personaLine + antiAiLine + countLine',
      '      + stickerStrategyLine + memeLine + tokenLine + preSleepLine + askLine + grumpLine + moodLine + moodBoardLine + statusLine',
    ],
    replace: [
      '    const slimSeg = cardLine + roleLine + personaLine + antiAiLine + countLine',
      '      + stickerStrategyLine + memeLine + tokenLine + searchLine + preSleepLine + askLine + grumpLine + moodLine + moodBoardLine + statusLine',
    ],
  },
  {
    name: 'H2c 成本探针里登记 searchLine',
    marker: 'stickerStrategyLine, memeLine, accountLine, tokenLine, searchLine, preSleepLine,',
    count: 1,
    find: [
      '          stickerStrategyLine, memeLine, accountLine, tokenLine, preSleepLine,',
    ],
    replace: [
      '          stickerStrategyLine, memeLine, accountLine, tokenLine, searchLine, preSleepLine,',
    ],
  },
  {
    name: 'H3 qq_get_prompt 的工具清单补搜索/kb',
    marker: "webSearch:",
    count: 1,
    find: [
      "            sendVoice: 'qq_send_voice / qq_list_voices'",
    ],
    replace: [
      "            sendVoice: 'qq_send_voice / qq_list_voices',",
      "            webSearch: 'mcp__web-search-safe__web_search（联网搜索）/ mcp__web-search-safe__web_fetch（抓正文）'",
    ],
  },
];

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function latestBackup() {
  const dir = path.join(ROOT, 'tmp');
  if (!fs.existsSync(dir)) return null;
  const all = fs.readdirSync(dir).filter((n) => n.startsWith('search-fix-old-backup-')).sort();
  if (!all.length) return null;
  return path.join(dir, all[all.length - 1], 'bridge.js.orig');
}
if (REVERT) {
  const backup = latestBackup();
  if (!backup) { console.error('没有找到 tmp/search-fix-backup-*/bridge.js.orig，无法还原'); process.exit(1); }
  fs.copyFileSync(backup, TARGET);
  console.log('已从备份还原：' + backup);
  process.exit(0);
}
const raw = fs.readFileSync(TARGET, 'utf8');
const crlf = (raw.match(/\r\n/g) || []).length;
const lfOnly = (raw.match(/(?<!\r)\n/g) || []).length;
const eol = crlf >= lfOnly ? '\r\n' : '\n';
console.log('目标 ' + path.relative(ROOT, TARGET) + '（' + raw.length + ' B，EOL=' + (eol === '\r\n' ? 'CRLF' : 'LF') + '）');
let text = raw;
const errors = [];
const plan = [];
for (const h of HUNKS) {
  if (text.includes(h.marker)) { plan.push('  [已装] ' + h.name); continue; }
  const find = h.find.join(eol);
  const replace = h.replace.join(eol);
  const n = text.split(find).length - 1;
  if (n !== h.count) { errors.push('  [失败] ' + h.name + '：锚点命中 ' + n + ' 处，期望 ' + h.count + ' 处'); continue; }
  plan.push('  [待装] ' + h.name + '：命中 ' + n + ' 处');
  text = text.split(find).join(replace);
}
console.log(plan.join('\n'));
if (errors.length) { console.error('以下锚点不符，整批不写入：\n' + errors.join('\n')); process.exit(1); }
const segs = (text.match(/searchLine/g) || []).length;
if (segs < 4 || !text.includes('web_search 搜（多搜两步')) {
  console.error('自检失败：searchLine 出现 ' + segs + ' 处');
  process.exit(1);
}
console.log('自检通过：searchLine 出现 ' + segs + ' 处，工具清单已补');
if (text === raw) { console.log('所有改动都已就位（幂等），无需写入。'); process.exit(0); }
if (DRY) { console.log('--dry-run：将写入 ' + text.length + ' B（原 ' + raw.length + ' B），未落盘。'); process.exit(0); }
const dir = path.join(ROOT, 'tmp', 'search-fix-backup-' + stamp());
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'bridge.js.orig'), raw);
const tmpFile = TARGET + '.tmp-search-fix';
fs.writeFileSync(tmpFile, text);
fs.renameSync(tmpFile, TARGET);
console.log('已写入 ' + text.length + ' B（原 ' + raw.length + ' B）；备份 ' + path.relative(ROOT, dir));
