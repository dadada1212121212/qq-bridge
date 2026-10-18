// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 「被 @ 必达」：唤醒频率闸门不许把 atMention 静默丢掉（日志里坐实过的失败形态：
  // 「最早可用时段在 6 分钟后…放弃本次唤醒（atMention）」），同时豁免仍要有绝对天花板。
  'test-wake-limits.mjs',
  // 「主人私聊一天至少主动找一次」：主动机会原本只按概率（软），用户要求变硬指标；
  // 这条网钉住默认值/归一化白名单/config.json 三处一致，以及 lastProactiveAt 跨重启保留。
  'test-proactive-guarantee.mjs',
  // 会话轮换口径：「当前上下文多大」= 最近一步的输入，不是最新一轮所有步的累加。
  // 后者让每个正常轮次都 24 万 ⇔ 每次唤醒都退役重建（2026-10-07 全天 29 次，一分钟连轮两次）。
  'test-context-rotation.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // [patch QQ空间] 她自己在群里撞见好笑的就发条说说。三段链路各有一条独立断言：
  //   · preset 源**和 DSH 真正加载的 patch 产物**都带规矩与工具名（只改源不重生成 = 她收不到，
  //     表现只是"她好像没发"，日志里看不出来）；
  //   · MCP 真注册出 qq_post_qzone / qq_read_qzone（漏登记 TOOL_CONFIG_FLAGS 的后果见该文件）；
  //   · bridge 的 qzoneImageRef **源码抽出来真跑**：Windows 路径必须变成 WSL 能读的
  //     `file:///mnt/<盘>/…`（SnowLuma 在 WSL、桥接在 Windows，转错就是图发不出去）。
  'test-qzone.mjs',
  // [patch DSH重启清残留] 2026-10-12 00:45 那次「她好像没反应」：DSH 重启时补发的非回合事件
  // 把会话建成 collector，而旧进程的 turn/end 永远不会到 ⇒ 8 分钟里主人 8 条消息全被
  // 「会话繁忙」挡下。这条断言把 releaseInflightOnDshRestart 的源码抽出来真跑。
  'test-dsh-restart-release.mjs',
  // [patch 高峰静默 + 群聊报错护栏] 2026-10-12 01:xx 的两件事：DeepSeek 峰谷定价下工作日
  // 9–12 / 14–18 群里不烧 token（被 @ 只回一句不好意思），以及**她的报错原文一个字都不许进群**。
  //    · peakWindowV2 / peakQuietAppliesV2 **源码抽出来真跑**，注入假 Date 覆盖周一/周末/
  //      节假日/窗口边界（判错时区或边界 = 白烧钱，或该说话时一句话不说）；
  //    · groupErrorLeakV2 同样真跑：14 条强特征必须拦住，正常聊天与兜底话术必须放行
  //      （误判的代价是她突然不说话）；
  //    · 三个文本出口（sendToQQ / sendBurstToQQ / onebotSend）都要接到护栏上，并钉住
  //      「护栏之外没有绕过它的裸群发」（控制台 /api/test-send 是唯一例外）。
  'test-peak-quiet.mjs',
  // 睡眠自动回复：[patch 睡眠] 的纯函数（深夜窗口 / 睡着判定 / 口令识别）同样抽源码真跑 ——
  // 判错边界的代价是「该回（zzz…）时死一样安静，或者半夜把她叫起来烧 token」；
  // 另外钉住三个结构事实：潜水≠睡着、闸门早退不吃唤醒配额、叫醒会清掉手动睡与有限睡眠闹钟。
  'test-sleep.mjs',
  // 她自己的小记与周报：日期/周号/时区钟/夹取这些纯函数真跑（算错就是"天天写两份"或"永远不写一次"），
  // 另外钉住三件结构事实：触发复用 sendWakePromptV2 的全部闸门（睡着/高峰/繁忙时不白烧 token）、
  // 「写哪一天」只有一处算法（看门狗与提示词分支同口径，跨零点那份也补得上）、小记只注入她自己的会话。
  'test-diary.mjs',
  // [patch 补拉时限 + 启动先用本地模式 + 补拉水位] 主人 m01940「有时候他会回去重新处理已经
  // 处理好的聊天记录」：DSH 离线启动 ⇒ currentMode 停在 'chat' ⇒ 入站走一代路径不写
  // reserved2 水位 ⇒ 切回 reserved2 后补拉把几小时前的旧消息当「从未入站」重放并叫醒她。
  // catchUpMissedV2 抽源码真跑（注入假 Date/OneBot/唤醒判定）：过期的漏消息不许重放、
  // 时限内的照补照叫醒、message_id 去重与 60 秒最小间隔不被挤掉；另外钉住启动处先
  // refreshMode()、一代路径也推水位、以及 config 里的 catchUpMaxAgeMs 默认 15 分钟。
  'test-catchup-watermark.mjs',
  // [patch 群聊小总结] 到点往群里发一条随口的小总结（和日记不同：日记是写给自己的私密小记，
  // 这个是真发进群）。纯函数真跑（配置夹取 / 目标群筛选 / 目标日与补发），并钉住三件事：
  // 按群取数（keyStats 而不是全库 dayStats —— 否则把别的群/私聊的事发进群，是隐私事故）、
  // 同日/同周去重（重启不重复发）、消息量不够不发（群里没人说话别尬总结）。
  'test-group-recap.mjs',
  // [patch 心情打卡/树洞] 群友的心情记录：纯逻辑 + 隐私红线。匿名必须真的不记名
  // （participants 空、summary 不带名字）、心情板只读当前会话（跨群不串味）、
  // 白名单外的 mood 写不进库、端点有鉴权/开关/限频。
  'test-mood-log.mjs',
  // [patch 表情包按语境配图] 从最近别人的话里推断情绪，把对得上的收藏表情往前排。
  // 钉住：只重排不过滤、没有情绪线索时退回按使用次数（老行为）、普通闲话别硬判情绪、
  // 注入的跨会话防注入语不能被排序改动顺手删掉。
  'test-sticker-context.mjs',
  // [patch 定时播报] 早报/晚报/节日 + 热点：纯逻辑（节日表判定、热榜解析容错）先跑，
  // 再跑 bridge 集成（提示词三类分支成型、落点固定主人私聊、三个去重位可序列化）。
  // 钉住的重点：播报提示词必须像随口聊天（不是播报腔）、热点抓不到要能降级不哑火。
  'test-broadcast-lib.mjs',
  'test-broadcast.mjs',
  // [patch 联网搜索提速] 多源并行竞速 + 每源短超时 + 结果缓存。
  // 钉住：快源胜出不串行等待、慢源/失败源不拖累整体、缓存第二次零网络、
  // attempts 并发多打能抵消"随机空手"、解析器对变形 HTML 的容错。
  'test-web-search-lib.mjs',
  // [patch 坏 JSON 修复重试] 模型偶发把工具参数写成非法 JSON → 整轮判 MALFORMED_RESPONSE。
  // 钉住：只认这一个 code、同会话 5 分钟冷却、被拒的申请不写状态、提示词点明「系统提示」与可执行写法。
  'test-malformed-retry.mjs',
  // [patch 省token·静态段每会话只发一次] 唤醒提示的静态段（人设/令牌/查证/省一步）
  // 以前每轮整条重发 = 每轮全价未命中；现在同一 DSH 会话只整条发一次，之后只发动态段
  // （静态段留在上下文里，按缓存命中价读，便宜 50 倍）。会话轮换后自动整条重发。
  'test-wake-lean.mjs',
  // [省 token] 白名单遮罩：把不在白名单里的继承层工具藏掉（省工具说明的 token）。
  'test-tool-mask.mjs',
  // [长记忆] 自动提炼 / 定期整理 / 相关性注入。
  'test-long-memory.mjs',
  // [QQ 唤醒器] 命令解析 / 鉴权 / 配置白名单。
  'test-wake-bot.mjs',
  'test-fresh-session.mjs',
  'test-thinking-filler.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
