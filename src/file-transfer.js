// file-transfer.js — QQ 文件收发核心模块
//
// 设计要点（与现有 qq_send_message / 图片发送同构）：
//   - 所有 OneBot 动作最终走 deps.oneBotCall(action, params)，打到 SnowLuma(:3000)。
//   - 发送：私聊用 upload_private_file，群聊用 upload_group_file；本地文件需把 Windows
//     路径转成 WSL 能读的 file:///mnt/<盘>/...（SnowLuma 跑在 WSL 里，与图片同套路）。
//   - 接收：onNotice 把文件类事件丢进来，这里负责下载、落盘、写索引。私聊文件在 OneBot
//     里是 offline_file notice（字段不定），所以 parseNotice 做了宽松归一，未知结构一律
//     dump 原始事件到磁盘，绝不丢数据。
//   - 落盘目录：<STATE_DIR>/files/inbox/<本地日期>/，索引在 <STATE_DIR>/files/inbox-index.jsonl。
//
// deps 契约：
//   oneBotCall(action, params)  必需，OneBot HTTP 调用
//   cfg                       必需，配置对象（读 socialV2.files.maxBytes / inboxDir）
//   ROOT                      必需，仓库根（相对路径解析 base）
//   STATE_DIR                 必需，状态目录
//   log                       可选，日志函数（缺省 noop）

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { localDayString } from './day-key.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB

function noop() {}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + u[i];
}

// 索引 seq：同一毫秒内连收两个文件会撞号（Date.now() 相同），之后按 seq 取件会取错。
// 用「至少比上一个大 1」保证进程内严格递增；重启后 Date.now() 必然大于旧值，无需持久化。
let lastSeq = 0;
function nextSeq() {
  const now = Date.now();
  lastSeq = now > lastSeq ? now : lastSeq + 1;
  return lastSeq;
}

// 收件目录覆盖状态：AI 经 setInboxDir 设置「接收文件存到哪」，持久化到磁盘。
// 只接受 Windows 盘符绝对路径，避免相对路径/网络路径造成歧义或越界写盘。
function isAbsWinDir(s) {
  return /^[A-Za-z]:[\\/]/.test(String(s || '').trim());
}
function readTransferState(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch { return {}; }
}
function writeTransferState(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch {}
}

// Windows 绝对路径 → WSL 文件引用（与 bridge.js qzoneImageRef 同构）。
// 接受：Windows 盘符绝对路径 / 相对 ROOT 的路径 / file:// 引用 / base64: 引用。
// 网络 URL 暂不支持（先把文件下到本地再发）。
function winPathToWslRef(raw, ROOT) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('filePath 不能为空');
  if (/^https?:/i.test(s)) throw new Error('暂不支持直接发送网络 URL（请先把文件下载到本地）');
  if (/^base64:/i.test(s)) return s;
  if (/^file:\/\//i.test(s)) return s.replace(/\\/g, '/');
  const abs = path.isAbsolute(s) ? s : path.resolve(ROOT, s);
  if (!fs.existsSync(abs)) throw new Error('找不到文件：' + abs);
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  if (!win) throw new Error('只支持 Windows 盘符路径（或 file:// / base64:// 引用）：' + abs);
  return 'file:///mnt/' + win[1].toLowerCase() + '/' + win[2].replace(/\\/g, '/');
}

// 清洗文件名，防目录穿越与非法字符。
function sanitizeName(name) {
  let s = String(name ?? '').trim();
  if (!s) s = 'file';
  // 去掉路径分隔符、Windows 非法字符与控制字符，统一空格。
  // ⚠️ 这里必须写 `\x00-\x1f` 的**转义形式**：曾经在源码里嵌裸控制字节（0x01/0x1F），
  // 功能等价但编辑器/格式化工具一碰就坏，且肉眼看不出正则到底匹配了什么。
  // 也不能写成 `|-\x7f`：那样 `|` 与 `\x7f` 之间会被当成字符范围（`|` `}` `~` DEL），
  // 把正常文件名里的 `~` `}` 也替换掉。
  s = s.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/\s+/g, ' ').trim();
  // Windows 不允许以点或空格结尾的文件名。
  s = s.replace(/[. ]+$/, '').trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  if (!s) s = 'file';
  return s;
}

