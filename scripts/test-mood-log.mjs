#!/usr/bin/env node
// [回归] 心情打卡 / 树洞（bridge.js 的 /api/socialV2/mood-log + memory-db 的 listMemberMoods/moodBoardStats）
//
// 为什么要有这一套：树洞这条链路一旦错，错法都很严重 ——
//   ① 匿名没真的匿名 ⇒ 说好"别说是我"却被记了名，是信任事故；
//   ② 心情板读**全库**而不是按会话 ⇒ 私聊的树洞内容出现在群里；
//   ③ 白名单外的心情值写进库 ⇒ 提示词里出现看不懂的标签；
//   ④ 端点漏了鉴权/开关 ⇒ 任何人都能往记忆库灌数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const bridge = read('src/bridge.js') + '\n' + read('src/console-server.js') + '\n' + read('src/wake-prompt.js');
const memdb = read('src/memory-db.js');
const mcp = read('src/mcp-snowluma-safe.js');
const config = JSON.parse(read('config.json'));
const example = JSON.parse(read('config.example.json'));
const presetSrc = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
const presetPatch = read('plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}`);
  }
};

// ── ① memory-db：按会话读心情（隐私的底层保证） ─────────────────────────────
{
  ok(memdb.includes('function listMemberMoods(key, opts)'), '有 listMemberMoods（按会话读群友心情）');
  ok(memdb.includes('function moodBoardStats(dayStr, key)'), '有 moodBoardStats（今天的打卡统计）');
  ok(/FROM events WHERE key = \? AND kind LIKE .+.mood:%/.test(memdb), 'listMemberMoods 按 key + kind + at 三条件过滤（真按会话）');
  ok(/FROM events WHERE key = \? AND kind LIKE .+.mood:%.+?AND at >= \? AND at <= \?/.test(memdb), 'moodBoardStats 按 key 与当天窗口过滤');
  ok(memdb.includes('if (!k) return [];') && memdb.includes('if (!k) return null;'), 'key 为空就返回空（不把全库当某个群）');
  ok(['listMemberMoods', 'moodBoardStats'].every((n) => new RegExp(`\\n    ${n},`).test(memdb)), '工厂导出这两个函数');
  ok(memdb.includes("if (MOOD_KINDS.indexOf(mood) < 0) continue;"), '脏 mood 值的行被跳过（不把 undefined 抛给调用方）');
  ok(memdb.includes('parseJsonArray(r.participants)') || memdb.includes('parseJsonArray(r.participants)'), 'participants 解析成数组');
}

// ── ② 端点：鉴权 / 开关 / 白名单 / 限频 / 树洞匿名 ──────────────────────────
{
  ok(bridge.includes("url.pathname === '/api/socialV2/mood-log'"), '有 /api/socialV2/mood-log 端点');
  const i = bridge.indexOf("url.pathname === '/api/socialV2/mood-log'");
  const block = bridge.slice(i, i + 3200);

  ok(block.includes("agentTokenOk(key, req.headers['x-agent-token'])"), '端点先验 agent token（不能裸调）');
  ok(block.includes('v2SessionAllowed(key)'), '端点再验会话在当前模式允许范围内');
  ok(block.includes("v2ToolEnabled('moodLog')"), '端点受 socialV2.tools.moodLog 开关控制');
  ok(block.includes('MOOD_KINDS_V2.includes(mood)'), 'mood 必须在白名单里（脏值写不进去）');
  ok(block.includes("if (!note)"), 'note 为空拒掉（不记空打卡）');
  ok(block.includes('moodTimes'), '有限频（防止刷磁盘/日志）');
  ok(block.includes("anonymous ? '' : String(body.who"), '匿名时不取 who');
  ok(block.includes('participants: anonymous ? [] : (who ? [who] : [])'), '匿名时 participants 为空（真的不记名）');
  ok(block.includes('anonymous ? note : (who ? `${who}：${note}` : note)'), '匿名时 summary 里不带名字');
  ok(block.includes("if (!mdbRef || typeof mdbRef.recordMoodEvent !== 'function')"), '记忆库没开就明确报错（不静默丢）');
  ok(block.includes('appendActivity('), '记一笔后写活动日志（可追溯）');

  ok(/const MOOD_KINDS_V2 = \[[^\]]*'touched'[^\]]*\]/.test(bridge), 'MOOD_KINDS_V2 白名单已定义（含 touched）');
  ok(bridge.includes('const MOOD_LABELS_V2 = {'), 'MOOD_LABELS_V2 中文名已定义');
  ok(bridge.includes("touched: '被暖到'"), '常见心情有中文名（提示词里读得懂）');
  ok(bridge.includes('const moodTimes = new Map();'), '限频表已定义');
}

