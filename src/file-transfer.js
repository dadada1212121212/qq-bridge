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
//   cfg                       必需，配置对象（读 socialV2.files.enabled/maxBytes/inboxDir）
//   ROOT                      必需，仓库根（相对路径解析 base）
//   STATE_DIR                 必需，状态目录
//   log                       可选，日志函数（缺省 noop）
//   swallow(tag, err, detail) 可选，静默失败记账（缺省只打日志）——见 src/silent-failures.js

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { localDayString } from './day-key.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB
// 索引超过这个行数就压缩一次（保留最近一半）。收件箱是"最近的有用"，历史全留没意义，
// 而且 readIndex 每次要整文件 parse，行数越多越慢。
const MAX_INDEX_ROWS = 2000;
const ROTATE_CHECK_EVERY = 200;

// 明确拒绝的收件目录：盘符根、Windows 系统目录。AI 有可能被用户话术带偏，
// 「存到 C:\Windows\System32」这种不该照做。
const FORBIDDEN_DIR_RE = new RegExp(
  '^[A-Za-z]:[\\\\/]?(?:$'
  + '|windows(?:[\\\\/]|$)'
  + '|program files(?: \\(x86\\))?(?:[\\\\/]|$)'
  + '|programdata(?:[\\\\/]|$)'
  + '|system volume information(?:[\\\\/]|$)'
  + ')',
  'i'
);

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
function isForbiddenDir(s) {
  return FORBIDDEN_DIR_RE.test(String(s || '').trim());
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
    return true;
  } catch { return false; }
}

// file:// 引用 → Windows 本地路径（用于发送前 stat 大小）。
// 同时认 WSL 风格 `file:///mnt/d/x` 和直写盘符 `file:///D:/x`。认不出返回 null。
function refToLocalPath(ref) {
  const s = String(ref || '');
  const wsl = /^file:\/\/\/mnt\/([a-z])\/(.*)$/i.exec(s);
  if (wsl) return `${wsl[1].toUpperCase()}:/${wsl[2]}`;
  const win = /^file:\/\/\/([A-Za-z]:\/.*)$/.exec(s);
  if (win) return win[1];
  return null;
}

