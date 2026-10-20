// JSON 读写 —— 全仓唯一实现（2026-10-20 统一）。
//
// 为什么单独一个文件：这套"读 JSON 容错"原来有 **4 份**，行为还不一样：
//   · `bridge.js` 顶层：处理 BOM、支持 `required` fail-fast、失败返回 fallback（不挪坏文件）
//   · `bridge.js` 内层（`pickFallbackModel` 旁边）：连 BOM 都不处理，直接 `catch { return null }`
//   · `console-server.cfgmodReadHistory`：只认数组，坏了就 `[]`
//   · `search-store.readJsonSafe`：会把坏文件改名成 `.bad`（唯一会自愈的那份）
// 后果是同一个 `state/*.json` 损坏时，一处自愈、一处静默当成空数据继续跑 —— 等于静默丢数据。
//
// 统一后的语义（三处都必须一致）：
//   - 文件不存在 / 空文件  → 返回 fallback（不是错误）
//   - Windows 的 UTF-8 BOM  → 先剥掉再 parse（否则 JSON.parse 必失败）
//   - 解析失败            → 记日志；`required` 时抛错；`quarantine` 时把坏文件改名 `.bad`
//   - `quarantine` 默认 **关**：本仓会读别的工具拥有的文件（`../our-free-model/*.json`），
//     不能因为对方文件坏了就把人家的文件改名。只有自己 `state/` 下的文件才开。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 读 JSON，容错。
 *
 * @param {string} file
 * @param {*} fallback 文件不存在/为空/解析失败时返回它
 * @param {{ required?: boolean, quarantine?: boolean, log?: Function }} [opts]
 */
export function readJsonFile(file, fallback = null, opts = {}) {
  const { required = false, quarantine = false, log = () => {} } = opts;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (required) throw new Error(`配置文件读取失败：${file}（${error?.message ?? error}）`);
    if (error?.code !== 'ENOENT') log(`读 ${path.basename(file)} 失败：${error?.message ?? error}`);
    return fallback;
  }
  // Windows 记事本/PowerShell 写出来的文件常带 BOM，JSON.parse 会直接报 Unexpected token。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件解析失败：${file}（${error?.message ?? error}）`);
    log(`解析 ${path.basename(file)} 失败：${error?.message ?? error}`);
    if (quarantine) {
      // 挪走坏文件，下一次写入就是干净的新文件；否则每次启动都在同一个坏文件上失败。
      try { fs.renameSync(file, `${file}.bad`); } catch { /* 挪不动就算了 */ }
    }
    return fallback;
  }
}

/**
 * 原子写 JSON：先写唯一临时文件再 rename。
 *
 * 为什么 rename 要重试：`fs.renameSync` 覆盖一个"正被别人打开"的目标，在 Windows 上会抛
 * EPERM/EBUSY（Defender 扫描、编辑器、资源管理器预览、云同步都可能在这个窗口里碰它）。
 * 本机实测可复现。
 */
export function writeJsonAtomic(file, data, { pretty = false, mode = 0o600, attempts = 4 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const text = pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
    let lastError;
    for (let i = 0; i < attempts; i += 1) {
      try { fs.renameSync(tmp, file); lastError = null; break; } catch (error) {
        lastError = error;
        if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') break;
        // 同步忙等：调用点大多在启动/收尾路径，不值得为它改成异步。
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch { /* 无 SharedArrayBuffer 就算了 */ }
      }
    }
    if (lastError) throw lastError;
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw error;
  }
}
