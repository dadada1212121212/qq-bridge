// re-export 壳：主人版守卫的权威实现只有一份，在
// plugins/qq-agent-presets/qq-tool-restrict-owner.mjs（它又复用严格版的 installGuard）。
//
// 与 qq-chat / qq-chat-v2 目录下那个同名壳的用途完全一致：DSH 0.1.7 起
// ~/.dsh/.agent-presets/<preset>/ 不再被读取，这个路径本身不再是「装进 DSH 的东西」；
// 保留它只是让仓库里按老路径读文件的脚本（test-audit-setup-guards.mjs 等）继续工作，
// 并明确指向唯一实现。
//
// ⚠️ 这个壳**只该出现在 qq-owner 目录下**。放进 qq-chat / qq-chat-v2 就等于把
// 手机控制权（点外卖、下单、付款、以主人名义发消息）交给所有群聊成员。
export * from '../../../plugins/qq-agent-presets/qq-tool-restrict-owner.mjs'
