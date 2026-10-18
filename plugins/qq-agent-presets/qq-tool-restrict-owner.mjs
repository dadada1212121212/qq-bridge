// 主人私聊专用守卫（qq-owner preset 引用）。
//
// 与严格版（qq-tool-restrict.mjs）**共用同一份实现**——危险工具名单、白名单判定逻辑
// 都在 installGuard() 里，这里只多传一个开关，不复制任何判断逻辑。
//
// 为什么单独成文件而不是给 preset 行加 `config: { allowPhoneAdb: true }`：
// 见 qq-tool-restrict.mjs 里 installGuard 的注释——本仓库没有插件读过 cordis 传进来的
// config，那条通道在 DSH 0.2.0 下没被验证过。安全边界不能建立在"大概会传进来"上，
// 用模块分流则是纯静态的：**谁引用了哪个文件，就决定了拿到哪份白名单**。
//
// 边界提醒：这个模块只该被 qq-owner 引用。qq-owner 在 bridge.js 里只对
// `private:<ownerQQ>` 生效；一旦被 qq-chat / qq-chat-v2 引用，等于把手机控制权
// （点外卖、下单、付款、以主人名义发消息）交给所有群聊成员。
// test-preset-local-tools.mjs 会钉住这一点。
export const name = 'qq-tool-restrict-owner'

export const inject = ['tools']

import { installGuard } from './qq-tool-restrict.mjs'

export function apply(ctx) {
  installGuard(ctx, { allowPhoneAdb: true })
}
