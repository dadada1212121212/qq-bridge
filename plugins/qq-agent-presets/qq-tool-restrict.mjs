// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// 两份白名单，一个实现（2026-10-12 加）：
//   · 本模块的 `apply`          → 严格版。qq-chat / qq-chat-v2 用，**不含**手机工具。
//   · `qq-tool-restrict-owner.mjs` → 主人版。只有 qq-owner preset 用，多放行 mcp__phone-adb__。
//   两者都调用下面的 installGuard()，所以「哪些工具危险」永远只有一份判断。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
/**
 * 宿主 / 运行期提供的工具名——它们**真实存在**于仿真会话的 schema 里，但不在
 * `scripts/dsh-tool-names.mjs` 的「DSH 工具包」扫描范围内（由宿主运行时直接注册），
 * 所以 test-preset-local-tools.mjs 的「拼错假名」对账要豁免这一组。
 *
 * 证据（不是推测）：qq-bridge/state/tool-calls.jsonl 里有她 2026-10-06 的真实调用记录——
 *   · compress ×4（12:48 / 13:20 / 13:34 / 14:22）——她手写超长 content 想"自己压缩上下文"，
 *     四次都被 guard 拒绝。光生成那段结构化长文本就是纯烧 token，用户为此报
 *     「dsh 在对话任务中会自己写程序（很浪费 token）」。
 *   · advanced_search ×1（06:04）——同批被拒。
 * 只要这组名字仍出现在工具的 schema 里，她就会反复尝试；所以必须进 restrict（注册期隐藏），
 * 而不只是靠 guard 在执行期拒绝。
 */
export const HOST_PROVIDED_TOOL_NAMES = Object.freeze([
  // ACP 上下文管理：只该由宿主的 ACP 层调用，仿真会话不该看见。
  'compress', 'decompress', 'search_context', 'acp_status', 'acp_cache',
  // 宿主自带的代码执行工具（PTC）：最典型的"写程序"口子。
  'run_code',
  // 宿主自带联网/搜索工具；预设只想给她 mcp__web-search-safe__web_search 这一条。
  'advanced_search', 'multi_search', 'platform_search', 'video_search', 'x_search',
  'web_search', 'web_fetch', 'read_page', 'free_search_test',
  // 编排 / 交付 / 计划类。
  'wait_agent', 'checkout_worktree', 'create_worktree', 'exit_plan_mode',
  'scheduler_create', 'scheduler_delete', 'scheduler_list', 'scheduler_update',
])

const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 宿主/运行期提供的工具名：见 HOST_PROVIDED_TOOL_NAMES 的说明与证据。
  ...HOST_PROVIDED_TOOL_NAMES,
]


const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
  // dsh-mode-boost（已装插件；虽未进 bundles，但上文「来源包」注释早已把它列为危险，
  // 而名单里一直漏了这三个名字 —— test-preset-local-tools.mjs 的 dev_mode_* 断言就是这样抓到的）：
  // dev_mode_subagent 派生 agent，dev_mode_set/status 改宿主开发态。
  'dev_mode_set',
  'dev_mode_status',
  'dev_mode_subagent',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

/**
 * 桌面宿主 / DSH 前端专用工具：**两个 preset 都隐藏**。
 *
 * 为什么单列而不并进 KNOWN_DANGEROUS_GLOBAL_TOOLS：上面那份名单的语义是"本地执行
 * 能力"，并且被 scripts/scan-dsh-tool-names.mjs 拿去和 DSH 安装包里的真实工具名
 * 对账（拼错假名会静默 no-op，必须能扫出来）。这一份的语义是"在 QQ 会话里没有
 * 载体也没有用处的宿主工具"，混在一起会让"本地执行"这个判定变模糊。
 *
 * 证据（2026-10-15，活会话 dump 的真实 request/header，见 tmp/restrict-verify.mjs）：
 * 严格组会话（group:429626254 / qq-chat-v2）的工具清单里这些名字**全都还在**，
 * 但 state/tool-calls.jsonl 全量 1955 次调用里**一次都没被调用过**——
 * 它们只是白占 schema（合计 ≈6.6KB）：render_ui 1,708B、validate_dsh_ui 1,104B、
 * domain_search 3,660B、dsh_im_return_file 596B、research 540B、weather 453B、
 * cache_search 437B。
 *
 * 为什么该隐藏（不只是省字节）：
 *   · render_ui / validate_dsh_ui / dsh_im_return_file 是**桌面 GUI 平面**的
 *     工具——QQ 桥接会话的交付物是聊天消息，不是 conversation 里的 UI 卡片；
 *   · research 会自己开子查询、domain_search / cache_search 是宿主检索面，
 *     而 QQ 会话的联网正路是唯一的 mcp__web-search-safe__web_search
 *     （web_search / web_fetch / advanced_search 早就在上面被隐藏）。
 *     留着它们 = 留着第二条联网路径，与"只留一条"的既有口径自相矛盾。
 */