// 避免同目录重名：name → name(1) → name(2) ...
async function uniquePath(dir, name) {
  const base = path.join(dir, name);
  if (!fs.existsSync(base)) return base;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10000; i++) {
    const cand = path.join(dir, `${stem}(${i})${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${name}.${Date.now()}`);
}

// 取第一个非空字符串（去空白）。用于抹平各家 OneBot 实现的字段命名差异。
function pickStr(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}
function pickNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

// 归一各种 notice 结构的字段。返回 null 表示不像文件事件。
//
// ⚠️ 真实报文里文件字段是**嵌套在 `file` 对象里**的，而且 id 的键名各家不同：
//   go-cqhttp / NapCat 私聊：{ notice_type:'offline_file', user_id, file:{ id, name, size, url } }
//   NapCat 部分版本：        { notice_type:'offline_file', user_id, file:{ uuid, name, size, url } }
//   标准群文件：             { notice_type:'group_upload', group_id, user_id, file:{ id, name, size, busid } }
// 早期版本只读顶层 `file_id`，导致以上三种**全部解析成 null**、只能走 dump 分支
// （数据不丢，但永远下不下来）。现在先解包 `file`，再回退到顶层字段。
function parseNotice(e) {
  if (!e || typeof e !== 'object') return null;
  // `file` 可能是对象，也可能直接是字符串形式的 file_id。
  const rawFile = e.file;
  const f = rawFile && typeof rawFile === 'object' ? rawFile : {};
  const fileStr = typeof rawFile === 'string' ? rawFile.trim() : '';
  const fileId = pickStr(
    f.id, f.file_id, f.fileId, f.uuid, fileStr,
    e.file_id, e.fileId, e.uuid
  );
  if (!fileId) return null;
  const name = pickStr(f.name, f.file_name, f.fileName, e.file_name, e.fileName, e.name) || null;
  const size = pickNum(f.size, f.file_size, f.fileSize, e.file_size, e.fileSize, e.size);
  const fileHash = pickStr(f.file_hash, f.fileHash, f.md5, e.file_hash, e.fileHash);
  const busid = pickNum(f.busid, e.busid) || undefined;
  // offline_file 通常自带下载直链，优先用它，省一次 API 往返，也绕开
  // 「get_private_file_url 并非所有实现都支持」的兼容问题。
  const url = pickStr(f.url, f.file_url, f.fileUrl, e.url, e.file_url);
  const groupId = pickStr(e.group_id, e.groupId) || null;
  const userId = pickStr(e.user_id, e.userId);
  const kind = groupId ? 'group' : 'private';
  return {
    fileId,
    name,
    size,
    fileHash,
    busid,
    url,
    kind,
    fromQQ: String(groupId || userId || ''),
    fromKey: groupId ? `group:${groupId}` : `private:${userId}`,
    noticeType: pickStr(e.notice_type, e.noticeType)
  };
}

