// 文件收发核心模块单测：路径转换 / action 选择 / 大小限制 / 未知 notice 落盘 / 正常接收+读取
import { createFileTransfer } from '../src/file-transfer.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-test-'));
const STATE = path.join(tmp, 'state');
fs.mkdirSync(STATE, { recursive: true });

function makeFt(oneBotCall) {
  return createFileTransfer({
    oneBotCall,
    cfg: { socialV2: { files: { maxBytes: 1024 } } },
    ROOT: tmp,
    STATE_DIR: STATE,
    log: () => {},
  });
}

function findInDir(dir, suffix) {
  if (!fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (findInDir(p, suffix)) return true; }
    else if (e.name.endsWith(suffix)) return true;
  }
  return false;
}

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

// 1. 路径转换 + 私聊 action
{
  const f = path.join(tmp, '报告.txt'); fs.writeFileSync(f, 'hi');
  let cap = null;
  const ft = makeFt(async (a, p) => { cap = { a, p }; return { file_id: 'FID1' }; });
  const r = await ft.sendFile({ key: 'private:3796180411', filePath: f });
  ok('sendFile 返回 ok', r.ok === true);
  ok('私聊用 upload_private_file', cap.a === 'upload_private_file');
  ok('file 转 WSL 路径', typeof cap.p.file === 'string' && cap.p.file.startsWith('file:///mnt/') && cap.p.file.includes('报告.txt'));
  ok('name 缺省取原文件名', cap.p.name === '报告.txt');
}

// 2. 群聊 action
{
  const f = path.join(tmp, 'g.txt'); fs.writeFileSync(f, 'x');
  let cap = null;
  const ft = makeFt(async (a, p) => { cap = { a, p }; return { file_id: 'F2' }; });
  await ft.sendFile({ key: 'group:123', filePath: f });
  ok('群聊用 upload_group_file', cap.a === 'upload_group_file');
}

// 3. 文件不存在抛错
{
  const ft = makeFt(async () => ({}));
  let threw = false;
  try { await ft.sendFile({ key: 'private:1', filePath: path.join(tmp, 'nope.txt') }); } catch { threw = true; }
  ok('不存在文件抛错', threw);
}

// 4. 大小超限抛错
{
  const f = path.join(tmp, 'big.txt'); fs.writeFileSync(f, 'a'.repeat(5000));
  const ft = makeFt(async () => ({ file_id: 'x' }));
  let threw = false;
  try { await ft.sendFile({ key: 'private:1', filePath: f }); } catch { threw = true; }
  ok('超限抛错', threw);
}

// 5. 网络 URL 不支持
{
  const ft = makeFt(async () => ({}));
  let threw = false;
  try { await ft.sendFile({ key: 'private:1', filePath: 'http://x/y.txt' }); } catch { threw = true; }
  ok('网络 URL 抛错', threw);
}

// 6. 未知 notice 结构 → dump 不丢数据
{
  const ft = makeFt(async () => ({}));
  const r = await ft.handleFileNotice({ notice_type: 'weird', foo: 1 });
  ok('未知结构 ok=false', r.ok === false && r.reason === 'unrecognized-notice');
  ok('未知结构已 dump 原始事件', findInDir(path.join(STATE, 'files', 'inbox'), '.unknown-event.json'));
}

// 7. 正常接收（get_file base64 兜底）+ 查询 + 读取
{
  const ft = makeFt(async (a) => {
    if (a === 'get_private_file_url') return {}; // 无 url，走兜底
    if (a === 'get_file') return { base64: Buffer.from('hello-file').toString('base64') };
    return {};
  });
  const r = await ft.handleFileNotice({ notice_type: 'offline_file', user_id: '3796180411', file_id: 'FIDX', file_name: '../../evil.txt', file_size: 10, file_hash: 'H' });
  ok('接收 ok', r.ok === true);
  ok('文件名被清洗（无路径分隔符/未穿越）', !r.meta.name.includes('/') && !r.meta.name.includes('\\'));
  ok('落盘未逃逸出 inbox 目录', r.savedPath.startsWith(path.join(STATE, 'files', 'inbox')));
  ok('落盘内容正确', fs.readFileSync(r.savedPath, 'utf8') === 'hello-file');
  const list = ft.listInbox();
  ok('收件箱能列出', list.count >= 1);
  const rd = await ft.readInboxText(r.meta.seq);
  ok('读取文本内容正确', rd.ok === true && rd.text === 'hello-file');
}

// 8. 收件目录：默认 / 配置 / AI 指定 三级优先级 + 自定义目录平铺存放
{
  // 8a. 默认目录 = state/files/inbox/<日期>
  const ft = makeFt(async () => ({}));
  const def = ft.getInboxDir();
  ok('默认收件目录落在 state/files/inbox', def.inboxDir.startsWith(path.join(STATE, 'files', 'inbox')) && def.withDate === true);

  // 8b. 配置 socialV2.files.inboxDir 覆盖默认
  const cfgDir = path.join(tmp, 'cfg-inbox');
  const ft2 = createFileTransfer({ oneBotCall: async () => ({}), cfg: { socialV2: { files: { inboxDir: cfgDir } } }, ROOT: tmp, STATE_DIR: STATE, log: () => {} });
  const c = ft2.getInboxDir();
  ok('配置 inboxDir 生效', c.inboxDir === cfgDir && c.withDate === true);

  // 8c. AI 指定目录覆盖一切，且平铺存放（withDate=false）
  const custom = path.join(tmp, 'my-custom');
  const r = ft.setInboxDir(custom);
  ok('setInboxDir 返回 ok 且写入绝对路径', r.ok === true && r.inboxDir === custom);
  const g = ft.getInboxDir();
  ok('指定目录生效（withDate=false）', g.inboxDir === custom && g.withDate === false);

  // 8d. 收到的文件直接存进指定目录（不套日期子目录）
  const ft3 = makeFt(async (a) => {
    if (a === 'get_private_file_url') return {};
    if (a === 'get_file') return { base64: Buffer.from('into-custom').toString('base64') };
    return {};
  });
  ft3.setInboxDir(custom); // 注意：状态文件按 STATE_DIR 共享，fts 已写过，这里再确认
  const rr = await ft3.handleFileNotice({ notice_type: 'offline_file', user_id: '3796180411', file_id: 'FX', file_name: 'a.txt', file_size: 10, file_hash: 'H' });
  ok('指定目录下平铺落盘', rr.ok === true && rr.savedPath.startsWith(custom) && !rr.savedPath.includes(path.join(custom, '20')));
  ok('指定目录内容正确', fs.readFileSync(rr.savedPath, 'utf8') === 'into-custom');

  // 8e. 非法目录（相对路径）被拒绝
  let threw = false;
  try { ft.setInboxDir('relative/path'); } catch { threw = true; }
  ok('相对路径被拒绝', threw);

  // 8f. 传空恢复默认
  const clr = ft.setInboxDir('');
  ok('传空恢复默认', clr.ok === true && clr.cleared === true && clr.inboxDir.startsWith(path.join(STATE, 'files', 'inbox')));
}

console.log(`\n结果：${pass} 通过, ${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