export const HARNESS_ONLY_TOOL_NAMES = Object.freeze([
  'render_ui',
  'validate_dsh_ui',
  'dsh_im_return_file',
  'research',
  'weather',
  'cache_search',
  'domain_search',
])

/**
 * 手机控制面：**只在严格版隐藏**（主人私聊照旧放行，见 OWNER_EXTRA_*）。
 *
 * 这是一条真实存在过的安全缺口，不是理论风险：注册期掩码（restrict）从来没有
 * 盖住手机工具，L7「仿真会话不得包含本地执行能力」在**注册期**是破的——群聊会话的
 * schema 里明明白白列着 phone_lan（7,805B）和 20 个 mcp__phone-adb__*（≈4.4KB），
 * 只靠执行期 guard 兜底（guard 确实拦得住，但"看得见"本身就会被诱导：
 * 模型会为一个它以为能用的工具写代码、编参数，白烧 token）。
 *
 * 为什么现在才补：此前以为 restrict 对它们"静默失效"。实测（tmp/restrict-verify.mjs）
 * 证明失效只发生在 **own 层**注册的工具上（见下面 installGuard 里团队工具那段说明），
 * 而手机工具是**全局层**（profile 的 cordis.patch.yml 注册 MCP server + dsh-phone-agent
 * 插件）⇒ 属于 inherited，restrict 本来就能遮住，只是名字从没进名单。
 *
 * ⚠️ 方向：这份名单**只在 allowPhoneAdb === false** 时生效。主人私聊（qq-owner）
 * 必须留着手机控制（OWNER_EXTRA_PREFIXES / OWNER_EXTRA_EXACT 就是为它写的）。
 */
export const STRICT_ONLY_TOOL_NAMES = Object.freeze([
  // dsh-phone-agent 是原生 cordis 插件，工具名是裸的（与 OWNER_EXTRA_EXACT 呼应）。
  'phone_lan',
  // mcp-phone-adb（Python MCP server，profile 全局注册）暴露的 20 个工具。
  'mcp__phone-adb__phone_apps',
  'mcp__phone-adb__phone_connect',
  'mcp__phone-adb__phone_find',
  'mcp__phone-adb__phone_key',
  'mcp__phone-adb__phone_launch',
  'mcp__phone-adb__phone_longpress',
  'mcp__phone-adb__phone_look',
  'mcp__phone-adb__phone_notifications',
  'mcp__phone-adb__phone_open_url',
  'mcp__phone-adb__phone_screen',
  'mcp__phone-adb__phone_screenshot',
  'mcp__phone-adb__phone_scroll',
  'mcp__phone-adb__phone_state',
  'mcp__phone-adb__phone_status',
  'mcp__phone-adb__phone_stop',
  'mcp__phone-adb__phone_swipe',
  'mcp__phone-adb__phone_tap',
  'mcp__phone-adb__phone_tap_text',
  'mcp__phone-adb__phone_type',
  'mcp__phone-adb__phone_wait_text',
])

/**
 * 本次（严格版）实际下发的 deny 名单。导出给测试用——两份 preset 的关键差异
 * 必须能被断言（严格版遮手机、主人版不遮），不能只靠人眼读代码。
 *
 * @param {{allowPhoneAdb?: boolean}} [options]
 * @returns {string[]}
 */
export function denyNamesFor({ allowPhoneAdb = false } = {}) {
  return [
    ...KNOWN_DANGEROUS_GLOBAL_TOOLS,
    ...HARNESS_ONLY_TOOL_NAMES,
    ...(allowPhoneAdb ? [] : STRICT_ONLY_TOOL_NAMES),
  ]
}