async function downloadFile(p, oneBotCall) {
  // ① 事件自带直链（offline_file 基本都有）——直接用。
  let url = /^https?:/i.test(p.url || '') ? p.url : null;
  if (!url) {
    if (p.kind === 'private') {
      const r = await oneBotCall('get_private_file_url', {
        user_id: Number(p.fromQQ),
        file_id: p.fileId,
        file_hash: p.fileHash,
      }).catch(() => null);
      url = r?.url || r?.file_url || null;
    } else {
      const r = await oneBotCall('get_group_file_url', {
        group_id: Number(p.fromQQ),
        file_id: p.fileId,
        busid: p.busid,
      }).catch(() => null);
      url = r?.url || r?.file_url || null;
    }
  }
  if (!url && p.fileId) {
    // ② 兜底：OneBot 通用媒体下载，可能直接返回 base64。
    const g = await oneBotCall('get_file', { file_id: p.fileId }).catch(() => null);
    if (g?.base64) return Buffer.from(g.base64, 'base64');
    if (g?.url) url = g.url;
  }
  if (!url) throw new Error('无法获取文件下载 URL（事件未带 url，且 get_*_file_url / get_file 都没返回）');
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('下载 HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

function readIndex(stateDir) {
  const f = path.join(stateDir, 'files', 'inbox-index.jsonl');
  if (!fs.existsSync(f)) return [];
  try {
    return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendIndex(stateDir, entry) {
  const dir = path.join(stateDir, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'inbox-index.jsonl');
  const seq = nextSeq();
  const line = JSON.stringify({ seq, ...entry });
  fs.appendFileSync(f, line + '\n');
  return seq;
}

export function createFileTransfer(deps) {
  const oneBotCall = deps.oneBotCall;
  if (typeof oneBotCall !== 'function') throw new Error('createFileTransfer 需要 deps.oneBotCall');
  const cfg = deps.cfg || {};
  const ROOT = deps.ROOT || process.cwd();
  const STATE_DIR = deps.STATE_DIR || ROOT;
  const log = typeof deps.log === 'function' ? deps.log : noop;

  const maxBytes = () => Number(cfg?.socialV2?.files?.maxBytes) || DEFAULT_MAX_BYTES;

  const TRANSFER_STATE = path.join(STATE_DIR, 'files', 'transfer-state.json');

  // 计算实际收件目录，优先级：AI 指定的覆盖 > 配置 socialV2.files.inboxDir > 默认 state/files/inbox。
  // AI 指定/配置的目录直接平铺存放（用户已明确位置，再套一层日期反而烦）；默认目录按日期归档。
  function resolveInboxDir() {
    const st = readTransferState(TRANSFER_STATE);
    if (st.inboxDir && isAbsWinDir(st.inboxDir)) {
      return { dir: path.resolve(String(st.inboxDir)), withDate: false };
    }
    const cfgDir = cfg?.socialV2?.files?.inboxDir;
    if (cfgDir && isAbsWinDir(cfgDir)) {
      return { dir: path.resolve(String(cfgDir)), withDate: true };
    }
    return { dir: path.join(STATE_DIR, 'files', 'inbox'), withDate: true };
  }

  function setInboxDir(dir) {
    const st = readTransferState(TRANSFER_STATE);
    if (!dir) {
      delete st.inboxDir;
      writeTransferState(TRANSFER_STATE, st);
      return { ok: true, cleared: true, inboxDir: resolveInboxDir().dir };
    }
    if (!isAbsWinDir(dir)) {
      throw new Error('收件目录必须是 Windows 绝对路径，例如 D:/我的文件（不支持相对路径或网络路径）');
    }
    const abs = path.resolve(String(dir).trim());
    st.inboxDir = abs;
    writeTransferState(TRANSFER_STATE, st);
    return { ok: true, inboxDir: abs };
  }

  function getInboxDir() {
    const r = resolveInboxDir();
    return { inboxDir: r.dir, withDate: r.withDate };
  }

  // ── 发送文件 ────────────────────────────────────────────────────────────
  async function sendFile({ key, filePath, name }) {
    const m = /^(group|private):(\d+)$/.exec(String(key || '').trim());
    if (!m) throw new Error('key 格式应为 group:群号 或 private:QQ号');
    const kind = m[1];
    const id = m[2];
    const ref = winPathToWslRef(filePath, ROOT); // 抛错：不存在/非法
    let size = 0;
    const lowerRaw = String(filePath).trim().toLowerCase();
    if (!/^(https?:|base64:|file:\/\/)/i.test(lowerRaw)) {
      try {
        const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
        size = fs.statSync(abs).size;
      } catch {}
    }
    const limit = maxBytes();
    if (size > limit) throw new Error(`文件过大（${formatBytes(size)} > ${formatBytes(limit)}），已拒绝发送`);
    const finalName = sanitizeName(name || String(filePath).replace(/[\\/]/g, '/').split('/').pop() || 'file');
    const action = kind === 'private' ? 'upload_private_file' : 'upload_group_file';
    const params = kind === 'private'
      ? { user_id: Number(id), file: ref, name: finalName, upload_file: true }
      : { group_id: Number(id), file: ref, name: finalName, upload_file: true };
    const data = await oneBotCall(action, params);
    log(`[文件] 发送 ${kind}:${id} 文件=${finalName} → ${action} file_id=${data?.file_id ?? 'null'}`);
    return { ok: true, fileId: data?.file_id ?? null, action, name: finalName, size, data };
  }

  // ── 接收文件 ────────────────────────────────────────────────────────────
  // 返回 { ok, savedPath, meta } 或 { ok:false, reason, dumped }
  async function handleFileNotice(event) {
    const parsed = parseNotice(event);
    const { dir: baseDir, withDate } = resolveInboxDir();
    const dir = withDate ? path.join(baseDir, localDayString()) : baseDir;
    fs.mkdirSync(dir, { recursive: true });
    if (!parsed || !parsed.fileId) {
      const dump = path.join(dir, `${Date.now()}.unknown-event.json`);
      await fsp.writeFile(dump, JSON.stringify(event, null, 2)).catch(() => {});
      log('[文件] 收到无法识别的文件类 notice，已 dump 原始事件到 ' + dump);
      return { ok: false, reason: 'unrecognized-notice', dumped: dump };
    }
    let buf = null;
    let downloadErr = null;
    try { buf = await downloadFile(parsed, oneBotCall); }
    catch (e) { downloadErr = e?.message ?? String(e); log('[文件] 下载失败：' + downloadErr); }

    const safeName = sanitizeName(parsed.name || 'file');
    let finalPath = await uniquePath(dir, safeName);
    if (buf && buf.length) {
      await fsp.writeFile(finalPath, buf);
    } else {
      // 下载失败：仍落盘元信息，便于事后用 file_id 重试。
      finalPath = finalPath + '.download-failed';
      await fsp.writeFile(finalPath, JSON.stringify({ ...parsed, downloadErr }, null, 2)).catch(() => {});
    }
    const seq = appendIndex(STATE_DIR, {
      receivedAt: new Date().toISOString(),
      fromKey: parsed.fromKey,
      fromQQ: parsed.fromQQ,
      name: safeName,
      size: parsed.size || (buf ? buf.length : 0),
      savedPath: finalPath,
      fileId: parsed.fileId,
      fileHash: parsed.fileHash,
      kind: parsed.kind,
      noticeType: parsed.noticeType,
      downloaded: !!buf,
      ...(downloadErr ? { downloadErr } : {}),
    });
    return {
      ok: true,
      savedPath: finalPath,
      meta: { seq, name: safeName, size: parsed.size, downloaded: !!buf },
    };
  }

  // ── 收件箱查询 ──────────────────────────────────────────────────────────
  function listInbox(limit = 50) {
    const all = readIndex(STATE_DIR);
    const items = all.slice(-Math.max(1, Number(limit) || 50)).reverse();
    return { count: items.length, items };
  }

  // 读取收件箱某条文本（seq）。非文本或过大时返回提示。
  async function readInboxText(seq) {
    const all = readIndex(STATE_DIR);
    const entry = all.find((e) => String(e.seq) === String(seq));
    if (!entry) return { ok: false, error: '未找到该收件（seq=' + seq + '）' };
    if (!entry.downloaded) return { ok: false, error: '该文件当时下载失败，无法读取', entry };
    let stat;
    try { stat = await fsp.stat(entry.savedPath); } catch { return { ok: false, error: '文件已不在磁盘', entry }; }
    const MAX_TEXT = 200 * 1024;
    if (stat.size > MAX_TEXT) {
      return { ok: false, error: `文件过大（${formatBytes(stat.size)}）无法作为文本读取，请用其它工具打开：${entry.savedPath}` };
    }
    const buf = await fsp.readFile(entry.savedPath);
    // 粗略判定是否像文本（含 NUL 字节则当二进制）
    if (buf.includes(0)) return { ok: false, error: '该文件看起来是二进制，无法作为文本读取', savedPath: entry.savedPath };
    return { ok: true, name: entry.name, text: buf.toString('utf8') };
  }

  return { sendFile, handleFileNotice, listInbox, readInboxText, parseNotice, setInboxDir, getInboxDir };
}
