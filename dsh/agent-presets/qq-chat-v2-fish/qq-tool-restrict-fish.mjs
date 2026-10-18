// re-export 壳：新号版守卫的权威实现只有一份，在
// plugins/qq-agent-presets/qq-tool-restrict-fish.mjs（它又复用严格版的 installGuard）。
//
// 与 qq-chat / qq-chat-v2 目录下那个同名壳的用途完全一致：DSH 0.1.7 起
// ~/.dsh/.agent-presets/<preset>/ 不再被读取，这个路径本身不再是「装进 DSH 的东西」；
// 保留它只是让仓库里按老路径读文件的脚本继续工作，并明确指向唯一实现。
//
// ⚠️ 这个壳只该出现在 qq-chat-v2-fish 目录下：它的白名单是 mcp__snowluma2__ 那套
// （第二个 QQ 号自己的 MCP），给老号用等于让她一个工具都调不动。
export * from '../../../plugins/qq-agent-presets/qq-tool-restrict-fish.mjs'