// 从用户/AI 给的 filePath 推出本地真实路径（拿不到就 null：base64、http、无法映射的 file://）。
function resolveLocalFile(raw, ROOT) {
  const s = String(raw ?? '').trim();
  if (!s || /^(https?:|base64:)/i.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    const p = refToLocalPath(s);
    return p ? path.resolve(p) : null;
  }
  return path.isAbsolute(s) ? s : path.resolve(ROOT, s);
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

// 原子地占一个不重名的文件句柄：name → name(1) → name(2) ...
//
// 不能用「先 existsSync 再写」：两个同名文件几乎同时到达时，两次检查都会说"不存在"，
// 于是抢到同一个路径互相覆盖。用 `wx`（独占创建）让文件系统来裁决，EEXIST 就换下一个名字。
async function openUnique(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 10000; i++) {
    const cand = path.join(dir, i ? `${stem}(${i})${ext}` : name);
    try {
      return { path: cand, fh: await fsp.open(cand, 'wx') };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('无法分配唯一文件名：' + name);
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

// 拿到下载直链（或 base64 兜底）。事件自带 url 时直接用，省一次 API 往返。
async function resolveDownload(p, oneBotCall) {
  if (/^https?:/i.test(p.url || '')) return { url: p.url };
  if (p.kind === 'private') {
    const r = await oneBotCall('get_private_file_url', {
      user_id: Number(p.fromQQ),
      file_id: p.fileId,
      file_hash: p.fileHash,
    }).catch(() => null);
    if (r?.url || r?.file_url) return { url: r.url || r.file_url };
  } else {
    const r = await oneBotCall('get_group_file_url', {
      group_id: Number(p.fromQQ),
      file_id: p.fileId,
      busid: p.busid,
    }).catch(() => null);
    if (r?.url || r?.file_url) return { url: r.url || r.file_url };
  }
  // 兜底：OneBot 通用媒体下载，可能直接返回 base64。
  const g = await oneBotCall('get_file', { file_id: p.fileId }).catch(() => null);
  if (g?.base64) return { base64: g.base64 };
  if (g?.url) return { url: g.url };
  return {};
}

// 下载并写入已打开的句柄（调用方负责关闭），**边下边写、边计数**，超限立刻中止。
//
// 为什么必须这样：原来是 `Buffer.from(await res.arrayBuffer())` 全量进内存，
// 对方发个 2GB 文件就能把桥接进程直接 OOM 掉（发送侧有 maxBytes，接收侧却一点不设防）。
// 先看 Content-Length 能省掉大部分无效下载；流式计数兜住"没给长度"或"长度撒谎"的情况。
async function downloadToFile(p, oneBotCall, fh, limitBytes) {
  const got = await resolveDownload(p, oneBotCall);
  if (got.base64) {
    const buf = Buffer.from(got.base64, 'base64');
    if (buf.length > limitBytes) {
      throw new Error(`文件过大（${formatBytes(buf.length)} > ${formatBytes(limitBytes)}），已放弃接收`);
    }
    await fh.write(buf);
    return { bytes: buf.length };
  }
  if (!got.url) {
    throw new Error('无法获取文件下载 URL（事件未带 url，且 get_*_file_url / get_file 都没返回）');
  }
  const res = await fetch(got.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('下载 HTTP ' + res.status);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limitBytes) {
    try { await res.body?.cancel(); } catch { /* 已放弃，取消失败无所谓 */ }
    throw new Error(`文件过大（${formatBytes(declared)} > ${formatBytes(limitBytes)}），已放弃接收`);
  }
  let written = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      written += chunk.length;
      if (written > limitBytes) {
        throw new Error(`文件过大（已超过 ${formatBytes(limitBytes)}），下载中止`);
      }
      await fh.write(chunk);
    }
  }
  return { bytes: written };
}

// 索引缓存：按 mtime + size 失效。listInbox / readInboxText / 去重判断都要读它，
// 每次都整文件 parse 太浪费（收件箱是高频查询）。
let indexCache = { file: '', mtimeMs: -1, size: -1, rows: [] };

function readIndex(stateDir) {
  const f = path.join(stateDir, 'files', 'inbox-index.jsonl');
  let st;
  try { st = fs.statSync(f); } catch {
    indexCache = { file: f, mtimeMs: -1, size: -1, rows: [] };
    return [];
  }
  if (indexCache.file === f && indexCache.mtimeMs === st.mtimeMs && indexCache.size === st.size) {
    return indexCache.rows;
  }
  let rows = [];
  try {
    rows = fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { rows = []; }
  indexCache = { file: f, mtimeMs: st.mtimeMs, size: st.size, rows };
  return rows;
}

// 索引压缩：超过 MAX_INDEX_ROWS 就只留最近一半，防止无限增长。
// 用 tmp + rename 原子替换，中途崩了也不会留下半个文件。
function maybeRotateIndex(f) {
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()); } catch { return false; }
  if (lines.length <= MAX_INDEX_ROWS) return false;
  const keep = lines.slice(-Math.floor(MAX_INDEX_ROWS / 2));
  try {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, keep.join('\n') + '\n');
    fs.renameSync(tmp, f);
    indexCache = { file: '', mtimeMs: -1, size: -1, rows: [] }; // 强制下次重读
    return true;
  } catch { return false; }
}

let appendCount = 0;
function appendIndex(stateDir, entry) {
  const dir = path.join(stateDir, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'inbox-index.jsonl');
  const seq = nextSeq();
  fs.appendFileSync(f, JSON.stringify({ seq, ...entry }) + '\n');
  // 压缩检查不能每次都做（要整文件读），每 ROTATE_CHECK_EVERY 次才看一遍。
  if (++appendCount % ROTATE_CHECK_EVERY === 0) maybeRotateIndex(f);
  return seq;
}