// ── ③ 心情板注入：只读当前会话 + 不进错段落 ─────────────────────────────────
{
  ok(bridge.includes('function moodBoardLineV2(key)'), '有 moodBoardLineV2（把群里心情喂给她）');
  ok(bridge.includes('mdb.listMemberMoods(key, { hours, limit: 40 })'), '心情板用 listMemberMoods 且带 key（只读当前会话）');
  ok(bridge.includes("cfg.socialV2?.mood?.board === false"), '心情板可单独关（mood.board）');
  ok(bridge.includes('【群里最近的心情'), '注入时有明确标题');
  ok(bridge.includes('别猜是谁') || bridge.includes('别猜'), '树洞时提示她别猜是谁');
  ok(/moodBoardLine\s*=\s*moodBoardLineV2\(key\)/.test(bridge), '心情板真的被构建（传了 key）');
  ok(/volatileSeg = [^\n]*moodBoardLine/.test(bridge), '心情板接进了 volatileSeg（每轮重算）');
  ok(/slimSeg = [\s\S]{0,400}?moodBoardLine/.test(bridge), '瘦身提示词里也保留心情板（很短但决定她像不像熟人）');
}

// ── ④ 工具与开关 ────────────────────────────────────────────────────────────
{
  ok(mcp.includes("'qq_mood_log'"), 'MCP 注册了 qq_mood_log');
  ok(/qq_mood_log[\s\S]{0,1200}?'\/api\/socialV2\/mood-log'/.test(mcp), '工具打的是桥接的 mood-log 端点');
  ok(/z\.enum\(\['happy', 'tired', 'stressed', 'sad', 'excited', 'angry', 'touched', 'calm'\]\)/.test(mcp), '工具参数把 mood 限成 8 个枚举值');
  ok(mcp.includes('anonymous: z.boolean()'), '工具支持匿名（树洞）');
  ok(mcp.includes('别去猜') || mcp.includes('不知道是谁'), '工具说明里讲了树洞匿名后不知道是谁');
  ok(mcp.includes('qq_mood_log 是替别人记的') || /这是替别人记的/.test(mcp) || mcp.includes('替别人记'), '工具说明里强调是替别人记（不是她自己的心情）');
  ok(bridge.includes("moodLog: 'qq_mood_log'"), '工具名登记进了 prompt 的可用工具表');
  ok(bridge.includes("v2ToolEnabled('moodLog')"), '端点开关名与登记一致');
}

// ── ⑤ 配置默认值 ────────────────────────────────────────────────────────────
for (const [name, c] of [['config.json', config], ['config.example.json', example]]) {
  ok(c.socialV2?.tools?.moodLog === true, `${name}: socialV2.tools.moodLog=true`);
  ok(c.socialV2?.mood?.enabled === true, `${name}: mood.enabled=true`);
  ok(c.socialV2?.mood?.board === true, `${name}: mood.board=true（默认开心情板）`);
  ok(Number(c.socialV2?.mood?.boardHours) >= 1, `${name}: mood.boardHours 是正数`);
  ok(Number(c.socialV2?.mood?.boardMaxEntries) >= 1, `${name}: mood.boardMaxEntries 是正数`);
}

// ── ⑥ preset：她得知道怎么打卡、匿名怎么处理 ────────────────────────────────
ok(presetSrc.includes('【心情打卡 / 树洞】'), 'preset 源有【心情打卡 / 树洞】');
ok(presetPatch.includes('【心情打卡 / 树洞】'), 'preset 产物（patch）有【心情打卡 / 树洞】');
ok(presetSrc.includes('qq_mood_log('), 'preset 源给了 qq_mood_log 调用写法');
ok(presetPatch.includes('qq_mood_log('), 'preset 产物给了 qq_mood_log 调用写法');
ok(presetSrc.includes('anonymous=true'), 'preset 讲了匿名参数');
ok(presetSrc.includes('别去猜'), 'preset 明确树洞"别猜是谁"');
ok(presetSrc.includes('别当病历问诊'), 'preset 明确别当病历问诊（隐私边界）');

console.log(`\n心情打卡/树洞回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