/**
 * **实测**能进 restrict 的名字（2026-10-15 从 harness 日志里抄下来的原文）。
 *
 * 证据：C:\Users\ASUS\AppData\Roaming\dsh-tauri\logs\dsh-web.log 每次启动都会打
 *   `[qq-tool-restrict] skip restrict pwsh: tools.restrict() names unknown global tool "pwsh";
 *    known global tools: advanced_search, cache_search, domain_search, …`
 * 那串 "known global tools" 就是 `view(scope)` 的 inherited 层（全局+祖先）名字，
 * 全量只有下面 17 个。deny 名单里其余 80+ 个名字（pwsh/read/compress/schedule_ 那 4 个/
 * mcp__phone-adb__ 前缀那 20 个、团队工具…）都不在其中 ⇒ 每次启动抛 unknown 被跳过。
 *
 * 结论（决定了"注册期掩码"的能力上限）：
 *   ⚠️ 2026-10-15 复测更正：下面"能遮"那一半**不成立**。实测 4 个 QQ 会话
 *      （严格版 qq-chat-v2 的 c13c3170 / 203c5cc4，主人版 qq-owner 的 8d09009c /
 *      4d77424b）的工具清单在 render_ui / validate_dsh_ui / research / weather /
 *      cache_search / domain_search / dsh_im_return_file 这 7 个宿主工具上**逐一致同、
 *      全都在**。而这 7 个名字确实出现在日志的 "known global tools" 里、又不在
 *      83 个 skip 名字里 ⇒ restrict() 接受了它们，却没有改变 agent 会话的工具面
 *      （dsh-tools/lib/index.js:2959-2985 的 view(scope) 把 layer.admits() 只用在
 *      inherited 上；restrict() 落成的那一层显然没进到会话真正取用的链条）。
 *   ⇒ 口径更正：这份名单的语义是"restrict() 会接受的名字"，**不等于"能遮住"**。
 *      在这版 harness 上，注册期掩码对 agent 会话工具面没有可观测效果；唯一真正
 *      有效的边界是下面的执行期 guard（2026-10-15 实测拦下 6 次 compress 跨界调用）。
 *      要真正收窄 schema 只能改 composition（不装载），重启 DSH 也换不来。
 *   · 另有一组有源码依据、注定遮不住的：preset 自己挂的 own 层工具（compaction/acp 5 个、团队 9 个）、
 *     每个 agent scope 单独注册的 MCP 工具（mcp__phone-adb__* 20 个）、
 *     以及 tauri 调度器注入的 schedule_create/list/update/delete 4 个。
 *     这些只能靠"composition 里不装载"来消除，restrict 做不到。
 *
 * 用途：test-preset-local-tools.mjs 断言"该遮的确实落在可遮集合里"，不再假装
 * 整份 deny 名单都能生效（那正是这次踩到的失败模式）。
 */
export const RESTRICTABLE_GLOBAL_TOOL_NAMES = Object.freeze([
  'advanced_search', 'cache_search', 'domain_search', 'free_search_test',
  'list_mcp_resources', 'list_mcp_resource_templates', 'multi_search',
  'phone_lan', 'platform_search', 'read_mcp_resource', 'read_page',
  'render_ui', 'research', 'validate_dsh_ui', 'video_search', 'weather', 'x_search',
])

/**
 * denyNamesFor 里**真正会生效**的那部分（∩ 上面那份实测集合）。
 * @param {{allowPhoneAdb?: boolean}} [options]
 * @returns {string[]}
 */
export function restrictableDenyNamesFor(options) {
  const known = new Set(RESTRICTABLE_GLOBAL_TOOL_NAMES)
  return denyNamesFor(options).filter((name) => known.has(name))
}

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // B 站只读工具（搜索/视频/热门/UP 主）：无登录、无写操作，所有会话可安全使用。
  'mcp__bilibili-safe__',
]

/**
 * 主人私聊专用白名单：在上面基础上多放行手机控制。
 *
 * ⚠️ 这条前缀**绝不能**进上面那个 SAFE_PREFIXES。phone_* 能点外卖、下单、付款、
 * 以主人的名义发消息——一旦进了共享白名单，**任何群聊成员**都能驱动它。
 * 只有 qq-owner preset（见 build-agent-preset-patches.mjs 的 DERIVED_PRESETS）
 * 会拿到这一份，而 qq-owner 只在 `private:<ownerQQ>` 这一个会话上生效
 * （bridge.js 的 modePreset 按 key 分流）。
 */
