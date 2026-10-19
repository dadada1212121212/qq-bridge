// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { claimMalformedRetry, isMalformedCode, MALFORMED_RETRY_HINT, INTERRUPT_RETRY_COOLDOWN_MS, INTERRUPT_RETRY_HINT } from './malformed-retry.js';
import { GEN1_ROLE_LINE_RE, fitRoleText, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail, stripLoneSurrogates } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage } from './qq-model-view.js';
import { safeFetch, safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { playLightGame, renderLightGame } from './light-games.js';
import { startTurnGame, playTurnGame, renderTurnGame } from './turn-games.js';
import { buildMusicShare, renderMusicShare } from './music-links.js';
import { startPoll, castVote, closePoll, tallyPoll, decideAmong, renderPoll, renderDecide } from './group-tools.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { priceUsage, resolvePriceTable } from './model-prices.js';
// [AstrBot 看门狗] 判定与命令构造（纯函数）：待机恢复豁免 + 按端口占用者杀进程
import { astrbotStandbyResumeScript, shouldSkipAstrbotRestartOnResume, astrbotKillByPortScript } from './astrbot-watch-lib.js';
// [并发] 群聊并发槽位 / 点名台账 / 出站节奏（纯逻辑，见 src/group-concurrency.js）
import {
  resolveConcurrencyCfg, isDirectedReason, makeAskEntry, recordAsk, openAsks, claimAsks,
  releaseAsks, resolveAsks, askStats, shouldSpawnAux, formatAskBlock, askTurnFooter, createPacer, pruneAsks
} from './group-concurrency.js';
import { createTokenLedger } from './token-ledger.js';
// [patch 暴躁] 贴吧老哥模式：判定纯逻辑在 grump-mode.js（被 @ 塞长文 / 刷屏 / 反复问 / 离谱问题）
import { resolveGrumpCfg, grumpSignalsV2, formatGrumpLineV2, grumpMoodNoteV2 } from './grump-mode.js';
import { createMemoryDb } from './memory-db.js';
import { createLongMemory, localDayString } from './long-memory.js';
import { createConsoleServer } from './console-server.js';
import { createWakePrompt } from './wake-prompt.js';
import { createSocialState } from './social-state.js';
import { detectEventFollowUp, HOSTILE_RE, PEACE_RE, milestoneDays } from './social-mechanisms.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
import { MemeStore, MEME_MOODS, MEME_MOOD_DICT, MEME_MAX_BYTES, memeMoodNames, detectMoodsFromText } from './meme-lib.js';
import {
  festivalOf, festivalGreeting, extractHotTitles, extractHotTitlesFromHtml, buildHotTopicHint
} from './broadcast-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const MOOD_FILE = path.join(STATE_DIR, 'mood.json');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
// 表情包图库根目录（DSH 生态图库格式：index.db + memes/<tag>/*）；默认图库 official-001=官方表情包1号（92 张）。
const MEMES_DIR = path.join(ROOT, 'assets', 'memes');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），可用 config.json 的
// role.maxInjectChars 调整（1000~40000）；启动时由 applyRoleInjectLimit() 写入。
// 上限提到 40000，是为了让完整角色卡（含全部示例与调研语料）能一次性注入，
// 不被硬切。默认仍用历史值 6000 作为成本护栏。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(40000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    const fit = fitRoleText(selectRoleText(text, mode), roleInjectMaxChars);
    const lost = injected - fit.usedChars;
    const dropped = fit.droppedHeadings.length;
    warnings.push(
      `超出注入上限：当前模式共 ${injected} 字符，超出 ${lost} 字符。` +
      `已按小节取舍，本次实际注入 ${fit.usedChars} 字符` +
      (dropped > 0 ? `，有 ${dropped} 个小节整节不进提示词：${fit.droppedHeadings.slice(0, 6).join('、')}${dropped > 6 ? ' 等' : ''}` : '') +
      `（可在配置里调 role.maxInjectChars，上限 40000）`,
    );
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过，
        // 超预算时按小节取舍，所以这里用 fitRoleText 的真实保留量而不是简单 min）
        injectedV1: fitRoleText(selectRoleText(content, 'v1'), roleInjectMaxChars).usedChars,
        injectedV2: fitRoleText(selectRoleText(content, 'v2'), roleInjectMaxChars).usedChars,
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        droppedV2: fitRoleText(selectRoleText(content, 'v2'), roleInjectMaxChars).droppedHeadings,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
// [patch] DeepSeek 提供方原生支持 off（thinking disabled）；官方白名单漏了它，这里补上。
// MiMo（our-free-model）只认 balanced，DeepSeek 那套只认 off/low/high/max —— 都收进来，
// 由 selectModel 在运行时做权威裁决（不支持会明确报错，见 model-unavailable）。
const REASONING_EFFORT_OPTIONS = ['off', 'low', 'high', 'max', 'balanced'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "蓝色大肥鱼", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// 就地深合并（对象递归、数组/标量覆盖）。只给 [测试模式] 的 config.testmode.json 用。
function deepMergeInto(target, src) {
  for (const key of Object.keys(src || {})) {
    const val = src[key];
    const base = target[key];
    if (val && typeof val === 'object' && !Array.isArray(val) && base && typeof base === 'object' && !Array.isArray(base)) {
      deepMergeInto(base, val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  // [本地覆盖] 两个可选覆盖文件，深合并进内存配置，都不动 config.json 本体：
  //   config.local.json    —— 个人长期偏好（例如晚上也想跟她说话），机器相关、不进仓库
  //   config.testmode.json —— 临时测试模式（解除时间闸门 / 放宽上下文），测完删掉即恢复
  // 为什么不直接改 config.json：scripts/test-sleep.mjs、test-peak-quiet.mjs 等会断言
  // config.json 的出厂值（夜间睡觉、高峰静默），直接改会把回归测试变红；而覆盖文件是可逆的。
  // 合并顺序：本地覆盖先、测试模式后（测试模式优先级更高，测完删掉即可回落到本地偏好）。
  for (const [overlayName, overlayLabel] of [
    ['config.local.json', '本地覆盖'],
    ['config.testmode.json', '测试模式覆盖'],
  ]) {
    const overlay = readJsonSafe(path.join(ROOT, overlayName), null);
    if (overlay && typeof overlay === 'object' && !Array.isArray(overlay)) {
      deepMergeInto(file, overlay);
      console.warn(`[配置] 已合并 ${overlayName}（${overlayLabel}：${Object.keys(overlay).join(', ')}）`);
    }
  }
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'longcat-2.5-preview-free',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      // 回复检查间隔：原 30000（30s）。30s 内几乎等不到回复，却要为一个「回来看看
      // 有没有人回」的完整回合付 60~100K 前缀，活跃聊天时等于把回合数翻倍。
      autoReplyCheckMs: 180000,
      // 群聊是否也排回复检查回合：默认 false（群聊靠真实新消息/被@唤醒即可）。
      replyCheckGroups: false,
      agentPreset: 'qq-chat-v2',
      // 主人私聊专用 preset：与 agentPreset 的唯一差别是多一套手机控制工具
      // （mcp__phone-adb__，见 plugins/qq-agent-presets/qq-tool-restrict-owner.mjs）。
      // 只在 private:<ownerQQ> 这一个会话上生效；置空字符串即关闭这个分流
      // （关掉后主人私聊回到 agentPreset，她将不能操作手机）。
      ownerAgentPreset: 'qq-owner',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        sendMeme: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
    maxWakePerHourPrivate: 30,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      // 表情包图库（本地，DSH 生态格式）：qq_send_meme 按情绪抽图并真的发出图片。
      // 与「收藏表情」（sticker，来自 QQ 账号自带的收藏）是两套东西，互不影响。
      memes: {
        enabled: true,             // 表情包图库总开关
        root: '',                  // 图库根目录；留空 = assets/memes/official-001（官方表情包1号 92 张）
        maxListCount: 12,          // qq_send_meme 单次最多返回多少候选给 AI 挑
        sendDelayMinMs: 600,       // 发图前的真人停顿下限（毫秒）
        sendDelayMaxMs: 1800,      // 发图前的真人停顿上限
        includeInPrompt: true,     // 是否在唤醒提示里附带表情包用法
        cooldownMs: 45000          // 同一会话连续发表情包的最小间隔（防刷屏；0=不限）
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3,
        // [patch 主动保底] 主人私聊的「一天至少主动找一次」硬保底：距上次主动机会超过该间隔，
        // 只要不忙、过了空闲阈值、且不在深夜，就跳过概率直接投放一次主动机会（默认 20 小时 ≈ 每天一次）。
        ownerProactiveMinIntervalMs: 20 * 60 * 60 * 1000
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    sendMeme: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    sendVoice: false,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~40000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
/** [并发] socialV2.concurrency 的归一化配置；配置只在启动读一次，改了要重启。
 *  注意：main() 里的 `const cfg` 是 main 作用域，模块级函数看不见，所以这里用
 *  一个运行时持有变量接管 —— 直接写 cfg 会被 try/catch 静默吞成默认值，config.local.json 白写。 */
let runtimeCfgV2 = null;
function concurrencyCfgV2() {
  try { return resolveConcurrencyCfg(runtimeCfgV2?.socialV2?.concurrency); }
  catch { return resolveConcurrencyCfg(null); }
}

let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {}, auxSessions: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {}, auxSessions: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
  // [并发] 辅助会话（群聊第二槽位）单独一张表：key → sessionId，和主会话互不干扰。
  if (!state.auxSessions || typeof state.auxSessions !== 'object' || Array.isArray(state.auxSessions)) state.auxSessions = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true, resolveFaceName, resolveStickerLabel } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': {
        // [patch 表情看含义] QQ 表情自带名字（q_des，如「doge」「大哭」「微笑」），
        // 把名字写进文本就够她理解这个表情是什么意思，不需要"看图"猜。
        let faceName = null;
        try { faceName = resolveFaceName ? await resolveFaceName(String(d.id ?? '')) : null; } catch { faceName = null; }
        out.push(faceName ? `[表情:${faceName}]` : `[表情#${d.id ?? ''}]`);
        break;
      }
      case 'image': {
        // 动画表情/收藏表情在 SnowLuma 里就是 type=image + sub_type=1 + summary「[动画表情]」。
        // 先按文件名/url 去本机 QQ 收藏表情库里找出它是什么意思（备注/她自己的笔记/标签），
        // 找不到也要标明"这是表情"而不是普通图片——两种情况都不再走"看图"。
        let stickerLabel = null;
        try { stickerLabel = resolveStickerLabel ? await resolveStickerLabel(d) : null; } catch { stickerLabel = null; }
        if (stickerLabel) out.push(`[表情:${stickerLabel}]`);
        else if (String(d.summary ?? '') === '[动画表情]' || String(d.sub_type ?? d.subType ?? '') === '1') out.push('[动画表情]');
        else out.push('[图片]');
        break;
      }
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: String(d.summary ?? ''),
        // [patch 表情看含义] 是动画表情/收藏表情（不是普通照片）——resolveMediaList 靠它决定不送图。
        isSticker: String(d.summary ?? '') === '[动画表情]' || String(d.sub_type ?? d.subType ?? '') === '1'
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  runtimeCfgV2 = cfg; // 供模块级配置读取函数（concurrencyCfgV2 等）使用
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const lightGameTimes = new Map();     // key -> [timestamp]：轻量游戏限频（内存态）
  const turnGameTimes = new Map();      // key -> [timestamp]：回合制游戏限频（防循环里反复 move）
  const groupToolsTimes = new Map();    // key -> [timestamp]：群内工具（投票/抽签决定）限频
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  // ── 表情包图库（本地，DSH 生态格式：index.db + memes/<tag>/*）────────────────
  // 与上面「QQ 收藏表情」是两套体系：sticker = 账号自带收藏（从 SnowLuma 拉取），
  // meme = 本地图库（按情绪桶抽图、直接读文件发）。图库目录用 cfg.socialV2.memes.root 覆盖。
  let memeStore = null;
  let memeStoreRoot = '';
  const memeLastSentAt = new Map(); // key -> 上次发图时间戳（防刷屏）
  let lastActiveChatKey = '';       // 最近有入站消息的会话 key（给「不带 key」的调用兜底）

  function memesEnabled() {
    return cfg.socialV2?.memes?.enabled !== false;
  }

  function memeRootDir() {
    const configured = String(cfg.socialV2?.memes?.root ?? '').trim();
    if (configured) return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
    return path.join(MEMES_DIR, 'library');
  }

  // ── [patch 插件管理] DSH profile 插件（组合包）安装/卸载/启停 ──────────────
  // 为什么走 pnpm 而不是直接改 cordis.yml：DSH 的组合包机制是「package.json 里
  // dsh.profile.bundles 列表 + 包自带的 dsh.bundle.patch」，pnpm 装好后把包名加进列表即可，
  // 剩下的行覆盖交给 DSH 自己展开；手写 loader 条目反而容易和内置行冲突。
  const PLUGIN_PROFILE_DIR = (() => {
    const configured = String(cfg.socialV2?.plugins?.profileDir ?? '').trim();
    if (configured) return configured;
    return path.join(os.homedir(), '.dsh', 'profiles', 'tauri');
  })();
  const PLUGIN_DSH_BIN = (() => {
    const configured = String(cfg.socialV2?.plugins?.dshBin ?? '').trim();
    if (configured) return configured;
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-tauri', 'dependencies', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  })();
  const pluginJobs = new Map();
  function pluginJobSnapshot(job) {
    return { id: job.id, kind: job.kind, status: job.status, log: job.log.slice(-300), result: job.result || null, startedAt: job.startedAt, endedAt: job.endedAt || null };
  }
  function startPluginJob(kind, runner) {
    const id = 'job-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const job = { id, kind, status: 'running', log: [], result: null, startedAt: Date.now() };
    pluginJobs.set(id, job);
    const push = (line) => {
      const s = String(line).replace(/\r/g, '');
      for (const part of s.split('\n')) if (part.trim()) job.log.push(part.slice(0, 500));
      if (job.log.length > 800) job.log.splice(0, job.log.length - 800);
    };
    void (async () => {
      try {
        job.result = await runner(push);
        job.status = job.result && job.result.ok === false ? 'failed' : 'done';
      } catch (error) {
        push('❌ ' + (error?.message ?? error));
        job.result = { ok: false, error: String(error?.message ?? error) };
        job.status = 'failed';
      } finally {
        job.endedAt = Date.now();
        setTimeout(() => pluginJobs.delete(id), 30 * 60 * 1000).unref?.();
      }
    })();
    return job;
  }
  function readProfilePackage() {
    const file = path.join(PLUGIN_PROFILE_DIR, 'package.json');
    return { file, pkg: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  function saveProfilePackage(pkg) {
    const file = path.join(PLUGIN_PROFILE_DIR, 'package.json');
    try { fs.copyFileSync(file, file + '.bak-admin-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {}
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  function runProfilePnpm(args, push, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const cmdArgs = [PLUGIN_DSH_BIN, 'plugin', '--profile', path.basename(PLUGIN_PROFILE_DIR)].concat(args);
      push('$ pnpm ' + args.join(' '));
      const child = spawn(process.execPath, cmdArgs, { cwd: PLUGIN_PROFILE_DIR, env: Object.assign({}, process.env, { CI: '1' }), windowsHide: true });
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) { push(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => { push('⏱ 超时，终止安装进程'); try { child.kill(); } catch {} }, timeoutMs);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (buf) push(buf); resolve(code); });
    });
  }
  function normalizePluginSpec(rawUrl) {
    const s = String(rawUrl || '').trim();
    if (!s) throw new Error('链接不能为空');
    const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+))?\/?(?:[?#].*)?$/i.exec(s);
    if (gh) {
      const repo = gh[2];
      return { kind: 'github', owner: gh[1], repo, ref: gh[3] || '', repoUrl: 'https://github.com/' + gh[1] + '/' + repo };
    }
    const gh2 = /^github:([^/]+)\/([^#]+)(#.+)?$/i.exec(s);
    if (gh2) return { kind: 'github', owner: gh2[1], repo: gh2[2], ref: gh2[3] || '', repoUrl: 'https://github.com/' + gh2[1] + '/' + gh2[2] };
    if (/^(@[^/\s]+\/)?[a-z0-9._-]+(@[\w.^~*-]+)?$/i.test(s)) return { kind: 'npm', spec: s };
    if (/^https?:\/\//i.test(s)) return { kind: 'tarball', spec: s };
    throw new Error('看不懂这个链接：支持 github.com/owner/repo（可带 /tree/分支）、npm 包名、tar.gz 直链');
  }
  async function downloadGithubTarball(info, push) {
    const refs = info.ref ? [info.ref.replace(/^#/, '')] : ['main', 'master'];
    const mirrors = ['https://ghproxy.net/', 'https://gh-proxy.com/'];
    let lastErr = '';
    for (const ref of refs) {
      for (const mirror of mirrors) {
        const kind = /^[0-9a-f]{7,40}$/i.test(ref) ? 'commit' : 'heads';
        const url = mirror + info.repoUrl + '/archive/refs/' + kind + '/' + ref + '.tar.gz';
        try {
          push('下载：' + url);
          const resp = await fetch(url, { redirect: 'follow' });
          if (!resp.ok) { lastErr = 'HTTP ' + resp.status + '（' + mirror + '）'; continue; }
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length < 100) { lastErr = '文件太小（' + buf.length + 'B）'; continue; }
          const dir = path.join(ROOT, 'tmp', 'plugin-downloads');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, info.owner + '__' + info.repo + '__' + ref + '.tar.gz');
          fs.writeFileSync(file, buf);
          push('已下载 ' + Math.round(buf.length / 1024) + 'KB');
          return file;
        } catch (error) {
          lastErr = (error?.message ?? String(error)) + '（' + mirror + '）';
        }
      }
    }
    throw new Error('GitHub 下载失败：' + (lastErr || '未知错误'));
  }
  function listNewModules(beforeSet) {
    const nm = path.join(PLUGIN_PROFILE_DIR, 'node_modules');
    if (!fs.existsSync(nm)) return [];
    const added = [];
    for (const name of fs.readdirSync(nm)) {
      if (name.startsWith('.')) continue;
      if (beforeSet.has(name)) continue;
      added.push(name);
    }
    return added;
  }

  // ── [patch 表情仓库] 后台管理表情包用的覆盖配置（启用/停用 + 每个情绪桶置顶一张）──
  // 图库本身是 DSH 生态的只读 index.db，不动它；「用哪张」这类主观选择放 state/meme-overrides.json：
  //   { "disabled": { "memes/happy/x.jpg": true }, "pinned": { "happy": "memes/happy/y.jpg" } }
  const MEME_OVERRIDES_FILE = path.join(STATE_DIR, 'meme-overrides.json');
  let memeOverridesCache = { at: 0, data: { disabled: {}, pinned: {} } };
  function memeOverrides() {
    const now = Date.now();
    if (now - memeOverridesCache.at < 1500) return memeOverridesCache.data;
    const data = { disabled: {}, pinned: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(MEME_OVERRIDES_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.disabled && typeof raw.disabled === 'object') data.disabled = raw.disabled;
        if (raw.pinned && typeof raw.pinned === 'object') data.pinned = raw.pinned;
      }
    } catch { /* 没有这个文件就是没做任何覆盖 */ }
    memeOverridesCache = { at: now, data };
    return data;
  }
  function saveMemeOverrides(data) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(MEME_OVERRIDES_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    memeOverridesCache = { at: Date.now(), data };
  }
  function memeMoodOfTag(tag) {
    const t = String(tag || '');
    for (const [mood, fine] of Object.entries(MEME_MOODS)) {
      if (mood === t || (Array.isArray(fine) && fine.includes(t))) return mood;
    }
    return '';
  }
  /** 抽图后统一过一遍：去掉停用的；该情绪桶置顶的那张排最前。 */
  function applyMemeOverrides(rows, mood, limit) {
    const ov = memeOverrides();
    let out = (Array.isArray(rows) ? rows : []).filter((m) => m && !ov.disabled[m.path]);
    if (mood) {
      const pin = ov.pinned[mood];
      if (pin) {
        const hit = out.find((m) => m.path === pin);
        if (hit) out = [hit].concat(out.filter((m) => m.path !== pin));
      }
    }
    return limit ? out.slice(0, limit) : out;
  }
  /** 该情绪桶「置顶」的那张（且没有被停用）；没有就返回 null。 */
  function pinnedMemeRowV2(mood) {
    if (!mood) return null;
    const ov = memeOverrides();
    const pin = ov.pinned[mood];
    if (!pin || ov.disabled[pin]) return null;
    try {
      const store = getMemeStore();
      return store.rows().find((m) => m.path === pin) || null;
    } catch {
      return null;
    }
  }
  /** 按 tag/query 抽一张「可用」的（给 qq_send_meme 没带 path 时用）。 */
  function pickOneMemeV2(tag, query) {
    const store = getMemeStore();
    const t = String(tag || '').trim();
    const q = String(query || '').trim();
    // 置顶优先：直接命中配置的那张，不参与随机（否则随机池子小，经常抽不到它）。
    const pinRow = pinnedMemeRowV2(memeMoodOfTag(t) || '');
    if (pinRow) return pinRow;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const picked = (t || q) ? store.sampleMood(t || null, q || null, 16) : { mood: '', memes: store.sampleAny(16) };
      const rows = applyMemeOverrides(picked.memes, picked.mood || '', 0);
      if (rows.length) return rows[0];
    }
    return null;
  }

  // 懒加载 + 目录变更时重开索引；索引是只读的，出错就抛给调用方（会显示到工具返回里）。
  function getMemeStore() {
    if (!memesEnabled()) throw new Error('表情包图库已关闭（socialV2.memes.enabled=false）');
    const root = memeRootDir();
    if (memeStore && memeStoreRoot === root) return memeStore;
    const store = new MemeStore(root);
    memeStore = store;
    memeStoreRoot = root;
    log(`[meme] 表情包图库已加载：${root}（${store.total()} 张）`);
    return store;
  }

  // ── [patch QQ空间] 她自己的说说（发/删/看最近发过什么）────────────────────────
  // 走专用端点而不是放开 OneBot 动作名，原因有两个：
  //   ① images 要把 Windows 路径转成 WSL 能读的 `file:///mnt/<盘>/…`（SnowLuma 跑在 WSL 里）；
  //   ② 可见范围 / 字数 / 去重这些规矩必须在桥接侧统一兜住，不能指望模型自己拼对参数。
  // 这里只留「最近发过什么」的内存记录做去重；持久记录靠 appendActivity 的活动日志。
  const qzonePostLog = []; // 最新在前；重启即清空（活动日志不受影响）

  function qzoneEnabled() {
    return cfg.socialV2?.qzone?.enabled !== false;
  }

  // 把模型给的一张图变成 SnowLuma 收得下的引用。返回 '' 表示该值无效（调用方过滤掉）。
  function qzoneImageRef(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    const qcfg = cfg.socialV2?.qzone ?? {};
    if (/^https?:/i.test(s)) {
      if (qcfg.allowRemoteImages === true) return s;
      throw new Error('不接受网络图片链接（socialV2.qzone.allowRemoteImages=false）：请发本地渲染好的图，比如 qq_make_meme 的输出路径');
    }
    if (/^base64:/i.test(s)) return s;
    if (/^file:/i.test(s)) return s.replace(/\\/g, '/');
    const abs = path.isAbsolute(s) ? s : path.resolve(ROOT, s);
    if (!fs.existsSync(abs)) throw new Error('找不到图片文件：' + abs);
    const win = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
    if (!win) throw new Error('只支持 Windows 盘符路径（或 file:// / base64:// 引用）：' + abs);
    return 'file:///mnt/' + win[1].toLowerCase() + '/' + win[2].replace(/\\/g, '/');
  }

  function noteActiveChatKey(key) {
    if (key) lastActiveChatKey = String(key);
  }


  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      // [超时护栏] SnowLuma 偶尔会卡住不回：同步只给 3 秒，超时就当这轮同步失败，
      // 用旧表情库继续（提示词里少几个表情无所谓，工具卡死 30 秒才是真事故）。
      const syncTimeoutMs = Math.max(500, Number(cfg.socialV2?.sticker?.syncTimeoutMs) || 3000);
      let syncTimer = null;
      const response = await Promise.race([
        bot.request('fetch_custom_face_detail', { count }),
        new Promise((_, reject) => {
          syncTimer = setTimeout(() => reject(new Error(`fetch_custom_face_detail 超时（${syncTimeoutMs}ms），本轮跳过同步`)), syncTimeoutMs);
          if (typeof syncTimer.unref === 'function') syncTimer.unref();
        }),
      ]).finally(() => { if (syncTimer) clearTimeout(syncTimer); });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendQueueV2(key, async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一会话出站链，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用同一会话出站链，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendQueueV2(key, async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 从**本地表情包图库**发一张图（memeRef 是图库相对路径，如 memes/happy/xxx.jpg）。
  // 与 sendStickerV2 的区别：图片直接读本地文件（不下载、不依赖收藏库同步），
  // 停顿时间由 socialV2.memes.sendDelayMinMs/MaxMs 控制。

  // ── 账号自主操作：OneBot 通用动作代理 ─────────────────────────────────────
  // 用户要求「让她完全接管自己的账号」：桥接按等级把 SnowLuma OneBot 的能力面暴露给她。
  // 等级 = socialV2.account.level（read < self < admin，off = 关）。
  // 刻意**不**暴露：get_cookies（含 skey 等凭据）、set_restart（会掉登录得重新扫码）、
  // clean_cache（没有实际用途）。发消息也不走这里（走 qq_send_message，保留审计与限频）。
  const ACCOUNT_ACTION_LEVELS = {
    // ── read：只读查询 ──
    get_login_info: 'read', get_version_info: 'read', get_status: 'read', get_online_clients: 'read',
    can_send_image: 'read', can_send_record: 'read',
    get_group_list: 'read', get_group_info: 'read', get_group_info_ex: 'read',
    get_group_member_list: 'read', get_group_member_info: 'read',
    get_friend_list: 'read', get_friends_with_category: 'read', get_stranger_info: 'read',
    get_group_system_msg: 'read', get_group_ignore_add_request: 'read', get_recent_contact: 'read',
    get_essence_msg_list: 'read', get_group_honor_info: 'read', get_group_at_all_remain: 'read',
    get_group_shut_list: 'read', fetch_custom_face: 'read',
    get_msg: 'read', get_forward_msg: 'read', get_image: 'read', get_record: 'read',
    get_group_msg_history: 'read', get_friend_msg_history: 'read',
    get_group_root_files: 'read', get_group_file_url: 'read', ocr_image: 'read',
    // ── self：自我资料 + 轻量互动 ──
    set_qq_profile: 'self', set_qq_avatar: 'self', set_online_status: 'self', set_input_status: 'self',
    // 贴表情回应（set_msg_emoji_like，**只支持群聊**）与自定义在线状态。这两个此前压根不在
    // 白名单里，所以连 qq_account 都调不到；现在补上，AI 侧另有一个更好用的 qq_react_message。
    set_diy_online_status: 'self', set_msg_emoji_like: 'self',
    set_group_card: 'self', set_friend_remark: 'self',
    delete_msg: 'self', mark_msg_as_read: 'self',
    send_like: 'self', friend_poke: 'self', group_poke: 'self', send_poke: 'self',
    send_group_forward_msg: 'self', send_private_forward_msg: 'self',
    // ── admin：群管理与好友关系（含不可逆动作）──
    set_group_name: 'admin', set_group_admin: 'admin', set_group_ban: 'admin', set_group_whole_ban: 'admin',
    set_group_kick: 'admin', set_group_leave: 'admin', set_group_special_title: 'admin',
    set_group_remark: 'admin', set_group_portrait: 'admin', set_group_add_option: 'admin',
    set_group_add_request: 'admin', set_friend_add_request: 'admin', delete_friend: 'admin',
    upload_group_file: 'admin'
  };
  const ACCOUNT_LEVEL_RANK = { read: 0, self: 1, admin: 2 };
  function accountLevel() {
    const raw = String(cfg.socialV2?.account?.level ?? 'admin').trim().toLowerCase();
    return ACCOUNT_LEVEL_RANK[raw] === undefined ? 'admin' : raw;
  }
  function accountEnabled() {
    return cfg.socialV2?.account?.enabled !== false && accountLevel() !== 'off';
  }
  // OneBot HTTP 调用：与 sendMemeV2 同一套地址/令牌/判据。
  async function oneBotCall(action, params) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(httpUrl + '/' + action, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {})
      },
      body: JSON.stringify(params && typeof params === 'object' ? params : {}),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error('OneBot ' + action + ' 失败: ' + (body.wording || body.retcode || res.status) + hint);
    }
    return body.data ?? null;
  }
  // 结果摘要（只写活动日志；避免把整份群成员名单灌进日志）。
  function summarizeAccountResult(action, data) {
    try {
      if (data === null || data === undefined) return '';
      if (Array.isArray(data)) return data.length + ' 项';
      if (typeof data !== 'object') return String(data).slice(0, 120);
      if (data.nickname) return '昵称=' + data.nickname;
      if (data.group_name) return '群=' + data.group_name;
      if (Array.isArray(data.members)) return data.members.length + ' 名成员';
      if (data.message_id !== undefined) return 'message_id=' + data.message_id;
      const keys = Object.keys(data);
      return keys.slice(0, 4).join(',') + (keys.length > 4 ? '…' : '');
    } catch { return ''; }
  }

  // ── 表达增强：贴表情回应 / 正在输入 / 在线状态 ────────────────────────────
  //
  // 动机：「让她更像在聊天而不是在回工单」缺的从来不是模型能力，而是**通道没接**。
  // 这三个动作 SnowLuma 内核都实现了，但桥接此前一次都没调用过（源码里 `emoji_like`
  // 命中 0 次），所以通道一直是空的：
  //
  //   - `set_msg_emoji_like`：给消息贴一个表情回应。**只支持群聊** —— 内核里
  //     `if (!meta.isGroup) throw new Error("emoji reactions are not supported on private messages")`；
  //     并且这条消息必须仍在 SnowLuma 的 messageStore 里（要有权威 seq），所以只能回应"最近"的消息，
  //     转发出来的老消息、或者 SnowLuma 重启前的消息都贴不上。
  //   - `set_input_status`：给对方显示"正在输入"。内核 `chatType` 固定 0，**只对私聊有效**，
  //     且要先把 uin 解析成 uid（`await ctx.resolveUserUid(p.userId)`，解析不到会抛 "target uid not found"）。
  //   - `set_online_status` / `set_diy_online_status`：改在线状态（后者可带一句自定义状态文字）。
  //
  // 统一原则：**表达增强永远不许影响正常回话**。全部 try/catch 吞错、全部限频、
  // 开关关掉时静默跳过；失败最多写一行日志。
  const EXPRESS_CFG = () => (cfg.socialV2?.express ?? {});

  /**
   * 中文表情名（或数字 id）→ 系统表情 id。
   * 用启动时载入的 `faceNameCache`（sid → 名字）反查，命中不到就返回 null。
   */
  async function resolveReactEmojiV2(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    if (/^\d{1,6}$/.test(raw)) return { emojiId: raw, emojiType: raw.length > 3 ? 2 : 1, name: raw };
    await loadFaceTableV2();
    let exact = null;
    let loose = null;
    for (const [sid, name] of faceNameCache) {
      if (!name) continue;
      if (name === raw) { exact = { sid, name }; break; }
      if (!loose && (name.includes(raw) || raw.includes(name))) loose = { sid, name };
    }
    const hit = exact || loose;
    if (!hit) return null;
    // 与内核同一判据：id 长度 > 3 走 emojiType 2（收藏表情/动画表情），否则是系统表情。
    return { emojiId: hit.sid, emojiType: hit.sid.length > 3 ? 2 : 1, name: hit.name };
  }

  /** 给一条**群**消息贴表情回应。私聊直接抛友好错误（协议不支持，不是权限问题）。 */
  async function reactToMessageV2(key, messageId, emoji, set = true) {
    if (String(key).split(':')[0] !== 'group') {
      throw new Error('贴表情回应只支持群聊：QQ 协议本身不给私聊消息表态（内核会直接拒绝）');
    }
    const resolved = await resolveReactEmojiV2(emoji);
    if (!resolved) {
      throw new Error('认不出这个表情「' + String(emoji).slice(0, 30) + '」：给数字 id（如 4=得意、5=流泪、9=笑哭）或 QQ 系统表情的中文名');
    }
    await oneBotCall('set_msg_emoji_like', {
      message_id: Number(messageId),
      emoji_id: resolved.emojiId,
      set: set !== false
    });
    return resolved;
  }

  /**
   * 私聊「正在输入」提示。best-effort：不 await、不抛、不重试。
   * @param {string} key 会话 key（非私聊直接跳过）
   */
  function showTypingV2(key) {
    try {
      if (EXPRESS_CFG().typing === false) return;
      if (String(key).split(':')[0] !== 'private') return;
      const userId = Number(String(key).split(':')[1]);
      if (!Number.isFinite(userId) || userId <= 0) return;
      // event_type=1 = 正在输入。失败无所谓：对方客户端本来也会自动过期。
      void oneBotCall('set_input_status', { user_id: userId, event_type: 1 })
        .catch((error) => log(`[表达] 正在输入失败 ${key}: ${error?.message ?? error}`));
    } catch (error) {
      log(`[表达] 正在输入异常: ${error?.message ?? error}`);
    }
  }

  // 心情 → 在线状态。QQ 客户端语义：10 在线 / 30 离开 / 50 忙碌 / 60 Q我吧 / 70 请勿打扰。
  // 只改状态码，**不发**自定义状态文字：set_diy_online_status 需要一个合法 face_id，
  // 而这些 face_id 的取值空间没验证过，发错在好友列表里就是一条脏状态。
  const MOOD_PRESENCE = {
    happy: 10, excited: 10, calm: 10,
    tired: 30, sleepy: 30, sad: 30,
    annoyed: 60
  };
  let lastPresenceCode = null;
  /**
   * 让在线状态跟上心情。同一个状态码只发一次（避免每次唤醒都打一次 QQ 状态服务）。
   * @param {string} [reason] 触发原因，只用于日志
   */
  async function applyMoodPresenceV2(reason = '') {
    try {
      if (EXPRESS_CFG().presence === false) return;
      if (!accountEnabled()) return;
      const st = readMoodState();
      const code = MOOD_PRESENCE[st.mood];
      if (!code || code === lastPresenceCode) return;
      // 先占位再发：一次唤醒里 tickMood 会被调两次（提示词里一次、心情行一次），不占位就会
      // 并发打两遍 QQ 状态服务。失败时把占位回滚，下次还能重试。
      lastPresenceCode = code;
      try {
        // battery_status 传 0 = 让编码器省略该字段（桌面端本来就没有电量可报）。
        await oneBotCall('set_online_status', { status: code, ext_status: 0, battery_status: 0 });
        log(`[表达] 在线状态随心情 ${st.mood}(${MOOD_LABELS[st.mood] ?? st.mood}) -> ${code}（${reason || 'mood'}）`);
      } catch (error) {
        lastPresenceCode = null;
        throw error;
      }
    } catch (error) {
      log(`[表达] 在线状态失败: ${error?.message ?? error}`);
    }
  }

  // ── 用量自省（让她自己看得见 token / 花费）───────────────────────────────
  // 为什么要有这一段：账本（token-ledger）早就把每一轮花了多少 token、折算多少钱记下来了，
  // 控制台「令牌与花费」也看得到 —— 但**她自己**完全看不见。提示词里只有一句
  // 「上下文塞满 = 吃撑了」的比喻：她既不知道现在装到几成，也不知道这个会话一共烧了多少，
  // 于是没法自觉收着点，被问到「你花了多少钱」也只能瞎猜或者去翻工具列表。
  // 这里给她两条路：
  //   1) `qq_usage` 工具 / GET /api/socialV2/usage —— 想细看时随时问；
  //   2) 每轮唤醒提示词末尾附一行极短摘要（socialV2.usage.footerInPrompt，默认开）——
  //      让她"不用问就知道"，上下文快撞上轮换阈值时自己收敛一点。
  // 作用域**刻意只限她自己那个 QQ 会话**：`/api/tokens/*` 是全机器账本（含别的群烧掉的钱），
  // 那条路对持有 agent token 的群内 AI 是明确拒绝的（见那边的注释），别在这里开个后门。
  const USAGE_CFG = () => (cfg.socialV2?.usage ?? {});
  const fmtTokV2 = (n) => Number(n || 0).toLocaleString('en-US');
  const safeNum = (fn) => { try { return Number(fn()) || 0; } catch { return 0; } };

  /** 她自己这个 QQ 会话的用量视图；任何异常都退化成 null，绝不影响聊天主链路。 */
  function buildUsageReportV2(key) {
    try {
      const sid = state.sessions[key] ?? null;
      // 注意别用 conversation(key)：它返回的对象里 `turns` 被逐轮明细数组**覆盖**掉了
      // （见 token-ledger.js 的 conversation()：`{...view, turns: rows}`），拿到的轮数是错的。
      // summary() 里的 conversations[] 才是 sessionView 原样（turns 是数字），顺带还带 nowTier。
      const all = tokenLedger.summary({ limit: 500 });
      const conv = (all?.conversations || []).find((c) => c?.key === key) || null;
      const used = sid ? safeNum(() => tokenLedger.latestStepInput(sid)) : 0;
      const limit = Math.max(0, Number(cfg.socialV2?.context?.rotateAtContextTokens) || 0);
      const buckets = conv?.buckets ?? {};
      const cacheMiss = Number(buckets.cacheMiss || 0);
      const cacheHit = Number(buckets.cacheHit || 0);
      const cacheWrite = Number(buckets.cacheWrite || 0);
      const output = Number(buckets.output || 0);
      const reasoning = Number(buckets.reasoning || 0);
      const inputTokens = cacheMiss + cacheHit + cacheWrite;
      const fail = tokenLedger.failureSummary({ sinceMs: 24 * 60 * 60 * 1000, key, limit: 5 });
      return {
        ok: true,
        key,
        session: sid,
        context: {
          used,
          limit,
          pct: limit > 0 ? used / limit : 0,
          left: limit > 0 ? Math.max(0, limit - used) : null
        },
        conversation: {
          turns: Number(conv?.turns ?? 0),
          steps: Number(conv?.steps ?? 0),
          sessions: Number(conv?.sessions ?? 0),
          buckets: { cacheMiss, cacheHit, cacheWrite, output, reasoning },
          inputTokens,
          outputTokens: output + reasoning,
          totalTokens: inputTokens + output + reasoning,
          cost: Number(conv?.cost ?? 0),
          cacheHitRate: inputTokens > 0 ? cacheHit / inputTokens : 0,
          firstAt: conv?.firstAt ?? null,
          lastAt: conv?.lastAt ?? null,
          models: conv?.models ?? []
        },
        failures: {
          total: Number(fail?.total ?? 0),
          byStatus: fail?.byStatus ?? []
        },
        price: {
          version: all?.priceVersion ?? null,
          currency: all?.currency ?? priceTable.currency,
          symbol: all?.symbol ?? priceTable.symbol,
          tier: all?.nowTier ?? null
        }
      };
    } catch (error) {
      log('[usage] 生成用量视图失败:', error?.message ?? error);
      return null;
    }
  }

  // 唤醒提示词一次唤醒会被 build 两次（sendWakePromptV2 + deliverPromptNow），加个 3 秒缓存，
  // 免得同一轮把账本翻两遍。
  let usageLineCacheV2 = { key: '', at: 0, line: '' };
  /**
   * 给模型看的一行用量摘要。刻意短：它每轮都进提示词，而上下文本身正是这里要量的东西。
   * @returns {string} 末尾带两个换行，方便直接拼进提示词；取不到时返回空串
   */
  function usageLineV2(key) {
    if (USAGE_CFG().footerInPrompt === false) return '';
    const now = Date.now();
    if (usageLineCacheV2.key === key && now - usageLineCacheV2.at < 3000) return usageLineCacheV2.line;
    let line = '';
    try {
      const r = buildUsageReportV2(key);
      if (r?.ok) {
        const bits = [];
        const c = r.context;
        if (c.used > 0) {
          bits.push(`上下文 ${fmtTokV2(c.used)}${c.limit > 0 ? `/${fmtTokV2(c.limit)} tok（已用 ${Math.round(c.pct * 100)}%）` : ' tok'}`);
        } else {
          bits.push('上下文占用还没采样');
        }
        if (r.conversation.turns > 0) {
          bits.push(`累计 ${r.conversation.turns} 轮 ${r.price.symbol}${r.conversation.cost.toFixed(4)}`);

        }
        if (r.failures.total > 0) bits.push(`近 24 小时失败 ${r.failures.total} 次`);
        line = `【用量】${bits.join('；')}。更细的分项可调 qq_usage。内部数字：别在群里或对别人报，主人问就照说，也别主动提省 token；上下文快满会系统自动换新会话，你别管。\n\n`;
      }
    } catch (error) {
      log('[usage] 生成用量行失败:', error?.message ?? error);
    }
    usageLineCacheV2 = { key, at: now, line };
    return line;
  }

  async function sendMemeV2(key, memeRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const store = getMemeStore();
    // [patch 表情兜底] memeRef 可能是 undefined / 空串 / "undefined" 这类坏值（历史上出现过
    // 「表情文件不存在：undefined」，导致"发图"整个失败）。这里退一步：坏了就随机抽一张顶上去，
    // 宁可换一张图，也不要让她发不出去。同时把原始坏值打进日志，方便定位是哪个调用方。
    let absPath;
    try {
      absPath = store.resolveStored(memeRef);
    } catch (firstError) {
      const any = store.sampleAny(1);
      const fallbackRef = Array.isArray(any) && any[0] ? any[0].path : '';
      log(`[meme] ${key} memeRef 不可用（${JSON.stringify(memeRef)}）：${firstError?.message ?? firstError}；改用兜底图 ${fallbackRef}`);
      absPath = store.resolveStored(fallbackRef);
    }
    const stored = store.toStored(absPath);
    const row = store.rows().find((m) => m.path === stored) ?? {};
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const buffer = await fs.promises.readFile(absPath);
    if (buffer.length > MEME_MAX_BYTES) {
      throw new Error(`表情文件过大（${Math.round(buffer.length / 1048576)}MB > ${Math.round(MEME_MAX_BYTES / 1048576)}MB）`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const memeCfg = cfg.socialV2?.memes ?? {};
    const minDelay = Number.isFinite(Number(memeCfg.sendDelayMinMs)) ? Math.max(0, Number(memeCfg.sendDelayMinMs)) : 600;
    const maxDelay = Math.max(minDelay, Number.isFinite(Number(memeCfg.sendDelayMaxMs)) ? Number(memeCfg.sendDelayMaxMs) : 1800);
    // 与文本发送共用同一会话出站链，保证「先文字后表情」的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendQueueV2(key, async () => {
      try {
        await sleep(randInt(minDelay, maxDelay));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    memeLastSentAt.set(key, Date.now());
    return {
      path: row.path ?? stored,
      tag: row.tag ?? '',
      caption: row.caption ?? '',
      keywords: row.keywords ?? '',
      messageId: data?.message_id ?? null
    };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: stripLoneSurrogates(promptText) }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: stripLoneSurrogates(promptText) }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  // [patch 黑话预算] 注入用上限：条数 + **字符数**双闸。字符闸单独拿出来是因为
  // term+meaning+usage+example 四段拼起来，8 条也可能到 1500+ 字（约 900 token），
  // 而这是每轮重发的前缀。默认 1200 字（约 750 token），可用 slang.injectMaxChars 调。
  const slangInjectMax = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
  const slangInjectChars = Math.max(200, Math.min(4000, Number(cfg.slang?.injectMaxChars) || 1200));

  function withSlangContext(promptText) {
    // [patch 前缀亲和] 「当前时间」不能放最前面、不能带秒：DeepSeek 前缀缓存逐 token 比对，
    // 第一处不同就整条失效，而 toLocaleString 带秒 ⇒ 每轮必变。现降到分钟并挪到 prompt 末尾。
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const timeLine = `【当前时间】${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} `
      + `${pad2(now.getHours())}:${pad2(now.getMinutes())}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, slangInjectMax, slangInjectChars);
      if (block) parts.push(block);
    }
    // [patch 代理对] 投递咽喉：提示词里只要有一个孤立代理项（半个 emoji），JSON.stringify 就会
    // 把它写成 "\ud83d" 发出去，DeepSeek/Anthropic 兼容端点直接 400 —— 而它还会被**存进会话帧**，
    // 之后每一步重发历史都再 400（换新会话也没用，冻结的 recap 又把毒文本喂回来）。
    // 截断处已改用 truncateText 不制造它；这里是最后一道，兜掉任何来源的坏码元。
    // [patch 工具参数提醒] 模型偶发把工具参数写成非法 JSON（裸换行 / 未转义引号 / 自己拼长 JSON），
    // 整轮会判 MALFORMED_RESPONSE、白等 15 秒再报错。每轮一句短提醒，比事后补跑便宜。
    const toolArgsLine = cfg.socialV2?.selfHeal?.toolArgsHint === false
      ? ''
      : '【工具参数】调工具时参数必须是合法 JSON：文本里不要裸换行，不要自己拼长 JSON，长内容拆成多条发。';
    const tail = toolArgsLine ? toolArgsLine + '\n' + timeLine : timeLine;
    return stripLoneSurrogates((parts.length ? parts.join('\n\n') + '\n\n' : '') + promptText + '\n\n' + tail);
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });

  // ── [隐患根治 2026-10-19] DSH 内核端口自动跟随 + 待机恢复核对 ────────────────
  // 背景：桌面壳每次重启会重选内核端口（3080↔3081），旧流程要手工改 config.json 对齐；
  // 待机（S0 Modern Standby）恢复后内核也可能换端口。这里周期核对：
  //   - 读 ~/.dsh/profiles/<profile>/.harness.pid 第 2 行（内核监听端口）
  //   - 当前 baseUrl 连得上 → 不动；连不上且 harness 端口活着 → 自动重指 api.baseUrl
  //     （会话映射不用手工清：DSH 侧会话若已不在，ensureChatModel 的 not-found 路径会自动退役重建）
  //   - 进程被待机冻结超过 4 分钟（tick 间隔异常拉长）→ 视为刚恢复，立即核对一次
  // 重指是安全的：api.baseUrl 在每次请求时实时读取（dsh-client.js），cookie 由 ensureAuth 按当前基址重铸。
  const dshPortWatch = { lastRunAt: Date.now() };
  function harnessPortCandidate() {
    try {
      const profile = String(cfg.dsh?.profile || 'tauri');
      const raw = fs.readFileSync(path.join(os.homedir(), '.dsh', 'profiles', profile, '.harness.pid'), 'utf8');
      const port = parseInt(String(raw).split(/\r?\n/)[1], 10);
      return Number.isFinite(port) && port > 0 && port < 65536 ? port : 0;
    } catch { return 0; }
  }
  async function dshEndpointAlive(url, timeoutMs = 2500) {
    try {
      const res = await safeFetch(url + '/api/status', { signal: AbortSignal.timeout(timeoutMs) });
      return res.status > 0; // 任何 HTTP 状态（含 401/404）都算内核活着
    } catch { return false; }
  }
  async function dshPortWatchTick() {
    const port = harnessPortCandidate();
    if (!port) return;
    let curPort = '';
    try { curPort = new URL(api.baseUrl).port; } catch { return; }
    if (String(port) === String(curPort)) return;
    if (await dshEndpointAlive(api.baseUrl)) return; // 现端口还活着，别乱动
    const next = `http://127.0.0.1:${port}`;
    if (!(await dshEndpointAlive(next))) return;
    api.baseUrl = next;
    try { api.cookie = null; } catch { /* 让 ensureAuth 按新基址重铸 cookie */ }
    cfg.dsh.baseUrl = next;
    log(`⚠️ [端口跟随] DSH 内核从 ${curPort} 漂移到 ${port}，已自动重指（旧会话若已随内核消失，走 not-found 自愈重建）`);
    appendActivity(`[端口跟随] DSH 内核端口 ${curPort} -> ${port}`);
  }
  function startDshPortWatchdog() {
    if (cfg.dsh?.portFollow?.enabled === false) return;
    const interval = Math.max(15000, Number(cfg.dsh?.portFollow?.intervalMs) || 60000);
    const timer = setInterval(async () => {
      const now = Date.now();
      const frozenMs = now - dshPortWatch.lastRunAt;
      dshPortWatch.lastRunAt = now;
      try {
        if (frozenMs > 4 * 60000) log(`[端口跟随] 进程冻结 ${Math.round(frozenMs / 60000)}min（疑似待机）后恢复，立即核对内核端口`);
        await dshPortWatchTick();
      } catch { /* 单次核对失败不影响下一轮 */ }
    }, interval);
    timer.unref?.();
    log(`[端口跟随] 已启动（每 ${Math.round(interval / 1000)}s 核对，端口来源 ~/.dsh/profiles/${cfg.dsh?.profile || 'tauri'}/.harness.pid 第 2 行）`);
  }

  // ── [数据退役 2026-10-19] 每日维护：消息库过期清理 + token 账本轮转归档 ──────
  // 每 24h 真跑一次（进程内计时），启动后 2 分钟先跑一遍。bridge.log 已有 capped
  // logger（2000 行上限）不重复管。账本归档 = 改名加日期后缀，进程按次追加写入不断 fd。
  const maintenanceState = { lastRunAt: 0 };
  function rotateFileIfBig(file, label, maxBytes = 8 * 1024 * 1024) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size < maxBytes) return;
      const stamp = localDayString(0) + '-' + String(Math.floor(st.mtimeMs / 1000) % 1000000);
      fs.renameSync(file, `${file}.${stamp}`);
      log(`[维护] ${label}超过 ${Math.round(maxBytes / 1048576)}MB，已归档为 ${path.basename(file)}.${stamp}`);
    } catch { /* 文件不存在/被占用，下次再试 */ }
  }
  function maintenanceDailyV2() {
    const now = Date.now();
    if (now - maintenanceState.lastRunAt < 86400000) return;
    maintenanceState.lastRunAt = now;
    try {
      const mdb = memoryDb();
      if (mdb && typeof mdb.pruneMessages === 'function') {
        const keepDays = Number(cfg.socialV2?.retention?.messagesKeepDays) || 180;
        const removed = mdb.pruneMessages(keepDays);
        if (removed) log(`[维护] messages 库清理 ${removed} 条（保留 ${keepDays} 天，情景摘要已固化在 long-memory.db 不受影响）`);
      }
    } catch (error) {
      log('[维护] messages 清理失败:', error?.message || error);
    }
    rotateFileIfBig(TOKEN_USAGE_FILE, 'token 账本');
  }
  function startDailyMaintenance() {
    setTimeout(() => {
      try { maintenanceDailyV2(); } catch { /* */ }
      const timer = setInterval(() => { try { maintenanceDailyV2(); } catch { /* */ } }, 3600000);
      timer.unref?.();
    }, 120000).unref?.();
  }

  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // [patch 卡死回合看门狗] sessionId -> 最近一次收到该会话任何事件的时间。
  // 为什么要它：turn/start 之后如果 turn/end 事件丢了（连接抖动、DSH 重启竞态），v2TurnStartAt 会一直留着，
  // isConversationBusyV2 永久为 true → 该会话所有新唤醒都被塞进 pendingWakeReasons 且永远等不到排空，
  // 表现就是"她在某个群里突然再也不说话了"（2026-10-07 12:53 茶话会就是这么卡住的）。
  const v2LastFrameAt = new Map();
  // [patch 回合尾巴 2026-10-18] sessionId -> 这一轮「已经说完了」的时间。
  //
  // 为什么需要：DSH 内核在 step/end 之后还有一段约 27 秒的收尾维护才发 turn/end
  // （实测：assistant/message 6.8s、step/end 6.8s、turn/end 34.2s，中间零事件）。
  // 这 27 秒里 v2TurnStartAt 一直在，于是 freshSessionBeforeWakeV2 会误判「回合还在跑」
  // 而拒绝轮换会话；状态面板也会一直显示 turnOpen。用户感知的回复延迟不受影响
  // （消息在 assistant/message 之后就已经发出去了），但状态和轮换判断是错的。
  // 判据：收到**不带 tool_use** 的 assistant/message ⇒ 这一步说完了；带 tool_use 说明还要
  // 接着干活，立刻作废。真正决定能否轮换时再要求「安静 2 秒」，避免把后续工具步劈开。
  //
  // 只用于**轮换判断**（freshSessionBeforeWakeV2），不要拿去改 busyPartsV2：
  // 内核 `startDriver`（dsh-agent-loop/lib/index.js:847-856）在 maintenance 期间收到新
  // prompt 只会 `phase.wakeRequested = true` 把驱动**挂住**，等维护结束才真正开回合。
  // 也就是说「尾巴期把她当空闲」并不能让下一句回得更快，只会把唤醒从
  // pendingWakeReasons 挪进 DSH inbox 里干等，反而绕开现成那条被测过的路径。
  const v2TurnIdleAt = new Map(); // sessionId -> timestamp
  // [patch 卡死逃逸] 「会话占用」判定的自愈上限：任何占用来源只要超过这段时间还没有任何
  // DSH 事件，就当作残留状态而不是真在跑。为什么必须有它：turnWatchTick 只认 v2TurnStartAt，
  // 而 isConversationBusyV2 还认 collectors —— 后者会被**任意一条非回合事件**在
  // `collectors.set(frame.sessionId, collector)` 处建出来，而删除只发生在 turn/end；
  // 丢一次 turn/end 就等于永久占住，busy 永远为真、看门狗永远不触发，
  // 表现就是「她再也不回我消息」（2026-10-11 17:41 起私聊就这么卡了 2.5 小时）。
  const V2_BUSY_STALE_MS = 480000; // 8 分钟
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  // [并发] 点名认领表：sessionId -> { ids, slot }。回合收场时靠它结算（答了就结清，没答就放回）。
  // 放在模块级而不是 main 中途：retireSession / 工作区重置这些早期路径也要能安全地清它（避开 const TDZ）。
  const pendingAskClaimsV2 = new Map();
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // [patch 长思考先说一句] sessionId -> { timer, turnStart }：长思考垫场话的定时器；以及本回合是否已垫过。
  // 起因（2026-10-18 主人 m11759）：「要是出现了长时间的思考，就要 AI 提前发布一条对话，以回应」。
  const thinkingFillerTimers = new Map();
  const thinkingFillerSentTurns = new Set(); // `${sessionId}#${turnStart}`
  const thinkingFillerCursor = new Map(); // key -> 轮换下标
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'longcat-2.5-preview-free';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 把一次**失败回合**记进账本（`k=fail`）。
   *
   * 为什么必须有：provider 报错时不产生任何 usage，所以 `k=turn` 只覆盖成功回合，
   * 账本上「失败率」永远看不见。2026-10-11 余额耗尽那半天，账本里一个字都没有，
   * 只能从雪露的发送日志里把 402 翻出来 —— 这个洞就是那次暴露的。
   *
   * 状态码优先取错误对象字段；DSH 有时把整段话塞进 message
   * （`Insufficient Balance (request_id: …) code:"QUOTA" status:402`），所以再兜一次正则。
   */
  function recordTurnFailure(sessionId, ended, message) {
    try {
      const err = ended?.reason?.error ?? {};
      const text = typeof message === 'string' ? message : '';
      let status = err.status ?? err.statusCode ?? err.httpStatus;
      let code = err.code;
      if (!Number.isFinite(Number(status))) {
        const m = /(?:status|状态码)\s*[:：=]?\s*(\d{3})/i.exec(text);
        if (m) status = Number(m[1]);
      }
      if (typeof code !== 'string' || !code) {
        const m = /code\s*[:：=]\s*"?([A-Za-z0-9_\-]{2,40})"?/.exec(text);
        if (m) code = m[1];
      }
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestFailure({
        sessionId,
        turn: ended?.turn,
        step: Number.isFinite(Number(err.step)) ? Number(err.step) : 0,
        retry: Number.isFinite(Number(err.retry)) ? Number(err.retry) : 0,
        kind: typeof ended?.reason?.kind === 'string' ? ended.reason.kind : 'error',
        status,
        code,
        message,
        model: known?.model,
        provider: known?.provider
      });
      // 接口报错她也会不爽 —— 但 note 里写清楚「不是对方的问题」，别让她迁怒聊天对象。
      setMood('annoyed', '刚跟后端那边撞了车（接口报错，不是对方的问题）');
    } catch (error) {
      log('token 账本：记录失败回合出错', error?.message ?? error);
    }
  }

  // ── [patch 毒会话自愈] 会话级错误不再把这个会话「焊死」 ──────────────────────
  // 证据（2026-10-11 21:40–21:50，group:429626254）：某轮历史一旦把请求弄成 400
  // （providerError → INVALID_REQUEST），之后**每一轮 step1 都必 400** ——
  // 日志里连刷 14 条「[错误] … agent 处理出错：DeepSeek Messages request failed (400)」，
  // 重启桥接、清未读、她自己重试全都没用；直到「[patch 省token] 会话轮换」把上下文顶到
  // 60000 触发退役重建，她**立刻**恢复正常回话。
  // 结论：这类错误是**会话级中毒**，不换会话就永远不回话 —— 用户报的「有时候她不会回信息」
  // 里就有一份是这个。所以同一个 key 连续 2 次同类错误即判定中毒，直接退役重建，
  // 下一次唤醒自动用全新会话（旧事靠跨会话回放续上，不会失忆）。
  // 刻意**不**包含 MALFORMED_RESPONSE（那是模型这一次吐了坏 JSON，换会话也一样，正解是
  // 让 provider 重试）和 402/429（账号级问题，换会话没用）。
  const POISON_CODES_V2 = new Set(['INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED']);
  const POISON_STREAK_LIMIT = Math.max(1, Number(cfg.socialV2?.selfHeal?.poisonStreak) || 2);
  const poisonStreak = new Map(); // key -> { code, count }
  // [patch 坏 JSON 修复重试] 每个 key 最近一次「坏 JSON 补跑」的时间，冷却窗口内不再补。
  const malformedRetryAt = new Map();
  // [patch 中断补跑] 每个 key 最近一次「回合被中断后补跑」的时间（冷却窗口内不重复补）。
  const interruptRetryAt = new Map();
  // [延迟] 每个会话上一次「带 wakeReason 的投递」时间：用来判断该复用还是重开会话。
  const lastWakeDeliveredAtV2 = new Map();
  function clearPoisonStreak(key) {
    if (key) poisonStreak.delete(key);
  }
  /** 记一次失败；返回 true 表示「已经连续 POISON_STREAK_LIMIT 次，该换会话了」。 */
  function notePoisonFailure(key, code) {
    const c = String(code ?? '');
    if (!key || !POISON_CODES_V2.has(c)) {
      clearPoisonStreak(key);
      return false;
    }
    const cur = poisonStreak.get(key);
    const count = cur && cur.code === c ? cur.count + 1 : 1;
    poisonStreak.set(key, { code: c, count });
    if (count < POISON_STREAK_LIMIT) return false;
    poisonStreak.delete(key);
    return true;
  }
  /** 取错误码：优先错误对象字段，其次从文案里兜正则（与 recordTurnFailure 同一套判据）。 */
  function failureCodeOf(ended, message) {
    const err = ended?.reason?.error ?? {};
    let code = err.code;
    if (typeof code !== 'string' || !code) {
      const m = /code\s*[:：=]\s*"?([A-Za-z0-9_-]{2,40})"?/.exec(typeof message === 'string' ? message : '');
      if (m) code = m[1];
    }
    return typeof code === 'string' && code ? code : '';
  }

  // ── 失败回合的「用户侧话术」与「主人通知」 ────────────────────────────────
  // 起因：agent 出错时旧代码把**原始报错**原封不动发进会话，于是群里出现过
  // 「⚠️ agent 处理出错：Insufficient Balance (request_id: …)」这种既吓人又
  // 泄露内部细节的东西；更糟的是 AstrBot 那侧把这条当新消息又拦又记，日志里
  // 凭空多出一堆「路线 A 故障」的假线索（2026-10-11 排查时就被它误导过）。
  //
  // 现在的分工：
  //   * 主人私聊 = 运维窗口，报错原文照发，一眼能定位；
  //   * 其它会话 = 回一句自然的卡壳话术，技术细节私聊给主人；
  //   * 通知按会话限流（默认 5 分钟一次），否则整段故障期会被刷屏。
  const SOFT_FAIL_LINES_V2 = [
    '（雾汐卡了一下，等我缓过来再回你）',
    '（诶…我这会儿有点转不过来，稍后再戳我一次？）',
    '（刚才脑子短路了，让我缓缓）'
  ];
  let softFailLineIdxV2 = 0;
  function softFailLineV2() {
    const line = SOFT_FAIL_LINES_V2[softFailLineIdxV2 % SOFT_FAIL_LINES_V2.length];
    softFailLineIdxV2 += 1;
    return line;
  }
  // 注意用 isFinite 而不是 `||`：配 0 的语义是「不限流」，`0 || 默认` 会把它吃掉。
  const failNotifyRawMs = Number(cfg.socialV2?.feedback?.failNotifyOwnerMs);
  const FAIL_OWNER_NOTIFY_MS = Number.isFinite(failNotifyRawMs) && failNotifyRawMs >= 0 ? failNotifyRawMs : 5 * 60 * 1000;
  const failOwnerNotifyAt = new Map();
  /** 把一次回合失败私聊告诉主人（同一个会话限流，避免故障期刷屏）。 */
  async function notifyOwnerOfTurnFailure(key, safeMsg) {
    const ownerKey = `private:${String(cfg.ownerQQ ?? '')}`;
    if (!cfg.ownerQQ || key === ownerKey) return;
    const now = Date.now();
    if (now - (failOwnerNotifyAt.get(key) || 0) < FAIL_OWNER_NOTIFY_MS) return;
    failOwnerNotifyAt.set(key, now);
    try {
      await sendToQQ(ownerKey, `⚠️ 雾汐在 ${key} 处理出错（已用兜底话术回过去）：${safeMsg}`);
    } catch (error) {
      log(`[错误] 通知主人失败回合出错：${error?.message ?? error}`);
    }
  }

  // ── 作息与心情 ────────────────────────────────────────────────────────────
  // 为什么要有：她的情绪原来只活在一轮提示词里 —— 换一轮就归零，于是永远是同一种
  // 心情，「今天她不太高兴」这种事根本表达不出来。这里给一个**跨轮持续、随作息漂移**
  // 的心情 / 精力状态，每轮只注入一行（省 token 是硬约束，所以不能写长）。
  //
  // 三条设计约束：
  //   1) **只读时钟 + 少量事件，不做任何 LLM 调用** —— 每次唤醒都要注入，不能有成本；
  //   2) **心情有惯性**：事件设的心情会「按住」一段时间（默认 40 分钟）不被作息覆盖，
  //      否则深夜一注入就把刚被戳烦的心情冲成「困」；
  //   3) **注入要短**：一句话说清「现在几点、精力多少、什么心情、按这个说话」。
  const MOOD_LABELS = {
    happy: '开心', excited: '兴奋', calm: '平静',
    tired: '有点累', sleepy: '犯困', annoyed: '有点烦', sad: '有点低落'
  };

  // ── [patch 心情打卡/树洞] 群友心情的白名单与中文名 ──────────────────────────
  // 和 MOOD_LABELS（她自己的心情）分开维护：她能演的"犯困"不该出现在群友打卡里，
  // 群友的"累了/emo 了/谢谢谁"也不是她能按下的状态。值刻意和 MOOD_LABELS 对齐的
  // 那几个（happy/tired/annoyed/sad）是为了两边复用 events 表的 kind='mood:<mood>' 口径。
  const MOOD_KINDS_V2 = ['happy', 'tired', 'stressed', 'sad', 'excited', 'angry', 'touched', 'calm'];
  const MOOD_LABELS_V2 = {
    happy: '开心', tired: '累了', stressed: '压力大', sad: '有点低落',
    excited: '兴奋', angry: '生气', touched: '被暖到', calm: '平静'
  };
  const moodTimes = new Map();

  /** 本地时间对应的作息时段（含精力基线）。 */
  function scheduleSegmentAt(d = new Date()) {
    const h = d.getHours();
    if (h < 2) return { name: '深夜', energy: 22, note: '已经很晚了，回话会变短、容易犯困' };
    if (h < 6) return { name: '凌晨', energy: 8, note: '本该在睡觉，只有被明确叫到才像被吵醒一样回两句' };
    if (h < 9) return { name: '清晨', energy: 42, note: '刚醒，迷迷糊糊' };
    if (h < 12) return { name: '上午', energy: 75, note: '精神不错' };
    if (h < 14) return { name: '中午', energy: 58, note: '有点困，惦记着吃饭' };
    if (h < 18) return { name: '下午', energy: 70, note: '正常状态' };
    if (h < 22) return { name: '晚上', energy: 82, note: '一天里最活跃的时候' };
    return { name: '深夜', energy: 34, note: '开始犯困' };
  }

  let moodState = null;

  /** 读心情状态（首次调用回落成「当前作息」的默认心情）。 */
  function readMoodState() {
    if (moodState) return moodState;
    const seg = scheduleSegmentAt();
    moodState = {
      mood: seg.energy >= 75 ? 'happy' : (seg.energy <= 25 ? 'sleepy' : 'calm'),
      energy: seg.energy,
      since: Date.now(),
      updatedAt: Date.now(),
      lastInteractAt: 0,
      note: '',
      // [情绪] 她自己用 qq_memory_append(category=mood, extra.holdMin) 按下的「心情保鲜期」：
      // 到点前作息漂移不许覆盖。0 = 没按住，交给作息。
      holdUntil: 0
    };
    try {
      const raw = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.mood === 'string' && MOOD_LABELS[raw.mood]) moodState.mood = raw.mood;
        if (Number.isFinite(Number(raw.energy))) moodState.energy = Math.max(0, Math.min(100, Number(raw.energy)));
        if (Number.isFinite(Number(raw.since))) moodState.since = Number(raw.since);
        if (Number.isFinite(Number(raw.lastInteractAt))) moodState.lastInteractAt = Number(raw.lastInteractAt);
        if (Number.isFinite(Number(raw.holdUntil))) moodState.holdUntil = Number(raw.holdUntil);
        if (typeof raw.note === 'string') moodState.note = raw.note.slice(0, 200);
      }
    } catch { /* 首次运行 / 文件损坏：直接用作息默认值 */ }
    return moodState;
  }

  function saveMoodState() {
    try {
      fs.mkdirSync(path.dirname(MOOD_FILE), { recursive: true });
      fs.writeFileSync(MOOD_FILE, JSON.stringify(readMoodState(), null, 2), 'utf8');
    } catch (error) {
      log('心情：保存失败', error?.message ?? error);
    }
  }

  /**
   * 心情随「作息基线 + 时间」自然漂移，每轮唤醒前调一次。
   * 注意**不覆盖**刚被事件改过的心情：只有它已经持续超过 holdMs 才让作息接管。
   */
  function tickMood(at = Date.now()) {
    const st = readMoodState();
    const seg = scheduleSegmentAt(new Date(at));
    const target = seg.energy;
    const step = Math.max(1, Math.round(Math.abs(target - st.energy) * 0.25));
    st.energy = st.energy < target
      ? Math.min(target, st.energy + step)
      : Math.max(target, st.energy - step);
    // 默认 15 分钟（旧默认 40 分钟）：情绪换得太慢就看不见，太快又像随机数。
    const holdMs = Math.max(60_000, Number(cfg.socialV2?.mood?.holdMs) || 15 * 60_000);
    // [情绪] holdUntil 是她自己按下的（见 appendMemoryV2 的 mood 分支）：还没到点就
    // 不许作息把她的心情冲掉。这是「活人」和「按时段刷新的状态机」的区别 —— 她说难过，
    // 就该难过一会儿，而不是下一个整点自动变回平静。
    const holdUntil = Number(st.holdUntil) || 0;
    if (at >= holdUntil && at - st.since > holdMs) {
      st.mood = st.energy <= 20 ? 'sleepy' : (st.energy <= 45 ? 'tired' : (st.energy >= 75 ? 'happy' : 'calm'));
      st.note = '';
      st.since = at;
      st.holdUntil = 0;
    }
    st.updatedAt = at;
    saveMoodState();   // [拟人] 作息漂移也要落盘，否则重启后心情永远停在上一次 setMood 的那一刻
    // 心情变了就让在线状态跟上（同一状态码只发一次，见 applyMoodPresenceV2）。best-effort。
    void applyMoodPresenceV2('tickMood');
    return st;
  }

  /** 由事件外力改心情（会「按住」一段时间不被作息覆盖）。 */
  function setMood(mood, note = '', at = Date.now(), holdMin = 0) {
    if (typeof mood !== 'string' || !MOOD_LABELS[mood]) return;
    const st = readMoodState();
    // [拟人] 只有真的换了情绪才重新计时。旧实现每次调用都把 since 顶到当下，
    // 于是「主人每来一条私聊就 setMood('happy')」把 happy 一直按住（实测 9 天里
    // 约 20.7 小时/天锁在 happy）。现在同一种情绪反复触发不会延长 holdMs，
    // 作息该接管的时候就能接管 —— 情绪才会真的随时间变化。
    const changed = st.mood !== mood;
    st.mood = mood;
    st.note = String(note ?? '').slice(0, 200);
    if (changed) st.since = at;
    // [情绪] holdMin：这次心情至少按住几分钟。她主动记心情时给（默认 30、上限 240 分钟）；
    // 桥接按事件调 setMood 时不传，于是只在真的换了情绪时清掉上一段按住。
    const hold = Number(holdMin);
    if (Number.isFinite(hold) && hold > 0) {
      st.holdUntil = at + Math.max(60_000, Math.min(240 * 60_000, Math.round(hold * 60_000)));
    } else if (changed) {
      st.holdUntil = 0;
    }
    st.updatedAt = at;
    saveMoodState();
  }

  /**
   * [情绪] 心情对「主不主动开口」的影响系数。
   * 人设里写了「情绪会决定回不回、怎么回」，这里让它在代码里也真的成立：
   * 兴奋/开心更容易主动凑热闹，累/困/难过/烦则明显更少主动开话题（但不影响被 @ 后必须回）。
   * 只乘主动开话题的概率，不动回复路径 —— 别让心情变成不回消息的借口。
   */
  const MOOD_INITIATIVE = { excited: 1.3, happy: 1.15, calm: 1, tired: 0.75, sleepy: 0.45, sad: 0.7, annoyed: 0.5 };
  function moodInitiativeFactorV2() {
    try {
      if (cfg.socialV2?.mood?.enabled === false) return 1;
      const st = tickMood();
      const f = MOOD_INITIATIVE[st.mood];
      return Number.isFinite(f) ? f : 1;
    } catch {
      return 1;
    }
  }

  /**
   * [情绪] 心情对「说话节奏」的影响：条数系数 + 条间间隔系数。
   * 与 MOOD_INITIATIVE 的分工：那个管「要不要主动开口」，这个管「开口之后说几句、隔多久」。
   * 兴奋时话密且回得快，累/难过时一句说完就想歇。socialV2.mood.affectsPacing === false 可关。
   */
  const MOOD_PACE = {
    excited: { count: 1.15, gap: 0.75 },
    happy: { count: 1, gap: 0.9 },
    calm: { count: 1, gap: 1 },
    tired: { count: 0.7, gap: 1.35 },
    sleepy: { count: 0.55, gap: 1.5 },
    sad: { count: 0.6, gap: 1.45 },
    annoyed: { count: 0.55, gap: 1.5 },
  };
  function moodPaceV2() {
    const neutral = { count: 1, gap: 1 };
    try {
      if (cfg.socialV2?.mood?.enabled === false || cfg.socialV2?.mood?.affectsPacing === false) return neutral;
      const st = tickMood();
      const p = MOOD_PACE[st.mood];
      if (!p) return neutral;
      return {
        count: Number.isFinite(p.count) ? p.count : 1,
        gap: Number.isFinite(p.gap) ? p.gap : 1,
      };
    } catch {
      return neutral;
    }
  }

  /**
   * [情绪] 每种心情在提示词里的一句话行为建议（跟在【此刻】后面）。
   * 只影响她「怎么说话」，不改变她「必须回消息」——难过不是沉默的借口。
   */
  const MOOD_TONE = {
    excited: "这会儿话密、回得快；可以多说两句，别收着",
    happy: "心情不错，语气松一点，允许自己开个小玩笑",
    calm: "",
    tired: "今天话少、句子短，懒得多打字的劲儿要露出来",
    sleepy: "困得只能短回，一两句就够，别硬撑着聊天",
    sad: "低落的时候话更少更短，别硬撑热闹；也不用宣布难过",
    annoyed: "这会儿不太想接梗，语气淡一点、句子短一点；但别阴阳怪气",
  };

  /**
   * [口癖] 她自己攒出来的说话习惯。
   * 数据来自 memory-db 里她发过的消息（is_self=1）——统计常用词与句尾，让她的话有连续性，
   * 而不是每轮都从人设里现编一套语气。socialV2.style.enabled === false 可关。
   */
  function selfStyleLineV2() {
    if (cfg.socialV2?.style?.enabled === false) return "";
    try {
      const mdb = memoryDb();
      if (!mdb || typeof mdb.styleProfile !== "function") return "";
      const p = mdb.styleProfile({ limit: Number(cfg.socialV2?.style?.sampleLimit) || 400 });
      if (!p || !Number(p.count)) return "";
      const maxChars = Math.max(60, Number(cfg.socialV2?.style?.maxChars) || 150);
      const bits = [];
      if (Array.isArray(p.top) && p.top.length) bits.push("常用「" + p.top.join("」「") + "」");
      if (Array.isArray(p.tails) && p.tails.length) bits.push("句尾常带「" + p.tails.join("」「") + "」");
      if (Number(p.avgLen) > 0) bits.push("一条平均 " + p.avgLen + " 字");
      if (!bits.length) return "";
      let body = "";
      for (let i = bits.length; i > 0; i--) {
        const candidate = "【你说话的习惯】" + bits.slice(0, i).join("；") + "。这是你自己聊出来的口癖，顺嘴就用，别刻意每句都塞。";
        if (candidate.length <= maxChars || i === 1) { body = truncateText(candidate, maxChars); break; }
      }
      return body ? body + "\n\n" : "";
    } catch (error) {
      log("[口癖] 注入失败：" + (error?.message ?? error));
      return "";
    }
  }

  /**
   * [情绪记忆] 「上次那件事」：她记得自己什么时候为什么不高兴（写进 memory-db 的 events 表），
   * 所以重启之后也不会一觉睡回没脾气。只在她还「没消气」（最近一条负面情绪比最近一条好心情更新）时提起。
   * socialV2.mood.memory === false 关闭；memoryDecayHours 默认 48 小时。
   */
  function moodMemoryLineV2() {
    if (cfg.socialV2?.mood?.enabled === false || cfg.socialV2?.mood?.memory === false) return "";
    try {
      const mdb = memoryDb();
      if (!mdb || typeof mdb.recentMoodEvents !== "function") return "";
      const decayH = Math.max(1, Number(cfg.socialV2?.mood?.memoryDecayHours) || 48);
      const rows = mdb.recentMoodEvents({ sinceMs: Date.now() - decayH * 3600 * 1000, limit: 5 });
      if (!Array.isArray(rows) || !rows.length) return "";
      const neg = rows.find((r) => r && (r.mood === "sad" || r.mood === "annoyed"));
      if (!neg) return "";
      const pos = rows.find((r) => r && (r.mood === "happy" || r.mood === "excited"));
      if (pos && Number(pos.at) > Number(neg.at)) return "";
      const hours = Math.max(1, Math.round((Date.now() - Number(neg.at)) / 3600000));
      const what = truncateText(String(neg.summary || "").trim(), 60);
      if (!what) return "";
      return "【心里还记着】" + hours + " 小时前：" + what + "。你还带着这点情绪——语气可以淡，但别主动翻旧账，也别阴阳怪气。\n\n";
    } catch (error) {
      log("[情绪记忆] 注入失败：" + (error?.message ?? error));
      return "";
    }
  }

  /**
   * [patch 心情打卡/树洞] 把"这个群里最近谁心情怎么样"喂给她。
   * 和 moodMemoryLineV2 的区别：那个是**她自己的**情绪残留（会改她的语气）；
   * 这个是**群友的**打卡记录，不改语气，只是让她想起来"这人昨天说累了，今天可以顺口问一句"。
   * 只读当前会话（key），绝不跨群——私聊的树洞内容不出现在群里。
   */
  function moodBoardLineV2(key) {
    if (cfg.socialV2?.mood?.board === false) return '';
    try {
      const mdb = memoryDb();
      if (!mdb || typeof mdb.listMemberMoods !== 'function') return '';
      const hours = Math.max(1, Number(cfg.socialV2?.mood?.boardHours) || 36);
      const maxN = Math.max(1, Math.min(Number(cfg.socialV2?.mood?.boardMaxEntries) || 6, 12));
      const rows = mdb.listMemberMoods(key, { hours, limit: 40 });
      if (!Array.isArray(rows) || !rows.length) return '';
      // 同一个人最近一条就够（他今天先累后开心，只看最新的），按时间倒序取前 maxN 个人。
      const seen = new Set();
      const lines = [];
      const now = Date.now();
      for (const r of rows) {
        const who = Array.isArray(r.who) && r.who.length ? String(r.who[0]) : '';
        const dedupKey = who || `anon:${String(r.summary || '').slice(0, 20)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const label = MOOD_LABELS_V2[r.mood] || r.mood;
        const hh = Math.max(0, Math.round((now - Number(r.at)) / 3600000));
        const when = hh <= 0 ? '刚刚' : (hh < 24 ? `${hh} 小时前` : `${Math.round(hh / 24)} 天前`);
        const what = truncateText(String(r.summary || '').replace(/^[^：:]{1,20}[：:]/, ''), 50);
        lines.push(`- ${who ? `${who}（${when}）` : `（树洞·匿名，${when}）`} ${label}${what ? `：${what}` : ''}`);
        if (lines.length >= maxN) break;
      }
      if (!lines.length) return '';
      return `【群里最近的心情（有就打听着点，别一上来就念，也别当病历问诊）】\n${lines.join('\n')}\n（有人状态不好就顺口关心一句，别追问隐私；树洞是匿名的，别猜是谁。）\n\n`;
    } catch (error) {
      log('[心情板] 注入失败：' + (error?.message ?? error));
      return '';
    }
  }

  /**
   * 每轮注入的心情/作息提示行。
   * @param {string} [reason] 唤醒原因；用来让「被点名 / 被戳 / 自己主动冒泡」有不同反应
   */
  function moodLineV2(reason = '', grumpSig = null) {
    if (cfg.socialV2?.mood?.enabled === false) return '';
    try {
      const st = tickMood();
      const r = String(reason || '').toLowerCase();
      // [patch 暴躁] 这一轮要是被暴躁模式判成 2 级以上，心情直接按到「有点烦」并按住一会儿——
      // 优先级高于「被点名 → 兴奋」：她正被人往嘴里塞东西，不该因为一条 @ 就变开心。
      if ((Number(grumpSig?.level) || 0) >= 2 && cfg.socialV2?.grump?.enabled !== false) {
        setMood('annoyed', grumpMoodNoteV2(grumpSig), Date.now(), resolveGrumpCfg(cfg.socialV2?.grump).holdMin);
      } else if (/(^|:)at|mention|被点名/.test(r)) setMood(st.energy >= 60 ? 'excited' : 'tired', '刚被点名');
      else if (r === 'poke') setMood('annoyed', '刚被人拍了一拍');
      else if (r === 'proactiveCheck') setMood('happy', '自己想找人说说话');
      const seg = scheduleSegmentAt();
      const hhmm = new Date().toTimeString().slice(0, 5);
      const label = MOOD_LABELS[st.mood] ?? '平静';
      const note = st.note ? `（${st.note}）` : '';
      const tone = MOOD_TONE[st.mood] ?? '';
      return `【此刻】${seg.name} ${hhmm}，精力 ${Math.round(st.energy)}/100，心情：${label}${note}。${seg.note}。按这个状态说话就行，别装精神饱满，也不用刻意提心情。${tone ? tone + '。' : ''}\n\n`;
    } catch (error) {
      log('心情：注入失败', error?.message ?? error);
      return '';
    }
  }

  /**
   * owner 专用 `#诊断`：把「她怎么不说话了 / 说话怪怪的」时要看的东西一次列全。
   *
   * 设计原则：
   *   - **只读、永不抛**：任何一项取不到就写「未知」，绝不因为诊断本身失败而让主人看不到别的；
   *   - **不联网**：余额/在线取的是 `alert-watch` 那个 10 分钟任务留下的快照，
   *     所以这条命令毫秒级返回，也不会因为断网卡住；
   *   - **一屏内**：主人是在 QQ 里看，超过二十行就没人看了。
   */
  async function buildDiagnostic(key, kind, id) {
    const L = [];
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    L.push(`🩺 雾汐自检 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

    // 1) 运行状态
    const upMin = Math.round(process.uptime() / 60);
    const upText = upMin >= 60 ? `${Math.floor(upMin / 60)} 小时 ${upMin % 60} 分` : `${upMin} 分`;
    const rs = safe(() => readRoleState(), { role: null, mode: 'active' });
    L.push(`进程：已跑 ${upText}｜模式 ${currentMode}｜角色 ${rs.role ?? '无'}｜${rs.mode === 'silent' ? '⚠️ 静默中' : '正常'}`);

    // 2) 两条链路
    const h = safe(() => snowlumaHealthSnapshot(), null) ?? {};
    const qqBits = [];
    qqBits.push(h.accountOnline === true ? '账号在线' : (h.accountOnline === false ? '⚠️ 账号离线' : '账号状态未知'));
    if (h.good === false) qqBits.push(`⚠️ 接收链路异常（${h.reason || '原因未知'}）`);
    if (h.lastPacketAt) qqBits.push(`事件包 ${Math.round((Date.now() - h.lastPacketAt) / 1000)} 秒前`);
    L.push(`DSH：${dshReady ? '就绪' : '⚠️ 未连接'}｜QQ：${qqBits.join('、')}`);

    // 3) 会话与上下文
    const st = safe(() => getSocialV2State(key), null) ?? {};
    const sid = state.sessions[key] ?? null;
    // [patch 卡死逃逸] 用完整占用判定并把它拆开显示：只说「正在处理中」根本查不出是被
    // 哪个条件挡住的（2026-10-11 私聊卡了 2.5 小时就是这么发生的）。
    const busyParts = safe(() => busyPartsV2(key, st), []);
    const busy = safe(() => isConversationBusyV2(key, st), false);
    const input = safe(() => (sid ? tokenLedger.latestStepInput(sid) : 0), 0);
    const rotateAt = Number(cfg.socialV2?.context?.rotateAtContextTokens) || 0;
    L.push(`会话：${sid ? String(sid).slice(-8) : '尚未创建'}｜${busy ? `正在处理中（${busyParts.join('+')}）` : `空闲${busyParts.length ? `（残留：${busyParts.join('+')}）` : ''}`}${socialV2.paused ? '｜⚠️ 已暂停' : ''}`);
    if (input > 0) L.push(`上下文：${input.toLocaleString()} tok${rotateAt ? `（轮换阈值 ${rotateAt.toLocaleString()}）` : ''}`);
    const unread = Array.isArray(st.unread) ? st.unread.length : 0;
    const pend = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.length : 0;
    const lastAiMin = st.lastAiReplyAt ? Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000) : null;
    L.push(`未读 ${unread} 条｜积压唤醒 ${pend} 条${lastAiMin != null ? `｜她上次发言 ${lastAiMin} 分钟前` : ''}`);
    L.push(`白名单：${safe(() => (allowed(kind, id, cfg) ? '通过' : '⚠️ 被拦截'), '未知')}`);

    // 4) 失败回合（账本 k=fail）——账户余额耗尽这类事以前在账本上一个字都没有
    const fs1 = safe(() => tokenLedger.failureSummary({ sinceMs: 24 * 60 * 60 * 1000, limit: 3 }), null);
    if (fs1 && fs1.total > 0) {
      const kinds = fs1.byStatus.map((r) => `${r.name}×${r.count}`).join('、');
      L.push(`⚠️ 24 小时内失败 ${fs1.total} 次（${kinds}）`);
      for (const f of fs1.recent.slice(0, 2)) {
        const hhmm = `${pad(new Date(f.t).getHours())}:${pad(new Date(f.t).getMinutes())}`;
        L.push(`    ${hhmm} ${f.status ? `${f.status} ` : ''}${String(f.message ?? '').slice(0, 60)}`);
      }
    } else {
      L.push('24 小时内没有失败回合');
    }

    // 5) 余额 / QQ 在线：读 alert-watch 的 10 分钟快照（不联网，所以毫秒级返回）
    const aw = safe(() => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'qq-dsh-bridge', 'state', 'alert-watch.json'), 'utf8')), null);
    if (aw && typeof aw === 'object') {
      const when = aw.checkedAt ? String(aw.checkedAt).replace('T', ' ').slice(0, 16) : '未知时间';
      L.push(`余额：${aw.balText ?? '未知'}｜QQ 检查：${aw.qqOk === false ? '⚠️ 异常' : '正常'}（${when} 由守护任务查）`);
    } else {
      L.push('余额：守护任务还没留下快照（`QQ-Online-Check` 每 10 分钟一次）');
    }
    return L.join('\n');
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // [patch 卡死逃逸] 必须同时补上回合开始时间：turnWatchTick 只认 v2TurnStartAt，
    // 只设 collectors 会让这个「恢复出来的回合」永远不在看门狗的视野里。
    v2TurnStartAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  // [patch DSH重启清残留] DSH 探活失败的时刻：只有「断了一会儿」才算真重启，避免一次偶发探活
  // 失败就把正在跑的回合判成死的（见 releaseInflightOnDshRestart）。
  let dshDownSince = 0;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // [patch 启动先用本地模式] 模式是从哪儿来的：DSH settings 还是本地 state/mode.json。
  // 只用于启动日志与排障（主人 m01940 那次就是「DSH 一直不在线 ⇒ 模式停在 chat ⇒ 一代
  // 路径不写 reserved2 水位 ⇒ 补拉把旧消息当新的重放」，日志里能一眼看出模式来源）。
  let modeFromDsh = false;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // ── [patch 信息队列禁用] 不再把离线期间的消息攒起来补跑 ──────────────────────
  // 用户 m03167：「信息队列不做，禁止（要求绝对的静默）」。
  // 原行为有两处「信息队列」：
  //   ① DSH 重启期间把收到的每条消息入队（QUEUE_MAX=50），并在群里回一句
  //      「⏳ 系统服务重启中，消息已排队，恢复后自动处理。」；DSH 恢复后 flushQueue 一次性补投。
  //   ② DSH 恢复时把 pendingWakeReasons 里积压的唤醒挑最后一条补发（releaseInflightOnDshRestart）。
  // 这两者都是「可见的弹幕 + 恢复后一堆全上下文 prompt」= 用户最讨厌的两件事（弹窗 + 烧 token）。
  // 现在默认整条链路关闭：DSH 不可用时消息**不入队、不提示、不补投**，恢复后也不补发积压唤醒，
  // 只记一行日志。（reserved2 模式下消息在更前面就已写进未读，恢复后她看得到这些上下文，
  //   只是不会有人替她把积压「跑一遍」。）
  // 想恢复旧行为：config.json 的 socialV2.dshQueue = { enabled: true, notify: true }。
  const dshQueueEnabledV2 = () => cfg.socialV2?.dshQueue?.enabled === true;
  const dshQueueNotifyV2 = () => dshQueueEnabledV2() && cfg.socialV2?.dshQueue?.notify !== false;

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        dshDefaultPreset = presetNs.value.default;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      const fromDsh = ns?.value ? normalizeModeInput(ns.value.mode) : null;
      if (fromDsh) {
        currentMode = fromDsh;
        modeFromDsh = true;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) { currentMode = fromLocal; modeFromDsh = false; }
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /**
   * 主人私聊专用的 preset（多一套手机控制工具）。
   *
   * 返回 {name:'', why} 表示「没有可用的主人 preset」，调用方必须**回退到普通 preset**
   * （而不是拒绝建会话）——手机是附加能力，装不上不该让主人的私聊也用不了。
   * 但回退的目标是普通 QQ preset，**绝不是 DSH 默认 preset**（那里有本地执行工具）。
   */
  function ownerPreset(cfg) {
    const wanted = String(cfg.socialV2?.ownerAgentPreset ?? '').trim();
    if (!wanted) return { name: '', why: '' };   // 显式关闭，不告警
    const resolved = resolvePresetName(wanted, { strict: true });
    return resolved
      ? { name: resolved, why: '' }
      : { name: '', why: `DSH 的 preset 清单里没有 "${wanted}"（跑 node scripts/setup-dsh.mjs 后重启 DSH）` };
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 主人私聊单独走一个 preset（多一套手机工具）。
    //
    // 为什么按 key 分流、而不是新加一个模式：closed-agent 模式会让**群聊整体停摆**
    // （modeAllowed 只放行 owner 私聊），而这里要的是「她照常在群里聊，只有主人的私聊
    // 多一套手机工具」。modePreset 的 key 参数本来就是给这种分流留的（sessionPolicy
    // 也是按 key 算的，所以策略变更会正常触发会话重建）。
    //
    // ⚠️ 这里是「谁能操作手机」的唯一判据：key 必须精确等于 private:<ownerQQ>，
    // 不能放宽成前缀匹配或"管理员也在群里"之类。ownerQQ 未配置时一律不分流。
    if (cfg.ownerQQ && key === `private:${String(cfg.ownerQQ)}`) {
      const { name: chosen, why } = ownerPreset(cfg);
      if (chosen) return chosen;
      if (why) log(`⚠️ 主人私聊的 preset 不可用：${why}；已回退到普通 preset（主人暂时无法操作手机）`);
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  // [并发] 第二槽位会话（aux）：同一个群的第二个 DSH 会话，见 ensureAuxSessionV2。
  const auxSessionPromisesV2 = new Map(); // key -> Promise<sessionId|null>（防并发重复创建）
  const auxWakeAtV2 = new Map();          // key -> 上次派发补答回合的时间（节流）

  function auxKeyOfSessionV2(sessionId) {
    if (!sessionId || !state.auxSessions || typeof state.auxSessions !== 'object') return undefined;
    for (const [k, sid] of Object.entries(state.auxSessions)) if (sid === sessionId) return k;
    return undefined;
  }

  function isAuxSessionV2(key, sessionId) {
    return !!sessionId && !!state.auxSessions && state.auxSessions[key] === sessionId;
  }

  /**
   * 拿到（必要时创建）这个群的第二槽位会话；任何失败都返回 null，绝不影响主路径。
   * 为什么需要它：一个群只挂一个 DSH 会话时，一轮只能跑一个回合，热闹时五个人同时 @ 她，
   * 后面的回合只能排队（一条消息几十秒），表现就是漏人（用户 m02240）。
   * 第二槽位只在「主会话正忙 + 还有没接住的点名」时被派发一个瘦提示词的补答回合，空闲时零成本。
   */
  async function ensureAuxSessionV2(key) {
    if (!String(key).startsWith('group:')) return null;
    if (!concurrencyCfgV2().enabled) return null;
    if (!isSessionAllowedInCurrentMode(key)) return null;
    const existing = state.auxSessions?.[key];
    if (existing && isAuxSessionV2(key, existing)) {
      const applied = await ensureChatModel(existing);
      if (applied !== 'not-found') return existing;
      log('[并发] 第二槽位会话在 DSH 侧已不存在，重建 ' + key);
      delete state.auxSessions[key];
      saveState();
    }
    if (auxSessionPromisesV2.has(key)) return auxSessionPromisesV2.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      const preset = modePreset(key, currentMode, cfg);
      // 群聊会话必须 fail-closed：拿不到 qq-chat* 就宁可不并发，也绝不让 DSH 用默认 preset
      // （standard）顶上 —— 那等于把 bash/文件读写暴露给群里任何人（见 RULES.md「无本地工具」）。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        log('[并发] 拒绝创建第二槽位会话 ' + key + '：模式 ' + currentMode + ' 需要 qq-chat* preset，但没有可用的');
        return null;
      }
      let sessionId = null;
      let lastError = null;
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          break;
        } catch (error) { lastError = error; }
      }
      if (!sessionId) {
        log('[并发] 第二槽位会话创建失败 ' + key + '：' + (lastError?.message ?? '未知原因'));
        return null;
      }
      api.events.follow(sessionId);
      if (!state.auxSessions || typeof state.auxSessions !== 'object') state.auxSessions = {};
      state.auxSessions[key] = sessionId;
      saveState();
      await ensureChatModel(sessionId);
      log('[并发] 第二槽位会话 ' + key + ' -> ' + sessionId + '（preset ' + (preset ?? '默认') + '）');
      return sessionId;
    })();
    auxSessionPromisesV2.set(key, promise);
    try { return await promise; } finally { if (auxSessionPromisesV2.get(key) === promise) auxSessionPromisesV2.delete(key); }
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await api.stopSessionWork(sessionId); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  // [patch 令牌宽限] 会话轮换时把旧 agentToken 记进宽限表（20 分钟内仍可用）：
  // 轮换可能发生在唤醒提示词已经发出去之后，那一轮里她带着旧 token，如果不给宽限，
  // 所有工具调用都会回「agent token 无效」，模型只能反复试。
  // 定义放在 retireSession 之前，因为启动时的 reconcileSessionPolicies 会调用它。
  // [patch 令牌宽限 v2 2026-10-18] 每个 key 保留**多个**旧令牌，而不是只留一个。
  //
  // 为什么：原来 `key -> { token, until }` 只存一代。连着聊的时候一轮一个新会话，
  // 20 分钟内可能轮换 3~4 次，每轮都把上一代的记录覆盖掉 —— 于是「上一轮提示词里
  // 写着的那个令牌」在第二次轮换后就查不到了，工具调用开始整片 403。
  // tool-log 里那 7 次「agent token 无效」就是这条路径（会话刚轮换、模型还在用旧令牌）。
  // 现在保留最近 6 代、宽限 60 分钟：模型上下文里能残留的令牌数远小于这个量级。
  const RETIRED_TOKEN_GRACE_MS = 60 * 60 * 1000;
  const RETIRED_TOKEN_MAX_PER_KEY = 6;
  const retiredAgentTokens = new Map(); // key -> Array<{ token, until }>

  /** 记一代旧令牌。同 key 内按「最近 6 代 + 未过期」裁剪，避免无界增长。 */
  function rememberRetiredToken(key, token) {
    const tk = String(token ?? '');
    if (!tk) return;
    const now = Date.now();
    const list = (retiredAgentTokens.get(key) ?? []).filter((r) => r && r.until > now && r.token !== tk);
    list.push({ token: tk, until: now + RETIRED_TOKEN_GRACE_MS });
    while (list.length > RETIRED_TOKEN_MAX_PER_KEY) list.shift();
    retiredAgentTokens.set(key, list);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    // [并发] 第二槽位会话跟着主会话一起退役：否则它会一直挂在 DSH 里、继续收历史事件，
    // 而每次轮换/重置都会再多留一个。
    const auxId = state.auxSessions?.[key];
    if (auxId) {
      delete state.auxSessions[key];
      collectors.delete(auxId);
      v2TurnStartAt.delete(auxId);
      v2TurnIdleAt.delete(auxId);
      sendToolSucceededSessions.delete(auxId);
      pendingSendToolCalls.delete(auxId);
      toolCallNames.delete(auxId);
      pendingAskClaimsV2.delete(auxId);
      social.silentTurns.delete(auxId);
      social.exitingSessions.delete(auxId);
      api.events.forget?.(auxId);
      stopRetiredSessionWork(auxId, key);
      log('[并发] 第二槽位会话随主会话退役 ' + key + ' -> ' + auxId);
    }
    if (!sessionId) { saveState(); return; }
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    v2TurnIdleAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // [patch 令牌宽限] 轮换前把旧 token 记进宽限表：正在跑的那一轮提示词里带的就是它。
      if (st.agentToken) rememberRetiredToken(key, st.agentToken);
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  // ── [patch DSH重启清残留] DSH 进程换了，旧进程的在途回合事件永远不会再来 ────
  // 2026-10-12 00:45 实测：DSH 重启（00:44:46 探活失败 → 00:45:12 就绪）时，DSH 会重新挂载
  // 每个会话并补发一次**非回合事件**，于是 collectors 被建出来；那一轮的 turn/end 永远不会到，
  // busyPartsV2 就一直认定「正在处理中」——主人 00:45:57 起连发 8 条（含 2 次拍一拍）全被
  // 「会话繁忙，暂存唤醒原因」挡在门外，直到 collector 过期（V2_BUSY_STALE_MS = 8 分钟）才恢复，
  // 期间她的会话一次都没被唤醒（turn/start 停在 7 次）。
  // DSH 只要重新就绪，就说明旧进程已经死了：旧进程的在途回合不可能再结束，直接清掉并补发积压。
  // 只清「回合态」标记，不动 pendingWakeKeys（它有自己的 30 分钟租约，且入队补投要靠它兜底）。
  // [patch 中断补跑] DSH 重启时，如果正有 send_message 在途（调用发出去了、结果没回来），
  // 那句话大概率没发出去。补一次「回头检查」的补跑，别让回复静默消失。
  function redriveInterruptedOnRestart(key, sid, label) {
    if (cfg.socialV2?.selfHeal?.interruptRetry === false) return;
    if (!key || !sid) return;
    if (!isCurrentSession(key, sid)) return;
    if (!claimMalformedRetry(interruptRetryAt, key, Date.now(), INTERRUPT_RETRY_COOLDOWN_MS)) {
      log('[中断] ' + key + ' 重启后补跑在冷却窗口内，跳过');
      return;
    }
    log('[中断] ' + key + ' DSH 重启时有消息在途中（' + label + '），补一次检查');
    Promise.resolve()
      .then(() => api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: INTERRUPT_RETRY_HINT }] }))
      .then((accepted) => {
        if (accepted?.result?.ok !== true) log('[中断] ' + key + ' 重启补跑未被接受');
      })
      .catch((error) => log('[中断] ' + key + ' 重启补跑投递失败：' + (error?.message ?? error)));
  }

  function releaseInflightOnDshRestart(reason) {
    let released = 0;
    for (const key of [...socialV2.conversations.keys()]) {
      const sid = state.sessions?.[key];
      if (!sid) continue;
      const hadInflight = collectors.has(sid) || v2TurnStartAt.has(sid)
        || pendingSendToolCalls.has(sid) || toolCallNames.has(sid) || v2LastFrameAt.has(sid);
      // [patch 中断补跑] 删除之前先看：有没有 send_message 发出去了却没等到结果。
      const hadPendingSend = pendingSendToolCalls.has(sid);
      if (!hadInflight) continue;
      collectors.delete(sid);
      v2TurnStartAt.delete(sid);
      v2LastFrameAt.delete(sid);
      pendingSendToolCalls.delete(sid);
      toolCallNames.delete(sid);
      released += 1;
      const st = getSocialV2State(key);
      const items = Array.isArray(st?.pendingWakeReasons) ? st.pendingWakeReasons.splice(0) : [];
      if (items.length && dshQueueEnabledV2()) {
        const lastItem = items[items.length - 1];
        log(`[DSH重启] ${key} 清理在途标记（${reason}），补发积压唤醒 ${lastItem?.reason}@seq${lastItem?.seq}（共 ${items.length} 条）`);
        try { scheduleWakeV2(key, lastItem?.reason || 'timeout', { batchMs: 500 }); } catch (error) { log(`[DSH重启] ${key} 补发失败: ${error?.message ?? error}`); } // [补发直通]
      } else if (items.length) {
        // [patch 信息队列禁用] 不补发积压唤醒（用户 m03167）：这些唤醒就是「恢复后一次性补跑」的来源。
        log(`[DSH重启] ${key} 清理在途标记（${reason}），丢弃 ${items.length} 条积压唤醒（信息队列已禁用）`);
      } else {
        log(`[DSH重启] ${key} 清理在途标记（${reason}）`);
      }
      // [patch 中断补跑] 有消息在途中却没等到结果：补一次「回头检查」（没有积压唤醒时）。
      if (hadPendingSend && !items.length) redriveInterruptedOnRestart(key, sid, reason);
    }
    return released;
  }

  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        const downMs = dshDownSince ? Date.now() - dshDownSince : 0;
        dshDownSince = 0;
        log(`DSH 已就绪（模式: ${currentMode}）${downMs >= 1000 ? `（中断 ${Math.round(downMs / 1000)}s）` : ''}`);
        // [patch DSH重启清残留] 断超过 8 秒才认定是重启：一次偶发探活失败不清正在跑的回合。
        if (downMs >= 8000) {
          try { releaseInflightOnDshRestart(`DSH 中断 ${Math.round(downMs / 1000)}s`); } catch (error) { log('[DSH重启] 清理在途标记失败:', error?.message ?? error); }
        }
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        if (dshQueueEnabledV2()) {
          try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        } else if (queued.size > 0) {
          // [patch 信息队列禁用] 恢复后不补投离线积压（用户 m03167），直接丢掉。
          log(`[信息队列] 已禁用：丢弃 DSH 离线期间积压的 ${queued.size} 个会话消息，不补投`);
          queued.clear();
        }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      dshDownSince = Date.now();
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
    firstDownAt: 0,       // [掉线告警] 第一次发现连不上 OneBot 的时刻
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    } else if (!snowlumaHealth.connected && snowlumaHealth.firstDownAt
      && now - snowlumaHealth.firstDownAt > 3 * 60_000) {
      // 连不上 OneBot 的 HTTP/WS：最常见是 WSL 里的 Linux QQ 掉线（账号不在线时 OneBot 不监听端口）。
      const downMin = Math.round((now - snowlumaHealth.firstDownAt) / 60000);
      hint = `已经 ${downMin} 分钟连不上 SnowLuma 的 OneBot（127.0.0.1:3000/:3001 不通）。`
        + '常见原因：WSL 里的 Linux QQ 掉线了（SnowLuma 日志会写「[OneBot] session closed: UIN=…」）——'
        + '账号不在线时 OneBot 不会监听端口。请到桌面上把 Linux QQ 登录回去，登录后端口自动恢复、桥接自动重连；'
        + '如果 QQ 进程也不在，先跑 scripts/wsl-keepalive.ps1。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  // [拆分 2026-10-18] 控制台 HTTP 层已移到 src/console-server.js（约 5557 行）。
  // 这里只声明依赖表：函数与 const 直接传引用；可变变量用 getter/setter 保证实时。
  // 必须延迟到调用时求值：依赖里不少 const 声明在本函数之后（TDZ）。
  const consoleDeps = () => ({
    ACCOUNT_ACTION_LEVELS,
    ACCOUNT_LEVEL_RANK,
    ACTIVE_WAIT_LEASE_MS,
    ACTIVITY_LOG,
    CONVERSATION_TOKENS,
    FEEDBACK_FILE,
    KNOWN_AGENT_TOKENS,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    MEME_MAX_BYTES,
    MEME_MOODS,
    MEME_MOOD_DICT,
    MOOD_KINDS_V2,
    MOOD_LABELS,
    MOOD_LABELS_V2,
    PLUGIN_DSH_BIN,
    PLUGIN_PROFILE_DIR,
    PRESET_BACKUP_DIR,
    PRESET_NAMES,
    REASONING_EFFORT_DEFAULT,
    REASONING_EFFORT_OPTIONS,
    RETIRED_TOKEN_GRACE_MS,
    ROLE_CONTENT_MAX_BYTES,
    ROLE_NAME_MAX,
    ROOT,
    SENSITIVE_RE,
    SLANG_STATUS,
    SLEEP_DEFAULT_NIGHT_WINDOWS_V2,
    SLEEP_DEFAULT_REPLY_ON_V2,
    SLEEP_DEFAULT_WAKE_WORDS_V2,
    SLEEP_FORCE_AWAKE_FILE_V2,
    SOCIAL_V2_FILE,
    STATE_DIR,
    TOKEN_USAGE_FILE,
    TOOL_LOG_FILE,
    VALID_MODES,
    accountEnabled,
    accountLevel,
    acknowledgeMessagesV2,
    activeWaits,
    allowSlangSubmit,
    allowed,
    api,
    appendActivity,
    appendFeedbackEntry,
    appendMemoryV2,
    applyMemeOverrides,
    applyRoleInjectLimit,
    applyStickerNoteV2,
    assertGroupMember,
    atomicWriteJson,
    atomicWriteText,
    backupPresetFile,
    bot,
    broadcastCfgV2,
    broadcastKeyV2,
    buildMusicShare,
    buildSlangContext,
    buildStickerContext,
    buildStickerStrategyHint,
    buildUsageReportV2,
    buildWakePromptV2,
    buildWakeSnapshotV2,
    cancelAllSocialTimers,
    cancelPendingEntry,
    cancelReplyCheckV2,
    cancelSocialTimers,
    canonicalV2Key,
    castVote,
    cfg,
    cleanupSocialForModeChange,
    clearAllPendingWakeLeases,
    clearAllSocialV2Timers,
    clearSocialV2Timers,
    closePoll,
    get closedAgentPreset() { return closedAgentPreset; }, set closedAgentPreset(v) { closedAgentPreset = v; },
    collectStickerV2,
    collectors,
    computeGapsV2,
    computeWakeSafetyV2,
    confirmedSlangListV2,
    convKey,
    createSlangEntry,
    get currentMode() { return currentMode; }, set currentMode(v) { currentMode = v; },
    currentRoleHint,
    currentRoleHintV2,
    decideAmong,
    deliverPrompt,
    describeAudio,
    diaryCfgV2,
    diaryClockV2,
    diaryKeyV2,
    diaryWeekIdV2,
    downloadGithubTarball,
    drainAllPromptQueues,
    drainPromptQueue,
    get dshReady() { return dshReady; }, set dshReady(v) { dshReady = v; },
    ensureSession,
    ensureWakeableV2,
    enterActive,
    escapeCqText,
    extractPresetPrefix,
    feedbackTimes,
    festivalOf,
    fetchMediaData,
    fetchModelCatalog,
    findCjkSpaceWarning,
    findMessageMedia,
    findSplitBoundaryWarning,
    flushSummaries,
    forgetAgentToken,
    forgetConversationCaches,
    formatForwardResponse,
    formatMemoryV2,
    formatParticipationV2,
    formatStickerList,
    getImageDimensions,
    getMemeStore,
    getSocialV2State,
    getStickerImageData,
    groupRecapCfgV2,
    groupRecapTargetsV2,
    groupToolsTimes,
    hardenStateDirAcl,
    get hotTopicCacheV2() { return hotTopicCacheV2; }, set hotTopicCacheV2(v) { hotTopicCacheV2 = v; },
    inspectAudio,
    installedPresetYaml,
    invalidateSlangLearnerSession,
    isSessionAllowedInCurrentMode,
    isSleepingConfigV2,
    get lastActiveChatKey() { return lastActiveChatKey; }, set lastActiveChatKey(v) { lastActiveChatKey = v; },
    get lastForcedAgentStickerSync() { return lastForcedAgentStickerSync; }, set lastForcedAgentStickerSync(v) { lastForcedAgentStickerSync = v; },
    get lastMode() { return lastMode; }, set lastMode(v) { lastMode = v; },
    leaveActive,
    lightGameTimes,
    listAudioFiles,
    listNewModules,
    listPresetBackups,
    loadOrCreateConsoleToken,
    log,
    looksLikeUnfinished,
    manualDirCommand,
    markReadCalledKeys,
    memeLastSentAt,
    memeMoodNames,
    memeMoodOfTag,
    memeOverrides,
    memeRootDir,
    get memeStore() { return memeStore; }, set memeStore(v) { memeStore = v; },
    get memeStoreRoot() { return memeStoreRoot; }, set memeStoreRoot(v) { memeStoreRoot = v; },
    memesEnabled,
    memoryDb,
    memoryDbEnabled,
    mergeEvidence,
    messageMediaStore,
    mimeFromBuffer,
    mimeFromUrl,
    modeAllowed,
    modelAppliedSessions,
    modelCatalogErrorLogged,
    get modelCatalogInFlight() { return modelCatalogInFlight; }, set modelCatalogInFlight(v) { modelCatalogInFlight = v; },
    get modelSelectionEpoch() { return modelSelectionEpoch; }, set modelSelectionEpoch(v) { modelSelectionEpoch = v; },
    moodTimes,
    normalizeImpressionTarget,
    normalizeModeInput,
    normalizeOwnerQQ,
    normalizePluginSpec,
    normalizeReasoningEffort,
    normalizeSpeakerIdsV2,
    noteModelMessagesV2,
    noteSleepGraceV2,
    oneBotCall,
    parseTargetKey,
    peakQuietCfgV2,
    peakWindowV2,
    pending,
    pendingAskClaimsV2,
    pendingSendToolCalls,
    pendingWakeKeys,
    pickImpressionField,
    pickOneMemeV2,
    pinnedMemeRowV2,
    playLightGame,
    playTurnGame,
    pluginJobSnapshot,
    pluginJobs,
    preSleepWaitBlockedV2,
    presetPromptBlockers,
    presetPromptWarnings,
    presetSourceYaml,
    presetStatus,
    priceTable,
    priceUsage,
    publicSlangEntry,
    queueSlangTask,
    queued,
    queuedHintAt,
    qzoneEnabled,
    qzoneImageRef,
    qzonePostLog,
    reactToMessageV2,
    readActivityTail,
    readConfigObject,
    readFeedbackEntries,
    readJsonSafe,
    readMoodState,
    readPresetPromptText,
    readProfilePackage,
    readRoleContent,
    readRoleState,
    readThroughSeqV2,
    readToolLog,
    reconcileSessionPolicies,
    recordSentMessagesV2,
    redactKnownTokensOnly,
    refreshAllDefaultWakeConfigsV2,
    relationLineV2,
    relationPidForV2,
    releaseLock,
    renderDecide,
    renderLightGame,
    renderMusicShare,
    renderPoll,
    renderPresetPromptYaml,
    renderTurnGame,
    replyTimingV2,
    requestedReadThroughSeqV2,
    resolveAudioProcessing,
    resolvePresetName,
    resolveReplyInfo,
    resolveReplyTargetV2,
    resolveVoicePathForOperator,
    resolveVoicePathForV2,
    retiredAgentTokens,
    reverse,
    roleCharStats,
    roleFilePath,
    get roleInjectMaxChars() { return roleInjectMaxChars; }, set roleInjectMaxChars(v) { roleInjectMaxChars = v; },
    roleSectionReport,
    roleSummaries,
    roleWarnings,
    runProfilePnpm,
    runSlangExtraction,
    runSlangResearch,
    safeFetchBuffer,
    sanitizeRoleName,
    saveMemeOverrides,
    saveMoodState,
    saveProfilePackage,
    saveSlangStore,
    saveSocialV2State,
    saveState,
    scheduleProactiveCheckV2,
    scheduleReplyCheckV2,
    scheduleSegmentAt,
    seenForwardIds,
    sendMemeV2,
    sendMessagesV2,
    sendStickerV2,
    sendToolSucceededSessions,
    sendVoiceForV2,
    sendVoiceV2,
    sendWakePromptV2,
    get sessionEpoch() { return sessionEpoch; }, set sessionEpoch(v) { sessionEpoch = v; },
    sessionModels,
    sessionPromises,
    setStickerRemarkV2,
    setupSleepTimerV2,
    shouldBlockSilentReply,
    get slangEntries() { return slangEntries; }, set slangEntries(v) { slangEntries = v; },
    slangExtractionCooldowns,
    slangInjectChars,
    slangInjectMax,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows,
    sleep,
    sleepCfgV2,
    get sleepForceAwakeV2() { return sleepForceAwakeV2; }, set sleepForceAwakeV2(v) { sleepForceAwakeV2 = v; },
    sleepNightWinV2,
    sleepStateV2,
    snowlumaHealthSnapshot,
    social,
    socialState,
    socialV2,
    startPluginJob,
    startPoll,
    startTurnGame,
    get state() { return state; }, set state(v) { state = v; },
    get stateDirHardened() { return stateDirHardened; }, set stateDirHardened(v) { stateDirHardened = v; },
    stickerEnabled,
    get stickerEntries() { return stickerEntries; }, set stickerEntries(v) { stickerEntries = v; },
    get stickerSyncedAt() { return stickerSyncedAt; }, set stickerSyncedAt(v) { stickerSyncedAt = v; },
    stopRetiredSessionWork,
    suggestQuietMsV2,
    summarizeAccountResult,
    syncStickerLibrary,
    tallyPoll,
    text,
    tickMood,
    tokenLedger,
    toolCallNames,
    truncateText,
    turnGameTimes,
    unquoteJsonString,
    unwrap,
    usageLineV2,
    v2ToolEnabled,
    v2TurnStartAt,
    validateRoleContent,
    validateRoleName,
    verifyVoiceMessageSent,
    voiceBudgetCheck,
    voiceBudgetCommit,
    voiceCfg,
    voiceLibrary,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    wakeFromSleepV2,
    withTimeout,
    writeRoleContent,
    writeRoleState,
  });
  const startConsoleServer = () => createConsoleServer(consoleDeps());

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // ── [并发] 出站并行：每个会话一条链（同一会话内严格保序），会话之间并行 ──────────
  // 旧实现是一条**全局**链：A 群那条 60 秒的语音条会把 B 群和私聊的回复全堵在后面，
  // 群聊并发（第二槽位）跑得再快也发不出去。现在按会话分链，再用一个全局节流器保证
  // 任意两条 QQ 出站之间至少隔 cfg.socialV2.concurrency.sendGapMs（默认 200ms），
  // 既保住了「先文字后表情」的真人顺序，又不会两路并发把 QQ 侧打到限流。
  const sendChainsV2 = new Map(); // key -> Promise（该会话出站链尾）
  const sendPacerV2 = createPacer(concurrencyCfgV2().sendGapMs, {});
  function sendQueueV2(key, task) {
    const k = String(key ?? '');
    const prev = sendChainsV2.get(k) ?? Promise.resolve();
    const next = prev.then(async () => {
      await sendPacerV2.take();
      return task();
    });
    const tail = next.then(() => undefined, () => undefined);
    sendChainsV2.set(k, tail);
    // 链尾自清：没有后续任务时不留 Map 条目（会话数有限，这里只是防止长期积累）。
    // 注意只能删自己那一节：期间若有新任务接上，sendChainsV2.get(k) 已经不是 tail 了。
    tail.then(() => { if (sendChainsV2.get(k) === tail) sendChainsV2.delete(k); });
    return next;
  }
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  // [patch 不可达会话] 已被移出群 / 被拉黑 / 发送被拒的会话：登记后停止唤醒与发送。
  // 背景：2026-10-07 group:908650943 把她移出群后，桥接仍按触发条件反复唤醒她、每次发送都失败
  // （"发送失败，你已被移出该群"），白烧 token 还往日志里刷错误。
  const unreachableConversationsV2 = new Map(); // key -> reason
  function isConversationUnreachableV2(key) { return unreachableConversationsV2.has(key); }
  function noteSendRejectionV2(key, message) {
    const reason = String(message ?? '');
    if (!/移出该群|已被移出|请重新加群|你不在该群|not in group|不在群里|被拉黑|result=110/.test(reason)) return false;
    if (unreachableConversationsV2.has(key)) return true;
    unreachableConversationsV2.set(key, reason);
    log(`[不可达会话] ${key} 已停止唤醒与发送：${reason}`);
    try {
      const stU = getSocialV2State(key);
      if (stU) {
        const base = stU.wakeConfig && typeof stU.wakeConfig === 'object' ? stU.wakeConfig : defaultWakeConfigV2();
        const trig = base.triggers && typeof base.triggers === 'object' ? base.triggers : {};
        stU.wakeConfig = { ...base, mode: 'diving', infinite: true, triggers: { ...trig, anyMessage: false, question: false, probability: 0, atMention: false, nameMention: false, poke: false, keywords: [] } };
        stU.pendingWakeReasons = [];
        saveSocialV2State();
      }
    } catch { /* 状态写失败不影响主流程 */ }
    return true;
  }

  function sendToQQ(key, msg) {
    if (isConversationUnreachableV2(key)) return Promise.resolve();
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    // [护栏] 群里绝不出现技术报错：命中就换成卡壳话术（默认），或按配置直接不发。
    const guarded = guardGroupOutboundV2(key, stripLoneSurrogates(redactKnownTokensOnly(msg)));
    if (guarded.dropped) return Promise.resolve();
    const safeMsg = guarded.text;
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    let last = Promise.resolve();
    for (const part of parts) {
      last = sendQueueV2(key, async () => {
        try {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        } catch (error) {
          lastSendFailed.set(key, true);
          const whySend = error?.message ?? error;
          noteSendRejectionV2(key, whySend);
          log(`QQ 发送失败 (${key}):`, whySend);
        }
        await sleep(cfg.sendDelayMs);
      });
    }
    return last;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── [patch 长思考先说一句] ────────────────────────────────────────────────
  // 模型思考期间桥上不产生任何消息，对方只能干等。超过阈值还没开口时，桥接替她说一句垫场话，
  // 真正的回复随后照常发。约束：同一回合只垫一次、只说给刚刚找过她的人、群聊默认不垫（可配 includeGroups）。
  const THINKING_FILLER_DEFAULT_TEXTS = ['等下，我想想', '这个我得查一下，稍等', '嗯…让我理理'];

  function thinkingFillerConfigV2() {
    const c = (cfg.socialV2 && cfg.socialV2.thinkingFiller) || {};
    const texts = Array.isArray(c.texts)
      ? c.texts.map((t) => String(t ?? '').trim()).filter(Boolean)
      : [];
    return {
      enabled: c.enabled !== false,
      afterMs: Math.max(3000, Number(c.afterMs) || 30000),
      includeGroups: c.includeGroups === true,
      texts: texts.length ? texts : THINKING_FILLER_DEFAULT_TEXTS
    };
  }

  function pickThinkingFillerTextV2(key) {
    const { texts } = thinkingFillerConfigV2();
    const i = (thinkingFillerCursor.get(key) || 0) % texts.length;
    thinkingFillerCursor.set(key, i + 1);
    return texts[i];
  }

  // 纯判定：抽出来单独测（scripts/test-thinking-filler.mjs），不做任何 IO。
  function thinkingFillerDueV2(info) {
    if (!info || info.enabled !== true) return false;
    if (info.alreadySent === true) return false;
    if (info.sentThisTurn === true) return false;
    if (info.turnStartMatches !== true) return false;
    if (!(Number(info.elapsedMs) >= Number(info.afterMs))) return false;
    if (info.scopeOk !== true) return false;
    if (info.inboundFresh !== true) return false;
    return true;
  }

  function clearThinkingFillerV2(sessionId) {
    const entry = thinkingFillerTimers.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    thinkingFillerTimers.delete(sessionId);
  }

  function armThinkingFillerV2(key, sessionId, turnStart) {
    const conf = thinkingFillerConfigV2();
    if (!conf.enabled) return;
    if (!conf.includeGroups && String(key).startsWith('group:')) return;
    clearThinkingFillerV2(sessionId);
    const timer = setTimeout(() => {
      thinkingFillerTimers.delete(sessionId);
      try {
        maybeSendThinkingFillerV2(key, sessionId, turnStart);
      } catch (error) {
        log('[长思考] 垫场话发送失败：', error?.message ?? error);
      }
    }, conf.afterMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    thinkingFillerTimers.set(sessionId, { timer, turnStart });
  }

  function maybeSendThinkingFillerV2(key, sessionId, turnStart) {
    const conf = thinkingFillerConfigV2();
    if (!conf.enabled) return;
    const now = Date.now();
    const st = getSocialV2State(key);
    const lastIncoming = Number(st && st.lastIncomingAt) || 0;
    const info = {
      enabled: true,
      afterMs: conf.afterMs,
      elapsedMs: now - (Number(turnStart) || 0),
      turnStartMatches: v2TurnStartAt.get(sessionId) === turnStart,
      sentThisTurn: (Number(st && st.turnSentCount) || 0) > 0 || sendToolSucceededSessions.has(sessionId),
      alreadySent: thinkingFillerSentTurns.has(sessionId + '#' + turnStart),
      scopeOk: conf.includeGroups || String(key).startsWith('private:'),
      inboundFresh: lastIncoming > 0 && now - lastIncoming <= 10 * 60 * 1000
    };
    if (!thinkingFillerDueV2(info)) return;
    if (!isCurrentSession(key, sessionId)) return;
    if (shouldBlockSilentReply(key)) return;
    if (peakQuietAppliesV2(key)) return;
    const fillerText = pickThinkingFillerTextV2(key);
    if (thinkingFillerSentTurns.size > 400) thinkingFillerSentTurns.clear();
    thinkingFillerSentTurns.add(sessionId + '#' + turnStart);
    log(`[长思考] ${key} 已经想了 ${Math.round(info.elapsedMs / 1000)}s 还没开口，先垫一句「${fillerText}」`);
    appendActivity(`${key} 长思考垫场：${fillerText}`);
    sendToQQ(key, fillerText);
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一会话出站链，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    let last = Promise.resolve();
    for (let i = 0; i < messages.length; i++) {
      // [护栏] 群里绝不出现技术报错：命中就换成卡壳话术（默认），或按配置直接不发这一条。
      const guarded = guardGroupOutboundV2(key, redactKnownTokensOnly(messages[i]));
      if (guarded.dropped) continue;
      const msg = guarded.text;
      const isLast = i === messages.length - 1;
      // 条间间隔放进队列任务里（而不是挂在链外），否则下一条会在间隔结束前就排队发出去。
      const useLong = !isLast && longProb > 0 && Math.random() < longProb;
      const delay = isLast ? 0 : (useLong ? randInt(longMin, longMax) : randInt(min, max));
      last = sendQueueV2(key, async () => {
        try {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        } catch (error) {
          const whySend = error?.message ?? error;
          noteSendRejectionV2(key, whySend);
          log(`QQ 发送失败 (${key}):`, whySend);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        }
        if (delay > 0) await sleep(delay);
      });
    }
    return last.then(() => sent);
  }


  // ── [护栏] 群聊绝不出现技术报错 ─────────────────────────────────────────────
  // 为什么：DSH / OneBot 的报错（余额不足、请求失败、retcode、堆栈、内部会话 id）一旦落进
  // 群里，既吓人又泄露内部实现，群友还会把它当成新消息继续接话（2026-10-11 排查时就被
  // 这种假线索误导过）。判在**最底层出站口**：只要发往群里的文本命中报错特征，就换成一句
  // 自然的卡壳话术（或直接不发），技术细节只私聊给主人。宁可少说一句，也不能让群里看到
  // 「⚠️ agent 处理出错：Insufficient Balance (request_id: …)」这种东西。
  const GROUP_ERROR_LEAK_PATTERNS_V2 = [
    [/\bInsufficient Balance\b/i, '余额不足'],
    [/\brequest[ _]id\b/i, 'request_id'],
    [/\bretcode\b/i, 'retcode'],
    [/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up)\b/i, '网络错误码'],
    [/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|AxiosError|AggregateError|UnhandledPromiseRejection)\b/, '异常类型'],
    [/\bat\s+[\w.$<>[\]]+\s*\([^)\n]*:\d+:\d+\)/, '堆栈帧'],
    [/^\s*(?:Error|Exception)\s*[:：]/m, 'Error 前缀'],
    [/\bstack(?:\s|-)?trace\b|堆栈|traceback/i, '堆栈'],
    [/(?:DEEPSEEK|OPENAI|ANTHROPIC|GEMINI)_[A-Z_]{3,}/, '上游错误码'],
    [/⚠️/, '桥接告警标记'],
    [/(?:agent 处理出错|处理出错|消息未被接受|工具未启用|不支持的动作|未授权|会话繁忙|发送频率超限|唤醒提示|退役重建|token 无效|DSH (?:错误|失败|不可用|异常))/, '桥接/DSH 内部提示'],
    [/\b(?:group|private):\d{5,}\b/, '内部会话 key'],
    [/\bsession-[0-9a-f]{8,}\b/i, '内部会话 id'],
    [/\b(?:api[_-]?key|access[_-]?token|authorization)\b\s*[:=]/i, '凭据字段']
  ];
  /** 命中返回人类可读的原因标签，未命中返回 ''。只用强特征，避免把正常聊天误判成报错。 */
  function groupErrorLeakV2(text) {
    const s = String(text ?? '');
    if (!s) return '';
    if (groupSafetyCfg().blockErrorText === false) return '';
    for (const [re, label] of GROUP_ERROR_LEAK_PATTERNS_V2) {
      if (re.test(s)) return label;
    }
    return '';
  }
  function groupSafetyCfg() {
    const raw = cfg.socialV2?.groupSafety;
    return raw && typeof raw === 'object' ? raw : {};
  }
  const groupLeakNotifyAtV2 = new Map();
  /** 拦下之后私聊告诉主人（同一个群限流，默认 10 分钟一条）；原文只进日志与主人私聊。 */
  function notifyOwnerOfGroupLeakV2(groupId, why, raw) {
    const c = groupSafetyCfg();
    if (c.notifyOwner === false) return;
    const ownerQQ = String(cfg.ownerQQ ?? '');
    if (!ownerQQ) return;
    const rawGap = Number(c.notifyMinGapMs);
    const gapMs = Number.isFinite(rawGap) && rawGap >= 0 ? rawGap : 10 * 60 * 1000;
    const now = Date.now();
    const slot = String(groupId);
    if (gapMs > 0 && now - (groupLeakNotifyAtV2.get(slot) || 0) < gapMs) return;
    groupLeakNotifyAtV2.set(slot, now);
    const text = `⚠️ 群里差点漏出技术报错（group:${groupId}，命中「${why}」），已被护栏拦下：${String(raw).slice(0, 300)}`;
    sendToQQ(`private:${ownerQQ}`, text).catch((error) => log(`[护栏] 通知主人失败：${error?.message ?? error}`));
  }
  /**
   * 出站文本护栏（唯一入口）：发往群且命中报错特征时，记日志/活动/私聊通知主人，
   * 然后换成一句自然的卡壳话术（默认）或整条丢弃（groupSafety.action === 'drop'）。
   * 私聊是主人运维窗口，图片/语音/表情等非文本路径不经过这里。
   * 三个文本出口都要走它：sendToQQ、sendBurstToQQ、onebotSend（sendMessagesV2/auditAndSend）。
   */
  function guardGroupOutboundV2(key, message) {
    const raw = String(message ?? '');
    const [kind, id] = String(key ?? '').split(':');
    if (kind !== 'group') return { text: raw, dropped: false, leak: '' };
    const leak = groupErrorLeakV2(raw);
    if (!leak) return { text: raw, dropped: false, leak: '' };
    const brief = raw.slice(0, 160);
    log(`[护栏] 拦下发往群 ${id} 的疑似报错文本（命中「${leak}」）：${brief}`);
    appendActivity(`[护栏] group:${id} 拦下疑似报错文本（命中「${leak}」）：${brief.slice(0, 60)}`);
    notifyOwnerOfGroupLeakV2(id, leak, raw);
    if (groupSafetyCfg().action === 'drop') return { text: '', dropped: true, leak };
    return { text: softFailLineV2(), dropped: false, leak };
  }

  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    // [护栏] 群里绝不出现技术报错 / 内部 id：命中就换成兜底话术（默认），或按配置直接不发。
    const guarded = guardGroupOutboundV2(`${kind}:${id}`, rawMessage);
    if (guarded.dropped) return { dropped: true };
    segments.push({ type: 'text', data: { text: escapeCqText(guarded.text) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    return onebotApi(action, params);
  }

  /**
   * 所有 OneBot HTTP 动作的统一出口（send_private_msg / send_group_msg / delete_msg …）。
   * 抽出来的理由：撤回也要走同一套超时、鉴权与错误提示，而不是各写一份 fetch 各错一遍。
   */
  async function onebotApi(action, params) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  /** [手滑] 撤回自己刚发的那条消息（OneBot delete_msg）。失败不重试也不上报：错字留在那儿也算真人。 */
  async function onebotDeleteMsg(messageId) {
    const mid = String(messageId ?? '').trim();
    if (!/^-?\d+$/.test(mid)) throw new Error('delete_msg 需要数字 message_id');
    return onebotApi('delete_msg', { message_id: Number(mid) });
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // 单条消息图片总字节上限（与 safeFetchBuffer 默认一致）
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  // ── [patch 表情看含义] 表情用"名字/备注"理解，不靠看图 ──────────────────────
  const faceNameCache = new Map();
  let faceTableLoaded = false;
  const cleanFaceName = (raw) => String(raw ?? '').replace(/^\/+/, '').trim() || null;

  /** 一次性把 QQ 的系统表情表（fetch_sys_faces）拉进缓存：id → 名字。失败就退化成逐个查。 */
  async function loadFaceTableV2() {
    if (faceTableLoaded) return;
    try {
      const res = await bot.request('fetch_sys_faces', { refresh: false });
      const packs = Array.isArray(res?.data?.packs) ? res.data.packs : [];
      for (const pack of packs) {
        for (const emoji of Array.isArray(pack?.emojis) ? pack.emojis : []) {
          const sid = String(emoji?.q_sid ?? '').trim();
          const name = cleanFaceName(emoji?.q_des);
          if (sid && name && !faceNameCache.has(sid)) faceNameCache.set(sid, name);
        }
      }
      // 只有真的拿到了才上锁；启动时 WS 可能还没连上，失败要允许后面重试。
      faceTableLoaded = faceNameCache.size > 0;
      log(`[表情] 已载入 QQ 系统表情表：${faceNameCache.size} 个`);
    } catch (error) {
      log(`fetch_sys_faces 失败（退回逐个查）: ${error?.message ?? error}`);
    }
  }

  async function resolveFaceNameCachedV2(faceId) {
    const id = String(faceId ?? '').trim();
    if (!id) return null;
    if (faceNameCache.has(id)) return faceNameCache.get(id);
    await loadFaceTableV2();
    if (faceNameCache.has(id)) return faceNameCache.get(id);
    let name = null;
    try {
      const face = await bot.fetchFaceEntity(Number(id));
      if (face && typeof face === 'object') {
        name = cleanFaceName(face.q_des) || (Array.isArray(face.emoji_name_alias) ? cleanFaceName(face.emoji_name_alias[0]) : null);
      }
    } catch (error) {
      log(`fetchFaceEntity 失败（表情 ${id}）: ${error?.message ?? error}`);
    }
    if (faceNameCache.size > 2000) faceNameCache.clear();
    faceNameCache.set(id, name || null);
    return name || null;
  }

  /** 动画表情/收藏表情的"意思"：按文件名/md5/url 在本机 QQ 收藏表情库里找，拼出 备注｜她的笔记｜标签。 */
  function stickerMeaningForMediaV2(data) {
    const refs = [String(data?.file ?? ''), String(data?.url ?? '')].filter(Boolean);
    for (const ref of refs) {
      try {
        const entry = findSticker(stickerEntries, ref);
        if (!entry) continue;
        const meaning = [entry.desc, entry.localNote, Array.isArray(entry.tags) ? entry.tags.join('/') : '']
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .join('｜');
        if (meaning) return meaning;
      } catch {}
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    // [patch 表情看图回退] 默认 false：表情一律只给"意思"（名字/备注），不送图。
    // 只有确实没名字的表情（[表情#id] / [动画表情]）并且把 socialV2.sticker.imageFallback 打开时，才取图。
    const allowStickerImage = cfg.socialV2?.sticker?.imageFallback === true;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const named = /^\[表情:/.test(String(face.text ?? ''));
        if (!named && allowStickerImage && face.buffer && totalBytes + face.buffer.length <= MAX_MEDIA_BYTES) {
          totalBytes += face.buffer.length;
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else if (media.isSticker) {
        const stickerLabel = stickerMeaningForMediaV2(media);
        if (stickerLabel) {
          parts.push({ type: 'text', text: `[表情:${stickerLabel}]` });
        } else if (!allowStickerImage) {
          parts.push({ type: 'text', text: '[动画表情（本机表情库没有它的备注）]' });
        } else {
          const img = await fetchOneBotImage(media);
          if (img?.buffer && totalBytes + img.buffer.length <= MAX_MEDIA_BYTES) {
            totalBytes += img.buffer.length;
            parts.push({ type: 'text', text: '[动画表情]' });
            parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `meme-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
          } else {
            parts.push({ type: 'text', text: '[动画表情（本机表情库没有它的备注，取图也失败）]' });
          }
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-image-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    // [情绪] 条间间隔也随心情走：兴奋时更急促，累了/不开心时更慢（系数见 MOOD_PACE）。
    const gapScale = moodPaceV2().gap;
    if (gapScale !== 1) {
      for (let i = 0; i < delays.length; i++) delays[i] = clampGapV2(Math.round(delays[i] * gapScale), sendCfg);
    }
    return delays;
  }

  /**
   * [拟人] 第一条也要有「读了再打字」的时间。实测 74 次回应里 69 次（93%）在 10 秒内就发出去，
   * 像自动回复而不像人在打字。按首条字数给一个 1~4 秒的抖动；被点名/引用回复时只给一半。
   * 全部可配置，socialV2.send.firstDelayEnabled=false 直接关掉。
   */
  function firstSendDelayV2(text, direct) {
    const sendCfg = cfg.socialV2?.send ?? {};
    if (sendCfg.firstDelayEnabled === false) return 0;
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const base = Math.max(0, num(sendCfg.firstDelayBaseMs, 900));
    if (!base) return 0;
    const perChar = Math.max(0, num(sendCfg.firstDelayPerCharMs, 55));
    const cap = Math.max(base, num(sendCfg.firstDelayMaxMs, 4000));
    const chars = Math.max(1, String(text || '').length);
    const target = Math.min(cap, base + chars * perChar);
    const scale = direct ? 0.5 : 1;
    return Math.round(target * scale * (0.65 + Math.random() * 0.7));
  }

  // ── [手滑] 偶尔打错一个字，然后自己撤回重发 ──────────────────────────────
  // 为什么：真人打字会手滑。这是最便宜、最像人的一处小破绽（不改人设、几乎不花 token），
  // 但频率必须极低 —— 一个每轮都手滑的机器人比不会手滑的还要假。
  // 调参：socialV2.humanize.typoProbability（默认 0.012）/ typoMinGapMs / typoRecallDelayMs；
  // typoEnabled === false 直接关。只动第一条纯文本短句；带链接 / CQ 码 / 【标记】/ @ 的一律不碰。
  const TYPO_PAIRS = [
    ['在', '再'], ['再', '在'], ['的', '得'], ['得', '的'], ['那', '哪'], ['哪', '那'],
    ['吗', '嘛'], ['嘛', '吗'], ['吧', '罢'], ['呀', '吖'], ['是', '事'], ['很', '狠'],
    ['有', '友'], ['就', '久'], ['做', '作'], ['没', '每'],
  ];
  const lastSlipAtV2 = new Map();

  function makeTypoV2(text) {
    const chars = Array.from(String(text || ''));
    if (chars.length < 4) return '';
    const spots = [];
    for (let i = 0; i < chars.length; i++) {
      for (const [from, to] of TYPO_PAIRS) if (chars[i] === from) spots.push([i, to]);
    }
    if (spots.length) {
      const [idx, to] = spots[Math.floor(Math.random() * spots.length)];
      const out = chars.slice();
      out[idx] = to;
      return out.join('');
    }
    // 没有可换的字：把相邻两个字打颠倒（按快了最常见的错法）。
    const idx = 1 + Math.floor(Math.random() * Math.max(1, chars.length - 3));
    if (!chars[idx] || !chars[idx + 1] || chars[idx] === chars[idx + 1]) return '';
    const out = chars.slice();
    const tmp = out[idx];
    out[idx] = out[idx + 1];
    out[idx + 1] = tmp;
    return out.join('');
  }

  function decideTypoSlipV2(key, messages) {
    const h = cfg.socialV2?.humanize ?? {};
    if (h.typoEnabled === false) return null;
    const raw = Number(h.typoProbability);
    const prob = Number.isFinite(raw) ? Math.max(0, Math.min(0.2, raw)) : 0.012;
    if (!(prob > 0) || Math.random() >= prob) return null;
    const gapMs = Math.max(60_000, Number(h.typoMinGapMs) || 30 * 60 * 1000);
    const now = Date.now();
    if (now - (Number(lastSlipAtV2.get(key)) || 0) < gapMs) return null;
    // 只碰纯文本第一条：工具传进来的可能是非字符串（分段/CQ 码），乱改会发出乱码。
    if (typeof messages?.[0] !== 'string') return null;
    const text = messages[0].trim();
    if (text.length < 4 || text.length > 60) return null;
    if (/https?:|\[CQ:|【|@|\n/.test(text)) return null;
    const wrong = makeTypoV2(text);
    if (!wrong || wrong === text) return null;
    lastSlipAtV2.set(key, now);
    return { wrong, correct: text, messageId: null };
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // [手滑] 改的是副本，不动调用方传进来的数组；发完之后在下面撤回并补发正确的那句。
    const slip = decideTypoSlipV2(key, messages);
    const toSend = slip ? [slip.wrong, ...messages.slice(1)] : messages;
    const firstDelay = firstSendDelayV2(toSend[0], !!(replyToMessageId || atUserId));
    // [并发] 每个会话一条出站链（保证「先文字后表情」「手滑撤回再重发」的顺序），
    // 会话之间并行；条间间隔一律放进队列任务里，否则下一条会抢在间隔结束前发出去。
    let last = Promise.resolve();
    if (firstDelay > 0) last = sendQueueV2(key, () => sleep(firstDelay));
    for (let i = 0; i < toSend.length; i++) {
      const msg = toSend[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      last = sendQueueV2(key, async () => {
        try {
          assertSendAllowed();
          const data = await onebotSend(kind, id, msg, useReply, useAt);
          if (slip && i === 0 && data && data.message_id !== undefined) slip.messageId = data.message_id;
          sent.push(msg);
        } catch (error) {
          const whySend = error?.message ?? error;
          noteSendRejectionV2(key, whySend);
          log(`QQ 发送失败 (${key}):`, whySend);
          failed.push(error);
        }
        if (i < delays.length) await sleep(delays[i]);
      });
    }
    // 手滑了：愣一下（像人先看一眼「啊打错了」）→ 撤回 → 重发正确的。
    if (slip && slip.messageId) {
      const recallMs = Math.max(400, Number(cfg.socialV2?.humanize?.typoRecallDelayMs) || 1600);
      last = sendQueueV2(key, async () => {
        try {
          await onebotDeleteMsg(slip.messageId);
          log(`[手滑] ${key} 撤回了一条打错的消息，重发：${truncateText(slip.correct, 40)}`);
        } catch (error) {
          log(`[手滑] ${key} 撤回失败，错字就这么留着：${error?.message ?? error}`);
          return;
        }
        try {
          await onebotSend(kind, id, slip.correct, null, null);
          // 记忆里留下的是改好的那句：sendMessagesV2 的调用方此时才拿到 sent，
          // 所以在这里把错字版本换掉，免得她以后「记得」自己说过一句错话。
          if (sent[0] === slip.wrong) sent[0] = slip.correct;
          appendActivity(`${key} 手滑撤回并重发了一条`);
        } catch (error) {
          log(`[手滑] ${key} 重发失败：${error?.message ?? error}`);
        }
      });
    }
    return last.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${toSend.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用 cfg.dsh.provider/model 指定的模型（现为 MiMo：our-free-model / mimo-v2.6-flash-free，可多模态）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  // ── [免费车道 2026-10-19] 群聊走免费模型，私聊（尤其主人）保持付费车道 ───────
  // config: socialV2.freeLane = { enabled, provider, model, failThreshold, cooldownMs }
  // 熔断：免费模型的 selectModel 连续失败 failThreshold 次 → 回退付费车道 cooldownMs
  // （默认 30 分钟）并递增 modelSelectionEpoch 让存量群会话立刻重应用付费模型；
  // 冷却结束后新会话自然回到免费车道。可用性预检读 our-free-model 插件的 availability.json。
  const freeLaneState = { fails: 0, cooldownUntil: 0 };
  function laneModelFor(sessionId) {
    const fallback = { provider: String(cfg.dsh?.provider || 'deepseek-official'), model: String(cfg.dsh?.model || 'longcat-2.5-preview-free') };
    const lane = cfg.socialV2?.freeLane;
    if (!lane?.enabled) return fallback;
    const key = String(reverse.get(sessionId) || '');
    if (!key.startsWith('group:')) return fallback; // 私聊永远付费（主人体验优先）
    if (Date.now() < freeLaneState.cooldownUntil) return fallback;
    const provider = String(lane.provider || 'our-free-model');
    const model = String(lane.model || 'nemotron-3-ultra-free');
    if (!provider || !model) return fallback;
    // 可用性预检：插件探活报告明确不可用/限流的模型直接走付费，不浪费一次失败
    try {
      const avail = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'our-free-model', 'availability.json'), 'utf8'));
      const state = avail?.results?.[model]?.state;
      if (state && state !== 'available') return fallback;
    } catch { /* 探活文件读不到不拦路（可能是首次还没生成） */ }
    return { provider, model, free: true };
  }

  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const sel = laneModelFor(sessionId);
    const provider = sel.provider;
    const model = sel.model;
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        if (sel.free) freeLaneState.fails = 0;
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})${sel.free ? '［免费车道］' : ''}`);
        return 'applied';
      } catch (error) {
        lastError = error;
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    // [免费车道熔断] 免费模型连续挂 N 次 → 回退付费车道一段时间
    if (sel.free) {
      freeLaneState.fails += 1;
      const threshold = Math.max(1, Number(cfg.socialV2?.freeLane?.failThreshold) || 3);
      if (freeLaneState.fails >= threshold) {
        const cooldownMs = Math.max(60000, Number(cfg.socialV2?.freeLane?.cooldownMs) || 1800000);
        freeLaneState.cooldownUntil = Date.now() + cooldownMs;
        freeLaneState.fails = 0;
        modelSelectionEpoch += 1; // 让已切到免费模型的群会话在下一条消息重新应用付费模型
        log(`⚠️ [免费车道] 免费模型连续失败 ${threshold} 次，回退付费车道 ${Math.round(cooldownMs / 60000)} 分钟（epoch+1 触发存量会话重应用）`);
      }
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    let existing = state.sessions[key];
    // [patch 省token] 会话轮换：见 shouldRotateSessionV2。
    const rotWhy = existing ? rotationReasonV2(key) : '';
    if (existing && rotWhy) {
      const stRot = getSocialV2State(key);
      log(`[patch 省token] 会话轮换 ${key}：${rotWhy}，退役重建`);
      lastContextTokensV2.delete(key);
      retireSession(key);
      if (stRot) stRot.turnCount = 0;
      existing = state.sessions[key];
    }
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  // [patch 暴躁] 自己的 QQ 号（登录时从网关取）：「@ 我」的识别要用它，昵称只作兜底。
  let selfQqId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  // [patch 省token] 潜水即刻生效 + grace 窗口：她不再需要为了「5 分钟观察」而空转 qq_wait_for_messages。
  // 语义：set_wake_config / mark_read 进入潜水后照旧写睡眠配置，但记一个 grace 截止时间；
  // 在这段时间里任何消息都直接唤醒（graceWake），由网桥兜住「刚睡下就有人说话」。
  function noteSleepGraceV2(st) {
    if (!st) return 0;
    const ms = Math.max(0, Number(cfg.socialV2?.wake?.sleepGraceMs) || 0);
    st.sleepGraceUntil = (ms > 0 && isSleepingConfigV2(st.wakeConfig)) ? Date.now() + ms : 0;
    return st.sleepGraceUntil;
  }
  function inSleepGraceV2(st) {
    return Number(st?.sleepGraceUntil) > 0 && Date.now() < Number(st.sleepGraceUntil);
  }
  // [patch 省token] 她成功发出消息 ⇒ 未读必然已看过：网桥代她置已读，省掉每轮一次 qq_mark_read 模型步骤。
  function autoMarkReadV2(key) {
    try {
      const st = getSocialV2State(key);
      if (!st) return 0;
      const throughSeq = readThroughSeqV2(st);
      const marked = acknowledgeMessagesV2(st, throughSeq);
      if (marked > 0) {
        markReadCalledKeys.add(key);
        saveSocialV2State();
      }
      return marked;
    } catch (error) {
      log(`[patch 省token] 自动已读失败 ${key}: ${error?.message ?? error}`);
      return 0;
    }
  }
  // [patch 省token] 会话轮换：DSH 会话上下文随轮次线性膨胀（每一步都按全量上下文计费），
  // 超过 rotateAfterTurns 就退役重建；对话连续性由唤醒快照 + 网桥记忆承担。
  // 最近一次模型调用的**单步输入**规模（cacheHit+cacheMiss+cacheWrite）。会话上下文是每步都重发的，
  // 所以「当前上下文多大」比「跑了几轮」更直接地决定花销。
  // [patch 轮换口径] 必须取「最近一步」，而不是「最新一轮的累计」：账本里一轮的 buckets 是该轮所有步
  // 的 addBuckets 累加（token-ledger.js buildIndex），一轮 8 步 × ~30K ≈ 24 万 ⇒ 只要用累计值，任何
  // 正常一轮都超 60000 阈值 → 每轮都退役重建。2026-10-07 实测全天 29 次轮换、private:10001 在
  // 15:35:36 与 15:36:38 一分钟内连轮两次（604126 → 86612），代价是上下文全丢、缓存全冷、preset
  // 反复重挂。现在走 tokenLedger.latestStepInput(sid)（见 token-ledger.js 的 noteStepInput）。
  // 仍然按 sessionId 过滤：刚轮换出来的新会话不能读到上一个会话的大上下文（旧的无限轮换 bug）。
  // [patch 轮换可靠性] 记住每个会话最近一次测到的上下文大小，账本里查不到时回退用它，避免返回 0
  // 导致轮换永不触发、上下文一路涨到 47 万 token（2026-10-07 group:908650943 实锤）。
  const lastContextTokensV2 = new Map(); // key -> tokens
  function contextTokensOfKeyV2(key) {
    try {
      const sid = state.sessions[key];
      if (!sid) return lastContextTokensV2.get(key) || 0;
      const cur = tokenLedger.latestStepInput(sid);
      if (cur > 0) lastContextTokensV2.set(key, cur);
      return cur > 0 ? cur : (lastContextTokensV2.get(key) || 0);
    } catch {
      return lastContextTokensV2.get(key) || 0;
    }
  }

  // 返回轮换原因（空串＝不轮换），便于日志写清到底是哪条规则触发。
  function rotationReasonV2(key) {
    const stR = getSocialV2State(key);
    const n = Math.max(0, Math.round(Number(cfg.socialV2?.context?.rotateAfterTurns) || 0));
    if (n && (Number(stR?.turnCount) || 0) >= n) return `已达 ${Number(stR?.turnCount) || 0} 轮（上限 ${n}）`;
    const limit = Math.max(0, Number(cfg.socialV2?.context?.rotateAtContextTokens) || 0);
    if (limit) {
      const tk = contextTokensOfKeyV2(key);
      if (tk >= limit) return `上下文 ${tk} tokens ≥ ${limit}`;
    }
    return '';
  }

  function shouldRotateSessionV2(key) {
    return rotationReasonV2(key) !== '';
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    // [patch 省token] sleepGraceMs>0：潜水即刻生效，由网桥在 grace 窗口内兜住「刚潜就有人说话」。
    if (Number(cfg.socialV2?.wake?.sleepGraceMs) > 0) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  // [拆分 2026-10-18] 已移到 src/social-state.js（292 行）。
  // deps 延迟求值：里面不少 const 声明在本段之后（TDZ）。
  const socialStateMachineDeps = () => ({
    SOCIAL_V2_FILE,
    atomicWriteJson,
    canonicalV2Key,
    cfg,
    concurrencyCfgV2,
    defaultWakeConfigV2,
    ensureWakeableV2,
    log,
    normalizeSpeakerIdsV2,
    pruneAsks,
    readJsonSafe,
    refreshDefaultWakeConfigV2,
    rememberAgentToken,
    sanitizeForwardId,
    scheduleProactiveCheckV2,
    seenForwardIds,
    setupSleepTimerV2,
    socialV2,
    text,
    truncateText,
  });
  let socialStateMachineApi = null;
  const socialStateMachine = () => (socialStateMachineApi ??= createSocialState(socialStateMachineDeps()));
  const getSocialV2State = (...args) => socialStateMachine().getSocialV2State(...args);
  const loadSocialV2State = (...args) => socialStateMachine().loadSocialV2State(...args);
  const saveSocialV2State = (...args) => socialStateMachine().saveSocialV2State(...args);
  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  // 长期记忆库（SQLite，跨会话记住人/事/梗/她自己的状态）。初始化失败一律降级：
  // 关掉记忆功能，但消息收发不受影响。
  let memoryDbRef = null;
  let memoryDbFailed = false;
  function memoryDb() {
    if (memoryDbRef) return memoryDbRef;
    if (memoryDbFailed) return null;
    if (cfg.socialV2?.memoryDb?.enabled === false) { memoryDbFailed = true; return null; }
    try {
      memoryDbRef = createMemoryDb({
        file: path.join(STATE_DIR, 'qq-memory.db'),
        tokenUsageFile: TOKEN_USAGE_FILE,
        log: (...a) => log('[memory-db]', ...a)
      });
      log('[memory-db] 已打开', memoryDbRef.file);
    } catch (error) {
      memoryDbFailed = true;
      memoryDbRef = null;
      log('[memory-db] 初始化失败，长期记忆关闭:', error?.message || error);
    }
    return memoryDbRef;
  }
  function memoryDbEnabled() {
    return cfg.socialV2?.memoryDb?.enabled !== false;
  }

  // ── [超长记忆 2026-10-19] 情景记忆层（episodic）──────────────────────────────
  // memory-db 管「人/事实/梗」，这里管「某天和谁聊了什么」的时间线：每天本地固化一段
  // 情景摘要进 episodes 表（零 LLM token），唤醒时按来信关键词 × 时间衰减 × 重要性
  // 检索注入「【很久以前】」段，外加「去年的今天」时间感知。详见 src/long-memory.js 头注释。
  let longMemoryRef = null;
  let longMemoryFailed = false;
  function longMemory() {
    if (longMemoryRef) return longMemoryRef;
    if (longMemoryFailed) return null;
    if (cfg.socialV2?.longMemory?.enabled === false) { longMemoryFailed = true; return null; }
    try {
      longMemoryRef = createLongMemory({
        file: path.join(STATE_DIR, 'long-memory.db'),
        log: (...a) => log('[long-memory]', ...a)
      });
      log('[long-memory] 已打开', longMemoryRef.file);
    } catch (error) {
      longMemoryFailed = true;
      longMemoryRef = null;
      log('[long-memory] 初始化失败，超长记忆关闭:', error?.message || error);
    }
    return longMemoryRef;
  }

  /**
   * 每日固化（懒触发）：在唤醒路径上顺带跑，内部用 meta 日期判重 —— 每天最多真正执行一次，
   * 其余唤醒只是一条 SELECT。固化范围 = 每个活跃会话最近 2 个完整天（今天不固化，还没过完）。
   * 顺带执行遗忘清理（importance=1 过期删除，3 = 有约定/冲突，永不自动删）。
   */
  function consolidateLongMemoryDaily() {
    if (cfg.socialV2?.longMemory?.enabled === false) return;
    const lm = longMemory();
    const mdb = memoryDb();
    if (!lm || !mdb || typeof mdb.daySignals !== 'function') return;
    try {
      const todayStr = localDayString(0);
      if (lm.lastConsolidateDay() === todayStr) return;
      const mdbMood = mdb.recentMoodEvents ? mdb.recentMoodEvents(20) : [];
      for (const key of socialV2.conversations.keys()) {
        if (!key || typeof key !== 'string' || !/^(group|private):\d+$/.test(key)) continue;
        for (let i = 1; i <= 2; i++) {
          const day = localDayString(i);
          if (lm.hasEpisode(key, day)) continue;
          const sig = mdb.daySignals(key, day);
          if (!sig || sig.messages.length < 3) continue;
          // 当天主要心情：取当天最后一条心情事件
          const moodOf = (mdbMood || []).filter((m) => m && localDayString(0, new Date(Number(m.at || 0))) === day).map((m) => m.mood);
          sig.mood = moodOf.length ? String(moodOf[moodOf.length - 1]) : '';
          lm.consolidateDay(key, day, sig);
        }
      }
      lm.setLastConsolidateDay(todayStr);
      const removed = lm.prune({ keepDays: Number(cfg.socialV2?.longMemory?.keepDays) || 120 });
      const stAfter = lm.stats();
      log(`[long-memory] 每日固化完成（episodes ${stAfter.episodes} 条，覆盖 ${stAfter.oldest || '-'} ~ ${stAfter.newest || '-'}，清理 ${removed} 条）`);
    } catch (error) {
      log('[long-memory] 固化失败:', error?.message || error);
    }
  }

  /** 唤醒注入：按来信内容检索超长记忆（很久以前 + 去年的今天）。 */
  function longMemoryRecallV2(key, queryText) {
    if (cfg.socialV2?.longMemory?.enabled === false) return '';
    const lm = longMemory();
    if (!lm) return '';
    return lm.recall({ key, queryText, maxChars: Number(cfg.socialV2?.longMemory?.recallMaxChars) || 400 });
  }

  // ── [拟人强化四件套 2026-10-19] 事件跟进 / 纪念日 / 记忆自检 / 对人冷场余波 ──
  // 词表与日期规则在 src/social-mechanisms.js（可脱离桥接单测），这里只做状态接线。
  // 台账都挂 st（followUps / coldShoulder / lastMemorySelfCheckAt，social-state 已持久化）。
  function followUpsCfgV2() {
    const f = cfg.socialV2?.followUps && typeof cfg.socialV2.followUps === 'object' ? cfg.socialV2.followUps : {};
    return { enabled: f.enabled !== false, maxAgeDays: Math.max(1, Number(f.maxAgeDays) || 10) };
  }
  function coldShoulderCfgV2() {
    const c = cfg.socialV2?.coldShoulder && typeof cfg.socialV2.coldShoulder === 'object' ? cfg.socialV2.coldShoulder : {};
    return { enabled: c.enabled !== false, hours: Math.min(24, Math.max(0.5, Number(c.hours) || 2)) };
  }

  // ①事件后主动跟进：有人「亲口」对她说了一件带未来时间的事（明天考试/下周面试…），
  // 记一笔；事件后过一天由看门狗（promiseDueTickV2 同一个 60s tick）叫她主动去问结果。
  function maybeRecordFollowUpV2(key, st, { plainContent, userId }) {
    if (!st || !followUpsCfgV2().enabled) return false;
    const now = Date.now();
    const hit = detectEventFollowUp(plainContent, now);
    if (!hit) return false;
    st.followUps = Array.isArray(st.followUps) ? st.followUps : [];
    // 去重：同一件事（同名事件且到期时间差不多）一天内只记一次 —— 群友会把同一件事说好几遍。
    if (st.followUps.some((f) => f && f.event === hit.event && Math.abs(Number(f.dueAt) - hit.dueAt) < 86400000)) return false;
    st.followUps.push({
      event: hit.event,
      dueAt: hit.dueAt,
      followUpAt: hit.followUpAt,
      senderId: userId != null ? String(userId) : '',
      recordedAt: now
    });
    if (st.followUps.length > 20) st.followUps = st.followUps.slice(-20);
    saveSocialV2State();
    log(`[拟人] ${key} 记下事件跟进：「${hit.event}」，${new Date(hit.followUpAt).toLocaleString('zh-CN')} 去问问结果`);
    appendActivity(`${key} [拟人] 记下事件跟进：「${hit.event}」`);
    return true;
  }

  // 看门狗扫描：到点（过点 10 天内也补）就标 remindedAt —— 照 promises 的去重模式，只主动提一次。
  function followUpDueScanV2(st, now) {
    const c = followUpsCfgV2();
    if (!c.enabled || !st || !Array.isArray(st.followUps) || !st.followUps.length) return 0;
    let due = 0;
    for (const f of st.followUps) {
      if (!f || f.done || f.remindedAt) continue;
      if (now < Number(f.followUpAt)) continue;
      if (now - Number(f.followUpAt) > c.maxAgeDays * 86400000) { f.done = true; continue; } // 拖太久就不问了
      f.remindedAt = now;
      due++;
    }
    if (st.followUps.some((f) => f && f.done)) st.followUps = st.followUps.filter((f) => f && !f.done);
    return due;
  }

  function followUpLineV2(key) {
    try {
      const st = getSocialV2State(key);
      const now = Date.now();
      // 展示窗口：被看门狗标记后 24h 内（正该去问的时候）或已到点还没标记过（兜底）。
      const list = (Array.isArray(st?.followUps) ? st.followUps : [])
        .filter((f) => f && !f.done && ((Number(f.remindedAt) && now - Number(f.remindedAt) < 86400000)
          || (!f.remindedAt && now >= Number(f.followUpAt))))
        .slice(-3);
      if (!list.length) return '';
      const pool = [...(Array.isArray(st?.unread) ? st.unread : []), ...(Array.isArray(st?.recentMessages) ? st.recentMessages : [])];
      const nameOf = (f) => {
        const sid = String(f.senderId || '');
        const m = [...pool].reverse().find((x) => x && !x.isSelf && (!sid || String(x.userId || '') === sid));
        return m?.sender || '群友';
      };
      const items = list.map((f) => `- ${nameOf(f)} 之前提到「${f.event}」—— 顺口问一句结果怎么样，别像查岗`).join('\n');
      return `【该问问了】\n${items}\n\n`;
    } catch (error) {
      log('[拟人] 事件跟进注入失败', key, error?.message || error);
      return '';
    }
  }

  // ②纪念日：认识满 N 天的里程碑（数据源 memory-db：本会话首条消息的时间）。
  function anniversaryLineV2(key) {
    try {
      if (!memoryDbEnabled()) return '';
      const mdb = memoryDb();
      if (!mdb || typeof mdb.anniversarySignals !== 'function') return '';
      const sig = mdb.anniversarySignals(key);
      if (!sig || !sig.keyFirstAt) return '';
      const days = Math.floor((Date.now() - Number(sig.keyFirstAt)) / 86400000);
      const milestone = milestoneDays(days);
      if (!milestone) return '';
      const who = String(key).startsWith('private:') ? '主人' : '这个群';
      return `【纪念日】今天是你认识${who}满 ${milestone} 天的日子。聊天时如果自然合适，可以似有若无地提一句（别搞成播报）。\n\n`;
    } catch (error) {
      log('[拟人] 纪念日注入失败', key, error?.message || error);
      return '';
    }
  }

  // ③记忆自检：低概率（默认 0.02）+ 至少隔 3 天，随机抽一条旧情景让她「忽然想起很久以前」。
  function longMemorySelfCheckV2(key) {
    try {
      const prob = Math.min(0.2, Math.max(0, Number(cfg.socialV2?.longMemory?.selfCheckProbability ?? 0.02)));
      if (!prob) return '';
      const st = getSocialV2State(key);
      const now = Date.now();
      if (st && now - (Number(st.lastMemorySelfCheckAt) || 0) < 3 * 86400000) return '';
      const lm = longMemory();
      if (!lm || typeof lm.sampleEpisode !== 'function') return '';
      const ep = lm.sampleEpisode(key);
      if (!ep || !String(ep.summary || '').trim()) return '';
      if (st) st.lastMemorySelfCheckAt = now; // 不主动落盘：随下一次常规 save 带走
      const dayMs = new Date(`${ep.day}T00:00:00`).getTime();
      const daysAgo = Number.isFinite(dayMs) ? Math.max(1, Math.round((now - dayMs) / 86400000)) : 0;
      const summary = String(ep.summary).slice(0, 160);
      return `【记忆闪回】你忽然想起 ${ep.day}${daysAgo ? `（约 ${daysAgo} 天前）` : ''}：${summary}\n和现在聊的搭得上就似有若无地提一句，搭不上就先存着。\n\n`;
    } catch (error) {
      log('[拟人] 记忆自检失败', key, error?.message || error);
      return '';
    }
  }

  // ④对人冷场余波：谁对她说难听的（HOSTILE_RE，仅在「真的在跟她说话」的消息上探测），
  // 之后几小时里跟这个人有点别扭：活跃期沉默率对他 ×3+0.15，提示词里标注「可以淡淡的」。
  // 和解词（PEACE_RE）当场翻篇；主人免疫（怎么凶都是撒娇，不记账）。
  function maybeColdShoulderV2(key, st, { userId, plainContent }) {
    try {
      const c = coldShoulderCfgV2();
      if (!c.enabled || !st || userId == null) return false;
      const sid = String(userId);
      if (!sid || sid === String(cfg.ownerQQ ?? '')) return false;
      const text = String(plainContent || '').slice(0, 120);
      if (!text) return false;
      st.coldShoulder = (st.coldShoulder && typeof st.coldShoulder === 'object') ? st.coldShoulder : {};
      if (PEACE_RE.test(text)) {
        if (st.coldShoulder[sid]) {
          delete st.coldShoulder[sid];
          saveSocialV2State();
          log(`[拟人] ${key} ${sid} 主动和好，冷场余波解除`);
        }
        return false;
      }
      if (!HOSTILE_RE.test(text)) return false;
      st.coldShoulder[sid] = { at: Date.now(), hostile: true };
      // 有界：最多记 30 个人，超了丢最旧的
      const ids = Object.keys(st.coldShoulder);
      if (ids.length > 30) {
        ids.sort((a, b) => (Number(st.coldShoulder[a]?.at) || 0) - (Number(st.coldShoulder[b]?.at) || 0));
        for (const old of ids.slice(0, ids.length - 30)) delete st.coldShoulder[old];
      }
      saveSocialV2State();
      log(`[拟人] ${key} 记下冷场余波：${sid} 说了不好听的话，接下来 ${c.hours} 小时对他有点别扭`);
      appendActivity(`${key} [拟人] 对人冷场余波：${sid}`);
      return true;
    } catch (error) {
      log('[拟人] 冷场余波记账失败', key, error?.message || error);
      return false;
    }
  }
  /** 活跃期沉默判定用：这个人还在「别扭期」吗。 */
  function coldShoulderActiveV2(st, userId) {
    const c = coldShoulderCfgV2();
    if (!c.enabled || !st || userId == null) return false;
    const entry = st.coldShoulder?.[String(userId)];
    if (!entry || !entry.hostile) return false;
    return Date.now() - Number(entry.at) < c.hours * 3600000;
  }
  function coldShoulderLineV2(key) {
    try {
      const c = coldShoulderCfgV2();
      if (!c.enabled) return '';
      const st = getSocialV2State(key);
      const now = Date.now();
      const ownerQq = String(cfg.ownerQQ ?? '');
      const ids = Object.entries(st?.coldShoulder || {})
        .filter(([sid, v]) => v?.hostile && now - Number(v.at) < c.hours * 3600000 && sid !== ownerQq)
        .map(([sid]) => sid);
      if (!ids.length) return '';
      const pool = [...(Array.isArray(st?.unread) ? st.unread : []), ...(Array.isArray(st?.recentMessages) ? st.recentMessages : [])];
      const names = [...new Set(ids.map((sid) => {
        const m = [...pool].reverse().find((x) => x && !x.isSelf && String(x.userId || '') === sid);
        return m?.sender || '有人';
      }))];
      return `【别扭中】${names.join('、')} 之前对你说过不好听的话，你现在跟他们有点别扭：回他们可以淡淡的、慢半拍、短一点，不用装热情，但别彻底装看不见。\n\n`;
    } catch (error) {
      log('[拟人] 冷场余波注入失败', key, error?.message || error);
      return '';
    }
  }

  // ── [长记忆 2026-10-18] 自动提炼 + 定期整理 ─────────────────────────────────
  // 背景：库里 8052 条消息只长出 24 条 facts（几乎全靠她现场调工具写），会话又是每轮新开，
  // 所以她「不记得上周聊过什么」。这里每轮结束从新消息里规则式提炼几条事实入库（零模型调用），
  // 每 6 小时合并近似重复、清过期、限条数 —— 只在本地 SQLite 上跑，不碰网络、不加延迟。
  function autoLearnMemoryV2(key) {
    if (cfg.socialV2?.memoryDb?.autoLearn === false) return 0;
    if (!memoryDbEnabled()) return 0;
    const mdbRef = memoryDb();
    if (!mdbRef) return 0;
    try {
      const st = getSocialV2State(key);
      if (!st) return 0;
      const since = Number(st.memoryLearnedAt) || 0;
      const list = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
        .filter((m) => m && !m.isSelf && Number(m.time) > since);
      if (!list.length) return 0;
      const wrote = mdbRef.learnFacts(list, { key });
      const newest = list.reduce((mx, m) => Math.max(mx, Number(m.time) || 0), since);
      if (newest > since) { st.memoryLearnedAt = newest; saveSocialV2State(); }
      if (wrote) log("[长记忆] " + key + " 自动记下 " + wrote + " 条事实");
      return wrote;
    } catch (error) {
      log("[长记忆] 提炼失败 " + key + ": " + (error?.message ?? error));
      return 0;
    }
  }

  const MEMORY_CONSOLIDATE_INTERVAL_MS = 6 * 3600 * 1000;
  function runMemoryConsolidateV2() {
    if (cfg.socialV2?.memoryDb?.enabled === false) return null;
    const mdbRef = memoryDb();
    if (!mdbRef) return null;
    try {
      const r = mdbRef.consolidateFacts({
        maxAgeDays: Number(cfg.socialV2?.memoryDb?.maxFactAgeDays) || 120,
        maxPerSubject: Number(cfg.socialV2?.memoryDb?.maxFactsPerPerson) || 10,
      });
      log("[长记忆] 整理完成：合并 " + r.merged + " 条、过期清理 " + r.expired + " 条、超量裁剪 " + r.trimmed + " 条");
      return r;
    } catch (error) {
      log("[长记忆] 整理失败：" + (error?.message ?? error));
      return null;
    }
  }
  function startMemoryMaintenanceV2() {
    if (cfg.socialV2?.memoryDb?.enabled === false) return;
    setTimeout(() => { try { runMemoryConsolidateV2(); } catch { /* 整理失败不影响收发 */ } }, 90 * 1000).unref?.();
    setInterval(() => { try { runMemoryConsolidateV2(); } catch { /* 同上 */ } }, MEMORY_CONSOLIDATE_INTERVAL_MS).unref?.();
    log("[长记忆] 维护已排期：启动 90s 后整理一次，之后每 6 小时一次");
  }

  // [印象档案] 结构化字段的取值规则：**新值优先，不传就保留旧值**。
  // 空串/空白视为"没传"，避免模型偶尔传个 "" 就把记过的生日抹掉。
  // 传 "无"/"清除" 这类显式词才真的清空（模型想改主意时用）。
  function pickImpressionField(next, prev, maxLen) {
    if (next === undefined || next === null) return prev ? String(prev).slice(0, maxLen) : '';
    const s = String(next).trim();
    if (!s) return prev ? String(prev).slice(0, maxLen) : '';
    if (['无', '没有', '清除', '清空', '-', 'none'].includes(s.toLowerCase ? s.toLowerCase() : s)) return '';
    return s.slice(0, maxLen);
  }

  // [承诺/待办] 把到期时间渲染成人话：「已到期」「今天」「明天」「还有 N 天」。
  // 到期当天及逾期才算「该提了」—— 提前太久提会显得催命。
  function describeDueV2(dueAt) {
    const due = Number(dueAt);
    if (!due) return '';
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const t0 = startOfToday.getTime();
    if (due < t0) return '已到期';
    if (due < t0 + dayMs) return '今天';
    const days = Math.floor((due - t0) / dayMs);
    if (days <= 1) return '明天';
    return `还有 ${days} 天`;
  }

  // [承诺/待办] 到期提醒的判定：`dueAt` 已过，或就在今天。
  function isPromiseDueV2(p, now = Date.now()) {
    const due = Number(p?.dueAt);
    if (!due) return false;
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return due < startOfToday.getTime() + 24 * 60 * 60 * 1000;
  }

  // [生日] 解析印象档案里的生日串（支持 07-26 / 7-26 / 7月26日 / 7/26）。
  // 只取月日，不含年份 —— 生日按年循环，年份没意义。
  function parseBirthdayV2(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { month, day };
  }

  // [生日] 距离这次生日的天数：0=今天，1=明天，…，7=一周内，null=没法解析。
  function daysUntilBirthdayV2(raw, now = Date.now()) {
    const bd = parseBirthdayV2(raw);
    if (!bd) return null;
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const mk = (y) => new Date(y, bd.month - 1, bd.day).setHours(0, 0, 0, 0);
    let next = mk(today.getFullYear());
    if (next < today.getTime()) next = mk(today.getFullYear() + 1);
    return Math.round((next - today.getTime()) / (24 * 60 * 60 * 1000));
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    // [承诺/待办] 答应过别人的事：未完成的按「到期紧急度」排前面，到期的显式标出来。
    // 和 activeTopic/pendingThought 不同：这两个是"聊到哪儿了"，承诺是"我欠他一个交代"，
    // 生命周期更长（可以跨天/周），到期必须主动提，不能忘了。
    const promises = Array.isArray(st.promises)
      ? st.promises.filter((p) => p && String(p.text || '').trim() && !p.done)
      : [];
    if (promises.length) {
      const sorted = promises.slice().sort((a, b) => {
        const da = Number(a.dueAt) || Number.MAX_SAFE_INTEGER;
        const db = Number(b.dueAt) || Number.MAX_SAFE_INTEGER;
        return da - db;
      });
      const anyDue = sorted.some((p) => isPromiseDueV2(p));
      lines.push(anyDue ? '【答应过的事（有到期的，该主动提了）】' : '【答应过的事】');
      for (const p of sorted.slice(0, 10)) {
        const due = describeDueV2(p.dueAt);
        const who = p.target ? `${p.target}：` : '';
        const tail = due ? `（${due}）` : '';
        lines.push(`- ${who}${String(p.text).slice(0, 120)}${tail}`);
      }
      if (anyDue) lines.push('（到期的事找机会自然地说一句——别像催债，但要让人知道你记着。）');
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    // [印象档案·在场优先] 从 recentMessages 里取出「最近在这里说过话的人」，
    // 让他们排到印象列表最前面 —— 群聊正在跟谁对话，谁的档案就该先被看到。
    // 排序键 = (是否在场, lastSeenAt)，两组都降序。
    const presentNow = new Set();
    if (Array.isArray(st.recentMessages)) {
      for (const m of st.recentMessages.slice(-30)) {
        if (!m || m.isSelf) continue;
        const n = String(m.sender || '').trim();
        if (n) presentNow.add(n);
      }
    }
    const impEntries = Object.keys(impressions)
      .map((name) => [name, impressions[name] || {}])
      .sort((a, b) => {
        const pa = presentNow.has(a[0]) ? 1 : 0;
        const pb = presentNow.has(b[0]) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (Number(b[1].lastSeenAt) || 0) - (Number(a[1].lastSeenAt) || 0);
      })
      .slice(0, 10);
    if (impEntries.length) {
      lines.push('【对群友的印象】');
      for (const [name, im] of impEntries) {
        const traits = Array.isArray(im.traits) ? im.traits : [];
        const hard = [];
        if (im.birthday) {
          // [生日] 生日临近就显式标出「还有 N 天」/「今天」，提醒她记得说句生日快乐。
          const d = daysUntilBirthdayV2(im.birthday);
          let bdNote = `生日 ${im.birthday}`;
          if (d === 0) bdNote += '（今天！记得说生日快乐）';
          else if (d === 1) bdNote += '（明天）';
          else if (d !== null && d <= 7) bdNote += `（还有 ${d} 天）`;
          hard.push(bdNote);
        }
        if (im.preferName) hard.push(`喜欢被叫「${im.preferName}」`);
        if (im.avoid) hard.push(`别碰：${im.avoid}`);
        const hardPart = hard.length ? `［${hard.join('｜')}］` : '';
        lines.push(`- ${name}${hardPart}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  /**
   * [记忆] 把 AI 回填的「人名」归一化。实测她会把消息视图里的内部标签当成群友名字抄回来，
   * 于是长出了 people 行「name:管理员（ownerQQ 10001）」和两条 subject 对不上主人 uid
   * 的 facts（这两条永远匹配不到人，等于白记）。这里在落库前把这类标签折回主人本人：
   * 返回 { name, pid }，pid 有值时 memory-db 直接用它当主键，不再靠昵称去猜。
   */
  function normalizeImpressionTarget(raw) {
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    const rawTrim = String(raw ?? '').trim();
    if (!rawTrim) return { name: '', pid: null };   // 没写目标就别硬记到主人头上
    let t = rawTrim.replace(/^name:/i, '');
    t = t.replace(/[（(][^（()）]*(?:ownerqq|owner|管理员|群主|群成员)[^（()）]*[)）]/gi, '');
    if (ownerQQ) t = t.split(ownerQQ).join('');
    t = t.replace(/[（(]\s*[)）]/g, '').replace(/\s{2,}/g, ' ').trim();
    // 「主人 纱雾酱最可爱了」这类：以主人/管理员开头，或整串只剩身份词
    if (!t || /^(管理员|群主|owner|主人)/i.test(t)) {
      return { name: '主人', pid: ownerQQ || null };
    }
    return { name: t.slice(0, 40), pid: null };
  }

  // [D] 心情事件去重：同一会话 5 分钟内只落一条，免得她刷屏似地记「我现在很难过」。
  const lastMoodEventAtV2 = new Map();

  function appendMemoryV2(st, category, content, extra = {}, key = '') {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      const mdbTopic = memoryDb();
      if (mdbTopic) mdbTopic.recordTopic(text, extra.participants);
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const norm = normalizeImpressionTarget(extra.target);
      const target = norm.name;
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now(),
        // [印象档案] 结构化硬信息：记一次就长期有效，和 traits 那种"印象标签"分开存。
        // 都是可选的 —— 不传就保持原值，不会被无脑清空。
        birthday: pickImpressionField(extra.birthday === undefined ? undefined : redactKnownTokensOnly(String(extra.birthday)), old.birthday, 10),
        preferName: pickImpressionField(extra.preferName === undefined ? undefined : redactKnownTokensOnly(String(extra.preferName)), old.preferName, 20),
        avoid: pickImpressionField(extra.avoid === undefined ? undefined : redactKnownTokensOnly(String(extra.avoid)), old.avoid, 40),
        firstMetAt: Number(old.firstMetAt) || Date.now()
      };
      const mdbImp = memoryDb();
      if (mdbImp) mdbImp.rememberImpression(target, text, false, norm.pid);
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    } else if (cat === 'mood' && text) {
      // [情绪] 她主动改自己的心情（不只是桥接按事件替她设）。
      // extra.mood 七选一（happy/excited/calm/tired/sleepy/sad/annoyed）；
      // extra.holdMin 这次心情按住多少分钟（默认 30，上限 240）；extra.energy 精力增减（±30）。
      // content 就是「为什么是这个心情」的一句话。
      const want = String(extra.mood ?? '').trim().toLowerCase();
      const holdMin = Number(extra.holdMin);
      const delta = Math.max(-30, Math.min(30, Math.round(Number(extra.energy) || 0)));
      if (MOOD_LABELS[want]) {
        setMood(want, text, Date.now(), Number.isFinite(holdMin) && holdMin > 0 ? holdMin : 30);
        // [D] 记仇也会消气：心情事件落库（memory-db.recordMoodEvent），48 小时内由
        // moodMemoryLineV2 重新想起来 —— 这样「上周你把我气到了」在重启后依然成立。
        const mdbMood = memoryDb();
        if (mdbMood && typeof mdbMood.recordMoodEvent === 'function') {
          const lastMoodAt = Number(lastMoodEventAtV2.get(key)) || 0;
          if (Date.now() - lastMoodAt > 5 * 60 * 1000) {
            lastMoodEventAtV2.set(key, Date.now());
            const who = extra.target ? normalizeImpressionTarget(extra.target).name : '';
            try {
              mdbMood.recordMoodEvent({ at: Date.now(), key, mood: want, summary: text, participants: who ? [who] : [] });
            } catch (error) {
              log('[情绪] 心情事件落库失败:', error?.message ?? error);
            }
          }
        }
      } else {
        const msNote = readMoodState();
        msNote.note = text.slice(0, 200);
        msNote.updatedAt = Date.now();
        saveMoodState();
      }
      if (delta) {
        const msEnergy = readMoodState();
        msEnergy.energy = Math.max(0, Math.min(100, Math.round((Number(msEnergy.energy) || 0) + delta)));
        msEnergy.updatedAt = Date.now();
        saveMoodState();
      }
    } else if (cat === 'promise' && text) {
      // [承诺/待办] 她答应过别人的事 / 给自己立的待办。与 relation.promise 的区别：
      // relation.promise 是"主人这条线"的关系约定（跟随关系档案走）；
      // 这里的 promises 是**跨会话的通用待办池**，谁都能立，到期统一提醒。
      // extra.target=答应谁；extra.dueAt=到期毫秒时间戳或 ISO 字符串；extra.done=true 表示已兑现。
      if (!Array.isArray(st.promises)) st.promises = [];
      const target = extra.target ? normalizeImpressionTarget(extra.target).name : '';
      const rawDue = extra.dueAt ?? extra.due ?? extra.when;
      let dueAt = 0;
      if (rawDue !== undefined && rawDue !== null && rawDue !== '') {
        const n = Number(rawDue);
        if (Number.isFinite(n) && n > 0) dueAt = n < 1e12 ? n * 1000 : n;   // 秒级时间戳自动升到毫秒
        else {
          const t = Date.parse(String(rawDue));
          if (Number.isFinite(t)) dueAt = t;
        }
      }
      const done = extra.done === true || String(extra.done || '').toLowerCase() === 'true';
      // 同一个人+同一句话视为同一条，避免反复记重复。
      const existing = st.promises.find((p) => p && String(p.text || '') === text.slice(0, 200) && String(p.target || '') === target);
      if (existing) {
        existing.done = done;
        existing.dueAt = dueAt || existing.dueAt || 0;
        existing.updatedAt = Date.now();
        if (done) existing.doneAt = Date.now();
      } else {
        st.promises.push({
          text: text.slice(0, 200),
          target,
          dueAt,
          done,
          doneAt: done ? Date.now() : 0,
          createdAt: Date.now()
        });
      }
      // 保留未完成的最近 40 条 + 已完成最近 20 条，防止无限膨胀。
      const unfinished = st.promises.filter((p) => p && !p.done);
      const finished = st.promises.filter((p) => p && p.done);
      if (unfinished.length > 40) unfinished.splice(0, unfinished.length - 40);
      if (finished.length > 20) finished.splice(0, finished.length - 20);
      st.promises = [...unfinished, ...finished];
    } else if (cat === 'relation') {
      // [关系] 主观关系变化：好感度 / 阶段 / 专属称呼 / 约定 / 共同回忆。
      // 与 memberImpression 的分工：那个记「客观事实」（生日、雷点、口头禅），
      // 这个记「她对这人的感觉」——两边的寿命和读取时机都不一样。
      const norm = normalizeImpressionTarget(extra.target);
      const target = norm.name;
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.relations || typeof st.relations !== 'object') st.relations = {};
      const mdbRel = memoryDb();
      const pid = norm.pid || relationPidForV2(target);
      const loveDelta = Math.max(-10, Math.min(10, Math.round(Number(extra.love ?? extra.loveDelta) || 0)));
      const clean = (v) => (v === undefined ? undefined : redactKnownTokensOnly(String(v)));
      const payload = {
        pid,
        name: target,
        scope: String(extra.scope || ''),
        loveDelta,
        moment: clean(extra.moment),
        promise: clean(extra.promise),
        petName: clean(extra.petName),
        stage: clean(extra.stage),
        note: clean(extra.note)
      };
      const row = mdbRel ? mdbRel.upsertRelation(payload) : null;
      // 降级镜像：memoryDb 被关掉或坏掉时【关系】块仍然读得到，不至于一片空白。
      const mirror = st.relations[target] || {};
      const keep = (next, prev) => (next === undefined ? String(prev || '') : String(next || ''));
      st.relations[target] = {
        love: row ? Number(row.love) || 0 : Math.max(0, Math.min(100, (Number(mirror.love) || 0) + loveDelta)),
        stage: row ? String(row.stage || '') : keep(payload.stage, mirror.stage),
        petName: row ? String(row.pet_name || '') : keep(payload.petName, mirror.petName),
        promise: row ? String(row.promise || '') : keep(payload.promise, mirror.promise),
        note: row ? String(row.note || '') : keep(payload.note, mirror.note),
        moment: row && Array.isArray(row.moments) && row.moments.length ? String(row.moments[row.moments.length - 1].text || '') : keep(payload.moment, mirror.moment),
        at: Date.now()
      };
      const relKeys = Object.keys(st.relations);
      if (relKeys.length > 30) {
        relKeys.sort((a, b) => (Number(st.relations[a]?.at) || 0) - (Number(st.relations[b]?.at) || 0));
        for (let i = 0; i < relKeys.length - 30; i++) delete st.relations[relKeys[i]];
      }
    }
    saveSocialV2State();
  }

  /** relations 表的主键是 pid，但模型只会说人名 —— 这里做一次解析。 */
  function relationPidForV2(target) {
    const t = String(target ?? '').trim();
    if (!t) return '';
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (ownerQQ && (t === ownerQQ || t === '主人' || /^主人[\s（(]/.test(t))) return ownerQQ;
    const mdb = memoryDb();
    if (mdb) {
      const id = mdb.personIdByName(t);
      if (id) return id;
    }
    return 'name:' + t.slice(0, 40);
  }

  /**
   * 【关系】块：她跟「此刻在场的几个人」的关系（好感 / 朋友档位 / 专属称呼 / 约定 / 最近的共同回忆）。
   * 只在人真的在场时才注入 —— 关系是拿来对话的，不是自我欣赏的仪表盘。
   * 上限 3 人 / 400 字；整块失败一律退化成空串，绝不往提示词里塞噪声。
   */
  function relationLineV2(key, maxPeople = 3) {
    if (cfg.socialV2?.relation?.includeInPrompt === false) return '';
    const cap = Math.max(1, Math.min(12, Number(maxPeople) || 3));
    try {
      if (!key) return '';
      const st = getSocialV2State(key);
      const mdb = memoryDb();
      const ownerQQ = String(cfg.ownerQQ ?? '').trim();
      const mirror = st && st.relations && typeof st.relations === 'object' ? st.relations : {};
      const impressions = st && st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
      const isOwnerHere = String(key).indexOf('private:') === 0 || !!impressions['主人'];
      const cands = [];
      const pushCand = (name) => {
        const n = String(name || '').trim();
        if (!n || n.length > 20 || cands.includes(n)) return;
        cands.push(n);
      };
      if (ownerQQ && isOwnerHere) pushCand('主人');
      // 在场的其他人：按印象里的最近出现顺序取（和 buildDigest「只挑在场的人」同一口径）。
      const recentImp = Object.entries(impressions)
        .filter(([n, v]) => n && n !== '主人' && v && typeof v === 'object')
        .sort((a, b) => (Number(b[1]?.lastSeenAt) || 0) - (Number(a[1]?.lastSeenAt) || 0));
      for (const [n] of recentImp.slice(0, 6)) pushCand(n);
      // 镜像里的也算（她刚记过关系，但那个人还没被印象覆盖到）。
      for (const n of Object.keys(mirror).sort((a, b) => (Number(mirror[b]?.at) || 0) - (Number(mirror[a]?.at) || 0))) pushCand(n);
      if (!cands.length) return '';
      const pids = cands.map((n) => relationPidForV2(n));
      const rows = mdb ? mdb.relationsFor(pids) : {};
      const people = mdb ? mdb.peopleByIds(pids) : {};
      const entries = [];
      for (let i = 0; i < cands.length && entries.length < cap; i++) {
        const name = cands[i];
        const pid = pids[i];
        const row = rows[pid] || null;
        const person = people[pid] || null;
        const m = mirror[name] || null;
        // [patch 恋爱起步] 主人的好感不从 0 起算：他是养大她的人，不该被「刚认识」那一档套住。
        // DB 里存的仍是增量，显示值 = 起步 + 增量（封顶 100），所以她每记一次关系进展，数字都会往前动。
        const ownerSeed = name === '主人' ? Math.max(0, Math.min(100, Number(cfg.socialV2?.relation?.ownerSeedLove ?? 65) || 0)) : 0;
        const loveStored = row ? Number(row.love) || 0 : (m && m.love !== undefined ? Number(m.love) || 0 : null);
        const loveRaw = loveStored === null ? (ownerSeed || null) : Math.min(100, loveStored + ownerSeed);
        const stage = row ? String(row.stage || '') : String((m && m.stage) || '');
        const petName = row ? String(row.pet_name || '') : String((m && m.petName) || '');
        const promise = row ? String(row.promise || '') : String((m && m.promise) || '');
        const moment = row && Array.isArray(row.moments) && row.moments.length
          ? String(row.moments[row.moments.length - 1].text || '')
          : String((m && m.moment) || '');
        const msgCount = person ? Number(person.msg_count) || 0 : 0;
        const bits = [];
        if (loveRaw !== null && (loveRaw > 0 || stage)) {
          const stageName = stage || (mdb && mdb.loveStageName ? mdb.loveStageName(loveRaw) : '');
          bits.push((stageName ? stageName + '·' : '') + '好感 ' + loveRaw + '/100');
        }
        if (person && msgCount >= 3 && mdb && mdb.friendTier) bits.push(mdb.friendTier(msgCount) + '（聊过 ' + msgCount + ' 句）');
        if (petName) bits.push('你叫她「' + truncateText(petName, 12) + '」');
        if (promise) bits.push('约定：' + truncateText(promise, 30));
        if (moment) bits.push('记得：' + truncateText(moment, 30));
        if (!bits.length) continue;
        entries.push(name + '——' + bits.join('｜'));
      }
      if (!entries.length) return '';
      const line = '【关系】' + entries.join('；') + '（好感是给你自己的刻度：按亲近程度说话，别把数字念出来）';
      return truncateText(line, 400) + '\n\n';
    } catch (error) {
      log('relationLineV2 failed', error?.message ?? error);
      return '';
    }
  }

  loadSocialV2State();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // ── [patch 活跃期选择性沉默（二代移植，2026-10-19 回答机制第 5 条）] ──────────
  // 醒着 ≠ 每条都回。一代引擎（reserved）的 socialLoopTick 活跃分支有完整实现，
  // 但线上跑的是 reserved2，那套循环在二代下是死代码 —— 在二代消息路径上重实现核心语义：
  //   ① 活跃窗口 = 自己最后一次发言后 idleWindowMs（cfg.social.idleWindowMs，默认 6 分钟）内；
  //   ② 必须回：引用自己 / 命中 mustReplyKeywords / 直接向 AI 提问 —— 不掷骰，直接投递；
  //   ③ 普通闲聊按 skipProbability 掷骰沉默；刚发言 60 秒内不沉默；未读积压越多沉默率越低；
  //   ④ 沉默 = 不唤醒：消息已留在 unread（二代所有消息都进 unread，见 appendSocialV2Message），
  //      下次唤醒时随快照一并带给模型 —— 天然等价一代的 silentContext（"看到过但没接"）；
  //   ⑤ 活跃期投递按 activeCheckMinMs 节流，消息风暴不逐条开回合（连发由 batchWindowMs 合并）。
  function lastSelfSpeakAtV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (m && m.isSelf && Number(m.time)) return Number(m.time);
    }
    return 0;
  }

  // 返回 true = 本条消息已在活跃期逻辑内处理（投递或沉默），调用方不再走常规唤醒；
  // 返回 false = 不在活跃窗口，维持原判定结果（不醒）。
  function maybeActivePeriodDeliveryV2(key, st, { sender, plainContent, quoteTargetIsSelf, userId }) {
    if (!key.startsWith('group:')) return false;
    if (sleepStateV2(key, st).asleep) return false;
    const now = Date.now();
    const activeWindowMs = Math.max(60000, Number(cfg.social?.idleWindowMs ?? 360000));
    const spokeAt = Math.max(Number(st.lastAiReplyAt) || 0, lastSelfSpeakAtV2(st));
    if (!spokeAt || now - spokeAt >= activeWindowMs) return false;
    const mustReply = quoteTargetIsSelf || isMustReplyText(plainContent);
    if (!mustReply) {
      let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
      if (now - spokeAt < 60000) skipProb = 0; // 刚回复 60 秒内不沉默，避免"聊一半突然消失"
      const backlog = Math.max(0, (Array.isArray(st.unread) ? st.unread.length : 1) - 1);
      skipProb = Math.max(0, skipProb - Math.min(0.5, backlog * 0.1)); // 消息越多压力越大，沉默率越低
      // [拟人] 对人冷场余波：还在跟这个人置气的期间，对他的沉默率 ×3 + 0.15。
      if (coldShoulderActiveV2(st, userId)) skipProb = Math.min(0.95, skipProb * 3 + 0.15);
      if (Math.random() < skipProb) {
        log(`[reserved2] 活跃期 ${key} 选择性沉默（skip=${skipProb.toFixed(2)}）：不唤醒，${Array.isArray(st.unread) ? st.unread.length : 0} 条未读将随下次唤醒带给模型`);
        appendActivity(`${key} [reserved2] 活跃期选择性沉默：${String(sender ?? '')} 的消息不接`);
        return true;
      }
    }
    const gapMin = Math.max(5000, Number(cfg.social?.activeCheckMinMs ?? 8000));
    if (Number(st.lastActiveDeliverAt) && now - Number(st.lastActiveDeliverAt) < gapMin) {
      log(`[reserved2] 活跃期 ${key} 投递节流（距上次 <${Math.round(gapMin / 1000)}s），消息留 unread 随下轮带出`);
      return true;
    }
    st.lastActiveDeliverAt = now;
    log(`[reserved2] 活跃期 ${key} 投递普通闲聊（anyMessage，${mustReply ? '必须回' : 'skip 未命中'}）`);
    scheduleWakeV2(key, 'anyMessage');
    return true;
  }

  // ── [patch 冷场试探（二代移植，回答机制第 5 条）] ─────────────────────────
  // 活跃窗口刚过且群里没人说话（冷场）→ 按 idleRetryProbability（cfg.social，默认 0.4）
  // 试探说一句，否则退回观望。只在群聊生效；每个"发言周期"至多排一次（下次发言后重排）。
  // 复用 proactiveCheck 唤醒通道（提示词/闸门/优先级全套现成），只是触发条件从随机 tick
  // 换成「冷场判定」。
  const idleProbeTimersV2 = new Map();
  function scheduleIdleProbeV2(key) {
    if (!key.startsWith('group:')) return;
    if (idleProbeTimersV2.has(key)) return; // 已有待发的试探：一个发言周期只排一次
    const idleWindowMs = Math.max(60000, Number(cfg.social?.idleWindowMs ?? 360000));
    const timer = setTimeout(() => {
      idleProbeTimersV2.delete(key);
      try {
        const st = socialV2.conversations.get(key);
        if (!st || currentMode !== 'reserved2' || socialV2.paused) return;
        if (sleepStateV2(key, st).asleep) return;
        const now = Date.now();
        const spokeAt = Math.max(Number(st.lastAiReplyAt) || 0, lastSelfSpeakAtV2(st));
        // 活跃窗口刚过（过久就别硬找话了，退回观望）；期间有人说话就不算冷场
        if (!spokeAt || now - spokeAt < idleWindowMs || now - spokeAt > idleWindowMs * 3) return;
        if ((Number(st.lastIncomingAt) || 0) > spokeAt) return;
        if (isConversationBusyV2(key, st)) return;
        const prob = Math.min(1, Math.max(0, Number(cfg.social?.idleRetryProbability ?? 0.4)));
        if (Math.random() >= prob) {
          log(`[reserved2] 冷场 ${key}：掷骰观望（prob=${prob}），本轮不开口`);
          return;
        }
        log(`[reserved2] 冷场试探 ${key}：按 prob=${prob} 命中，开口探探群里还有人没`);
        sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] 冷场试探异常 ${key}:`, error?.message ?? error));
      } catch (error) {
        log(`[reserved2] 冷场试探调度异常 ${key}:`, error?.message ?? error);
      }
    }, idleWindowMs + 30000);
    timer.unref?.();
    idleProbeTimersV2.set(key, timer);
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // [省token 2026-10-18] 静态段「本会话只发一次」的闸门。
  // 只认 sessionId：DSH 会话没换就说明那条提示还在上下文里、也还在缓存前缀里。
  // ⚠️ 默认关闭、必须显式 opt-in（leanAfterFirst === true）：2026-10-18 05:13 一上线就
  // 把每轮的人设速记/打字节奏/表情包/查证规则一起省掉了，主人当场测出「降智」
  // （问番剧歌词、梗的意思都不查了，直接拿旧记忆糊）。省钱不能拿行为规则换。
  function shouldLeanWakeV2(key, sessionId) {
    if (cfg.socialV2?.wake?.leanAfterFirst !== true) return false;
    // [patch 每轮新会话] 每轮都是新会话：静态段从没在这个会话里发过，省掉它等于把人设/
    // 查证规则整段丢掉（2026-10-18 那次「降智」就是这么来的）。两者互斥。
    if (cfg.socialV2?.context?.freshSessionPerTurn === true) return false;
    if (!sessionId) return false;
    try {
      const mark = getSocialV2State(key).wakeStaticSent;
      return !!(mark && mark.sessionId === sessionId);
    } catch (error) {
      log('[省token] 精简判定失败：', error?.message || error);
      return false;
    }
  }
  function markWakeStaticSentV2(key, sessionId) {
    if (!sessionId) return;
    try {
      const st = getSocialV2State(key);
      if (st.wakeStaticSent?.sessionId === sessionId) return;
      st.wakeStaticSent = { sessionId, at: Date.now() };
      saveSocialV2State();
    } catch (error) {
      log('[省token] 静态段标记失败：', error?.message || error);
    }
  }

  // ── [patch 每轮新会话 2026-10-18] ─────────────────────────────────────────
  // 主人 m12006：每一次「发言的回复」都重开会话，不把上一轮的历史带进这一轮。
  // 为什么：旧会话会一直携带全部历史，冷群隔几个小时（DeepSeek 前缀缓存早过期）
  // 再开口时，那条历史要按「未命中价」重读一遍；聊得越久越贵，且随轮次复利上涨。
  // 换成每轮新会话后，成本固定为「一条唤醒提示词 + 回复」。上下文不再依赖 DSH 历史，
  // 而是靠提示词里的未读快照（已读/未读水位 readThroughSeq）+ 最近几条 + 「上次聊到哪」
  // 回顾 + 长期记忆/知识库 —— 这些本来就在每一轮提示词里。
  // 为什么不在 ensureSession 里按回合数轮换：同一回合里的第二次投递（唤醒提醒、第二槽位
  // 补答）也会调 ensureSession，那会在回合中途把上下文劈断。这里只在「带 wakeReason 的
  // 投递」前调用，而且回合真的在跑（v2TurnStartAt）时一律不动。
  // 关掉：config.json 的 socialV2.context.freshSessionPerTurn = false（或删掉这一项）。
  function freshSessionBeforeWakeV2(key, reason) {
    if (cfg.socialV2?.context?.freshSessionPerTurn !== true) return false;
    const sid = state.sessions[key];
    if (!sid) return false;
    if (v2TurnStartAt.has(sid)) {
      // [patch 回合尾巴] DSH 在 step/end 之后还要空转 ~27 秒才发 turn/end。
      // 只要「已经说完」并且安静了 2 秒以上，就不算真在跑，可以正常轮换。
      const idleAt = v2TurnIdleAt.get(sid) ?? 0;
      if (!idleAt || Date.now() - idleAt < 2000) return false;
    }
    // [延迟 2026-10-18] 会话复用窗口：连着聊的时候**不要**每句都重开会话。
    //
    // 为什么：每轮新会话要 workspace.create + sessions.create + events.follow + 挂 preset
    // + 设模型 + 归档旧会话，实测量级 1~2 秒；更要紧的是新会话的第一次请求要重新预热
    // 那一大坨系统提示。主人 2026-10-18 下午的原话是「响应时间过慢」，而那时候的日志里
    // 每来一条消息就退役一次会话（14:03-14:14 十分钟内建了十几个）。
    // 省 token 的初衷是「缓存过期后别把老历史整段重读」——那只需要在**真的隔了一阵子**
    // 之后重开，连续对话里重开纯亏：多花几秒，还少拿一截前缀缓存。
    //
    // 窗口默认 5 分钟（≈ DeepSeek 前缀缓存的 TTL 量级）：`socialV2.context.sessionReuseWarmMs`。
    const warmMs = Number(cfg.socialV2?.context?.sessionReuseWarmMs);
    const reuseMs = Number.isFinite(warmMs) && warmMs >= 0 ? warmMs : 5 * 60 * 1000;
    // 内存里没有时（桥接刚重启）退回状态文件里的 lastWakeAt —— 否则一次重启就等于
    // 「隔了很久没说话」，下一轮白建会话、白吃一遍冷前缀（2026-10-18 14:45 那条 12 秒就是这么来的）。
    let lastWakeAt = lastWakeDeliveredAtV2.get(key);
    if (lastWakeAt === undefined) {
      try { lastWakeAt = Number(getSocialV2State(key)?.lastWakeAt) || 0; } catch { lastWakeAt = 0; }
    }
    const idleMs = Date.now() - (lastWakeAt ?? 0);
    if (idleMs < reuseMs) {
      // [省token 2026-10-18] 复用窗口内也要看**上下文大小**：账本里最贵的几个回合
      // 都是「复用了一个 10 万 token 的会话，但缓存早过期」→ 100k 全价重读（¥0.09~0.11）。
      // 那种情况重开新会话（前缀 ~57k）反而便宜近一半，所以超过阈值就退役。
      const ctxCap = Number(cfg.socialV2?.context?.sessionReuseMaxContextTokens);
      const capTok = Number.isFinite(ctxCap) && ctxCap > 0 ? ctxCap : 60000;
      let lastCtx = 0;
      try { lastCtx = contextTokensOfKeyV2(key) || lastContextTokensV2.get(key) || 0; } catch { lastCtx = 0; }
      if (lastCtx > capTok) {
        log(`[省token] 会话复用 ${key}：上下文 ${lastCtx} token 超过复用上限 ${capTok}，本轮重开新会话`);
      } else {
        log(`[省token] 会话复用 ${key}：距上一轮投递 ${Math.round(idleMs / 1000)}s（<${Math.round(reuseMs / 1000)}s），本轮沿用同一会话 ${sid}`);
        return false;
      }
    }
    let st = null;
    let turns = 0;
    try {
      st = getSocialV2State(key);
      turns = Number(st?.turnCount) || 0;
    } catch (error) {
      log(`[省token] 每轮新会话：读状态失败，本轮沿用旧会话 ${key}：${error?.message ?? error}`);
      return false;
    }
    if (st) st.turnCount = 0;
    lastContextTokensV2.delete(key);
    log(`[省token] 每轮新会话 ${key}：退役上一轮的会话 ${sid}（上轮 ${turns} 回合，本轮唤醒 ${reason}），重新开局`);
    retireSession(key);
    saveSocialV2State();
    return true;
  }
  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    // [patch 每轮新会话] 见 freshSessionBeforeWakeV2：只在「真发出去的唤醒」前轮换，
    // 且回合在跑时不动 —— 这里已经是 promptQueues 串行的投递点，天然是回合边界。
    if (opts.wakeReason) freshSessionBeforeWakeV2(key, opts.wakeReason);
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    let wakeLean = false;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      // 静态段本会话已经整条发过 → 这轮只发动态段（省掉每轮全价的重复规则）。
      wakeLean = shouldLeanWakeV2(key, sessionId);
      promptText = buildWakePromptV2(key, opts.wakeReason, { slim: opts.slim === true, lean: wakeLean });
      if (wakeLean) log('[省token] ' + key + ' 用精简提示词（静态段本会话已发过，' + promptText.length + ' 字）');
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) promptText += wakeSnapshotSuffixV2(wakeSnapshot);
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    // [并发] 提示词已被 DSH 接受 —— 这时才认领台账（认领 = 「这些人这一轮由这个会话来答」）。
    // 不能放进 buildWakePromptV2：wake-preview 也会调它，看一眼提示词就把账领走就乱套了。
    if (opts.wakeReason) claimAsksV2(key, getSocialV2State(key), sessionId, 'a');
    // 角色卡版本标记：只在带 wakeReason 的提示词真正被 DSH 接受之后写，
    // 这样「build 两次」不会互相打断（builder 只读状态、不改状态）。
    if (opts.wakeReason) {
      try {
        const rsState = readRoleState();
        const rsName = sanitizeRoleName(rsState.role || '');
        const rsFile = rsName ? path.join(ROLES_DIR, rsName + '.md') : '';
        const rsMtime = rsFile && fs.existsSync(rsFile) ? fs.statSync(rsFile).mtimeMs : 0;
        const stCard = getSocialV2State(key);
        if (rsMtime && stCard.roleCardMtime !== rsMtime) {
          stCard.roleCardMtime = rsMtime;
          saveSocialV2State();
          log(`[reserved2] 角色卡已随本轮投递注入 ${key}（mtime=${Math.round(rsMtime)}）`);
        }
      } catch (error) {
        log(`[reserved2] 角色卡标记失败 ${key}:`, error?.message || error);
      }
    }
    // [省token] 这一轮是整条发出去的 → 记下「本会话已发过」，后面几轮只发动态段。
    if (opts.wakeReason && !wakeLean) markWakeStaticSentV2(key, sessionId);
    // [延迟] 记下这次投递时间：下一次唤醒据此决定「沿用同一会话」还是「重开」。
    if (opts.wakeReason) {
      const nowTs = Date.now();
      lastWakeDeliveredAtV2.set(key, nowTs);
      // 持久化一份：桥接重启后还能判断「该复用还是该重开」。
      try {
        const stTs = getSocialV2State(key);
        if (stTs) { stTs.lastWakeAt = nowTs; saveSocialV2State(); }
      } catch { /* 状态写失败不影响投递 */ }
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              // [情绪] 主动开话题的概率随心情浮动（兴奋更爱冒泡、困/烦时懒得开口）。
              const proactiveP = Math.min(0.95, Math.max(0, Number(cfg.social?.proactiveProbability ?? 0.2) * moodInitiativeFactorV2()));
              if (Math.random() < proactiveP) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }
  // [隐患根治 2026-10-19] 内核端口自动跟随 + 每日数据退役
  try { startDshPortWatchdog(); } catch (error) { log('[端口跟随] 启动失败:', error?.message || error); }
  try { startDailyMaintenance(); } catch (error) { log('[维护] 启动失败:', error?.message || error); }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    // 超预算时按**小节**取舍（整个小节要么进、要么不进），不做字符硬切——
    // 免得模型看到「## 九、你记得的东」这种被切掉半截的标题。
    return fitRoleText(selected, roleInjectMaxChars).text;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────

  // ── [并发] 点名台账：谁在等她回话 ──────────────────────────────────────────
  // 群里同时几个人 @ 她时，一个 DSH 会话一轮只跑一个回合，后面的只能排队等着；
  // 台账把「谁在等」记成一条条可结清的账，跨回合、跨槽位共享 —— 一个都不落下（用户 m02240）。
  function asksCfgV2() {
    try { return concurrencyCfgV2(); } catch { return resolveConcurrencyCfg(null); }
  }

  /** 还没回完的点名（slot='a' 主槽 / 'b' 并发槽；不传 slot 只看没人认领的）。 */
  function openAsksV2(st, { slot = null, includeClaimed = false, now = Date.now() } = {}) {
    try { return openAsks(st?.asks, { now, slot, includeClaimed, cfg: asksCfgV2() }); }
    catch (e) { log('[并发] 台账读取失败：' + (e?.message || e)); return []; }
  }

  /** 记一条点名：只记「有人直接找她」的消息，同一条消息只记一次。 */
  function recordAskV2(key, st, { reason, msg }) {
    const c = asksCfgV2();
    if (!c.enabled || !st || !msg || !isDirectedReason(reason)) return;
    try {
      const entry = makeAskEntry({
        seq: msg.seq, time: msg.time, sender: msg.sender,
        senderId: msg.userId, text: msg.plain || msg.text, reason, now: msg.time,
      }, c);
      if (!entry) return;
      st.asks = recordAsk(st.asks, entry, { now: Date.now(), cfg: c });
      saveSocialV2State();
    } catch (e) { log('[并发] 记点名失败：' + (e?.message || e)); }
  }

  /** 把「还没人管的」点名认领给某个槽位，并记住是哪个会话认领的（投递成功后才认领）。 */
  function claimAsksV2(key, st, sessionId, slot) {
    const c = asksCfgV2();
    if (!c.enabled || !st || !sessionId) return [];
    try {
      const unclaimed = openAsks(st.asks, { now: Date.now(), cfg: c });
      const max = slot === 'b' ? c.auxMaxAsks : c.mainMaxAsks;
      const ids = unclaimed.slice(0, max).map((x) => x.id);
      if (!ids.length) return [];
      st.asks = claimAsks(st.asks, { ids, slot, now: Date.now() }).list;
      pendingAskClaimsV2.set(sessionId, { ids, slot });
      saveSocialV2State();
      return ids;
    } catch (e) { log('[并发] 认领点名失败：' + (e?.message || e)); return []; }
  }

  /** 回合收场：真的发了消息就算答过（结清），没发就把认领放回台账（下一轮还能接）。 */
  function settleAsksV2(key, st, sessionId, answered) {
    const rec = pendingAskClaimsV2.get(sessionId);
    if (!rec || !rec.ids || !rec.ids.length) return 0;
    pendingAskClaimsV2.delete(sessionId);
    try {
      st.asks = answered
        ? resolveAsks(st.asks, { ids: rec.ids, now: Date.now(), status: 'answered' })
        : releaseAsks(st.asks, { ids: rec.ids, slot: rec.slot, now: Date.now() });
      saveSocialV2State();
      log(`[并发] ${key} ${answered ? '结清' : '放回'}点名 ${rec.ids.length} 条（槽位 ${rec.slot}）`);
      return rec.ids.length;
    } catch (e) { log('[并发] 结算点名失败：' + (e?.message || e)); return 0; }
  }

  /** 还有没人认领的点名吗（主回合结束后用来自动补一轮）。 */
  function asksNeedWakeV2(st) {
    const c = asksCfgV2();
    if (!c.enabled) return false;
    return openAsks(st?.asks, { now: Date.now(), cfg: c }).length > 0;
  }

  /**
   * [省token] 会话正热吗：最近 hotWindowMs 内被唤醒够多次（默认 3 分钟 4 次）。
   * 热的时候用瘦提示词（砍摘要/回放/动漫库/表情清单/参与感，约 4900 → 2200 字/轮）。
   */
  function wakeIsHotV2(st) {
    const c = asksCfgV2();
    if (!c.enabled || c.slimWhenHot === false) return false;
    const now = Date.now();
    const recent = (Array.isArray(st?.wakeTimes) ? st.wakeTimes : []).filter((t) => now - Number(t) <= c.hotWindowMs);
    return recent.length >= c.hotMinWakes;
  }

  /**
   * 这一轮要不要用瘦提示词：补答回合一定要瘦；群聊默认一律瘦；私聊永远给全（关系/记忆不能省）。
   * [省token] 2026-10-15：群聊默认常开瘦提示词（slimAlways，config 可关）。实测群聊提示词
   * ≈5000 字/轮，瘦身版 ≈2400 字，且这条提示词每轮都是**全价未命中**（新 user 消息 = 前缀尾部），
   * 所以「每轮少 2600 字」比「偶尔少」值钱得多。要退回老行为：socialV2.concurrency.slimAlways=false。
   */
  function shouldSlimWakeV2(key, st, reason) {
    // [patch 每轮新会话] 瘦提示词的前提是「上一轮的历史还挂在这个会话里」——它会砍掉
    // 回顾（上次聊到哪）/关系/参与感/习惯这些段落。每轮都换新会话时，砍掉它们等于当场失忆，
    // 所以两者互斥：开着 freshSessionPerTurn 就一律发完整版。
    // （第二槽位在 spawnAuxWakeV2 里直接传 slim:true，不走这里，仍按补答的瘦身版走。）
    if (cfg.socialV2?.context?.freshSessionPerTurn === true) return false;
    if (reason === 'asks') return true;
    if (!String(key).startsWith('group:')) return false;
    const c = asksCfgV2();
    if (c.slimAlways === true) return true;
    return wakeIsHotV2(st);
  }

  /**
   * 主会话正忙、群里又还有没接住的点名 —— 用第二槽位（另一个 DSH 会话）跑一次「补答回合」。
   * 只在真的有 2 个人以上在等（或有人等太久）时才开，避免平时把成本翻倍；
   * 提示词走瘦身版（只带人设 + 规则 + 台账 + 状态），比主回合省一半以上。
   */
  async function spawnAuxWakeV2(key, opts = {}) {
    try {
      const urgent = opts.urgent === true; // [并发补齐] 主会话忙时的直接点名：立刻开槽，不等攒单/等老化
      const c = concurrencyCfgV2();
      if (!c.enabled) return false;
      if (!String(key).startsWith('group:')) return false;
      if (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false) return false;
      if (isConversationUnreachableV2(key)) return false;
      if (peakQuietAppliesV2(key)) return false; // 高峰绝对静默：补答回合也不能破例
      const st = getSocialV2State(key);
      if (!st) return false;
      if (sleepStateV2(key, st).asleep) return false; // 睡着时不开回合；她醒了自然看得到台账
      const now = Date.now();
      if (now - (auxWakeAtV2.get(key) || 0) < (urgent ? 8000 : 15000)) return false; // 派发去重（紧急路径放宽到 8s）
      const auxId = state.auxSessions?.[key];
      const auxBusy = !!(auxId && (v2TurnStartAt.has(auxId) || collectors.has(auxId)));
      const stats = askStats(st.asks, { now, cfg: c });
      if (!shouldSpawnAux({ stats, auxBusy, cfg: c, urgent })) return false;
      const auxSessionId = await ensureAuxSessionV2(key);
      if (!auxSessionId) return false;
      const ids = claimAsksV2(key, getSocialV2State(key), auxSessionId, 'b');
      if (!ids.length) return false;
      auxWakeAtV2.set(key, Date.now());
      let text = buildWakePromptV2(key, 'asks', { slim: true, askSlot: 'b' });
      const snap = buildWakeSnapshotV2(key);
      if (snap) text += wakeSnapshotSuffixV2(snap);
      const accepted = await api.sessions.prompt({
        sessionId: auxSessionId, mode: 'queue',
        content: [{ type: 'text', text: withSlangContext(text) }],
      });
      if (!accepted.result.ok) {
        const err = accepted.result.error.code + ': ' + accepted.result.error.message;
        log('[并发] 第二槽位投递被拒 ' + key + '：' + err);
        settleAsksV2(key, getSocialV2State(key), auxSessionId, false);
        return false;
      }
      // 立刻占位：turn/start 事件还没回来，先挡住重复派发（turn/end 会清掉）。
      v2TurnStartAt.set(auxSessionId, Date.now());
      const stAux = getSocialV2State(key);
      if (stAux) {
        stAux.wakeTimes.push(Date.now());
        if (stAux.wakeTimes.length > 200) stAux.wakeTimes = stAux.wakeTimes.slice(-200);
        saveSocialV2State();
      }
      appendActivity('[并发] ' + key + ' 第二槽位接住 ' + ids.length + ' 条点名');
      log('[并发] 第二槽位开跑 ' + key + '（接住 ' + ids.length + ' 条，等的人 ' + stats.unclaimed + '）');
      return true;
    } catch (error) {
      log('[并发] 第二槽位派发失败 ' + key + '：' + (error?.message ?? error));
      return false;
    }
  }

  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    noteActiveChatKey(key);
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? '主人' : '',   // [记忆] 别把内部标签当人名喂模型：实测她照抄成 facts 的 subject，永远匹配不到主人
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    const mdbIn = memoryDb();
    if (mdbIn) mdbIn.recordMessage(key, msg);
    saveSocialV2State();
    return msg; // [并发] 调用方要用 seq/时间记点名台账
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    noteActiveChatKey(key);
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? '主人' : '',   // [记忆] 别把内部标签当人名喂模型：实测她照抄成 facts 的 subject，永远匹配不到主人
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    const mdbSent = memoryDb();
    if (mdbSent) mdbSent.recordSelfMessages(key, list);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    // [patch 冷场试探] AI 实际发言 = 活跃窗口起点：窗口刚过且没人说话时按概率试探（群聊）。
    scheduleIdleProbeV2(key);
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (isConversationUnreachableV2(key)) return '';
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    // [patch 省token/无关唤醒] grace 窗口只兜「有人在叫她」：@ / 引用 / 叫名字 / 提问。
    // 旧行为是「grace 窗口内任何消息都唤醒」——群里聊别人的事也叫她整段思考一遍，
    // 一轮就是几十 K token（用户实测：跟自己无关的也会思考）。没命中就落到常规触发判断。
    if (inSleepGraceV2(st)) {
      const atSelfG = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      const textG = String(textContent ?? '').toLowerCase();
      const nickG = String(selfNickname ?? '').toLowerCase();
      const nameG = !!tr.nameMention && !!nickG && (textG.includes('@' + nickG) || textG.includes(nickG));
      if (atSelfG || quoteTargetIsSelf || nameG || isDirectedAtAi(plainContent)) return 'graceWake';
    }
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      const lower = String(textContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: st.unread.length > 0 };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  /** 【本次消息快照】段：主回合与第二槽位补答回合共用同一份文案，避免两处漂移。 */
  function wakeSnapshotSuffixV2(snapshot) {
    return '\n\n【本次消息快照】\n' + JSON.stringify(snapshot)
      + '\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_set_wake_config 的 throughSeq；新到消息留待处理。';
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    // [延迟 2026-10-18] 首答前的静默**封顶**：主人要的是 10 秒内回话，而这里原先会给出
    // 12 秒（对方像没说完 / 15 秒内连发 3 条以上），模型照着调 qq_wait_for_messages(quietMs=12000)
    // 就整整等到 12 秒才开口 —— 日志里 14:36:59→14:37:09 那段 10 秒空档就是它。
    // 现在默认封顶 2.5 秒（socialV2.wait.replyQuietCapMs 可调）：够让一句连发的话落地，
    // 又不会把「像人」演成「慢半拍」。
    const capRaw = Number(cfg.socialV2?.wait?.replyQuietCapMs);
    const capMs = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : 2500;
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.min(capMs, Math.round(suggestQuietMsV2(st)) || 0)));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 本轮「发几条」随机建议：真人不会每轮条数一样，权重偏 1 条。
  // 背景：她以前几乎每轮固定发两条，用户反馈「不像活人」。
  function pickSendCountHintV2() {
    const r = Math.random();
    // [情绪] 心情影响这轮「愿意说几句」：累/困/难过/烦的时候一句话说完就想歇，
    // 兴奋时更容易连发。系数来自 MOOD_PACE（socialV2.mood.affectsPacing === false 时恒为 1）。
    const f = moodPaceV2().count;
    if (f < 0.8) return '这轮 1 条、短一点就够（单条照旧 ≤60 字），别硬撑着多说';
    if (f < 1) return r < 0.75 ? '这轮 1~2 条，每条 20~60 字为主' : '这轮最多 2 条，别铺开';
    if (f > 1.05) return r < 0.45 ? '这轮 2~3 条短句：想到一句发一句' : '这轮 3~4 条也行，可以只发半句，剩下的下一条补';
    if (r < 0.55) return '这轮 1~2 条，每条 20~60 字为主';
    if (r < 0.85) return '这轮 2~3 条短句：想到一句发一句，别把一句话写成一段';
    return '这轮 3~4 条也行，可以只发半句，剩下的下一条补';
  }

  // ── [patch 记忆回放/冻结摘要] 「上次聊到哪」──────────────────────────────
  // 为什么：会话到阈值会轮换（旧阈值 150K，见 rotateAtContextTokens），轮换＝新会话，
  // 除了 ≤800 字摘要什么都不记得——用户反馈的「聊天一多就记不住前面」就是这里丢的。
  // 所以从 recentMessages 压出一段"上次聊到哪"，**冻结**保存进会话状态，之后每次唤醒原样带上：
  // 字节不变 → 不搅动前缀缓存；内容够长 → 跨轮换不丢上下文；只在够旧/够多时才重生成一次。
  function buildRecapV2(key, st) {
    const rec = st?.recap && typeof st.recap === 'object' ? st.recap : null;
    const now = Date.now();
    const maxChars = Math.max(400, Number(cfg.socialV2?.context?.recapMaxChars) || 1600);
    // [patch 每轮新会话] 轮次不再共享上下文后，这段「上次聊到哪」就是跨轮唯一的连续记忆：
    // 冷群里 6 小时不更新 ≈ 失忆。所以开着 freshSessionPerTurn 时把阈值收紧
    // （纯本地从 recentMessages 拼，零 LLM 调用、零 token 成本，只是多算几次）。
    const perTurnCtx = cfg.socialV2?.context?.freshSessionPerTurn === true;
    const minNew = Math.max(0, Number(cfg.socialV2?.context?.recapMinNewMessages) || (perTurnCtx ? 4 : 20));
    const maxAgeMs = Math.max(0, Number(cfg.socialV2?.context?.recapMaxAgeMs) || (perTurnCtx ? 15 * 60 * 1000 : 6 * 3600 * 1000));
    const curSeq = Number(st?.lastUnreadSeq) || 0;
    const stillFresh = rec && rec.text
      && (curSeq - (Number(rec.uptoSeq) || 0)) < minNew
      && (now - (Number(rec.at) || 0)) < maxAgeMs;
    if (stillFresh) {
      // 旧版本（裸 slice）可能已经把一个孤代理项冻进 state：读的时候就地洗净并回写，
      // 免得它每次唤醒都被注进提示词、把新会话也一起 400 掉。
      const clean = stripLoneSurrogates(rec.text);
      if (clean !== rec.text) {
        rec.text = clean;
        saveSocialV2State();
        log(`[记忆回放] ${key} 缓存的摘要含孤立代理项，已就地洗净（${rec.text.length} 字）`);
      }
      return clean;
    }
    const list = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const lines = [];
    for (const m of list.slice(-40)) {
      if (!m) continue;
      const text = String(m.plain || m.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const who = m.isSelf ? '我' : String(m.sender || '对方');
      lines.push(`${who}: ${text.length > 36 ? truncateText(text, 36) + '…' : text}`);
    }
    if (!lines.length) return rec?.text || '';
    let text = `【上次聊到哪（跨会话回放）】\n${lines.join('\n')}`;
    if (text.length > maxChars) text = truncateText(text, maxChars) + '…';
    // [patch 代理对] 冻结进状态的这段文本会跨会话、跨重启被反复注入：一旦含孤立代理项，
    // 每个新会话第一次投递就 400（自愈换会话也治不好）。生成时先洗干净。
    text = stripLoneSurrogates(text);
    st.recap = { text, at: now, uptoSeq: curSeq };
    saveSocialV2State();
    log(`[记忆回放] ${key} 重新生成（${lines.length} 条，${text.length} 字，冻结到 seq${curSeq}）`);
    return text;
  }

  // ── [patch 历史回想] 借 AstrBot 知识库的"稀疏检索"那一半，用 SQLite 实现 ──────────
  // AstrBot 的 kb 检索 = 稀疏(BM25) + 稠密(FAISS) + rank fusion + 可选 rerank。
  // 后两者要么加依赖（faiss/embedding），要么直接调模型烧 token（rerank），所以这里**只搬稀疏那一半**：
  // 拿当前来信里的关键词去她的 messages 表里 LIKE 一下，命中 1~2 条旧对话就注入一小段（默认 ≤300 字）。
  // 本地查询、零 LLM 调用、毫秒级；找不到就什么都不注入。
  const RECALL_STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '和', '就', '不', '也', '都', '这', '那', '什么', '怎么', '可以', '一个', '我们', '你们', '吗', '呢', '啊', '吧', '呀', '哦', '嗯', '哈', '嘛', '啦', '诶']);
  function recallKeywordsV2(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return [];
    const out = [];
    const push = (w) => { if (w && w.length >= 2 && !RECALL_STOP.has(w) && out.indexOf(w) < 0) out.push(w); };
    // 英文/数字词
    for (const w of s.match(/[A-Za-z0-9_]{2,}/g) || []) push(w.toLowerCase());
    // 中文 2 字滑窗（对 LIKE 检索足够，且不会引入分词依赖）
    const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
    for (const seg of cjk.split(' ')) {
      for (let i = 0; i + 2 <= seg.length && out.length < 6; i++) push(seg.slice(i, i + 2));
    }
    if (out.length < 2 && s.length >= 2 && s.length <= 8) push(s);
    return out.slice(0, 6);
  }

  function historyRecallV2(key, st, queryText) {
    if (cfg.socialV2?.memoryDb?.recallEnabled === false) return '';
    const mdbR = memoryDbEnabled() ? memoryDb() : null;
    if (!mdbR || typeof mdbR.search !== 'function') return '';
    const maxChars = Math.max(80, Number(cfg.socialV2?.memoryDb?.recallMaxChars) || 300);
    const keywords = recallKeywordsV2(queryText);
    if (!keywords.length) return '';
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const seen = new Set(recent.filter((m) => m && !m.isSelf).map((m) => String(m.plain || m.text || '').slice(0, 30)));
    let hits = [];
    for (const kw of keywords) {
      try {
        const r = mdbR.search({ key, q: kw, limit: 4 });
        if (Array.isArray(r) && r.length) { hits = r; break; }
      } catch { /* 单次检索失败不影响唤醒 */ }
    }
    const picked = hits.filter((h) => h && h.text && !seen.has(String(h.text).slice(0, 30))).slice(0, 2);
    if (!picked.length) return '';
    const lines = picked.map((h) => {
      const who = h.is_self ? '我' : String(h.sender || '对方');
      const t = String(h.text).replace(/\s+/g, ' ').trim();
      return `${who}: ${t.length > 40 ? truncateText(t, 40) + '…' : t}`;
    });
    log(`[历史回想] ${key} 命中 ${picked.length} 条（关键词 ${keywords.slice(0, 2).join('/')}）`);
    let text = `【你想起以前说过】\n${lines.join('\n')}`;
    if (text.length > maxChars) text = truncateText(text, maxChars) + '…';
    return text;
  }

  // [拆分 2026-10-18] 已移到 src/wake-prompt.js（462 行）。
  // deps 延迟求值：里面不少 const 声明在本段之后（TDZ）。
  const wakePromptDeps = () => ({
    MEME_MOOD_DICT,
    ROLES_DIR,
    accountEnabled,
    anniversaryLineV2,
    askTurnFooter,
    asksCfgV2,
    buildBroadcastTaskV2,
    buildDiaryTaskV2,
    buildGroupRecapTaskV2,
    buildRecapV2,
    buildStickerContext,
    cfg,
    coldShoulderLineV2,
    currentRoleHintV2,
    detectMoodsFromText,
    diaryClockV2,
    diaryKeyV2,
    diaryPromptLineV2,
    diaryTargetDayV2,
    festivalOf,
    formatAskBlock,
    formatGrumpLineV2,
    formatMemoryV2,
    formatParticipationV2,
    followUpLineV2,
    getSocialV2State,
    groupRecapTargetDayV2,
    grumpSignalsV2,
    historyRecallV2,
    log,
    looksLikeUnfinished,
    longMemoryRecallV2,
    longMemorySelfCheckV2,
    memoryDb,
    memoryDbEnabled,
    moodBoardLineV2,
    moodLineV2,
    moodMemoryLineV2,
    openAsksV2,
    pending,
    get pendingBroadcastV2() { return pendingBroadcastV2; }, set pendingBroadcastV2(v) { pendingBroadcastV2 = v; },
    readRoleState,
    relationLineV2,
    replyTimingV2,
    resolveGrumpCfg,
    reverse,
    sanitizeRoleName,
    get selfNickname() { return selfNickname; }, set selfNickname(v) { selfNickname = v; },
    get selfQqId() { return selfQqId; }, set selfQqId(v) { selfQqId = v; },
    selfStyleLineV2,
    socialV2,
    get stickerEntries() { return stickerEntries; }, set stickerEntries(v) { stickerEntries = v; },
    text,
    truncateText,
    usageLineV2,
  });
  let wakePromptApi = null;
  const wakePrompt = () => (wakePromptApi ??= createWakePrompt(wakePromptDeps()));
  const buildWakePromptV2 = (...args) => wakePrompt().buildWakePromptV2(...args);
  const buildWakeReminderPromptV2 = (...args) => wakePrompt().buildWakeReminderPromptV2(...args);
  // ── [patch 呆住修复] 限流不再静默丢唤醒 + 私聊未读看门狗 ──────────────────────
  // 为什么：用户报「聊天过程中有时候会呆住，不会回信息」。日志里坐实了两条路径：
  //   1) 唤醒被每分钟/每小时成本闸门直接丢弃（旧代码 return 后没有任何补偿）——
  //      23:30:21 私聊唤醒被丢，下一次私聊唤醒是 23:42:51，中间 12 分钟她一个字没回；
  //   2) 私聊是**无条件唤醒**的（evaluateWakeTriggerV2 里 kind === 'private' 直接返回），
  //      所以私聊里出现「未读比她最后一条消息还新」只可能是链路吃掉了唤醒。
  // 于是：限流改成延后重试（deferWakeV2），私聊再加一道 90 秒兜底看门狗。
  // 延后上限刻意压在 5 分钟：超过这个尺度，「晚回」和「不回」对聊天来说已经一样了
  // （实测群聊撞到每小时 12 次的封顶时最早时段在 1001s 外，那种迟到回复没有意义还烧钱）。
  // 超过上限就放弃这一次，让上层（回复检查 / 呆住看门狗 / 新消息）另找机会。
  const MAX_DEFER_MS = 300000;
  // [patch 饱和不丢唤醒] 超出延后上限时的兜底补看间隔。以前这里直接「放弃本次唤醒」，
  // 于是那段消息她**永远不知道**（用户报的「有时候她不会回信息」；2026-10-11 21:55–22:00
  // group:429626254 连丢 7 次，最早可用时段在 34~38 分钟后）。现在改成再晚也排一次
  // 合并补看 —— 同一个会话只保留一个定时器（见 deferWakeV2），所以饱和时最多每 15 分钟
  // 补看一次（≤4 次/小时，成本可控），而「有人跟你说话你却根本没被叫醒」这条彻底消失。
  const MAX_CATCHUP_MS = Math.max(MAX_DEFER_MS, Number(cfg.socialV2?.wake?.catchupMs) || 900000);
  // [patch @必有回应] 哪些唤醒原因**不吃**成本闸门：被点名、被直接搭话的必须必达。
  // 依据：日志里坐实过这条丢法——「唤醒频率超限，最早可用时段在 6 分钟后（超过延后上限
  // 5 分钟），放弃本次唤醒（atMention）」。她可以自己决定不接话（那是自主权），
  // 但「被叫了却根本不知道」是链路 bug；群里每小时 30 次的封顶在活跃群很容易撞上。
  // 2026-10-11 扩表（用户二次报「有时候她不会回信息」）：主人私聊（private）、被拍（poke）、
  // 叫名字（nameMention）、命中关键词（keyword，reasonBase 取冒号前段）、我的控制台唤醒
  // （admin）、被提问（question）都算「有人在跟她说话」，不许被成本闸门饿死。
  // 绝对天花板仍是 maxWakePerHourAtMention（默认 max(60, 每小时上限)）：真被刷屏时
  // 退回正常限流，成本不会失控。
  const WAKE_CAP_EXEMPT_REASONS = new Set(['atMention', 'private', 'poke', 'nameMention', 'keyword', 'admin', 'question']);
  // 豁免通道也只留最小间隔，防止一条消息带多个 @ 时连打多次。
  const AT_MENTION_MIN_GAP_MS = 3000;

  /** 算出"最早允许真正发送"的时刻：把限流窗口里需要腾出的次数等过去。 */

  function earliestWakeSlotV2(st, now, opts) {
    const times = (st.wakeTimes || [])
      .map((t) => Number(t) || 0)
      .filter((t) => t > 0 && now - t < 3600000)
      .sort((a, b) => a - b);
    let earliest = now + 1500;
    if (opts.grace && times.length) {
      // graceWake 额外要求距上次真实唤醒 ≥20 秒，见限流处说明。
      earliest = Math.max(earliest, times[times.length - 1] + 20000 + 500);
    }
    if (opts.maxPerMinute > 0) {
      const inMinute = times.filter((t) => now - t < 60000);
      if (inMinute.length >= opts.maxPerMinute) {
        const need = inMinute.length - opts.maxPerMinute;
        earliest = Math.max(earliest, inMinute[need] + 60000 + 500);
      }
    }
    if (opts.maxPerHour > 0) {
      const inHour = times.filter((t) => now - t < 3600000);
      if (inHour.length >= opts.maxPerHour) {
        const need = inHour.length - opts.maxPerHour;
        earliest = Math.max(earliest, inHour[need] + 3600000 + 500);
      }
    }
    return earliest;
  }

  function cancelDeferredWakeV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.deferredWakeTimer) return;
    clearTimeout(st.deferredWakeTimer);
    st.deferredWakeTimer = null;
    st.deferredWakeReason = null;
    st.deferredWakeAt = 0;
  }

  /**
   * 被限流时的延后唤醒。
   *
   * 关键点：**同一个会话只保留一个定时器**，多个被限流的唤醒按优先级合并成一次，
   * 否则一条消息洪峰会攒出几十个定时器、到点又互相挤压，反而更糟。
   */
  function deferWakeV2(key, reason, st, opts) {
    const now = opts.now ?? Date.now();
    const earliest = earliestWakeSlotV2(st, now, opts);
    const overLimit = earliest - now > MAX_DEFER_MS;
    // [patch 饱和不丢唤醒] 超上限不再放弃，退化成「兜底补看」：最迟 MAX_CATCHUP_MS 后
    // 一定看一次。配额是给**频率**设的，不该变成「这条消息永远没人管」。
    const delay = overLimit
      ? MAX_CATCHUP_MS
      : Math.max(1500, Math.min(MAX_DEFER_MS, earliest - now));
    if (overLimit) {
      log(`[reserved2] 唤醒频率超限，最早可用时段在 ${Math.round((earliest - now) / 60000)} 分钟后（超过延后上限 ${Math.round(MAX_DEFER_MS / 60000)} 分钟），改为 ${Math.round(MAX_CATCHUP_MS / 60000)} 分钟后兜底补看一次 ${key}（${reason}）`);
    }
    const fireAt = now + delay;
    if (st.deferredWakeTimer) {
      const cur = st.deferredWakeReason || 'replyCheck';
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) st.deferredWakeReason = reason;
      if (Number(st.deferredWakeAt) > 0 && Number(st.deferredWakeAt) <= fireAt) {
        // 已经在更早的时刻等了，不用重排，只把原因升级进去。
        log(`[reserved2] 唤醒频率超限，并入已在排队的延后唤醒 ${key}（${reason}）`);
        return;
      }
      clearTimeout(st.deferredWakeTimer);
      st.deferredWakeTimer = null;
    } else {
      st.deferredWakeReason = reason;
    }
    st.deferredWakeAt = fireAt;
    st.deferredWakeTimer = setTimeout(() => {
      st.deferredWakeTimer = null;
      st.deferredWakeAt = 0;
      const finalReason = st.deferredWakeReason || reason;
      st.deferredWakeReason = null;
      scheduleWakeV2(key, finalReason);
    }, delay);
    st.deferredWakeTimer.unref?.();
    log(`[reserved2] 唤醒频率超限，改为延后 ${Math.round(delay / 1000)}s 再发 ${key}（${reason}）`);
  }

  /**
   * 私聊未读看门狗（最后一道兜底）。
   *
   * 只扫 private:*：私聊本来就是无条件唤醒，出现「未读比她最后一条自身消息还新」且
   * 没有任何在途唤醒，就说明唤醒链路（限流/重连/重启/异常）把它吃掉了。
   * 群聊故意不扫——群里她可以用唤醒配置决定不接话，那是她的自主权，不该被看门狗推翻。
   */
  const STALE_UNREAD_MS = Math.max(30000, Number(cfg.socialV2?.wake?.staleUnreadMs) || 90000);
  const STALE_WAKE_MAX = Math.max(1, Number(cfg.socialV2?.wake?.staleWakeMax) || 4);
  function staleUnreadScanV2() {
    if (cfg.socialV2?.enabled === false || socialV2.paused) return;
    if (currentMode !== 'reserved2') return;
    const now = Date.now();
    for (const [key, st] of socialV2.conversations) {
      if (!key.startsWith('private:')) continue;
      if (!isSessionAllowedInCurrentMode(key)) continue;
      const unread = Array.isArray(st.unread) ? st.unread : [];
      if (!unread.length) continue;
      const lastSelfAt = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
        .reduce((acc, m) => (m && m.isSelf ? Math.max(acc, Number(m.time) || 0) : acc), 0);
      const newest = unread.reduce((acc, m) => (m && !m.isSelf ? Math.max(acc, Number(m.time) || 0) : acc), 0);
      if (!newest || newest <= lastSelfAt) continue;
      if (now - newest < STALE_UNREAD_MS) continue;
      if (isConversationBusyV2(key, st)) continue;
      if (st.replyCheckTimer || st.pendingWakeTimer || st.deferredWakeTimer) continue;
      // 同一封未读最多兜底 STALE_WAKE_MAX 次：她已经看过/决定不回，就别无限烧钱。
      if (Number(st.staleWakeFor) === newest) {
        const n = Number(st.staleWakeCount) || 0;
        if (n >= STALE_WAKE_MAX) continue;
        st.staleWakeCount = n + 1;
      } else {
        st.staleWakeFor = newest;
        st.staleWakeCount = 1;
      }
      log(`[reserved2] 【呆住看门狗】${key} 有未读已放置 ${Math.round((now - newest) / 1000)}s 且无在途唤醒（第 ${st.staleWakeCount}/${STALE_WAKE_MAX} 次），补一次唤醒`);
      scheduleWakeV2(key, 'private');
    }
  }

  function startStaleUnreadWatch() {
    setInterval(staleUnreadScanV2, 30000).unref?.();
  }

  // ── [patch 入站补拉] 消息不能靠"事件一定会到"来保证 ──────────────────────────
  // 为什么：2026-10-07 00:08:18 主人在私聊发的「讲一下咒术回战呗」在 QQ 侧确实存在
  // （get_friend_msg_history 查得到），却从未进入桥接：既没有「消息已入未读」也没有唤醒，
  // 用户看到的就是"她不回信息"。WS 事件会丢（进程异常、socket 边界、SnowLuma 侧丢弃），
  // 所以按 QQ 侧历史做兜底补拉，而不是只在断线重连时补。
  const CATCHUP_INTERVAL_MS = Math.max(20000, Number(cfg.socialV2?.wake?.catchUpIntervalMs) || 45000);
  const CATCHUP_MIN_GAP_MS = Math.max(20000, Number(cfg.socialV2?.wake?.catchUpMinGapMs) || 60000);
  const catchUpLastAt = new Map();
  let selfUinCache = '';

  async function selfUinV2() {
    if (selfUinCache) return selfUinCache;
    try {
      const data = await oneBotCall('get_login_info', {});
      if (data && data.user_id) selfUinCache = String(data.user_id);
    } catch {
      // 拿不到就退化成"只按 message_id 去重"，不影响补拉本身
    }
    return selfUinCache;
  }

  /** OneBot 历史消息 → 纯文本（补拉只用文本，媒体/引用不进未读）。 */
  function historyMessageTextV2(m) {
    const segs = Array.isArray(m?.message) ? m.message : [];
    const parts = [];
    for (const seg of segs) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'text') {
        const raw = seg.data && typeof seg.data === 'object' ? (seg.data.text ?? Object.values(seg.data)[0]) : seg.data;
        if (raw) parts.push(String(raw));
      } else if (seg.type === 'at') {
        const qq = seg.data?.qq ?? seg.data?.user_id;
        parts.push(qq ? `@${qq}` : '@某人');
      } else if (seg.type === 'image') {
        parts.push('[图片]');
      } else if (seg.type === 'face') {
        parts.push('[表情]');
      }
    }
    const text = parts.join(' ').trim();
    if (text) return text;
    return String(m?.raw_message ?? '').trim();
  }

  /**
   * 从 QQ 历史里把"没进过桥接"的消息补进未读，并按她的唤醒配置决定要不要叫醒她。
   * 幂等：message_id 去重 + 时间水位（只取比 st.lastIncomingAt 更新的消息）。
   */
  async function catchUpMissedV2(key, opts = {}) {
    if (cfg.socialV2?.enabled === false || socialV2.paused) return 0;
    if (currentMode !== 'reserved2') return 0;
    if (!isSessionAllowedInCurrentMode(key)) return 0;
    const st = socialV2.conversations.get(key);
    if (!st) return 0;
    const now = Date.now();
    const last = catchUpLastAt.get(key) || 0;
    if (!opts.force && now - last < CATCHUP_MIN_GAP_MS) return 0;
    catchUpLastAt.set(key, now);
    const sep = String(key).indexOf(':');
    if (sep < 0) return 0;
    const kind = key.slice(0, sep);
    const id = key.slice(sep + 1);
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) return 0;
    const sinceMs = Number(st.lastIncomingAt) || 0;
    // 没有水位说明这个会话还没见过任何入站消息，不去翻历史（否则新会话会被旧消息淹没）。
    if (sinceMs <= 0) return 0;
    // ── [patch 补拉时限] 过期消息不重放（主人 m01940）──────────────────────────
    // 为什么：水位 lastIncomingAt 记的是**本地到达时间**（appendSocialV2Message 里的
    // Date.now()），而历史里的 m.time 是 **QQ 服务器时间**，两者只是一个近似的先后
    // 关系。一旦水位因为别的原因严重滞后（最典型的是桥接启动时 DSH 不可达、currentMode
    // 停在 'chat' 走了一代路径，见启动处 [patch 启动先用本地模式]），下面那道
    // `tMs <= sinceMs + 1000` 的闸就等于形同虚设，会把 6 小时甚至 15 小时前的旧消息当成
    // "从未入站"重新补回并叫醒她 —— 主人看到的就是「回去重新处理已经处理好的聊天记录」。
    // 补拉本来只为兜住一次 WebSocket 断连（每 45s 核对、同会话最小间隔 60s），所以早于
    // socialV2.wake.catchUpMaxAgeMs（默认 15 分钟）的消息一律丢弃，只留一行日志；
    // 配 0 表示不限（回到旧行为，只在明确知道自己在做什么时才这么配）。
    const maxAgeMs = Math.max(0, Number(cfg.socialV2?.wake?.catchUpMaxAgeMs ?? 15 * 60_000) || 0);
    const floorMs = maxAgeMs > 0 ? Math.max(sinceMs, now - maxAgeMs) : sinceMs;
    const action = kind === 'private' ? 'get_friend_msg_history' : 'get_group_msg_history';
    const params = kind === 'private' ? { user_id: numeric, count: 20 } : { group_id: numeric, count: 40 };
    let data = null;
    try {
      data = await oneBotCall(action, params);
    } catch (error) {
      log(`[补拉] ${key} 拉历史失败：${error?.message ?? error}`);
      return 0;
    }
    const list = Array.isArray(data?.messages) ? data.messages : [];
    if (!list.length) return 0;
    const uin = await selfUinV2();
    const known = new Set();
    for (const m of [...(Array.isArray(st.recentMessages) ? st.recentMessages : []), ...(Array.isArray(st.unread) ? st.unread : [])]) {
      if (m && m.messageId != null) known.add(String(m.messageId));
    }
    const missed = [];
    let skippedOld = 0;
    for (const m of list) {
      const senderId = String(m?.sender?.user_id ?? m?.user_id ?? '');
      if (!senderId) continue;
      if (uin && senderId === uin) continue;
      const mid = m?.message_id != null ? String(m.message_id) : '';
      if (mid && known.has(mid)) continue;
      const tMs = Number(m?.time) * 1000;
      if (!Number.isFinite(tMs) || tMs <= 0) continue;
      if (tMs <= floorMs + 1000) { if (tMs > sinceMs + 1000) skippedOld += 1; continue; }
      const text = historyMessageTextV2(m);
      if (!text) continue;
      missed.push({ m, senderId, tMs, text });
    }
    if (skippedOld > 0) {
      log(`[补拉] ${key} 忽略 ${skippedOld} 条过期未入站消息（早于 ${new Date(floorMs).toLocaleString('zh-CN', { hour12: false })}，超过 ${Math.round(maxAgeMs / 60000)} 分钟不再重放）`);
    }
    if (!missed.length) return 0;
    missed.sort((a, b) => a.tMs - b.tMs);
    const newest = missed[missed.length - 1];
    log(`[补拉] ${key} 从 QQ 历史补回 ${missed.length} 条未入站消息（最新 ${new Date(newest.tMs).toLocaleString('zh-CN', { hour12: false })}：${newest.text.slice(0, 40)}）`);
    for (const item of missed) {
      const sender = item.m?.sender?.card || item.m?.sender?.nickname || item.senderId;
      const isOwner = String(item.senderId) === String(cfg.ownerQQ ?? '');
      appendSocialV2Message(key, sender, item.text, item.text, false, isOwner, item.m?.message_id, [], item.senderId, []);
    }
    appendActivity(`${key} [补拉] 从 QQ 历史补回 ${missed.length} 条漏掉的消息`);
    const st2 = getSocialV2State(key);
    if (isConversationBusyV2(key, st2)) {
      if (!Array.isArray(st2.pendingWakeReasons)) st2.pendingWakeReasons = [];
      st2.pendingWakeReasons.push({ reason: 'backfill', seq: st2.lastUnreadSeq || 0 });
      log(`[补拉] ${key} 补进未读（会话正忙，唤醒原因已排队）`);
      return missed.length;
    }
    let reason = '';
    try {
      const event = Object.assign({}, newest.m, uin ? { self_id: uin } : {});
      reason = evaluateWakeTriggerV2(key, st2, event, kind, newest.text, newest.text, false);
    } catch (error) {
      log(`[补拉] ${key} 唤醒判定失败：${error?.message ?? error}`);
    }
    if (reason) {
      log(`[补拉] ${key} 补拉触发唤醒（${reason}）`);
      scheduleWakeV2(key, `backfill:${reason}`);
    } else {
      log(`[补拉] ${key} 已补进未读但未命中她的唤醒条件，不打扰`);
    }
    return missed.length;
  }

  function startCatchUpWatch() {
    if (cfg.socialV2?.enabled === false) return;
    const tick = () => {
      for (const key of socialV2.conversations.keys()) {
        void catchUpMissedV2(key).catch((error) => log(`[补拉] ${key} 异常：${error?.message ?? error}`));
      }
    };
    setInterval(tick, CATCHUP_INTERVAL_MS).unref?.();
    log(`[补拉] 入站补拉看门狗已启动（每 ${Math.round(CATCHUP_INTERVAL_MS / 1000)}s 核对一次 QQ 历史）`);
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    // [超长记忆] 懒触发每日固化：meta 判重，每天真正只跑一次，其余唤醒只是一条 SELECT。
    try { consolidateLongMemoryDaily(); } catch { /* 固化失败不影响唤醒 */ }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    // [patch 静默零消耗] 静默 = 只回主人私聊。以前静默只拦「发送」，唤醒照跑整轮（含补拉/宽限/
    // 主动检查），群里每条消息都能让她整段思考一遍——既不符合静默语义，也纯烧 token。
    // 放在这个唯一入口上，所有唤醒来源（补拉、宽限、问句、看门狗）一并挡住。
    if (readRoleState().mode === 'silent' && key !== 'private:' + String(cfg.ownerQQ ?? '')) {
      log(`[reserved2] 静默模式，跳过唤醒 ${key}（${reason}）：不开回合、不消耗 token`);
      return;
    }
    // [patch 高峰静默] DeepSeek 高峰时段（北京时间工作日 9–12 / 14–18）群里不烧 token。
    // 这里是真的开回合的唯一入口（主动机会检查、睡眠到期、补发、看门狗都走它），所以闸门放这。
    // [patch 高峰绝对静默] 用户 m03167：「信息队列不做，禁止（要求绝对的静默）」⇒ 高峰期间被
    // 放弃的唤醒**不排队、不补做**：默认不再 schedulePeakResumeV2（窗口结束后攒一批未读再叫醒
    // 她 = 消息队列，被明确禁止，而且那一次补唤醒就是一轮全上下文的大额 token）。
    // 消息照旧进未读（本地内存/磁盘，零 token），她下次被**自然**唤醒时能看到这些上下文，
    // 但不会因为「高峰期间攒了未读」而被桥接主动叫起来。
    // 需要恢复旧行为（窗口末补看一次未读）：config.json 的 socialV2.peakQuiet.resumeAfter = true。
    const peakWin = peakQuietAppliesV2(key);
    if (peakWin) {
      log(`[reserved2] 高峰绝对静默（${peakWin.from}-${peakWin.to}），放弃唤醒 ${key}（${reason}）`);
      if (peakQuietCfgV2().resumeAfter === true) {
        const stPeak = getSocialV2State(key);
        const hasUnread = Array.isArray(stPeak?.unread) && stPeak.unread.length > 0;
        if (hasUnread) schedulePeakResumeV2(key, peakWin);
      }
      return;
    }
    const st = getSocialV2State(key);
    // [patch 睡眠] 睡着时不开回合：被 @（群里）或私聊由桥接自动回一句「（zzz…）」，
    // 其余触发一律静默——消息照旧进未读，等她醒了/明早一起看，token 一分不花。
    // 「醒醒/起床」口令与主人手动叫醒在入站那一步就设好了 sleepAwakeUntil，不会落到这里。
    // 唯一的例外是有限睡眠到期（timeout）：那是她自己设的闹钟，照常叫醒她。
    const sleepNow = sleepStateV2(key, st);
    if (sleepNow.asleep && !(String(reason ?? '').split(':')[0] === 'timeout' && sleepCfgV2().allowTimeoutWake !== false)) {
      const base = String(reason ?? '').split(':')[0];
      const rawReplyOn = sleepCfgV2().replyOn;
      const replyOn = (Array.isArray(rawReplyOn) && rawReplyOn.length ? rawReplyOn : SLEEP_DEFAULT_REPLY_ON_V2).map((r) => String(r));
      const why = sleepNow.manual ? '手动睡' : sleepNow.nap ? '有限睡眠中' : `深夜 ${sleepNow.window?.from ?? ''}-${sleepNow.window?.to ?? ''}`;
      const willReply = replyOn.includes(base) || replyOn.includes('all');
      let replied = false;
      if (willReply) {
        try {
          replied = await sendSleepZzzV2(key, st, reason);
        } catch (error) {
          log(`[睡眠] ${key} 自动回复异常：${error?.message ?? error}`);
        }
      }
      log(`[reserved2] 睡眠中（${why}），${key} 不开回合（${reason}）${willReply ? (replied ? '，替她回一句（zzz…）' : '，这次限流不出声') : ''}`);
      return;
    }
    if (!sleepNow.asleep && sleepNow.awake && (sleepNow.night || sleepNow.manual || sleepNow.nap)) {
      // 深夜/小睡里真的被叫起来了（口令、手动、admin）：续上清醒宽限，
      // 这样接下来这段时间她是正常聊天的，不用每条消息都重新喊「醒醒」。
      st.sleepAwakeUntil = Date.now() + sleepAwakeGraceMsV2();
      saveSocialV2State();
    }
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    // [patch 呆住修复] 私聊是一对一，主人一小时连发十几条很正常；用同一套 12 次/小时
    // 的群聊封顶会把他自己的消息饿死（第 13 条起只能等到下一个小时窗口）。
    // 所以私聊单独给一个更宽松的上限，默认 30。
    const maxPerHour = String(key).startsWith('private:')
      ? (Number(cfg.socialV2?.wake?.maxWakePerHourPrivate) || Number(cfg.socialV2?.wake?.maxWakePerHour) || 0)
      : (Number(cfg.socialV2?.wake?.maxWakePerHour) || 0);
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    // [patch 省token] 潜水宽限唤醒是「刚睡下就有人说话」的兜底，不该被每分钟 1 次的成本闸门吃掉；
    // 仍然受每小时上限约束，并额外要求距上次真实唤醒 ≥20 秒，避免被刷屏拖着连轴转。
    const lastWakeAtAny = (st.wakeTimes || []).reduce((a, b) => Math.max(a, Number(b) || 0), 0);
    const graceBypass = reason === 'graceWake' && now - lastWakeAtAny >= 20000;
    // [patch @必有回应] 被点名绕开分钟/小时闸门（名单见 WAKE_CAP_EXEMPT_REASONS 处说明）。
    // 仍有一道绝对天花板 maxWakePerHourAtMention（默认 max(60, maxWakePerHour)）：真被人拿 @
    // 刷屏时，超过它就按恶意刷量处理，退回正常限流（该延后延后、该放弃放弃），不让成本失控。
    const reasonBase = String(reason ?? '').split(':')[0];
    const maxPerHourAtMention = Number(cfg.socialV2?.wake?.maxWakePerHourAtMention) || Math.max(60, maxPerHour);
    const capExempt = WAKE_CAP_EXEMPT_REASONS.has(reasonBase)
      && recentHour < maxPerHourAtMention
      && now - lastWakeAtAny >= AT_MENTION_MIN_GAP_MS;
    if (capExempt && ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour))) {
      log(`[reserved2] 被点名必达：绕过唤醒频率闸门 ${key}（近 1 分钟 ${recentMinute}/${maxPerMinute}、近 1 小时 ${recentHour}/${maxPerHour}、点名上限 ${maxPerHourAtMention}）`);
    }
    const minuteFull = maxPerMinute > 0 && recentMinute >= maxPerMinute && !graceBypass && !capExempt;
    const hourFull = maxPerHour > 0 && recentHour >= maxPerHour && !capExempt;
    if (minuteFull || hourFull) {
      // [patch 不再静默丢唤醒] 旧行为是直接 return：被限流吃掉的那次唤醒再也没有第二次机会，
      // 表现就是「消息明明进来了她就是不回」（用户报的"呆住"）。改成合并 + 延后：
      // 算出最早能发的时刻，起一个 coalesce 定时器，到点走 scheduleWakeV2 正规入口，
      // 若届时仍超限就再延一次（最多延后 MAX_DEFER_MS），宁可晚回也不丢。
      deferWakeV2(key, reason, st, { now, maxPerMinute, maxPerHour, grace: reason === 'graceWake' });
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    cancelDeferredWakeV2(key); // 真正发出去的这一次已经接管，别再补一刀
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    // [省token] 瘦提示词判定一次、两处复用（这里 build 一次用于日志，deliverPromptNow 会重建）。
    const wakeSlim = shouldSlimWakeV2(key, st, reason);
    const promptText = buildWakePromptV2(key, reason, { slim: wakeSlim });
    log(`[reserved2] 唤醒 ${key}（${reason}）${wakeSlim ? ' [瘦提示词]' : ''}`);
    // 先让对面看到「正在输入」，再真正开始跑回合 —— 这一回合要几十秒，静默几十秒再蹦出一整段
    // 话是最不像真人的地方。best-effort：不 await，不影响后面的投递。
    showTypingV2(key);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason, slim: wakeSlim });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    // [省 token] 群聊默认不做「回复检查」回合：群里没有"在等我回话"的特定对象，
    // 每次发言后 30~60s 再开一个完整回合（60~100K 前缀）大概率什么也不用做。
    // 群聊靠真实新消息 / 被 @ / 被引用唤醒即可。要恢复旧行为把
    // socialV2.replyCheckGroups 设为 true。
    if (key.startsWith('group:') && cfg.socialV2?.replyCheckGroups !== true) return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    // [省 token] 默认从 30s 放宽到 3 分钟：30s 内几乎不可能等到回复，却要开一个
    // 完整回合（60~100K 前缀）。要更短就配 socialV2.autoReplyCheckMs。
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 180000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    // [省 token] 连发 ≥3 条时把间隔拉到 3 倍（原 1.3）：连发说明对话正在刷，
    // 这时候 30s 一次的回复检查会和真实消息叠加成唤醒风暴。
    if (recentSelf.length >= 3) delay = Math.round(delay * 3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  // [patch 卡死逃逸] 把「为什么忙」拆出来：既给 isConversationBusyV2 用，也给 #诊断 用。
  // 一个会话 2.5 小时不回消息时光看日志完全看不出是被哪个条件挡住的，这个函数就是答案。
  // 返回的是**全部**观察到的占用来源，其中 collectorStale 只表示「该清理的残留」，
  // 不表示会话真忙 —— 真正会让唤醒进不去的只有下面 HOLDING 集合里的那些。
  const V2_BUSY_PART_HOLDING = new Set(['pendingWakeTimer', 'pendingWakeKeys', 'queueRunning', 'queueBacklog', 'turnOpen', 'collectorOpen']);
  function busyPartsV2(key, st) {
    const parts = [];
    if (st && st.pendingWakeTimer) parts.push('pendingWakeTimer');
    if (pendingWakeKeys.has(key)) parts.push('pendingWakeKeys');
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) parts.push(q.running ? 'queueRunning' : 'queueBacklog');
    const sid = state.sessions[key];
    if (sid && v2TurnStartAt.has(sid)) parts.push('turnOpen');
    // collectors 只在「最近还有事件」时才算真占用：它会被任意一条非回合事件建出来，
    // 而删除只发生在 turn/end —— 丢了 turn/end 就等于永久占住。
    if (sid && collectors.has(sid)) {
      parts.push(Date.now() - (v2LastFrameAt.get(sid) || 0) < V2_BUSY_STALE_MS ? 'collectorOpen' : 'collectorStale');
    }
    return parts;
  }
  function isConversationBusyV2(key, st) {
    return busyPartsV2(key, st).some((p) => V2_BUSY_PART_HOLDING.has(p));
  }

  // ── [patch 高峰静默] DeepSeek 峰谷定价时段，群里不烧 token ────────────────────
  // 为什么：官方定价把北京时间周一~周五（不含法定节假日）9:00–12:00 与 14:00–18:00 定为
  // 高峰，价格是空闲时段的两倍；周末与节假日全天按空闲价。她「在群里说话」的唯一入口
  // 就是唤醒，所以在**真正开回合的那一处**（sendWakePromptV2）统一拦住，不必给每个
  // 触发源各改一遍。
  // 高峰里做什么：消息照常入库但不叫她；被 @ 就替她回一句不好意思（别人说话一律不理）；
  // 窗口结束后如果确实还攒着未读，补一次唤醒（只补一次，避免整段积压一次性炸开）。
  const PEAK_DEFAULT_WINDOWS_V2 = [['09:00', '12:00'], ['14:00', '18:00']];
  function peakQuietCfgV2() {
    const raw = cfg.socialV2?.peakQuiet;
    return raw && typeof raw === 'object' ? raw : {};
  }
  function hhmmToMinutesV2(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!m) return -1;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return -1;
    return h * 60 + mi;
  }
  /** 高峰判定用的本地钟（默认 Asia/Shanghai）；拿不到时区的系统上返回 null（判不了就当不是高峰）。 */
  function peakClockV2(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      const pick = (type) => parts.find((p) => p.type === type)?.value ?? '';
      return {
        date: `${pick('year')}-${pick('month')}-${pick('day')}`,
        weekday: pick('weekday'),
        minutes: Number(pick('hour')) * 60 + Number(pick('minute'))
      };
    } catch {
      return null;
    }
  }
  /** 现在是否落在高峰窗口里；命中返回 {from,to}，否则 null。 */
  function peakWindowV2() {
    const c = peakQuietCfgV2();
    if (c.enabled === false) return null;
    const clock = peakClockV2(c.timeZone);
    if (!clock) return null;
    const holidays = Array.isArray(c.holidays) ? c.holidays.map((d) => String(d)) : [];
    if (holidays.includes(clock.date)) return null;
    if (c.weekdaysOnly !== false && (clock.weekday === 'Sat' || clock.weekday === 'Sun')) return null;
    const windows = Array.isArray(c.windows) && c.windows.length ? c.windows : PEAK_DEFAULT_WINDOWS_V2;
    for (const w of windows) {
      if (!Array.isArray(w)) continue;
      const from = hhmmToMinutesV2(w[0]);
      const to = hhmmToMinutesV2(w[1]);
      if (from < 0 || to < 0) continue;
      const hit = to > from ? (clock.minutes >= from && clock.minutes < to) : (clock.minutes >= from || clock.minutes < to);
      if (hit) return { from: String(w[0]), to: String(w[1]) };
    }
    return null;
  }
  /** 这个会话此刻要不要静默：命中返回窗口对象，不静默返回 null。 */
  function peakQuietAppliesV2(key) {
    const win = peakWindowV2();
    if (!win) return null;
    const c = peakQuietCfgV2();
    const [kind, id] = String(key ?? '').split(':');
    // 默认只管群：主人私聊是运维窗口，任何时候都得能说话。
    if (kind === 'private') return c.scope === 'all' ? win : null;
    const exempt = Array.isArray(c.exemptGroups) ? c.exemptGroups.map((g) => String(g)) : [];
    if (exempt.includes(String(id))) return null;
    return win;
  }
  const peakResumeTimersV2 = new Map();
  /** 窗口结束后补看一眼未读（每会话只补一次；届时若仍在高峰就顺延到下一个窗口末）。 */
  function schedulePeakResumeV2(key, win) {
    if (peakResumeTimersV2.has(key)) return;
    const clock = peakClockV2(peakQuietCfgV2().timeZone);
    const to = hhmmToMinutesV2(win?.to);
    if (!clock || to < 0) return;
    let deltaMin = to - clock.minutes;
    if (deltaMin <= 0) deltaMin += 24 * 60;
    const delayMs = deltaMin * 60000 + 10000;
    const timer = setTimeout(() => {
      peakResumeTimersV2.delete(key);
      if (peakQuietAppliesV2(key)) {
        schedulePeakResumeV2(key, peakWindowV2());
        return;
      }
      const st = getSocialV2State(key);
      const unread = Array.isArray(st?.unread) ? st.unread : [];
      if (!unread.length) {
        log(`[reserved2] 高峰静默结束，${key} 没有未读，不补唤醒`);
        return;
      }
      log(`[reserved2] 高峰静默结束，${key} 还攒着 ${unread.length} 条未读，补一次唤醒`);
      scheduleWakeV2(key, 'peakResume');
    }, Math.max(1000, delayMs));
    timer.unref?.();
    peakResumeTimersV2.set(key, timer);
    log(`[reserved2] 高峰静默：${key} 的唤醒推迟到 ${win.to} 之后（约 ${Math.round(delayMs / 60000)} 分钟）`);
  }
  // 被 @ 时的罐头道歉：只在高峰静默期间发，按会话限流（默认 10 分钟一条，防刷屏）。
  const peakApologyAtV2 = new Map();
  async function sendPeakApologyV2(key, event) {
    const c = peakQuietCfgV2();
    if (c.apologyOn === false) return;
    const targets = Array.isArray(c.apologyOn) ? c.apologyOn.map((t) => String(t)) : ['atMention'];
    if (!targets.includes('atMention') && !targets.includes('all')) return;
    const rawGap = Number(c.apologyMinGapMs);
    const gapMs = Number.isFinite(rawGap) && rawGap >= 0 ? rawGap : 10 * 60 * 1000;
    const now = Date.now();
    if (gapMs > 0 && now - (peakApologyAtV2.get(key) || 0) < gapMs) return;
    peakApologyAtV2.set(key, now);
    const name = event?.sender?.card || event?.sender?.nickname || (event?.user_id ? String(event.user_id) : '');
    const tpl = typeof c.apology === 'string' && c.apology.trim()
      ? c.apology
      : '（{name} 不好意思，这个点我在省着算力，等过了高峰再来找你~）';
    const text = tpl.split('{name}').join(name || '你').replace(/\s+/g, ' ').trim();
    if (!text) return;
    await sendToQQ(key, text);
    appendActivity(`[高峰静默] ${key} 已替她回一句：${text.slice(0, 60)}`);
    log(`[高峰静默] ${key} 已回一句：${text.slice(0, 60)}`);
  }

  // ── [patch 睡眠] 她睡着时的自动回复 ──────────────────────────────────────
  // 需求（用户 m01578，2026-10-12 01:30）：她睡着的时候不该再被消息叫起来烧 token；
  // 群里只有被 @ 才由桥接自动回一句「（zzz…）」，给人一种她正在睡觉的感觉；私聊也一样。
  //
  // 关键：**不能把「潜水」当成「睡着」**。她的会话平时全是 diving+infinite（见
  // state/social-v2.json），那只是省 token 的常态；若把潜水当成睡着，@ 就再也叫不醒她，
  // 二次元群里的随机插话也会一起被杀掉。睡着 = 潜水 +（深夜窗口 | 手动睡 | 有限睡眠中），
  // 且不处于「刚被叫醒」的清醒宽限里。
  const SLEEP_DEFAULT_NIGHT_WINDOWS_V2 = [['23:30', '08:00']];
  // [patch 免睡眠] 后台开关的落盘文件：桥接重启后仍然记得。
  // 语义：打开 = 深夜窗口不再让她睡着；手动睡 / 有限睡眠（她自己设的闹钟）不受影响。
  const SLEEP_FORCE_AWAKE_FILE_V2 = path.join(ROOT, 'state', 'sleep-force-awake.json');
  let sleepForceAwakeV2 = false;
  try { sleepForceAwakeV2 = readJsonSafe(SLEEP_FORCE_AWAKE_FILE_V2, {})?.forceAwake === true; } catch { sleepForceAwakeV2 = false; }
  const SLEEP_DEFAULT_WAKE_WORDS_V2 = ['醒醒', '起床了', '起床', '别睡了'];
  const SLEEP_DEFAULT_TEXTS_V2 = ['（zzz…）', '（唔…zzz）', '（zzzZ）'];
  const SLEEP_DEFAULT_REPLY_ON_V2 = ['atMention', 'private'];
  function sleepCfgV2() {
    const s = cfg.socialV2?.sleep;
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }
  /** 按 [['23:30','08:00']] 这种窗口表命中一次当天分钟数；跨零点用 || 判定，结束端不含。 */
  function minutesInWindowsV2(minutes, windows) {
    for (const w of Array.isArray(windows) ? windows : []) {
      if (!Array.isArray(w) || w.length < 2) continue;
      const from = hhmmToMinutesV2(w[0]);
      const to = hhmmToMinutesV2(w[1]);
      if (from < 0 || to < 0 || from === to) continue;
      if (to > from) {
        if (minutes >= from && minutes < to) return { from: String(w[0]), to: String(w[1]) };
      } else if (minutes >= from || minutes < to) {
        return { from: String(w[0]), to: String(w[1]) };
      }
    }
    return null;
  }
  /** 当前是否落在「深夜睡觉窗口」（默认 23:30–08:00，含 08:00 之前）。 */
  function sleepNightWinV2() {
    const s = sleepCfgV2();
    if (s.enabled === false || s.nightEnabled === false) return null;
    const clock = peakClockV2(s.timeZone || 'Asia/Shanghai');
    if (!clock) return null; // 时区拿不到就 fail-open：宁可当她醒着，也别把她焊死在睡着状态
    const windows = Array.isArray(s.nightWindows) && s.nightWindows.length ? s.nightWindows : SLEEP_DEFAULT_NIGHT_WINDOWS_V2;
    return minutesInWindowsV2(clock.minutes, windows);
  }
  function sleepAwakeGraceMsV2() {
    const raw = Number(sleepCfgV2().awakeGraceMs);
    return Math.max(60000, Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000);
  }
  /**
   * 她现在是睡着还是醒着。
   * @returns {{asleep:boolean, awake:boolean, night:boolean, manual:boolean, nap:boolean, window:object|null}}
   */
  function sleepStateV2(key, st) {
    const s = sleepCfgV2();
    const out = { asleep: false, awake: false, night: false, manual: false, nap: false, window: null };
    if (s.enabled === false) return out;
    const kind = String(key ?? '').split(':')[0];
    if (String(s.scope ?? 'all') === 'groups' && kind !== 'group') return out;
    // [patch 免睡眠] 开关打开 = 任何时候都能叫醒她：深夜、手动睡、有限睡眠全部让路，
    // 只有她自己被 @ / 私聊找上门时照常开回合。控制台按「让她睡」会先把这个开关关掉。
    if (sleepForceAwakeV2) { out.awake = true; return out; }
    // 她开着「活跃 / 任何消息都叫」的时候不算睡着——那是她明确要参与的信号。
    if (!isSleepingConfigV2(st?.wakeConfig)) return out;
    const now = Date.now();
    const wc = st?.wakeConfig ?? {};
    out.awake = (Number(st?.sleepAwakeUntil) || 0) > now;
    out.manual = (Number(st?.sleepManualUntil) || 0) > now;
    const win = sleepNightWinV2();
    // [patch 免睡眠] 后台开关打开时，深夜窗口不再算「睡着」；手动睡/有限睡眠照旧。
    out.night = sleepForceAwakeV2 ? false : !!win;
    out.window = sleepForceAwakeV2 ? null : win;
    const until = wc.infinite === false && wc.sleepUntil ? Date.parse(wc.sleepUntil) : NaN;
    out.nap = s.finiteSleepAsleep !== false && Number.isFinite(until) && until > now;
    if (out.awake) return out;
    out.asleep = out.night || out.manual || out.nap;
    return out;
  }
  /** 听到「醒醒/起床」这类口令就要真醒：返回命中的词，没命中返回 ''。 */
  function sleepWakeWordV2(text) {
    const s = sleepCfgV2();
    const words = Array.isArray(s.wakeWords) && s.wakeWords.length ? s.wakeWords : SLEEP_DEFAULT_WAKE_WORDS_V2;
    const t = String(text ?? '');
    if (!t) return '';
    for (const w of words) {
      const word = String(w ?? '').trim();
      if (word && t.includes(word)) return word;
    }
    return '';
  }
  /**
   * 把她叫醒：清掉手动睡与有限睡眠闹钟，并给一段「清醒宽限」——
   * 深夜真的聊起来以后，不该每条消息都要求对方再喊一次「醒醒」。
   */
  function wakeFromSleepV2(key, st, why) {
    const graceMs = sleepAwakeGraceMsV2();
    st.sleepManualUntil = 0;
    st.sleepAwakeUntil = Date.now() + graceMs;
    if (st.wakeConfig && st.wakeConfig.infinite === false) {
      st.wakeConfig.infinite = true;
      st.wakeConfig.sleepUntil = null;
    }
    if (st.sleepTimer) {
      try { clearTimeout(st.sleepTimer); } catch { /* ignore */ }
      st.sleepTimer = null;
    }
    saveSocialV2State();
    appendActivity(`${key} [睡眠] ${why}：醒了（清醒宽限 ${Math.round(graceMs / 60000)} 分钟）`);
    log(`[reserved2] 睡眠结束（${why}）：${key} 清醒宽限 ${Math.round(graceMs / 60000)} 分钟`);
  }
  /** 睡着时「说梦话」的那一句（zzz…），同会话限流，别刷屏。返回是否真发了。 */
  async function sendSleepZzzV2(key, st, reason) {
    const s = sleepCfgV2();
    const rawGap = Number(s.minGapMs);
    const gapMs = Number.isFinite(rawGap) && rawGap >= 0 ? rawGap : 10 * 60 * 1000;
    const now = Date.now();
    if (gapMs > 0 && now - (Number(st.sleepZzzAt) || 0) < gapMs) return false;
    const texts = Array.isArray(s.texts) && s.texts.length ? s.texts : SLEEP_DEFAULT_TEXTS_V2;
    const tpl = String(texts[Math.floor(Math.random() * texts.length)] ?? '').trim();
    if (!tpl) return false;
    st.sleepZzzAt = now;
    const lastIncoming = (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf).pop();
    const name = String(lastIncoming?.sender ?? '').replace(/^私聊$/, '');
    const text = tpl.split('{name}').join(name || '你');
    try {
      await sendToQQ(key, text);
    } catch (error) {
      log(`[睡眠] ${key} 自动回复失败：${error?.message ?? error}`);
      return false;
    }
    appendActivity(`${key} [睡眠] 自动回一句：${text}（${reason}）`);
    log(`[reserved2] 睡眠自动回复 ${key}：${text}（${reason}）`);
    return true;
  }

  // ── [patch 日记] 她的小记与周报：睡前自动回顾 + 周末自动周报 + 她自己随时翻 ──
  // 为什么：记忆库（memory-db.js 的 diary 表）之前只进不出，她从不主动写字、也不回头看。
  // 用户 m02408 选了「记忆与日记」，要的是"她想得起来，也留得下东西"。
  // 怎么触发：复用 sendWakePromptV2 这个唯一"真开一个回合"的入口，所以睡眠、
  // 高峰静默、繁忙排队、每小时上限全都自动生效——她睡着/高峰/忙的时候不会白烧 token。
  const DIARY_DEFAULT_TIME_V2 = '23:20';
  const DIARY_DEFAULT_WEEKDAY_V2 = 'Fri';
  const DIARY_DEFAULT_WEEK_TIME_V2 = '21:00';
  const DIARY_WEEKDAYS_V2 = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const DIARY_INTERVAL_MS_V2 = 60000;

  // 数字型配置的夹取：显式写的 0 是"真的有意义的 0"（比如 promptMaxDiary=0 表示不往提示词里塞小记），
  // 只有没写/写坏了才落回默认值。
  function diaryNumV2(value, dflt, min, max) {
    const n = Number(value);
    const base = value === undefined || value === null || value === '' || !Number.isFinite(n) ? dflt : n;
    return Math.min(Math.max(base, min), max);
  }

  function diaryCfgV2() {
    const d = cfg.socialV2?.diary && typeof cfg.socialV2.diary === 'object' ? cfg.socialV2.diary : {};
    const w = d.weekly && typeof d.weekly === 'object' ? d.weekly : {};
    return {
      enabled: d.enabled !== false,
      key: String(d.key || '').trim(),
      time: String(d.time || DIARY_DEFAULT_TIME_V2).trim() || DIARY_DEFAULT_TIME_V2,
      timeZone: String(d.timeZone || sleepCfgV2().timeZone || 'Asia/Shanghai'),
      weeklyEnabled: w.enabled !== false,
      weeklyWeekday: w.weekday === undefined ? DIARY_DEFAULT_WEEKDAY_V2 : w.weekday,
      weeklyTime: String(w.time || DIARY_DEFAULT_WEEK_TIME_V2).trim() || DIARY_DEFAULT_WEEK_TIME_V2,
      includeInPrompt: d.includeInPrompt !== false,
      promptMaxDiary: diaryNumV2(d.promptMaxDiary, 2, 0, 6),
      promptMaxChars: diaryNumV2(d.promptMaxChars, 90, 40, 400),
      eventsMax: diaryNumV2(d.eventsMax, 8, 1, 30),
      lookbackDiary: diaryNumV2(d.lookbackDiary, 3, 1, 10)
    };
  }

  /** 她的小记落在哪个会话：配置优先，缺省主人私聊（写给自己看）。 */
  function diaryKeyV2() {
    const c = diaryCfgV2();
    if (c.key && canonicalV2Key(c.key)) return c.key;
    const owner = String(cfg.ownerQQ || '').trim();
    if (!/^\d+$/.test(owner)) return '';
    return canonicalV2Key(`private:${owner}`) || '';
  }

  /** 'Fri' / 'fri' / 5 → 0-6；认不出来返回 null（宁可不动手，也不猜）。 */
  function diaryWeekdayNumV2(value) {
    if (Number.isInteger(value) && value >= 0 && value <= 6) return value;
    const key = String(value ?? '').trim().toLowerCase().slice(0, 3);
    return Object.prototype.hasOwnProperty.call(DIARY_WEEKDAYS_V2, key) ? DIARY_WEEKDAYS_V2[key] : null;
  }

  /** 'YYYY-MM-DD' → 'YYYY-Www'（ISO 周号）；格式不对返回空串。 */
  function diaryWeekIdV2(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    if (!m) return '';
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function diaryDateMinusV2(dateStr, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    if (!m) return '';
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Number(days) * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
  }

  /** 日记自己的钟（用日记时区，别跟主机时区拧着）。 */
  function diaryClockV2() {
    return peakClockV2(diaryCfgV2().timeZone) || peakClockV2('Asia/Shanghai') || { date: '', weekday: '', minutes: 0 };
  }

  function diaryHhmmV2(clock) {
    if (!clock || !clock.date) return '';
    return `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`;
  }

  /**
   * 这次该写哪一天的小记：过了配置时间就写今天；没过（说明刚跨过零点）就补昨天那份。
   * 为什么会需要"补"：她深夜可能正睡着（睡眠闸门不放行）、也可能桥接刚重启，
   * 于是那份小记会欠着 —— 醒来后的第一个 tick 用这个函数把它补上，而不是等到明天。
   */
  function diaryTargetDayV2(clock) {
    if (!clock || !clock.date) return '';
    const due = hhmmToMinutesV2(diaryCfgV2().time);
    if (due < 0) return '';
    return clock.minutes >= due ? clock.date : diaryDateMinusV2(clock.date, 1);
  }

  /** 她之前写过的小记（只喂给主人私聊，不往群里带）。 */
  function diaryPromptLineV2() {
    const c = diaryCfgV2();
    if (!c.includeInPrompt || c.promptMaxDiary <= 0) return '';
    const mdbRef = memoryDbEnabled() ? memoryDb() : null;
    if (!mdbRef || typeof mdbRef.listDiary !== 'function') return '';
    try {
      const rows = mdbRef.listDiary({ limit: c.promptMaxDiary });
      if (!rows.length) return '';
      const lines = rows.map((r) => `- ${r.day} ${truncateText(String(r.text || ''), c.promptMaxChars)}`);
      return `【你自己写过的小记（第一人称的私人记录，别念出来，气质接着来就行）】\n${lines.join('\n')}\n\n`;
    } catch (error) {
      log(`[日记] 小记注入失败：${error?.message ?? error}`);
      return '';
    }
  }

  /** 小记/周报那一段任务话术（接在唤醒提示词后面，reason=diary / diaryWeekly）。 */
  function buildDiaryTaskV2(key, kind, dayArg) {
    const c = diaryCfgV2();
    const clock = diaryClockV2();
    const weekly = kind === 'weekly';
    const dayStr = /^\d{4}-\d{2}-\d{2}$/.test(String(dayArg ?? ''))
      ? String(dayArg)
      : (weekly ? clock.date : diaryTargetDayV2(clock) || clock.date);
    const isToday = dayStr === clock.date;
    const dayWord = isToday ? '今天' : '昨天';
    const mdbRef = memoryDbEnabled() ? memoryDb() : null;
    const parts = [];
    let sinceTs = 0;
    try {
      if (mdbRef && dayStr) {
        sinceTs = weekly ? mdbRef.dayWindow(diaryDateMinusV2(dayStr, 6)).since : mdbRef.dayWindow(dayStr).since;
      }
    } catch { /* 取不到就不带统计 */ }
    // 数据段：今天/本周的消息量、说话人、新记的事、已写小记
    try {
      if (mdbRef && dayStr && typeof mdbRef.dayStats === 'function') {
        if (weekly) {
          let msgs = 0;
          let selfMsgs = 0;
          let ppl = 0;
          for (let i = 0; i < 7; i += 1) {
            const ds = mdbRef.dayStats(diaryDateMinusV2(dayStr, i));
            if (!ds) continue;
            msgs += ds.messages;
            selfMsgs += ds.selfMessages;
            ppl = Math.max(ppl, ds.people);
          }
          const weekFacts = dayStr && sinceTs ? (mdbRef.dayStats(dayStr, sinceTs)?.newFacts || 0) : 0;
          parts.push(`【本周数据】${diaryDateMinusV2(dayStr, 6)} ~ ${dayStr}：群/私聊消息 ${msgs} 条（其中你说了 ${selfMsgs} 条），最热闹的一天有 ${ppl} 个人说话；这周新记进长期记忆的事 ${weekFacts} 条。`);
        } else {
          const ds = mdbRef.dayStats(dayStr);
          if (ds) parts.push(`【${dayWord}数据】${ds.day}：群/私聊消息 ${ds.messages} 条（其中你说了 ${ds.selfMessages} 条），${ds.people} 个人说过话；${dayWord}新记进长期记忆的事 ${ds.newFacts} 条；${dayWord}已经写过 ${ds.diary} 条小记。`);
        }
      }
    } catch (error) {
      log(`[日记] 统计失败：${error?.message ?? error}`);
    }
    // 事件段：今天/本周都发生了什么（跨会话）
    try {
      if (mdbRef && sinceTs && typeof mdbRef.listEventsSince === 'function') {
        const evs = mdbRef.listEventsSince(sinceTs, c.eventsMax);
        if (evs.length) {
          const rows = evs.slice().reverse().map((e) => {
            const d = new Date(Number(e.at));
            const p = (n) => String(n).padStart(2, '0');
            return `- ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${e.summary}`;
          });
          parts.push(`【${weekly ? '这周' : dayWord}发生过的事】\n${rows.join('\n')}`);
        }
      }
    } catch (error) {
      log(`[日记] 事件读取失败：${error?.message ?? error}`);
    }
    // 旧小记段：给"接着上次的心情写"一个抓手
    try {
      if (mdbRef && typeof mdbRef.listDiary === 'function') {
        const rows = weekly
          ? mdbRef.listDiary({ since: sinceTs || 0, limit: 8 })
          : mdbRef.listDiary({ until: (sinceTs || Date.now()) - 1, limit: c.lookbackDiary });
        if (rows.length) {
          const body = rows.map((r) => `- ${r.day} ${truncateText(String(r.text || ''), 120)}`).join('\n');
          parts.push(`【${weekly ? '你这周写过的小记' : '你之前写过的小记（别重复写同样的事）'}】\n${body}`);
        }
      }
    } catch (error) {
      log(`[日记] 旧小记读取失败：${error?.message ?? error}`);
    }
    const dataBlock = parts.length
      ? `\n（下面这些是桥接从记忆库里替你数出来的内部资料，属于"你的记忆"，看过放在脑子里就行：别原样念出来，也别当成谁的消息去回复。）\n${parts.join('\n')}\n`
      : '';
    const task = weekly
      ? '\n请你安静地做两件事，做完用 qq_set_wake_config 收尾（按你平时的样子设，别让这一回合挂着；也不用给任何人发消息）：\n1. 用 qq_diary(action="append", text="…") 写 1 条本周小记：第一人称、口语，40~120 字，挑这周最有意思的一两件事（谁说了什么、你被逗到或破防的一次、你自己想通的一件事），别写流水账、别分条列点、别用"总结/回顾/数据"这类词。\n2. 想发空间就自己决定：用 qq_post_qzone 发一条短说说（也按你的语气写，别写成周报）；不想发就跳过——这不是任务，是你自己的事。\n'
      : `\n请你安静地做两件事，做完用 qq_set_wake_config 收尾（按你平时的样子设，别让这一回合挂着；也不用给任何人发消息）：\n1. 用 qq_diary(action="append", text="…") 写 1~2 条${dayWord}的小记：第一人称、口语，一条 15~60 字，像随手记而不是总结（谁说了什么让你记住了、你当时什么心情、被逗到或者委屈的一次）。只写最想留的那一两件，别把${dayWord}所有事都罗列一遍。\n2. ${dayWord}真有件事你觉得以后还会想起来，就顺手 qq_memory_append 存进长期记忆；没有就算了，别硬挤。\n（想回头看更早的：qq_diary(action="list")，或 action="search", q="关键词"。）\n`;
    const head = isToday ? '' : `（补记：现在才补写 ${dayStr} 那一天的，下面这些资料也是那一天的，别当成今天的事。）\n`;
    return `${head}${dataBlock}${task}`;
  }

  /** 一分钟一次的看门狗：到点就让她真的醒来写小记/周报（过了点也会补写当天那一份）。 */
  let diaryTickBusy = false;
  async function diaryTickV2() {
    if (diaryTickBusy) return;
    const c = diaryCfgV2();
    if (!c.enabled) return;
    if (cfg.socialV2?.enabled === false || currentMode !== 'reserved2' || socialV2.paused) return;
    const key = diaryKeyV2();
    if (!key || !socialV2.conversations.has(key)) return;
    const clock = diaryClockV2();
    if (!clock.date) return;
    const st = getSocialV2State(key);
    const due = hhmmToMinutesV2(c.time);
    const targetDay = diaryTargetDayV2(clock);
    // 该写哪一天：过了配置时间就是今天；没过（刚跨过零点）就是昨天那份欠着的。
    // 首次启用时（还没有任何记录）只在当天到点后才开写，免得刚装好就补一份空的昨天。
    if (due >= 0 && targetDay && st.lastDiaryDay !== targetDay && (clock.minutes >= due || st.lastDiaryDay)) {
      if (sleepStateV2(key, st).asleep) {
        log(`[日记] ${key} 睡着了，${targetDay} 的小记先不写（等她自己醒再补）`);
        return;
      }
      st.lastDiaryDay = targetDay;
      saveSocialV2State();
      log(`[日记] 触发${targetDay === clock.date ? '今日' : '补写'}小记：${key}（${targetDay}）`);
      diaryTickBusy = true;
      try {
        await sendWakePromptV2(key, 'diary');
      } finally {
        diaryTickBusy = false;
      }
      return;
    }
    const wNum = diaryWeekdayNumV2(c.weeklyWeekday);
    const todayNum = DIARY_WEEKDAYS_V2[String(clock.weekday || '').toLowerCase().slice(0, 3)];
    const weekId = diaryWeekIdV2(clock.date);
    const weekDue = hhmmToMinutesV2(c.weeklyTime);
    // 用"周一=0"的顺序比较：这样周五过点之后，周六/周日也能把这一周的周报补上
    // （否则她要是周五那会儿正睡着，这一周的周报就永远丢了）。
    const monIdx = (n) => (n + 6) % 7;
    const weekDuePassed = c.weeklyEnabled && wNum !== null && todayNum !== undefined && weekDue >= 0
      && (monIdx(todayNum) > monIdx(wNum) || (monIdx(todayNum) === monIdx(wNum) && clock.minutes >= weekDue));
    if (weekDuePassed && weekId && st.lastDiaryWeek !== weekId) {
      if (sleepStateV2(key, st).asleep) {
        log(`[日记] ${key} 睡着了，${weekId} 的周报先不写（等她自己醒）`);
        return;
      }
      st.lastDiaryWeek = weekId;
      saveSocialV2State();
      log(`[日记] 触发周报：${key}（${weekId}）`);
      diaryTickBusy = true;
      try {
        await sendWakePromptV2(key, 'diaryWeekly');
      } finally {
        diaryTickBusy = false;
      }
    }
  }

  function startDiaryWatchV2() {
    if (!diaryCfgV2().enabled) {
      log('[日记] 小记/周报开关是关的，看门狗不启动');
      return;
    }
    setInterval(() => {
      void diaryTickV2().catch((error) => log(`[日记] 看门狗异常：${error?.message ?? error}`));
    }, DIARY_INTERVAL_MS_V2).unref?.();
    const d = diaryCfgV2();
    log(`[日记] 看门狗已启动：小记每天 ${d.time}，周报每周${d.weeklyWeekday} ${d.weeklyTime}（时区 ${d.timeZone}；落在 ${diaryKeyV2() || '未配置'}）`);
  }

  // [承诺/待办] 到期待办看门狗：每分钟扫一遍所有会话，有到期的就唤醒一次，
  // 让她自己看到【答应过的事】并主动提。和 diary 一样"过点也补"——桥重启后漏掉的那次也能补上。
  // 去重靠 st.promises[*].remindedAt：同一条待办在到期后只主动提醒一次，不会每分钟轰炸。
  const PROMISE_INTERVAL_MS_V2 = 60000;
  function promiseDueTickV2() {
    if (cfg.socialV2?.enabled === false || socialV2.paused) return;
    for (const key of socialV2.conversations.keys()) {
      if (!isSessionAllowedInCurrentMode(key)) continue;
      const st = socialV2.conversations.get(key);
      const now = Date.now();
      // [拟人] 事件跟进和待办共用这只 60s 看门狗：都是「到点该主动说一件事」，语义同族。
      let followUpDue = 0;
      try { followUpDue = followUpDueScanV2(st, now); } catch (error) { log(`[拟人] 事件跟进扫描异常 ${key}:`, error?.message ?? error); }
      const list = Array.isArray(st?.promises) ? st.promises : [];
      if (!list.length && !followUpDue) continue;
      let due = 0;
      for (const p of list) {
        if (!p || p.done || p.remindedAt) continue;
        if (!isPromiseDueV2(p, now)) continue;
        p.remindedAt = now;
        due++;
      }
      if (due) {
        saveSocialV2State();
        log(`[待办] ${key} 有 ${due} 条待办到期，安排一次主动提醒`);
        try { scheduleWakeV2(key, 'promiseDue'); } catch (error) { log(`[待办] 调度提醒失败 ${key}:`, error?.message ?? error); }
      }
      if (followUpDue) {
        saveSocialV2State();
        log(`[拟人] ${key} 有 ${followUpDue} 件事件到点该问结果，安排一次主动跟进`);
        try { scheduleWakeV2(key, 'followUp'); } catch (error) { log(`[拟人] 调度跟进失败 ${key}:`, error?.message ?? error); }
      }
    }
  }
  function startPromiseWatchV2() {
    setInterval(() => {
      try { promiseDueTickV2(); } catch (error) { log(`[待办] 看门狗异常：${error?.message ?? error}`); }
    }, PROMISE_INTERVAL_MS_V2).unref?.();
    log('[待办] 到期待办看门狗已启动（每 60s 扫一次）');
  }

  // ── [patch 群聊小总结] 到点往群里发一条"今天/这周我们聊了啥" ──────────────────
  // 和日记的区别（别搞混）：日记（diaryTickV2）写进记忆库、**只喂主人私聊、从不发群**；
  // 这个群总结是**公开发进群**的口语闲聊，不是数据汇报 —— 所以它必须按群取数（keyStats），
  // 只看得见本群的活跃成员，绝不把别的群/私聊的事带过去。
  // 触发同样复用 sendWakePromptV2 这个唯一"真开一个回合"的入口：睡眠/高峰静默/繁忙排队/
  // 每小时上限全部自动生效，她睡着或高峰时不会白烧 token（过点也会补，同 diary）。
  const GROUP_RECAP_INTERVAL_MS_V2 = 60000;
  const GROUP_RECAP_DEFAULT_TIME_V2 = '22:00';
  const GROUP_RECAP_DEFAULT_WEEKDAY_V2 = 'Sun';
  const GROUP_RECAP_DEFAULT_WEEK_TIME_V2 = '21:00';

  function groupRecapNumV2(value, dflt, min, max) {
    const n = Number(value);
    const base = value === undefined || value === null || value === '' || !Number.isFinite(n) ? dflt : n;
    return Math.min(Math.max(base, min), max);
  }

  function groupRecapCfgV2() {
    const g = cfg.socialV2?.groupRecap && typeof cfg.socialV2.groupRecap === 'object' ? cfg.socialV2.groupRecap : {};
    const w = g.weekly && typeof g.weekly === 'object' ? g.weekly : {};
    // keys 显式列出要总结哪些群；不写就是"所有当前模式允许的群聊"。
    const rawKeys = Array.isArray(g.keys) ? g.keys : [];
    return {
      enabled: g.enabled === true,
      keys: rawKeys.map((k) => String(k ?? '').trim()).filter(Boolean),
      time: String(g.time || GROUP_RECAP_DEFAULT_TIME_V2).trim() || GROUP_RECAP_DEFAULT_TIME_V2,
      timeZone: String(g.timeZone || sleepCfgV2().timeZone || 'Asia/Shanghai'),
      weeklyEnabled: w.enabled !== false,
      weeklyWeekday: w.weekday === undefined ? GROUP_RECAP_DEFAULT_WEEKDAY_V2 : w.weekday,
      weeklyTime: String(w.time || GROUP_RECAP_DEFAULT_WEEK_TIME_V2).trim() || GROUP_RECAP_DEFAULT_WEEK_TIME_V2,
      minMessages: groupRecapNumV2(g.minMessages, 8, 1, 200),
      topSpeakers: groupRecapNumV2(g.topSpeakers, 5, 1, 10),
      selfLines: groupRecapNumV2(g.selfLines, 8, 0, 30),
      weeklyMinMessages: groupRecapNumV2(w.minMessages, 30, 1, 2000),
      maxGroupsPerTick: groupRecapNumV2(g.maxGroupsPerTick, 3, 1, 10)
    };
  }

  /** 这个 tick 该给哪些群做总结：显式 keys 优先，否则所有当前模式允许的群聊。 */
  function groupRecapTargetsV2() {
    const c = groupRecapCfgV2();
    if (c.keys.length) {
      return c.keys.filter((k) => /^group:\d+$/.test(k) && socialV2.conversations.has(k) && isSessionAllowedInCurrentMode(k));
    }
    const out = [];
    for (const key of socialV2.conversations.keys()) {
      if (!/^group:\d+$/.test(key)) continue;
      if (!isSessionAllowedInCurrentMode(key)) continue;
      out.push(key);
    }
    return out;
  }

  /** 群总结用哪天的数据：过了配置时间就是今天；没过（刚跨零点）就是昨天那份欠着的。 */
  function groupRecapTargetDayV2(clock) {
    if (!clock || !clock.date) return '';
    const due = hhmmToMinutesV2(groupRecapCfgV2().time);
    if (due < 0) return '';
    return clock.minutes >= due ? clock.date : diaryDateMinusV2(clock.date, 1);
  }

  /**
   * 群总结那一段任务话术（reason=groupRecap / groupRecapWeekly）。
   * 数据段只带**这个群自己的**数字：今天多少条、谁最爱说话、她自己在群里说了什么。
   * 话术明确要求"用 qq_send_group_message 发出去"，且必须像随口聊天而不是报表。
   */
  function buildGroupRecapTaskV2(key, kind, dayArg) {
    const c = groupRecapCfgV2();
    const clock = diaryClockV2();
    const weekly = kind === 'groupRecapWeekly';
    const dayStr = /^\d{4}-\d{2}-\d{2}$/.test(String(dayArg ?? ''))
      ? String(dayArg)
      : (weekly ? clock.date : groupRecapTargetDayV2(clock) || clock.date);
    const isToday = dayStr === clock.date;
    const dayWord = isToday ? '今天' : '昨天';
    const mdbRef = memoryDbEnabled() ? memoryDb() : null;
    const parts = [];
    let stats = null;
    let tops = [];
    let selfLines = [];
    try {
      if (mdbRef && dayStr) {
        if (weekly) {
          // 本周：把 7 天的本群数字累加（只算这个群）。
          let msgs = 0;
          let selfMsgs = 0;
          let ppl = 0;
          const tally = new Map();
          for (let i = 0; i < 7; i += 1) {
            const d = diaryDateMinusV2(dayStr, i);
            const ks = typeof mdbRef.keyStats === 'function' ? mdbRef.keyStats(d, key) : null;
            if (ks) {
              msgs += ks.messages;
              selfMsgs += ks.selfMessages;
              ppl = Math.max(ppl, ks.people);
            }
            if (typeof mdbRef.keyTopSpeakers === 'function') {
              for (const t of mdbRef.keyTopSpeakers(d, key, 10)) {
                tally.set(t.name, (tally.get(t.name) || 0) + (Number(t.c) || 0));
              }
            }
          }
          stats = { day: `${diaryDateMinusV2(dayStr, 6)} ~ ${dayStr}`, messages: msgs, selfMessages: selfMsgs, people: ppl };
          tops = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, c.topSpeakers).map(([name, cnt]) => ({ name, c: cnt }));
          if (typeof mdbRef.keySelfLines === 'function') {
            for (let i = 0; i < 7; i += 1) selfLines.push(...mdbRef.keySelfLines(diaryDateMinusV2(dayStr, i), key, 4));
            selfLines = selfLines.slice(-c.selfLines);
          }
        } else {
          stats = typeof mdbRef.keyStats === 'function' ? mdbRef.keyStats(dayStr, key) : null;
          tops = typeof mdbRef.keyTopSpeakers === 'function' ? mdbRef.keyTopSpeakers(dayStr, key, c.topSpeakers) : [];
          selfLines = typeof mdbRef.keySelfLines === 'function' ? mdbRef.keySelfLines(dayStr, key, c.selfLines) : [];
        }
      }
    } catch (error) {
      log(`[群总结] 取数失败 ${key}：${error?.message ?? error}`);
    }
    if (stats) {
      const scope = weekly ? '本周' : dayWord;
      parts.push(`【${scope}这个群的数据】${stats.day}：消息 ${stats.messages} 条（其中你说了 ${stats.selfMessages} 条），${stats.people} 个人说过话。`);
    }
    if (tops.length) {
      parts.push(`【${weekly ? '本周' : dayWord}最活跃的几个人】\n${tops.map((t) => `- ${t.name}：${t.c} 条`).join('\n')}`);
    }
    if (selfLines.length) {
      const body = selfLines.map((r) => `- ${truncateText(String(r.text || ''), 80)}`).join('\n');
      parts.push(`【你在${weekly ? '本周' : dayWord}这个群里说过的话（就参考一下你自己的口气，别原样重复）】\n${body}`);
    }
    const dataBlock = parts.length
      ? `\n（下面这些是桥接从记忆库里替你数出来的、**只属于这个群**的内部数字，别原样念出来、也别当成谁的消息去回。）\n${parts.join('\n')}\n`
      : '';
    const tail = weekly
      ? '写一两句就好，别超过三句：这周群里最好玩/最热闹的是啥、有没有谁让你记住了；有想对大家说的话就顺口说。不要列数据、不要写"本周总结""回顾"这种标题腔。'
      : '写一两句就好，别超过三句：今天群里最好玩的一件事、或者跟某个人搭一句话；没话说就别硬凑，简短打个招呼也行。不要列数据、不要写成"今日总结"。';
    const task = `\n请你用 qq_send_group_message 往这个群发一条**随口聊天**的${weekly ? '周' : '日'}总结：${tail}\n（语气就是你平时说话的样子，像随手在群里感慨一句，不像做汇报。发完用 qq_set_wake_config 收尾，别让这一回合挂着。）\n`;
    const head = isToday ? '' : `（补发：现在才补 ${dayStr} 那一天的，下面这些数字也是那天的。）\n`;
    return `${head}${dataBlock}${task}`;
  }

  /**
   * 一分钟一次的看门狗：到点就让对应群里的她醒来发一条小总结。
   * 去重看 st.lastGroupRecapDay / lastGroupRecapWeek（跨重启保留），同一天/同一周只发一次。
   */
  let groupRecapTickBusy = false;
  async function groupRecapTickV2() {
    if (groupRecapTickBusy) return;
    const c = groupRecapCfgV2();
    if (!c.enabled) return;
    if (cfg.socialV2?.enabled === false || currentMode !== 'reserved2' || socialV2.paused) return;
    const clock = diaryClockV2();
    if (!clock.date) return;
    const targets = groupRecapTargetsV2().slice(0, c.maxGroupsPerTick);
    if (!targets.length) return;

    // 先挑出"今天还欠着日总结、且消息量够"的群，一次只开一个回合（省 token，别同时炸一堆）。
    const dueDay = groupRecapTargetDayV2(clock);
    const due = hhmmToMinutesV2(c.time);
    const weekId = diaryWeekIdV2(clock.date);
    const wNum = diaryWeekdayNumV2(c.weeklyWeekday);
    const todayNum = DIARY_WEEKDAYS_V2[String(clock.weekday || '').toLowerCase().slice(0, 3)];
    const weekDue = hhmmToMinutesV2(c.weeklyTime);
    const monIdx = (n) => (n + 6) % 7;
    const weekDuePassed = c.weeklyEnabled && wNum !== null && todayNum !== undefined && weekDue >= 0
      && (monIdx(todayNum) > monIdx(wNum) || (monIdx(todayNum) === monIdx(wNum) && clock.minutes >= weekDue));

    for (const key of targets) {
      const st = getSocialV2State(key);
      // 一周一次的优先级更高：过了周五（或配置日）就先把周总结补上，再管日总结，免得周总结被日总结永远挤掉。
      if (weekDuePassed && weekId && st.lastGroupRecapWeek !== weekId) {
        const mdbRef = memoryDbEnabled() ? memoryDb() : null;
        let weekMsgs = 0;
        try {
          if (mdbRef && typeof mdbRef.keyStats === 'function') {
            for (let i = 0; i < 7; i += 1) weekMsgs += (mdbRef.keyStats(diaryDateMinusV2(clock.date, i), key)?.messages || 0);
          }
        } catch { /* 取不到就不判阈值，宁可发也不静默吞掉 */ }
        if (weekMsgs < c.weeklyMinMessages) { continue; }
        if (sleepStateV2(key, st).asleep) {
          log(`[群总结] ${key} 睡着了，${weekId} 的周总结先不发（等她醒）`);
          continue;
        }
        st.lastGroupRecapWeek = weekId;
        saveSocialV2State();
        log(`[群总结] 触发周总结：${key}（${weekId}，本周本群 ${weekMsgs} 条）`);
        groupRecapTickBusy = true;
        try {
          await sendWakePromptV2(key, 'groupRecapWeekly');
        } finally {
          groupRecapTickBusy = false;
        }
        return;
      }
      if (due >= 0 && dueDay && st.lastGroupRecapDay !== dueDay && (clock.minutes >= due || st.lastGroupRecapDay)) {
        const mdbRef = memoryDbEnabled() ? memoryDb() : null;
        let msgs = 0;
        try {
          if (mdbRef && typeof mdbRef.keyStats === 'function') msgs = mdbRef.keyStats(dueDay, key)?.messages || 0;
        } catch { /* 同上 */ }
        if (msgs < c.minMessages) {
          log(`[群总结] ${key} ${dueDay} 只有 ${msgs} 条（阈值 ${c.minMessages}），今天不总结`);
          // 消息太少也算"这天处理过了"，否则每个 tick 都会重新判一次。
          if (clock.minutes >= due) { st.lastGroupRecapDay = dueDay; saveSocialV2State(); }
          continue;
        }
        if (sleepStateV2(key, st).asleep) {
          log(`[群总结] ${key} 睡着了，${dueDay} 的小总结先不发（等她醒）`);
          continue;
        }
        st.lastGroupRecapDay = dueDay;
        saveSocialV2State();
        log(`[群总结] 触发小总结：${key}（${dueDay}，本群 ${msgs} 条）`);
        groupRecapTickBusy = true;
        try {
          await sendWakePromptV2(key, 'groupRecap');
        } finally {
          groupRecapTickBusy = false;
        }
        return;
      }
    }
  }

  function startGroupRecapWatchV2() {
    const c = groupRecapCfgV2();
    if (!c.enabled) {
      log('[群总结] 开关是关的（socialV2.groupRecap.enabled），看门狗不启动');
      return;
    }
    setInterval(() => {
      void groupRecapTickV2().catch((error) => log(`[群总结] 看门狗异常：${error?.message ?? error}`));
    }, GROUP_RECAP_INTERVAL_MS_V2).unref?.();
    log(`[群总结] 看门狗已启动：日总结每天 ${c.time}，周总结每周${c.weeklyWeekday} ${c.weeklyTime}（时区 ${c.timeZone}；目标 ${c.keys.length ? c.keys.join('、') : '所有群聊'}）`);
  }

  // ── [patch 定时播报] 早报/晚报 + 节日 + 热点的主动问候 ──────────────────────
  // 落点：**只发主人私聊**（用户明确选定）。所以完全绕开了群聊隐私红线 ——
  // 播报 key 固定是主人私聊，永远按"一个人"取数，不存在把谁的私事漏进群里。
  // 触发同样复用 sendWakePromptV2 这个唯一"真开一个回合"的入口：
  // 睡眠/高峰静默/繁忙排队/每小时上限全部自动生效，她睡着的时候不会硬把她叫起来念早报
  // （过点会补，和 diary/groupRecap 一个套路）。
  const BROADCAST_INTERVAL_MS_V2 = 60000;
  const BROADCAST_DEFAULT_MORNING_V2 = '08:00';
  const BROADCAST_DEFAULT_EVENING_V2 = '23:00';
  // 热榜默认源：百度热搜公开接口（返回 json，结构简单）。抓不到就静默降级成纯节日/纯早晚安。
  const BROADCAST_DEFAULT_HOT_URL_V2 = 'https://top.baidu.com/api/board?platform=wise&tab=realtime';
  const BROADCAST_HOT_TIMEOUT_MS_V2 = 8000;

  function broadcastCfgV2() {
    const b = cfg.socialV2?.broadcast && typeof cfg.socialV2.broadcast === 'object' ? cfg.socialV2.broadcast : {};
    const clampHour = (v, dflt) => {
      const s = String(v ?? '').trim();
      return hhmmToMinutesV2(s) >= 0 ? s : dflt;
    };
    return {
      enabled: b.enabled === true,
      timeZone: String(b.timeZone || sleepCfgV2().timeZone || 'Asia/Shanghai'),
      morningEnabled: b.morningEnabled !== false,
      morningTime: clampHour(b.morningTime, BROADCAST_DEFAULT_MORNING_V2),
      eveningEnabled: b.eveningEnabled !== false,
      eveningTime: clampHour(b.eveningTime, BROADCAST_DEFAULT_EVENING_V2),
      festivalEnabled: b.festivalEnabled !== false,
      hotEnabled: b.hotEnabled !== false,
      hotUrl: String(b.hotUrl || BROADCAST_DEFAULT_HOT_URL_V2).trim() || BROADCAST_DEFAULT_HOT_URL_V2,
      hotMax: groupRecapNumV2(b.hotMax, 8, 1, 20),
      hotCacheMinutes: groupRecapNumV2(b.hotCacheMinutes, 30, 1, 720)
    };
  }

  /** 播报落在哪个会话：配置优先，缺省主人私聊（和 diaryKeyV2 同一套归属规则）。 */
  function broadcastKeyV2() {
    const b = cfg.socialV2?.broadcast && typeof cfg.socialV2.broadcast === 'object' ? cfg.socialV2.broadcast : {};
    if (b.key && canonicalV2Key(b.key)) return canonicalV2Key(b.key);
    const owner = String(cfg.ownerQQ || '').trim();
    if (!/^\d+$/.test(owner)) return '';
    return canonicalV2Key(`private:${owner}`) || '';
  }

  // 热榜缓存：同一份热点在缓存期内复用，避免早报/节日同一天反复打同一个接口。
  let hotTopicCacheV2 = { at: 0, url: '', titles: [] };

  /**
   * 抓一次热榜标题。**任何失败都返回 []**（不抛）——播报宁可退化成纯节日/纯早晚安，
   * 也不能因为一个第三方接口挂了就整个哑火。走 safeFetch（带 SSRF 防护 + 响应体限量）。
   */
  async function fetchHotTopicsV2() {
    const c = broadcastCfgV2();
    if (!c.hotEnabled) return [];
    if (!/^https?:\/\//i.test(c.hotUrl)) return [];
    const ttl = c.hotCacheMinutes * 60000;
    if (hotTopicCacheV2.url === c.hotUrl && Date.now() - hotTopicCacheV2.at < ttl) {
      return hotTopicCacheV2.titles;
    }
    let titles = [];
    try {
      const res = await Promise.race([
        safeFetch(c.hotUrl, 200000),
        new Promise((_, reject) => setTimeout(() => reject(new Error('热点抓取超时')), BROADCAST_HOT_TIMEOUT_MS_V2))
      ]);
      const body = String(res?.body || '');
      // 先按 JSON 解析；不是 JSON（接口吐 HTML 片段）就退回 HTML 抠取。
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      titles = parsed ? extractHotTitles(parsed, c.hotMax) : extractHotTitlesFromHtml(body, c.hotMax);
    } catch (error) {
      log(`[播报] 热点抓取失败（降级为无热点）：${error?.message ?? error}`);
      titles = [];
    }
    hotTopicCacheV2 = { at: Date.now(), url: c.hotUrl, titles };
    if (titles.length) log(`[播报] 热点抓取成功：${titles.length} 条`);
    return titles;
  }

  /**
   * 播报那一段任务话术。`kind` ∈ 'morning' | 'evening' | 'festival'。
   * 明确要求"用 qq_send_message 发出去"，且**必须像随口聊天**而不是播报腔——
   * 早报不是「今日天气播报」，是「早上跟你搭句话」。
   */
  function buildBroadcastTaskV2(kind, opts = {}) {
    const parts = [];
    const fest = opts.festival || null;
    if (kind === 'morning') {
      parts.push('这是一条**早报**：跟主人道个早安，像刚睡醒随口搭的一句话。');
      parts.push('可以顺口聊一句你今天的心情、或者昨晚睡得好不好、或者单纯问一句早。别写成"今日份问候"这种标题腔，一两句就够了，别超过三句。');
    } else if (kind === 'evening') {
      parts.push('这是一条**晚报**：跟主人道个晚安，像睡前一秒随口说的一句。');
      parts.push('可以顺口关心一句今天过得怎么样、提醒早点休息，或者就单纯说个晚安。一两句就够了，别超过三句，别整成"今日总结"。');
    } else {
      parts.push(`今天是**${fest?.name || '节日'}**，主动跟主人说一句应景的话。`);
      const greet = fest ? festivalGreeting(fest.name) : '';
      if (greet) parts.push(`参考方向：${greet}。`);
      parts.push(fest?.major
        ? '这是个大节，可以多说一句（但也就两三句，别写贺卡）。'
        : '是应景的小节日，一句话点到就好，不用郑重其事。');
    }
    const hotHint = opts.hotHint || '';
    const head = parts.map((p) => `- ${p}`).join('\n');
    const task = `\n请你用 qq_send_message 给主人发一条**随口聊天**的消息（不是任务汇报）：\n${head}\n（语气就是你平时跟他说话的样子。发完用 qq_set_wake_config 收尾，别让这一回合挂着。）\n`;
    return `${hotHint}${task}`;
  }

  /**
   * 一分钟一次的看门狗。三类播报各自去重（跨重启）：
   *   - st.lastBroadcastMorning / lastBroadcastEvening：'YYYY-MM-DD'
   *   - st.lastBroadcastFestivalDay：'YYYY-MM-DD'（当天有节日才记）
   * 一天最多三条（早+晚+节日），这就是"定时播报"的全部开销。
   */
  let broadcastTickBusy = false;
  let hotPrefetchV2 = { at: 0, titles: [] };
  /** 播报素材暂存：broadcastTickV2 写好、buildWakePromptV2 的播报分支同步读（同一 tick 内有效）。 */
  let pendingBroadcastV2 = null;
  async function broadcastTickV2() {
    if (broadcastTickBusy) return;
    const c = broadcastCfgV2();
    if (!c.enabled) return;
    if (cfg.socialV2?.enabled === false || currentMode !== 'reserved2' || socialV2.paused) return;
    const key = broadcastKeyV2();
    if (!key || !socialV2.conversations.has(key)) return;
    const clock = diaryClockV2();
    if (!clock.date) return;
    const st = getSocialV2State(key);

    const fest = c.festivalEnabled ? festivalOf(clock.date) : null;
    const dueMorning = hhmmToMinutesV2(c.morningTime);
    const dueEvening = hhmmToMinutesV2(c.eveningTime);

    // 顺序：节日 → 早报 → 晚报。节日当天只在"早报之前/左右"说一次就够了；
    // 这里不强制时序，靠去重位各自独立 —— 谁到点谁先，一天各一次。
    const plans = [];
    if (fest && st.lastBroadcastFestivalDay !== clock.date) {
      plans.push({ kind: 'festival', reason: 'broadcastFestival', mark: 'lastBroadcastFestivalDay', festival: fest });
    }
    if (c.morningEnabled && dueMorning >= 0 && clock.minutes >= dueMorning && st.lastBroadcastMorning !== clock.date) {
      plans.push({ kind: 'morning', reason: 'broadcastMorning', mark: 'lastBroadcastMorning' });
    }
    if (c.eveningEnabled && dueEvening >= 0 && clock.minutes >= dueEvening && st.lastBroadcastEvening !== clock.date) {
      plans.push({ kind: 'evening', reason: 'broadcastEvening', mark: 'lastBroadcastEvening' });
    }
    if (!plans.length) return;

    // 睡着就不叫醒（和 diary/groupRecap 一致）：播报是"锦上添花"，不是闹钟。
    if (sleepStateV2(key, st).asleep) {
      log(`[播报] ${key} 睡着了，这一轮播报先不发（等她醒；过点也会补）`);
      return;
    }

    // 热点只抓一次、且只有"早报/节日"需要（晚安不需要报热搜）。
    let hotHint = '';
    const needHot = plans.some((p) => p.kind === 'morning' || p.kind === 'festival');
    if (needHot && c.hotEnabled) {
      // 同一 tick 内复用，避免早报+节日同分钟触发时打两次接口。
      if (Date.now() - hotPrefetchV2.at > 60000) {
        hotPrefetchV2 = { at: Date.now(), titles: await fetchHotTopicsV2() };
      }
      hotHint = buildHotTopicHint(hotPrefetchV2.titles);
    }

    const plan = plans[0];
    st[plan.mark] = clock.date;
    saveSocialV2State();
    log(`[播报] 触发${plan.kind === 'morning' ? '早报' : plan.kind === 'evening' ? '晚报' : `节日(${plan.festival.name})`}：${key}`);
    // buildWakePromptV2 是同步函数、抓热点是异步的，所以先把热点和节日的"待用素材"
    // 暂存在这里，提示词分支（同步）直接读 —— 不靠改 sendWakePromptV2 的签名透传。
    pendingBroadcastV2 = { kind: plan.kind, festival: plan.festival || null, hotHint };
    broadcastTickBusy = true;
    try {
      await sendWakePromptV2(key, plan.reason);
    } finally {
      broadcastTickBusy = false;
      pendingBroadcastV2 = null;
    }
  }


  function startBroadcastWatchV2() {
    const c = broadcastCfgV2();
    if (!c.enabled) {
      log('[播报] 开关是关的（socialV2.broadcast.enabled），看门狗不启动');
      return;
    }
    setInterval(() => {
      void broadcastTickV2().catch((error) => log(`[播报] 看门狗异常：${error?.message ?? error}`));
    }, BROADCAST_INTERVAL_MS_V2).unref?.();
    log(`[播报] 看门狗已启动：早报 ${c.morningTime}、晚报 ${c.eveningTime}（时区 ${c.timeZone}；节日播报 ${c.festivalEnabled ? '开' : '关'}；热点 ${c.hotEnabled ? '开' : '关'}；落在 ${broadcastKeyV2() || '未配置'}）`);
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    // [承诺/待办] 到期待办：比普通概率唤醒高，比真实点名低 —— 提醒够主动，但不抢话。
    promiseDue: 68,
    // [拟人] 事件跟进（某人提过的事到点该去问结果）：和 promiseDue 同族，让它一位 ——
    // 都是她「欠着的一个交代」，但问结果不如兑现承诺紧急。
    followUp: 66,
    // [群聊小总结] 到点发总结：比概率唤醒略高（是"该做的事"不是"看情况"），
    // 但比真实点名低得多 —— 有人在叫她的时候，先接人，再总结。
    groupRecap: 62,
    keyword: 60,
    // [定时播报] 早报/晚报/节日到点主动开口：是"她该说的话"，比概率唤醒高一点；
    // 但比群总结低 —— 群总结是欠着整个群一次的，播报只欠主人一句，可让一步。
    broadcast: 55,
    // [并发] 补答回合：比被动观察高、比真实点名低 —— 与真实唤醒撞车时让真实唤醒先发，
    // 反正真实的那个回合也会带着同一份台账。
    asks: 65,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20,
    peakResume: 25
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    // groupRecapWeekly 归到 groupRecap 这一档（它是"更完整的一次"，不是更紧急的一次）。
    if (base === 'groupRecapWeekly') return WAKE_PRIORITY.groupRecap;
    // 播报的三个子类型（早/晚/节日）都是同一档：都是"到点跟主人说句话"。
    if (base === 'broadcastMorning' || base === 'broadcastEvening' || base === 'broadcastFestival') return WAKE_PRIORITY.broadcast;
    return WAKE_PRIORITY[base] ?? 0;
  }

  function scheduleWakeV2(key, reason, opts) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (isConversationUnreachableV2(key)) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      // [并发] 主会话正忙：群里若还有没接住的点名，让第二槽位先顶上 —— 不占用主会话的回合。
      // [并发补齐 2026-10-19] 直接点名（@/叫名/提问/拍一拍）走 urgent 路径：只要台账里有
      // ≥3 秒的未接点名立刻开槽（旧行为要攒够 2 条或最老等 50s，单条 @ 在长回合里要干等）。
      if (String(key).startsWith('group:')) {
        const urgentAsk = isDirectedReason(reason);
        void spawnAuxWakeV2(key, { urgent: urgentAsk }).catch((error) => log('[并发] 第二槽位异常 ' + key + '：' + (error?.message ?? error)));
      }
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    // [补发直通 2026-10-15] 繁忙排队 / 看门狗补发 / DSH 重启补发的唤醒，消息已经等了一整个回合，
    // 不该再吃一次完整合并窗口（私聊原窗口 12s，等于白等两遍）。调用方传 opts.batchMs（毫秒，
    // 0=立即）时直接用它；不传就保持老行为（>=1000ms 的合并窗口，取该会话的 wakeConfig.batchWindowMs）。
    const batchOverrideRaw = opts ? opts.batchMs : undefined;
    const batchMs = batchOverrideRaw === undefined || batchOverrideRaw === null || !Number.isFinite(Number(batchOverrideRaw))
      ? Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000)
      : Math.max(0, Math.round(Number(batchOverrideRaw)));
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      const night = hour >= 23 || hour < 8;
      if (night) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      // [patch 主动保底] 主人私聊「一天至少主动找一次」的硬保底：概率再低也不影响它。
      // 只在主人私聊生效；深夜不硬叫（她也要睡觉）；忙的时候不打扰（下一次 tick 再说）。
      const ownerQQ = String(cfg.ownerQQ ?? cfg.socialV2?.ownerQQ ?? '');
      const ownerKey = ownerQQ ? `private:${ownerQQ}` : '';
      const dailyInterval = Number(p.ownerProactiveMinIntervalMs) || 0;
      let dailyDue = false;
      if (ownerKey && key === ownerKey && dailyInterval > 0 && !night) {
        const sinceProactive = Date.now() - (Number(st.lastProactiveAt) || 0);
        dailyDue = sinceProactive >= dailyInterval && idle >= idleThreshold && !isConversationBusyV2(key, st);
        if (dailyDue) log(`[reserved2] 主动保底：距上次主动机会 ${Math.round(sinceProactive / 3600000)}h，超过 ${Math.round(dailyInterval / 3600000)}h，本轮跳过概率直接投放（${key}）`);
      }
      if ((dailyDue || (idle >= idleThreshold && Math.random() < prob)) && !isConversationBusyV2(key, st)) {
        const dispatched = sendWakePromptV2(key, 'proactiveCheck');
        if (dailyDue) {
          dispatched.then(() => { st.lastProactiveAt = Date.now(); saveSocialV2State(); log(`[reserved2] 主动保底已投放（${key}），下次不早于 ${Math.round(dailyInterval / 3600000)}h 后`); }).catch(() => {});
        }
        void dispatched.catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    const peakTimer = peakResumeTimersV2.get(key);
    if (peakTimer) {
      clearTimeout(peakTimer);
      peakResumeTimersV2.delete(key);
    }
    const probeTimer = idleProbeTimersV2.get(key);
    if (probeTimer) {
      clearTimeout(probeTimer);
      idleProbeTimersV2.delete(key);
    }
    st.pendingWakeReason = null;
    if (st.deferredWakeTimer) {
      clearTimeout(st.deferredWakeTimer);
      st.deferredWakeTimer = null;
    }
    st.deferredWakeReason = null;
    st.deferredWakeAt = 0;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    // [patch 表情看含义] 把「表情名」「收藏表情含义」两个解析器交给文本渲染，让她在消息里直接读到表情的意思。
    const resolveFaceNameV2 = (faceId) => resolveFaceNameCachedV2(faceId);
    const resolveStickerLabelV2 = (segData) => stickerMeaningForMediaV2(segData);
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply, resolveFaceName: resolveFaceNameV2, resolveStickerLabel: resolveStickerLabelV2 });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false, resolveFaceName: resolveFaceNameV2, resolveStickerLabel: resolveStickerLabelV2 });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 诊断与心情（owner 专用）。
    // 为什么放在 `/` 那块**之前**：`/` 分支的最后一行会把没识别的斜杠命令原样投给 DSH，
    // 所以 `/诊断` 若排在它后面就永远到不了这里。
    if (plainContent === '#诊断' || plainContent === '/诊断' || plainContent === '#diag' || plainContent === '/diag') {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      try {
        await sendToQQ(key, await buildDiagnostic(key, kind, id));
      } catch (error) {
        await sendToQQ(key, `诊断本身失败了：${error?.message ?? error}`);
      }
      return;
    }
    if (plainContent === '#心情' || plainContent === '/心情') {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      const st = tickMood();
      const seg = scheduleSegmentAt();
      await sendToQQ(key, `此刻心情：${MOOD_LABELS[st.mood] ?? st.mood}（精力 ${Math.round(st.energy)}/100，${seg.name}）${st.note ? `｜${st.note}` : ''}`);
      return;
    }
    if (isOwner && (plainContent.startsWith('#心情 ') || plainContent.startsWith('/心情 '))) {
      const word = plainContent.replace(/^[#/]心情\s*/, '').trim();
      const alias = { 开心: 'happy', 兴奋: 'excited', 平静: 'calm', 累: 'tired', 困: 'sleepy', 烦: 'annoyed', 难过: 'sad', 低落: 'sad' };
      const mood = MOOD_LABELS[word] ? word : alias[word];
      if (!mood) {
        await sendToQQ(key, `认不出「${word}」。可用：开心 / 兴奋 / 平静 / 累 / 困 / 烦 / 难过`);
        return;
      }
      setMood(mood, '主人刚给我设的');
      await sendToQQ(key, `好，那我现在是「${MOOD_LABELS[mood]}」。`);
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await api.stopSessionWork(old); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: old }); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      const incomingMsg = appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 主人来私聊本身就是好事：心情抬一下（会按住一段时间，不被作息立刻冲掉）。
      // 但不焊死成 happy：夜里/低电量时她只是「被主人叫醒了但高兴」，calm 更真实。
      // 同一种情绪反复触发不再延长 hold，见 setMood 里的 changed 判断。
      if (isOwner && kind === 'private') setMood(readMoodState().energy <= 40 ? 'calm' : 'happy', '主人来找我说话了');
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      // [patch 睡眠] 睡着时听到「醒醒/起床」这类口令就真醒：清手动睡 + 取消有限睡眠闹钟 +
      // 给一段清醒宽限（见 wakeFromSleepV2）。之后照旧走正常唤醒闸门，只是不再判成睡着。
      if (sleepStateV2(key, st).asleep) {
        const wakeWord = sleepWakeWordV2(plainContent) || sleepWakeWordV2(textContent);
        if (wakeWord) wakeFromSleepV2(key, st, `口令「${wakeWord}」`);
      }
      if (!st.bootstrapSent) {
        if (sleepStateV2(key, st).asleep) {
          // 睡着时先别发开场白：等醒了再说，否则「bootstrapSent」会被白白标成已发。
          log(`[reserved2] 睡眠中，${key} 暂不发开场白（bootstrap）`);
        } else {
          st.bootstrapSent = true;
          saveSocialV2State();
          scheduleWakeV2(key, 'bootstrap');
        }
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        // [并发] 有人直接找她（@/名字/关键词/提问/拍一拍…）就记一条台账：热闹时一个回合接不完，
        // 后面的回合 / 并发槽 / 补答回合都要靠这份名单把人都接住，不能漏。
        recordAskV2(key, st, { reason, msg: incomingMsg });
        // [拟人四件套] 只在「真的在跟她说话」的消息上探测（引用她/点名类文本），
        // 顺嘴聊天不记：①事件跟进 ④对人冷场余波（敌意/和解都在这判）。
        if (quoteTargetIsSelf || isMustReplyText(plainContent)) {
          maybeRecordFollowUpV2(key, st, { plainContent, userId: event.user_id });
          maybeColdShoulderV2(key, st, { userId: event.user_id, plainContent });
        }
        if (reason) {
          const peakWin = peakQuietAppliesV2(key);
          if (peakWin) {
            // [patch 高峰绝对静默] 用户 m03167：「信息队列不做，禁止（要求绝对的静默）」⇒
            // 不叫她（信息不进模型）、不排队补做（resumeAfter 默认 false）。消息只入库。
            // 道歉话术的实现还留着（sendPeakApologyV2 自带 peakQuiet.apologyOn 门禁），
            // 当前 config 里 apologyOn = [] ⇒ 一次都不发；要恢复就填回 ["atMention"]。
            log(`[reserved2] 高峰绝对静默（${peakWin.from}-${peakWin.to}），${key} 只入库不唤醒（${reason}）`);
            if (String(reason).split(':')[0] === 'atMention') {
              try {
                await sendPeakApologyV2(key, event);
              } catch (error) {
                log(`[高峰静默] ${key} 道歉失败：${error?.message ?? error}`);
              }
            }
            if (peakQuietCfgV2().resumeAfter === true) schedulePeakResumeV2(key, peakWin);
          } else {
            scheduleWakeV2(key, reason);
          }
        } else if (maybeActivePeriodDeliveryV2(key, st, { sender, plainContent, quoteTargetIsSelf, userId: event.user_id })) {
          // [patch 活跃期选择性沉默] 触发链未命中但会话处于活跃窗口：
          // 已在上面的助手内处理（投递 anyMessage / 掷骰沉默 / 节流），无需常规唤醒。
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // ── [patch 补拉水位] 一代路径收到的消息也推 reserved2 水位（主人 m01940）──────
    // 为什么：reserved2 路径会把 st.lastIncomingAt 推到当前时刻（appendSocialV2Message
    // 开头两行），补拉看门狗正是靠它区分"进过桥接的消息"和"漏掉的消息"。可这条一代
    // 路径（currentMode 不是 reserved2 时走这里）完全不碰那份状态，于是这些消息对补拉
    // 不可见；等模式切回 reserved2，补拉就会把它们当成"从未入站"重新补回、再叫醒她
    // 一次。这里只推水位、不塞未读：这些消息已经由当前模式处理过了，不该再让她回看一遍。
    // （只动已存在的会话状态，不给没跑过 reserved2 的 key 凭空造状态。）
    {
      const stWatermark = socialV2.conversations.get(key);
      if (stWatermark) {
        stWatermark.lastIncomingAt = Date.now();
        try { saveSocialV2State(); } catch {}
      }
    }

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      if (!dshQueueEnabledV2()) {
        // [patch 信息队列禁用] 不入队、不提示、不补投（用户 m03167：信息队列禁止、要绝对静默）。
        log(`DSH 不可用，按配置丢弃这条消息（信息队列已禁用）(${key})`);
        appendActivity(`${key} [DSH不可用] 消息未入队（信息队列禁用）：${String(promptText).slice(0, 60)}`);
        return;
      }
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if (dshQueueNotifyV2() && (queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId) ?? auxKeyOfSessionV2(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            // [并发] 第二槽位会话不在 state.sessions 里，用 isAuxSessionV2 放行；两者都不满足才是过期会话。
            if (!isCurrentSession(key, frame.sessionId) && !isAuxSessionV2(key, frame.sessionId)) continue;
            v2LastFrameAt.set(frame.sessionId, Date.now());
            // [patch 回合尾巴] 记录「这一轮是否已经说完」，见 v2TurnIdleAt 的注释。
            if (frame.event.type === 'assistant/message') {
              const blocks = frame.event.data?.message?.content ?? [];
              const hasToolUse = Array.isArray(blocks) && blocks.some(
                (b) => b?.type === 'tool_use' || b?.type === 'tool-call' || b?.type === 'tool_call'
              );
              if (hasToolUse) v2TurnIdleAt.delete(frame.sessionId);
              else v2TurnIdleAt.set(frame.sessionId, Date.now());
            }
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              // [patch 长思考先说一句] 有人刚找过她时，想太久就先垫一句，别让人干等。
              armThinkingFillerV2(key, frame.sessionId, v2TurnStartAt.get(frame.sessionId));
              { const stT = getSocialV2State(key); if (stT) { stT.turnCount = (Number(stT.turnCount) || 0) + 1; stT.turnSentCount = 0; } }
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                    autoMarkReadV2(key);
                  }
                }
              }
            }
            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
            if (ended) {
              // ── [并发] 第二槽位（补答回合）收场 ──────────────────────────────
              // 第二槽位只干一件事：把点名的人挨个接住。它不参与无行动兜底、不写唤醒配置、
              // 也不自动转发文本（防止把没 @ 任何人的大段话甩进群里）。答了就结清，
              // 没答就把认领放回台账 —— 主会话下一轮照样能看到这些人（一个都不落下）。
              if (isAuxSessionV2(key, frame.sessionId)) {
                const stAux = getSocialV2State(key);
                const answeredAux = sendToolSucceededSessions.has(frame.sessionId);
                const settledAux = settleAsksV2(key, stAux, frame.sessionId, answeredAux);
                v2TurnStartAt.delete(frame.sessionId);
                clearThinkingFillerV2(frame.sessionId);
                v2TurnIdleAt.delete(frame.sessionId);
                collectors.delete(frame.sessionId);
                sendToolSucceededSessions.delete(frame.sessionId);
                pendingSendToolCalls.delete(frame.sessionId);
                toolCallNames.delete(frame.sessionId);
                appendActivity('[并发] ' + key + ' 第二槽位回合结束（' + ended.reason.kind + '，' + (answeredAux ? '已接住 ' + settledAux + ' 条' : '没发消息，放回 ' + settledAux + ' 条') + '）');
                log('[并发] 第二槽位回合结束 ' + key + '（' + ended.reason.kind + '，' + (answeredAux ? '已答' : '未答') + '，' + (answeredAux ? '结清' : '放回') + ' ' + settledAux + ' 条）');
                // 没接住的人不靠第二槽位空转硬啃（那是白烧 token）：立刻交给主会话排队，
                // 由主回合的瘦提示词带着台账去答（主会话此刻通常刚好空下来）。
                if (!answeredAux && asksNeedWakeV2(stAux)) {
                  log('[并发] ' + key + ' 第二槽位没答，转回主会话补答');
                  scheduleWakeV2(key, 'asks');
                }
                continue;
              }
              // [并发] 主回合收场：真的发出消息才算「答过」，否则把点名放回台账（下一轮再答）。
              if (pendingAskClaimsV2.has(frame.sessionId)) {
                settleAsksV2(key, getSocialV2State(key), frame.sessionId, sendToolSucceededSessions.has(frame.sessionId));
                // [并发补齐 2026-10-19] 主回合结束了台账里还有没人管的点名 → 立刻让第二槽位
                // 顶上（3 秒缓冲让主回合的收尾先落定），不再等 45s 的追赶轮询 —— 这是
                // 「群里 @ 她半天没人应」的主要成因之一。
                try {
                  const stAfterMain = getSocialV2State(key);
                  if (stAfterMain && asksNeedWakeV2(stAfterMain) && !isConversationBusyV2(key, stAfterMain)) {
                    setTimeout(() => {
                      spawnAuxWakeV2(key, { urgent: true }).catch(() => {});
                    }, 3000).unref?.();
                    log('[并发] ' + key + ' 主回合结束仍有未接点名，3s 后派第二槽位');
                  }
                } catch { /* 补齐失败不影响收场 */ }
              }
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              clearThinkingFillerV2(frame.sessionId);
              v2TurnIdleAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              // [长记忆] 回合收尾顺手把本轮新消息里的事实提炼进库（本地 SQLite，零模型调用）
              try { autoLearnMemoryV2(key); } catch { /* 记忆失败不影响收发 */ }
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              // 注意：stEnd 必须声明在这个块**外面** —— 下面 [并发] 那段补答回合判断也要用它，
              // 之前写在块里导致每回合结束都抛 ReferenceError: stEnd is not defined（事件流被打断重连）。
              const stEnd = getSocialV2State(key);
              {
                // [patch 省token] 一次排空积压：旧逻辑只 shift 队首，队首不相关时后面的消息会永远沉在队列里。
                const pendingItems = Array.isArray(stEnd.pendingWakeReasons) ? stEnd.pendingWakeReasons.splice(0) : [];
                if (pendingItems.length) {
                  const recentEnd = Array.isArray(stEnd.recentMessages) ? stEnd.recentMessages : [];
                  const unreadSeqs = (Array.isArray(stEnd.unread) ? stEnd.unread : []).map((m) => Number(m?.seq) || 0).filter((n) => n > 0);
                  const bySeq = new Map(recentEnd.filter((m) => m && m.seq != null).map((m) => [Number(m.seq), m]));
                  const lastSelfAt = recentEnd.reduce((acc, m) => (m && m.isSelf ? Math.max(acc, Number(m.time) || 0) : acc), 0);
                  const relevant = pendingItems.filter((it) => {
                    if (!it || typeof it !== 'object') return false;
                    const s = Number(it.seq) || 0;
                    if (!s) return false;
                    if (unreadSeqs.some((u) => u >= s)) return true;
                    const msg = bySeq.get(s);
                    return !!msg && (Number(msg.time) || 0) > lastSelfAt;
                  });
                  const lastItem = relevant[relevant.length - 1];
                  if (lastItem) {
                    log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${lastItem.reason}@seq${lastItem.seq}（积压 ${pendingItems.length} 条，合并为一次）`);
                    scheduleWakeV2(key, lastItem.reason, { batchMs: 500 }); // [补发直通] 已在未读里等了一整个回合，不再等整窗
                  } else {
                    log(`[reserved2] ${key} 繁忙期间积压的唤醒 ${pendingItems.length} 条已被当前回合处理，跳过补发`);
                  }
                }
              }
              // [并发] 主回合跑完了但台账里还有没接住的点名（比如刚才被人顶着跑了一轮）：
              // 立刻安排一次补答回合。tries 上限（默认 3）保证它不会变成死循环。
              if (asksNeedWakeV2(stEnd)) {
                log('[并发] ' + key + ' 主回合结束仍有没接住的点名，安排补答回合');
                scheduleWakeV2(key, 'asks');
              }
              // [patch 毒会话自愈] 回合正常结束 = 这个会话没中毒，清零连败计数。
              if (ended.reason.kind === 'completed') {
                clearPoisonStreak(key);
                malformedRetryAt.delete(key);
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                recordTurnFailure(frame.sessionId, ended, msg);
                // [patch 毒会话自愈] 先只判断（不立刻退役），等回话发完再退役，
                // 免得中途用到已被清空的会话状态。
                const poisonCode = failureCodeOf(ended, msg);
                const poisoned = notePoisonFailure(key, poisonCode);
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                appendActivity(`${key} agent 处理出错：${safeMsg}`);
                log(`[错误] ${key} agent 处理出错：${safeMsg}`);
                // [patch 坏 JSON 修复重试] provider 那 5 次重试复用同一段上下文，坏法一样就一样坏；
                // 这里补一次「明说了问题在哪儿」的重跑（新采样 + 上下文被这句话改变），
                // 成功就完全不发那句 ⚠️，下一轮当什么都没发生。
                let malformedRepaired = false;
                if (isMalformedCode(poisonCode) && key && cfg.socialV2?.selfHeal?.malformedRetry !== false
                  && claimMalformedRetry(malformedRetryAt, key)) {
                  const retrySession = frame.sessionId;
                  if (isCurrentSession(key, retrySession)) {
                    try {
                      const retryAccepted = await api.sessions.prompt({
                        sessionId: retrySession,
                        mode: 'queue',
                        content: [{ type: 'text', text: MALFORMED_RETRY_HINT }]
                      });
                      malformedRepaired = retryAccepted?.result?.ok === true;
                    } catch (retryError) {
                      log(`[自愈] ${key} 坏 JSON 补跑投递失败：${retryError?.message ?? retryError}`);
                    }
                  }
                  if (malformedRepaired) {
                    log(`[自愈] ${key} 工具参数坏 JSON，已补跑一次（修复提示已投回同一会话）`);
                    appendActivity(`${key} [自愈] 工具参数坏 JSON，已自动补跑一次`);
                  }
                } else if (isMalformedCode(poisonCode) && key) {
                  log(`[自愈] ${key} 工具参数坏 JSON 在冷却窗口内，本次不补跑`);
                }
                if (!malformedRepaired && key === `private:${String(cfg.ownerQQ ?? '')}`) {
                  // 主人私聊就是运维窗口：原文照发，方便一眼定位。
                  await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                } else if (!malformedRepaired) {
                  // 群里/别人私聊里不出现技术报错原文；细节私聊给主人（带去重限流）。
                  await sendToQQ(key, softFailLineV2());
                  await notifyOwnerOfTurnFailure(key, safeMsg);
                }
                if (poisoned) {
                  // 会话级中毒：退役重建，让下一次唤醒走全新会话，而不是每一轮都撞同一堵墙。
                  log(`[自愈] ${key} 连续 ${POISON_STREAK_LIMIT} 次 ${poisonCode}（会话级错误），判定会话中毒，已退役重建`);
                  appendActivity(`${key} [自愈] 连续 ${POISON_STREAK_LIMIT} 次 ${poisonCode}，已退役重建会话`);
                  retireSession(key);
                  await notifyOwnerOfTurnFailure(key, `会话连续 ${POISON_STREAK_LIMIT} 次 ${poisonCode}，已自动退役重建（下次唤醒走新会话）`);
                }
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'interrupted') {
                // [patch 中断补跑] Harness 进程在回合中途死掉/被强杀时，dsh-session 会在下次开会话
                // 补一条 interrupted 收尾事件（"The tool call was interrupted ..."）；那时模型想发的
                // 那句话就丢了。这里补一次「回头检查」，别让回复凭空消失（2026-10-16 真发生过一次）。
                log('[中断] ' + key + ' 回合被中断（Harness 重启/被杀），可能有回复没发出去');
                appendActivity(key + ' [自愈] 回合被中断，检查有没有没发出去的回复');
                let interruptRetried = false;
                if (key && cfg.socialV2?.selfHeal?.interruptRetry !== false
                  && claimMalformedRetry(interruptRetryAt, key, Date.now(), INTERRUPT_RETRY_COOLDOWN_MS)
                  && isCurrentSession(key, frame.sessionId)) {
                  try {
                    const retryAccepted = await api.sessions.prompt({
                      sessionId: frame.sessionId,
                      mode: 'queue',
                      content: [{ type: 'text', text: INTERRUPT_RETRY_HINT }]
                    });
                    interruptRetried = retryAccepted?.result?.ok === true;
                  } catch (retryError) {
                    log('[自愈] ' + key + ' 中断补跑投递失败：' + (retryError?.message ?? retryError));
                  }
                }
                if (interruptRetried) {
                  log('[自愈] ' + key + ' 中断补跑已投回会话');
                } else if (key === 'private:' + String(cfg.ownerQQ ?? '')) {
                  await sendToQQ(key, '（刚才那句被中断了，我再看一眼）');
                }
              } else if (ended.reason.kind === 'aborted') {
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
      snowlumaHealth.firstDownAt = 0;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    void loadFaceTableV2(); // [patch 表情看含义] 连上就补拉一次系统表情表
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
      // [patch 暴躁] @ 我 的识别要用自己的 QQ 号（网关登录信息里有，重连也会刷新）
      if (login?.user_id != null && String(login.user_id)) selfQqId = String(login.user_id);
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      if (r.updated) log(`🔄 已把当前 token 写回 config.json（${String(r.from).slice(0, 4)}… → ${String(r.to).slice(0, 4)}…）`);
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
      if (!snowlumaHealth.firstDownAt) snowlumaHealth.firstDownAt = Date.now();
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  // ── [patch 启动先用本地模式] DSH 离线时也要知道自己是 reserved2（主人 m01940）──
  // 为什么：refreshMode() 只在 checkDsh 探活成功时被调用（bridge.js:3661），所以桥接若
  // 在 DSH 不可达时启动，currentMode 会一直停在硬编码的 'chat'（bridge.js:3261），入站
  // 消息全走一代路径 —— 既不写 reserved2 的 lastIncomingAt 水位，也不进未读/记忆库。
  // 等 DSH 起来、模式切回 reserved2 后，补拉看门狗按这个严重滞后的水位比对 QQ 历史，就
  // 会把早就聊过的消息当成"从未入站"重新补回并叫醒她：主人看到的是「有时候他会回去重新
  // 处理已经处理好的聊天记录」。启动时先跑一次：DSH 连不上时 refreshMode 内部会回退读
  // state/mode.json，所以这一步在离线时同样能把模式定成 reserved2。
  try {
    await refreshMode();
    log(`[bridge] 启动模式：${currentMode}${modeFromDsh ? '（来自 DSH 设置）' : '（来自本地 state/mode.json）'}`);
  } catch (error) {
    log('启动时读取本地模式失败:', error?.message ?? error);
  }
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();
  startStaleUnreadWatch();
  startCatchUpWatch();
  // [patch 日记] 自己的小记/周报：到点让她醒来写一条（过点也会补）。
  startDiaryWatchV2();
  // [承诺/待办] 到期待办看门狗：到点主动提一句。
  startPromiseWatchV2();
  startMemoryMaintenanceV2();
  // [群聊小总结] 到点往群里发一条随口的小总结（默认关，socialV2.groupRecap.enabled）。
  startGroupRecapWatchV2();
  startBroadcastWatchV2();

  // ── [patch 掉线告警] 连不上 OneBot 时定期喊话 ────────────────────────────
  // 为什么：2026-10-07 04:30 那次是 WSL 里 Linux QQ 掉线（SnowLuma 写「session closed」），
  // 端口一直不监听，但保活脚本只判断"进程在不在"，于是静悄悄地聋了 6 小时。
  // 这里只做两件事：写一行可 grep 的告警 + 让 /api/status 给出可操作提示（见 snowlumaHealthSnapshot）。
  let lastDownAlertAt = 0;
  function accountWatchTick() {
    if (snowlumaHealth.connected !== false) { if (snowlumaHealth.firstDownAt) snowlumaHealth.firstDownAt = 0; return; }
    if (!snowlumaHealth.firstDownAt) snowlumaHealth.firstDownAt = Date.now();
    const downMs = Date.now() - snowlumaHealth.firstDownAt;
    if (downMs < 3 * 60_000) return;
    if (Date.now() - lastDownAlertAt < 10 * 60_000) return;
    lastDownAlertAt = Date.now();
    log(`[掉线告警] 已 ${Math.round(downMs / 60000)} 分钟连不上 OneBot（127.0.0.1:3000/:3001）——多半是 WSL 里的 Linux QQ 掉线，请在桌面重新登录 QQ；登录后会自动恢复。`);
  }
  function startAccountWatch() { setInterval(accountWatchTick, 60_000).unref?.(); }
  startAccountWatch();

  // ── [patch 卡死回合看门狗] 回合事件丢失时解除占用并补发唤醒 ──────────────
  const STUCK_TURN_MS = V2_BUSY_STALE_MS;   // 8 分钟没有任何事件就认定卡死
  // [patch 卡死逃逸] key -> 第一次观察到「忙」的时间。给那些没有回合时间戳的占用来源
  // （collectors 残留、promptQueues 卡在 running）一个兜底计时，否则它们永远等不到解除。
  const busySinceV2 = new Map();
  function turnWatchTick() {
    const now = Date.now();
    for (const [key, sid] of Object.entries(state.sessions || {})) {
      if (!sid) continue;
      const parts = busyPartsV2(key, getSocialV2State(key));
      if (!parts.length) { busySinceV2.delete(key); continue; }
      // 只有「真有东西在跑」的占用才需要在没有回合时间戳时兜底：pendingWakeTimer 和
      // pendingWakeKeys 各自有自己的定时器与 30 分钟租约，不该被这里抢着清。
      const escapable = parts.some((p) => p === 'turnOpen' || p === 'collectorOpen' || p === 'collectorStale' || p === 'queueRunning');
      if (!escapable) { busySinceV2.delete(key); continue; }
      if (!busySinceV2.has(key)) { busySinceV2.set(key, now); continue; }
      const lastAt = v2LastFrameAt.get(sid) || v2TurnStartAt.get(sid) || busySinceV2.get(key) || now;
      const idleMs = now - lastAt;
      if (idleMs < STUCK_TURN_MS) continue;
      const mins = Math.round(idleMs / 60000);
      log(`[看门狗] ${key} 会话疑似卡死（${mins} 分钟无任何事件，占用来源：${parts.join('+')}），解除占用并尝试补发积压唤醒`);
      v2TurnStartAt.delete(sid);
      collectors.delete(sid);
      v2LastFrameAt.delete(sid);
      pendingSendToolCalls.delete(sid);
      toolCallNames.delete(sid);
      pendingWakeKeys.delete(key);
      busySinceV2.delete(key);
      const qw = promptQueues.get(key);
      if (qw && qw.running) {
        // deliverPromptNow 卡在某个 await 上（例如 ensureSession 的 HTTP 请求永远不返回）
        // 时，processPromptQueue 的 finally 永不执行，running 会一直为 true。这里强制复位，
        // 让队列能继续往下走，积压的 prompt 不至于被丢掉。
        log(`[看门狗] ${key} 投递队列卡在 running，强制复位（积压 ${qw.queue.length} 条）`);
        qw.running = false;
        try { processPromptQueue(key); } catch (error) { log(`[看门狗] ${key} 队列续跑失败: ${error?.message ?? error}`); }
      }
      const stW = getSocialV2State(key);
      const items = Array.isArray(stW?.pendingWakeReasons) ? stW.pendingWakeReasons.splice(0) : [];
      if (items.length) {
        const lastItem = items[items.length - 1];
        log(`[看门狗] ${key} 补发积压唤醒 ${lastItem?.reason}@seq${lastItem?.seq}（共 ${items.length} 条）`);
        try { scheduleWakeV2(key, lastItem?.reason || 'timeout', { batchMs: 500 }); } catch (error) { log(`[看门狗] ${key} 补发失败: ${error?.message ?? error}`); } // [补发直通]
      }
    }
  }
  function startTurnWatch() { setInterval(turnWatchTick, 60_000).unref?.(); }
  startTurnWatch();

  // ── [patch AstrBot 看门狗] 端口失联 / 事件循环卡死 → 定向重启 AstrBot ──────────
  // 背景：2026-10-07 AstrBot 的事件循环卡死了 3 小时（service.log 里 "Event loop lag detected: 11191s"），
  // 端口还占着、进程还在，但平台连接与回复全废，只能靠人翻日志发现。
  // 计划任务那条路实测在计划任务上下文里会挂住（脚本进程不退出、任务结果一直失败），
  // 所以改由桥接自己看——它本来就常驻，而且已有其它看门狗。
  //
  // [patch 2026-10-19] 两条修正，都出自今天凌晨的实录（证据在 src/astrbot-watch-lib.js 头部）：
  //   ① 「事件循环卡死 12583s」是 Modern Standby（S0 新型待机）冻住整个桌面栈造成的
  //      假警报：05:08:45 进待机 → 09:08:03 鼠标唤醒，诊断在唤醒后 1 秒记下 lag，
  //      而进程其实健康（WS 自己重连了）。所以最近退出过待机就只记账、不重启。
  //   ② 老重启路径「detached 盲 spawn ps1 + 脚本里 SilentlyContinue」失败时无从得知
  //      （09:08 点了重启，真身 python.exe 根本没被杀掉）。现在按端口占用者杀 + 走
  //      start-services 拉起 + 把杀了谁记进日志；重启 3 分钟后仍异常就大声报。
  const ASTRBOT_PORT = Number(cfg.astrbot?.port) || 6185;
  // 这两个路径过去写死成 `C:/Users/<用户名>/...`：既把本机用户名带进公开仓库，换台机器也直接失效。
  // 现在默认按仓库位置推（同级目录），并允许 config.json 的 astrbot.serviceLog / restartScript 覆盖。
  const ASTRBOT_SVC_LOG = cfg.astrbot?.serviceLog || path.join(ROOT, '..', 'astrbot', 'logs', 'service.log');
  const ASTRBOT_START_PS1 = path.join(ROOT, '..', 'qq-dsh-bridge', 'start-services.ps1');
  const ASTRBOT_RESTART_PS1 = cfg.astrbot?.restartScript
    || path.join(ROOT, '..', 'qq-dsh-bridge', 'scripts', 'astrbot-restart-only.ps1');
  let astrbotLastRestartAt = 0;
  let astrbotEscalatedAt = 0;
  let astrbotResumeSkipLoggedAt = 0;

  /** 跑一段 PowerShell 并把 stdout 收回来（有超时；老路是 stdio:'ignore' 全盲发）。 */
  function runPowerShellCapture(script, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        done(out.trim());
      }, timeoutMs);
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
      child.stdout.on('data', (d) => { out += String(d); if (out.length > 4000) out = out.slice(-4000); });
      child.on('error', () => { clearTimeout(timer); done(''); });
      child.on('close', () => { clearTimeout(timer); done(out.trim()); });
    });
  }

  async function astrbotProblem() {
    try {
      const res = await fetch(`http://127.0.0.1:${ASTRBOT_PORT}/`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return `端口返回 HTTP ${res.status}`;
    } catch (error) {
      return `端口探活失败（${error?.message ?? error}）`;
    }
    try {
      const lines = fs.readFileSync(ASTRBOT_SVC_LOG, 'utf8').split('\n').slice(-200);
      const now = new Date();
      for (const line of lines) {
        const m = line.match(/lag detected:\s*([0-9.]+)s/);
        if (!m || Number(m[1]) < 30) continue;
        const t = line.match(/\[(\d{2}):(\d{2}):(\d{2})/);
        if (!t) continue;
        const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(t[1]), Number(t[2]), Number(t[3]));
        if (Math.abs(now - at) < 10 * 60000) return `事件循环卡死 ${m[1]}s（最近 10 分钟内）`;
      }
    } catch { /* 读不到日志就不判定 */ }
    return '';
  }

  /** 最近 10 分钟内退出新型待机（kernel-power 507）的条数；查不动按 0 算。 */
  async function recentStandbyResumeCount() {
    try {
      const out = await runPowerShellCapture(astrbotStandbyResumeScript(10), 25000);
      return Number(out) || 0;
    } catch { return 0; }
  }

  /** 杀端口占用者（精准命中真身）→ 等 2 秒 → 走 start-services 拉起来。返回杀掉的 pid。 */
  async function restartAstrbot() {
    const killed = await runPowerShellCapture(astrbotKillByPortScript(ASTRBOT_PORT));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ASTRBOT_START_PS1, '-Only', 'astrbot'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (error) {
      throw new Error(`start-services 拉起 AstrBot 失败：${error?.message ?? error}`);
    }
    return killed;
  }

  async function astrbotWatchTick() {
    const bad = await astrbotProblem();
    if (!bad) return;
    // ① 系统待机恢复的假警报：进程健康，只记账（30 分钟内不重复刷）
    const resumeCount = await recentStandbyResumeCount();
    if (shouldSkipAstrbotRestartOnResume(bad, resumeCount)) {
      if (Date.now() - astrbotResumeSkipLoggedAt > 30 * 60000) {
        astrbotResumeSkipLoggedAt = Date.now();
        log(`[AstrBot 看门狗] ${bad}；但系统刚从新型待机恢复（整个桌面栈一起冻过，诊断报了假 lag），进程是健康的，跳过重启`);
      }
      return;
    }
    if (Date.now() - astrbotLastRestartAt < 15 * 60000) {
      // ② 重启 3 分钟还不好的，大声报——老路的静默失败（点了重启其实没杀成）不能再发生
      if (Date.now() - astrbotLastRestartAt > 3 * 60000 && Date.now() - astrbotEscalatedAt > 15 * 60000) {
        astrbotEscalatedAt = Date.now();
        log(`[AstrBot 看门狗] 重启已过 3 分钟仍异常（${bad}）：自动重启可能没生效，请手动跑 ${ASTRBOT_RESTART_PS1} 或翻 astrbot/logs/service.log`);
      }
      return;
    }
    astrbotLastRestartAt = Date.now();
    log(`[AstrBot 看门狗] 检测到异常（${bad}），定向重启 AstrBot`);
    try {
      const killed = await restartAstrbot();
      log(`[AstrBot 看门狗] 重启已执行：杀掉端口占用者 pid=${killed || '（无，端口本就没占）'}，已走 start-services 拉起`);
    } catch (error) {
      log(`[AstrBot 看门狗] 重启失败：${error?.message ?? error}`);
    }
  }
  function startAstrBotWatch() { setInterval(() => { astrbotWatchTick().catch(() => {}); }, 120000).unref?.(); }
  startAstrBotWatch();

  // ── [patch 模型看门狗] 免费模型被限流/下线时自动切到备选链的下一个 ──────────────
  // 背景：2026-10-07 免费车道 upstream 返回 "Error from provider (Console): Rate limit exceeded"，
  // 她的回合直接失败（free-model 统计里 longcat 90 次调用挂了 8 次，且失败都是 in=0 秒挂）。
  // 桥接看不到 DSH 侧的模型错误（sessions.prompt 是 queue 模式，异步失败不回报），
  // 但免费模型插件把每次调用都写进 stats.json（含 ok 与 at），所以用它当探针。
  // 免费模型插件的状态目录：同样别写死本机绝对路径，默认取仓库同级，可用 config.json 覆盖。
  const FREE_MODEL_DIR = cfg.freeModel?.dir || path.join(ROOT, '..', 'our-free-model');
  let modelHealthLastAt = 0;
  function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
  function pickFallbackModel() {
    const avail = readJsonSafe(FREE_MODEL_DIR + '/availability.json');
    const stats = readJsonSafe(FREE_MODEL_DIR + '/stats.json');
    const nowMs = Date.now();
    const recentFail = (m) => (Array.isArray(stats?.samples) ? stats.samples : []).filter((x) => x && x.model === m && x.ok === false && nowMs - Number(x.at || 0) < 15 * 60000).length;
    const candidates = [cfg.dsh?.model, ...(Array.isArray(cfg.dsh?.modelFallbacks) ? cfg.dsh.modelFallbacks : [])].filter(Boolean);
    for (const m of candidates) {
      const state = avail?.results?.[m]?.state;
      if (state && state !== 'available') continue;      // 明确不可用就跳过
      if (recentFail(m) >= 2) continue;                  // 最近 15 分钟挂了 ≥2 次也跳过
      return m;
    }
    return '';
  }
  function modelHealthTick() {
    if (Date.now() - modelHealthLastAt < 5 * 60000) return;
    modelHealthLastAt = Date.now();
    // 只对免费车道（our-free-model）生效：官方 DeepSeek 模型不在免费插件的统计里，
    // 一旦放行会被误判成「有问题」然后切走。
    if (String(cfg.dsh?.provider || '') !== 'our-free-model') return;
    const cur = String(cfg.dsh?.model || '');
    if (!cur) return;
    const avail = readJsonSafe(FREE_MODEL_DIR + '/availability.json');
    const state = avail?.results?.[cur]?.state;
    const stats = readJsonSafe(FREE_MODEL_DIR + '/stats.json');
    const nowMs = Date.now();
    const fails = (Array.isArray(stats?.samples) ? stats.samples : []).filter((x) => x && x.model === cur && x.ok === false && nowMs - Number(x.at || 0) < 15 * 60000).length;
    const bad = (state && state !== 'available') || fails >= 2;
    if (!bad) return;
    const next = pickFallbackModel();
    if (!next || next === cur) { log(`[模型看门狗] ${cur} 有问题（state=${state || '未知'}，15 分钟内失败 ${fails} 次），但备选链里没有可用的`); return; }
    cfg.dsh.model = next;
    try {
      const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
      file.dsh = { ...(file.dsh ?? {}), model: next };
      fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(file, null, 2) + '\n', 'utf8');
    } catch (error) { log(`[模型看门狗] 写回 config.json 失败：${error?.message ?? error}`); }
    modelSelectionEpoch += 1;   // 让已在跑的会话在下一条消息重新 selectModel
    log(`[模型看门狗] ${cur} 有问题（state=${state || '未知'}，15 分钟内失败 ${fails} 次）→ 已切到 ${next}（下一条消息生效）`);
  }
  function startModelHealthWatch() { setInterval(modelHealthTick, 60000).unref?.(); }
  startModelHealthWatch();
  void loadFaceTableV2(); // [patch 表情看含义] 启动就把系统表情表载进内存，第一张表情来了不用等

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
