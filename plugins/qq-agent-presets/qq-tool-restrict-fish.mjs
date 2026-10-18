// 第二个 QQ 号专用守卫（qq-chat-v2-fish preset 引用）。
//
// 与严格版（qq-tool-restrict.mjs）**共用同一份实现**——危险工具名单、执行期白名单判定
// 都在 installGuard() 里，这里只把前缀白名单整体换成新号那套 MCP，不复制任何判断逻辑。
//
// 为什么必须换：第二个账号的 MCP serverName 带后缀（snowluma2 / snowluma2-host），
// 所以它的工具名是 mcp__snowluma2__qq_*。而**老号那套 mcp__snowluma__qq_*** 在同一个
// profile 里同样注册着——不换白名单的话，她不但调不动自己的工具（会被执行期 guard 拒），
// 还可能照着提示词里的老工具名去调**另一个 QQ 号**的 MCP。
//
// 为什么不用 preset 行的 config 传白名单：见 qq-tool-restrict.mjs 里 installGuard 的注释
// ——本仓库没有插件读过 cordis 传进来的 config，那条通道在 DSH 0.2.0 下没被验证过。
// 用模块分流是纯静态的：**谁引用了哪个文件，就决定了拿到哪份白名单**。
//
// 边界提醒：这个模块只该被 qq-chat-v2-fish 引用。老号（qq-chat / qq-chat-v2 / qq-owner）
// 引用它等于把自己的工具全部换成了另一个账号的。
export const name = 'qq-tool-restrict-fish'

export const inject = ['tools']

import { installGuard } from './qq-tool-restrict.mjs'

/** 新号的白名单：只放行它自己那套 snowluma MCP，外加共享的无害 web 搜索。 */
export const SAFE_PREFIXES_FISH = Object.freeze([
  'mcp__snowluma2__',
  'mcp__snowluma2-host__',
  'mcp__web-search-safe__',
])

/** 两套 MCP 的工具名只差一个后缀，调错时把正确前缀写进拒绝理由（见 installGuard 的 aliasHint）。 */
export const NAME_ALIASES = Object.freeze([
  ['mcp__snowluma-host__', 'mcp__snowluma2-host__'],
  ['mcp__snowluma__', 'mcp__snowluma2__'],
])

export function apply(ctx) {
  installGuard(ctx, {
    allowPrefixes: [...SAFE_PREFIXES_FISH],
    nameAliases: NAME_ALIASES.map((pair) => [...pair]),
  })
}