export function createFileTransfer(deps) {
  const oneBotCall = deps.oneBotCall;
  if (typeof oneBotCall !== 'function') throw new Error('createFileTransfer 需要 deps.oneBotCall');
  const cfg = deps.cfg || {};
  const ROOT = deps.ROOT || process.cwd();
  const STATE_DIR = deps.STATE_DIR || ROOT;
  const log = typeof deps.log === 'function' ? deps.log : noop;
  // 吞异常一律走记账（仓库约定：别用裸 catch {}，否则"静默失败"查不到痕迹）。
  const swallow = typeof deps.swallow === 'function'
    ? deps.swallow
    : (tag, error, detail) => { try { log(`[静默失败] ${tag}${detail ? '：' + detail : ''}：${error?.message ?? error}`); } catch { /* 日志本身失败无所谓 */ } };

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
      if (!writeTransferState(TRANSFER_STATE, st)) {
        throw new Error('清除收件目录失败：状态文件写不进去（' + TRANSFER_STATE + '）');
      }
      return { ok: true, cleared: true, inboxDir: resolveInboxDir().dir };
    }
    if (!isAbsWinDir(dir)) {
      throw new Error('收件目录必须是 Windows 绝对路径，例如 D:/我的文件（不支持相对路径或网络路径）');
    }
    if (isForbiddenDir(dir)) {
      throw new Error('拒绝把收件目录设为系统目录（盘符根 / Windows / Program Files / ProgramData）：' + dir);
    }
    const abs = path.resolve(String(dir).trim());
    st.inboxDir = abs;
    if (!writeTransferState(TRANSFER_STATE, st)) {
      throw new Error('设置收件目录失败：状态文件写不进去（' + TRANSFER_STATE + '）');
    }
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
    // 大小检查要覆盖 file:// 引用：原来只看"非 file://"的路径，等于给了个绕过口子。
    let size = 0;
    const local = resolveLocalFile(filePath, ROOT);
    if (local) {
      try { size = fs.statSync(local).size; }
      catch (error) {
        if (/^file:\/\//i.test(String(filePath))) throw new Error('找不到文件：' + local);
        swallow('文件发送-stat', error, local);
      }
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
  // 返回 { ok, savedPath, meta } / { ok:true, duplicate:true } / { ok:false, reason, dumped }
  async function handleFileNotice(event) {
    const parsed = parseNotice(event);
    const { dir: baseDir, withDate } = resolveInboxDir();
    const dir = withDate ? path.join(baseDir, localDayString()) : baseDir;
    fs.mkdirSync(dir, { recursive: true });
    if (!parsed || !parsed.fileId) {
      const dump = path.join(dir, `${Date.now()}.unknown-event.json`);
      await fsp.writeFile(dump, JSON.stringify(event, null, 2)).catch((error) => swallow('文件接收-dump', error, dump));
      log('[文件] 收到无法识别的文件类 notice，已 dump 原始事件到 ' + dump);
      return { ok: false, reason: 'unrecognized-notice', dumped: dump };
    }
    // 幂等：同一个 fileId 只收一次。重连补拉 / 上游重复投递都会把同一个 notice 再送一遍，
    // 不去重就会重复下载、落成 "报告(1).pdf" 这种垃圾。
    const prev = readIndex(STATE_DIR).find((r) => r.fileId === parsed.fileId);
    if (prev) {
      log(`[文件] 跳过重复投递：${parsed.fileId}（已在 ${prev.savedPath}）`);
      return { ok: true, duplicate: true, savedPath: prev.savedPath, meta: { seq: prev.seq, name: prev.name } };
    }

    const safeName = sanitizeName(parsed.name || 'file');
    // 先用 `wx` 独占占位，再往里写：并发同名文件不会抢到同一路径。
    const { path: finalPath, fh } = await openUnique(dir, safeName);
    const limit = maxBytes();
    let downloaded = false;
    let bytes = 0;
    let downloadErr = null;
    try {
      const r = await downloadToFile(parsed, oneBotCall, fh, limit);
      downloaded = true;
      bytes = r.bytes;
    } catch (error) {
      downloadErr = error?.message ?? String(error);
      swallow('文件接收', error, parsed.fileId);
    } finally {
      await fh.close().catch((error2) => swallow('文件接收-关闭句柄', error2, finalPath));
    }
    let savedPath = finalPath;
    if (!downloaded) {
      // 中途超限/中断会留下半个文件，必须删掉，否则占着这个名字。
      try { fs.unlinkSync(finalPath); } catch (error2) { swallow('文件接收-清理残留', error2, finalPath); }
      // 仍落盘元信息，便于事后用 file_id 重试。
      savedPath = finalPath + '.download-failed';
      await fsp.writeFile(savedPath, JSON.stringify({ ...parsed, downloadErr }, null, 2))
        .catch((error2) => swallow('文件接收-写失败元信息', error2, savedPath));
    }
    const seq = appendIndex(STATE_DIR, {
      receivedAt: new Date().toISOString(),
      fromKey: parsed.fromKey,
      fromQQ: parsed.fromQQ,
      name: safeName,
      size: parsed.size || bytes,
      savedPath,
      fileId: parsed.fileId,
      fileHash: parsed.fileHash,
      kind: parsed.kind,
      noticeType: parsed.noticeType,
      downloaded,
      ...(downloadErr ? { downloadErr } : {}),
    });
    return {
      ok: true,
      savedPath,
      meta: { seq, name: safeName, size: parsed.size || bytes, downloaded },
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