const OWNER_EXTRA_PREFIXES = [
  'mcp__phone-adb__',
]

/**
 * 主人私聊专用的**精确工具名**白名单（2026-10-12 加，配合 dsh-phone-agent）。
 *
 * 为什么需要这个而不是靠前缀：`dsh-phone-agent` 是**原生 cordis 插件**，不是 MCP
 * server，所以它注册的工具名是裸的 `phone_lan`（见其 cordis.patch.yml 的
 * config.toolName），**不带 `mcp__xxx__` 前缀**。上面的 prefixes 机制天生匹配不到它，
 * 不加这一条的话，插件挂上去也会被守卫在执行期一律拒绝——而且是"静默装了但用不了"
 * 这种最难查的失败。
 *
 * 为什么是精确名而不是前缀：`phone_lan` 不需要前缀匹配（只有一个工具），
 * 用精确名比前缀更不容易误放行（比如将来某个插件注册了 `phone_lan_helper`
 * 这种名字，前缀会连它一起放）。
 *
 * ⚠️ 安全性同 OWNER_EXTRA_PREFIXES：这是**主人私聊专属**。`phone_lan` 能点击、
 * 输入、发消息、下单，任何群聊成员拿到它都等于拿到主人的手机。所以它只出现在
 * OWNER_* 里，绝不进 SAFE_*。
 */
const OWNER_EXTRA_EXACT = [
  'phone_lan',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

/**
 * 安装守卫。**唯一实现**，qq-tool-restrict.mjs（严格）与
 * qq-tool-restrict-owner.mjs（主人版）都走这里——两份白名单不会漂移。
 *
 * 为什么不走 cordis 的 config 通道（preset 行里写 config: {allowPhoneAdb: true}）：
 * 本仓库的插件（qq-mode-console）只声明 Config 而没在 apply 里读过它，等于这条通道
 * 在 DSH 0.2.0 下**没有被验证过**。白名单是安全边界，不能建立在"大概会传进来"上。
 * 用工厂函数则是纯静态的：走哪条分支由 preset 引用的**模块**决定，一眼可查。
 *
 * @param {object} ctx cordis 上下文（需要 ctx.tools）
 * @param {{allowPhoneAdb?: boolean, allowPrefixes?: string[], nameAliases?: [string, string][]}} [options]
 *   allowPhoneAdb：是否放行手机控制工具（qq-owner 用）
 *   allowPrefixes：**整体替换**默认前缀白名单（第二个 QQ 号用，见 qq-tool-restrict-fish.mjs）；
 *     不传就是本仓库默认的 SAFE_PREFIXES，老号两条 preset 的行为一个字节都不变。
 *   nameAliases：[[错前缀, 对前缀], …]。撞上错前缀时把「你要用的是哪一个」写进拒绝理由
 *     （见 installGuard 里 aliasHint 的注释）。
 */
// 上下文压缩类工具：不在白名单里，但**每轮都会被 billion-context 代理注入**到 agent 的
// 工具 schema 里，而且它在上下文涨到阈值时会 nudge「该压缩了」。模型照 nudge 去调，就被这里拒
// （2026-10-17 一晚上 3 次，每次还先手写 1–2k token 摘要，纯烧钱）。
// 对这几个名字单独给一句「本会话用不了、别重试」的拒绝理由：通用那句只说「不在白名单内」，
// 模型容易理解成「我名字写错了」而不停试；说清是禁用，它这一轮就回去聊天了。
const CONTEXT_TOOLS = new Set([
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
])
export const CONTEXT_TOOL_NAMES = Object.freeze([...CONTEXT_TOOLS])
const CONTEXT_TOOLS_MESSAGE = '上下文压缩工具在本会话不可用（compress/decompress/search_context/acp_status/acp_cache）。'
  + '「上下文用量高/请压缩」这类提示来自外部代理，一律忽略；不要重试、不要自己写摘要——上下文由系统自动换会话，直接继续聊天。'

/**
 * 宿主检索类工具：不是"用不了"，而是"换一个用"——它们的正路是
 * `mcp__web-search-safe__web_search` / `web_fetch`，写进理由里它一次就能改对。
 *
 * 为什么单列：这批名字**已经被注册期掩码遮掉**（见 RESTRICTABLE_GLOBAL_TOOL_NAMES），
 * 多数时候模型看不见；但掩码对 own 层无效，个别 composition 下它们仍会露出来，
 * 而模型对"搜一下"的执念最深（2026-10-15 实测 compress 那种反复重试就属于同类）。
 */
const HOST_SEARCH_TOOL_NAMES = new Set([
  'web_search', 'web_fetch', 'read_page',
  'advanced_search', 'multi_search', 'platform_search', 'video_search', 'x_search', 'free_search_test',
])

/**
 * 本机能力类工具的拒绝理由（2026-10-19 加，起因是一次真实的 `tool=pwsh` 调用被拒）。
 *
 * 为什么必须有专门的一句（与 CONTEXT_TOOLS 完全同构）：下面这些都是 **own 层**注册的
 * 工具，`tools.restrict()` 永远遮不掉（源码依据见 installGuard 开头那段注释），所以它们
 * 每一轮都明明白白列在模型的工具 schema 里；而 DSH 的系统提示词是一套 coding agent
 * 口吻，模型隔一阵就想"跑个命令看看"。一调就被上面那句泛泛的「不在白名单内」拒绝时，
 * 它容易理解成"我名字写错了"，于是换个写法再试，白烧一轮 token。
 * 2026-10-18 的 harness 日志里就躺着一条 `审批事件：tool=pwsh session=…`。
 *
 * 名单不手抄第二份：从 RESTRICTED_TOOL_NAMES 扣掉「上下文压缩 / 宿主检索 / 桌面专用 /
 * 手机面」四类即是它——避免两份名单漂移（断言见 test-preset-local-tools.mjs：
 * 五类必须互不相交，且并集必须覆盖 RESTRICTED_TOOL_NAMES）。
 */
export const LOCAL_TOOL_MESSAGE_NAMES = Object.freeze(RESTRICTED_TOOL_NAMES.filter((name) => !CONTEXT_TOOLS.has(name)
  && !HOST_SEARCH_TOOL_NAMES.has(name)
  && !HARNESS_ONLY_TOOL_NAMES.includes(name)
  && !STRICT_ONLY_TOOL_NAMES.includes(name)))
export const HOST_SEARCH_TOOL_MESSAGE_NAMES = Object.freeze([...HOST_SEARCH_TOOL_NAMES])

const LOCAL_TOOLS_MESSAGE = (name) => `工具 "${name}" 属于本机能力（执行命令、读写文件、跑代码、派生智能体、改插件或配置），`
  + 'QQ 会话不开放这些：调了也只是被拒、不会执行，别再试。要动本机请主人在电脑上自己来；'
  + '你照常用 mcp__snowluma__* 的工具、正常回话就行。'
const HOST_SEARCH_TOOLS_MESSAGE = (name) => `宿主搜索工具 "${name}" 在本会话用不了（不是名字写错，是没有这个入口）。`
  + '要查资料只能用 mcp__web-search-safe__web_search / web_fetch，别再试宿主搜索。'

/**
 * 白名单遮罩：把继承层里所有**不在白名单**的工具从 schema 藏掉（不只是执行期拒绝）。
 *
 * 为什么需要「枚举否定」而不是直接 restrict({ allow })：allow 里的名字只要有一个
 * 在当前 composition 里不存在，restrict 就整批抛错（原子性），一个都遮不上；而
 * deny 可以先用 view(undefined).restrictableNames 取到「真实存在且可遮」的名单再算差集。
 *
 * 为什么用 view(undefined)：restrict 的 unknown 校验就是拿 `view(scope).restrictableNames`
 * 比对的（@deepseek-ai/dsh-tools/lib/index.js:2906）。undefined scope = 全局层视图，
 * 拿到的正是「继承层可遮蔽名字」——preset 自己注册的 scoped 工具不在里面，也就不受影响
 * （ask_user_question / todo_write 这类 own 层工具照旧可见）。
 *
 * 失败语义：拿不到清单、或 restrict 抛非 unknown 错 → 只打日志、跳过遮罩。
 * 遮罩是省钱优化，不能变成"会话起不来"的新失败点。
 *
 * @param {object} ctx cordis 上下文（agent.ctx）
 * @param {{scope: string, prefixes: string[], exacts: string[]}} opts
 * @returns {number} 遮掉的名字数量（0 = 没遮/被跳过）
 */
export function maskToAllowlist(ctx, { scope, prefixes, exacts = [] }) {
  const keep = (name) => SAFE_EXACT.has(name)
    || exacts.includes(name)
    || prefixes.some((prefix) => name.startsWith(prefix))
  let names = null
  for (const viewScope of [undefined, ctx]) {
    try {
      const view = ctx.tools.view(viewScope)
      if (view && view.restrictableNames && view.restrictableNames.size > 0) {
        names = [...view.restrictableNames]
        break
      }
    } catch {
      // 换下一个取法；两条都失败就是跳过（见上面的失败语义）。
    }
  }
  if (!names) {
    console.error(`[qq-tool-restrict] ${scope}：拿不到继承层工具清单，跳过白名单遮罩（不影响功能，只是省不到这份 token）`)
    return 0
  }
  const denied = names.filter((name) => !keep(name))
  if (denied.length === 0) return 0
  // restrict 对 unknown（own 层/未挂载）名字是整批拒绝的，而报错里会逐个列出这些名字。
  // 把它们从名单里剥掉再试，比在这里硬编码一份「哪些名字是 own 层」的名单可靠。
  let pending = denied
  for (let round = 0; round < 5 && pending.length > 0; round += 1) {
    try {
      ctx.tools.restrict({ deny: pending })
      return pending.length
    } catch (error) {
      const message = String(error?.message ?? error)
      const unknown = [...message.matchAll(/"([^"]+)"/g)]
        .map((match) => match[1])
        .filter((name) => pending.includes(name))
      if (unknown.length === 0) {
        console.error(`[qq-tool-restrict] ${scope}：白名单遮罩失败（${message.slice(0, 200)}）`)
        return 0
      }
      pending = pending.filter((name) => !unknown.includes(name))
    }
  }
  return 0
}

export function installGuard(ctx, { allowPhoneAdb = false, allowPrefixes, nameAliases } = {}) {
  const aliases = Array.isArray(nameAliases) ? nameAliases : []
  // 为什么拒绝理由要带上「你要用的应该是哪一个」：两套 MCP 的工具名只差一个后缀
  // （mcp__snowluma__qq_send_message vs mcp__snowluma2__qq_send_message），模型调错时
  // 只看到「不在白名单内」会反复重试同一个错名字、白烧一轮；写上正确名字它一次就改对。
  // 安全性不变：命中的是**拒绝**路径，只是把理由说清楚。
  const aliasHint = (name) => {
    for (const [wrong, right] of aliases) {
      if (name.startsWith(wrong)) {
        return ` 你要用的应该是 "${right}${name.slice(wrong.length)}"（${wrong}* 属于另一个 QQ 号）。`
      }
    }
    return ''
  }
  // 为什么白名单要能被整体换掉：第二个 QQ 号的 MCP 叫 mcp__snowluma2__ /
  // mcp__snowluma2-host__（serverName 必须带后缀，否则两套 MCP 的工具名撞车）。它必须
  // **看不到**老号那套工具名 —— 两套 MCP 在同一个 profile 里都注册着，不换白名单的话
  // 她不但调不动自己的工具，还可能照着提示词去调**另一个 QQ 号**的 MCP
  // （"用错账号发消息"是这里最难发现的错）。
  const basePrefixes = Array.isArray(allowPrefixes) && allowPrefixes.length > 0
    ? allowPrefixes
    : SAFE_PREFIXES
  const prefixes = allowPhoneAdb ? [...basePrefixes, ...OWNER_EXTRA_PREFIXES] : basePrefixes
  // 精确名白名单同样只给主人版（见 OWNER_EXTRA_EXACT 的说明）。
  const exacts = allowPhoneAdb ? OWNER_EXTRA_EXACT : []
  const scope = allowPhoneAdb ? '主人私聊' : 'QQ 桥接'
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  //
  // ⚠️ 名单里有一组**注定遮不住**的名字（2026-10-15 实测，别再以为名单没写）：
  // interrupt_agent / list_agents / send_message / spawn_teammate /
  // team_task_create / team_task_get / team_task_list / team_task_update / wait_agent
  // 仍然出现在严格组会话的工具清单里。根因在 DSH 侧，三处源码为证：
  //   · @deepseek-ai/dsh-tools/lib/index.js:2959-2985 的 view(scope)：
  //     inherited = 全局层 + 祖先层（**跳过 own**），visible 只对 inherited 应用
  //     layers.every(l => l.admits(name))；而 own 层是
  //     `if (own !== void 0) for (const [name, definition] of own.tools.entries())
  //      { knownNames.add(name); visible.set(name, definition) }`
  //     ⇒ **own 层注册的工具无条件可见，restrict 永远管不到**；
  //     名单里出现 own 层名字还会让 restrict 抛 unknown ⇒ 被下面的 catch 吞掉。
  //   · @deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js:64-97：
  //     `tryMembership(agent)` 对**任何没有 parentSession 的 root agent** 直接返回
  //     `{ root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }`。
  //   · @deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:229-231：
  //     install() 里 `const scoped = agent.ctx; scoped.tools.register(defineTool(...))`
  //     ⇒ 这 9 个工具被注册进**每个 QQ 桥接会话自己的 scope**（它们都是 root agent，
  //     也就是隐式 Team Lead）。它还会往系统提示词里塞一段 `team:policy`。
  // 结论：对它们 restrict 是"写了但不会生效"，留名只为可读性与执行期 guard 兜底；
  // 真要隐藏得等 DSH 提供 own 层掩码，或在 composition 里不装载那个插件。
  const restricted = []
  const skipped = []
  for (const name of denyNamesFor({ allowPhoneAdb })) {
    try {
      ctx.tools.restrict({ deny: [name] })
      restricted.push(name)
    } catch {
      // 名字不在 inherited 层（全局/祖先）里 ⇒ 要么是 own 层（restrict 永远管不到，
      // 源码依据见上面 view(scope) 的注释），要么这个 composition 根本没挂载它。
      skipped.push(name)
    }
  }
  // 一行汇总。老版本对 80 个 own 层名字各打一行（dsh-web.log 每次启动 135 行噪声），
  // 真正的信号反而是被淹掉的 —— 现在分两段报，一眼能看出"可遮的到底遮了几个"。
  console.error(
    `[qq-tool-restrict] ${scope}：注册期已遮 ${restricted.length} 个（${restricted.join(' ')}）；`
    + ` 遮不住 ${skipped.length} 个（own 层/未挂载，仅执行期兜底）：${skipped.join(' ')}`,
  )

  // 1.5) [省 token 2026-10-18] 白名单遮罩：把**不在本 preset 白名单里**的继承层工具
  // 也从 schema 里藏掉，而不只是等执行期拒绝。
  //
  // 为什么要这一步：53k 的「共享前缀」里，除了系统提示就是工具说明书。同一个 DSH 里
  // 注册着两套 QQ MCP（mcp__snowluma__ 老号 / mcp__snowluma2__ 鱼号），还有 dsh-free-search、
  // dsh-im、modsearch 这些全局工具——它们对 QQ 群聊一个都用不上（执行期本来就被下面
  // 的白名单拒掉），但每轮都要按未命中价读一遍。实测每个 QQ MCP 命名空间的工具说明
  // 约 5.0k token（snowluma 32 个工具、描述 6360 字；snowluma2 34 个、6646 字）。
  //
  // 做法：用 tools.restrict({ deny }) 一次性遮掉「继承层里所有不在白名单里的名字」。
  // 工具名清单只能这样取——restrict 只接受**已注册的精确名**（不认通配），而
  // view(undefined).restrictableNames 正好就是「继承层、可遮蔽」的那一批。
  // 拿不到清单就跳过（fail-open + 一条日志），绝不因此让会话起不来。
  const masked = maskToAllowlist(ctx, { scope, prefixes, exacts })
  if (masked) {
    console.error(
      `[qq-tool-restrict] ${scope}：白名单遮罩又藏了 ${masked} 个继承层工具`
      + `（只留 ${prefixes.join(' ')} 与 ${[...SAFE_EXACT, ...exacts].join(' / ')}）`,
    )
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (SAFE_EXACT.has(name)) return
    if (exacts.includes(name)) return
    if (prefixes.some((prefix) => name.startsWith(prefix))) return
    if (CONTEXT_TOOLS.has(name)) return CONTEXT_TOOLS_MESSAGE
    if (HOST_SEARCH_TOOL_NAMES.has(name)) return HOST_SEARCH_TOOLS_MESSAGE(name)
    if (LOCAL_TOOL_MESSAGE_NAMES.includes(name)) return LOCAL_TOOLS_MESSAGE(name)
    return `工具 "${name}" 不在${scope}白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）${aliasHint(name)}`
  })
}

export function apply(ctx) {
  installGuard(ctx)
}
