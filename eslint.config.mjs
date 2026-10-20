// ESLint 配置（2026-10-20 引入，质量体检 P2）。
//
// 原则：**只开五条**，不引入格式化风暴。
// 这个仓库有 3.6 万行、几十个文件，如果一上来就开 `recommended`，会一次性冒出上千条
// 风格问题（缩进/引号/换行），既没人会去修，也会把真问题淹掉。所以只挑几类
// 「不修会出真 bug」的规则：
//
//   no-undef       —— 用了不存在的变量。这个仓库踩过最狠的一次：拆模块后 bridge.js
//                     漏了 import，测试全绿、真实进程一启动就 ReferenceError。
//                     引这条规则当场就抓出 3 处真 bug（st/now 出了 try 作用域、
//                     slangEntries 漏了 S. 前缀、formatVideo 漏了 import）。
//   no-unused-vars —— 死代码/漏用。反过来也能抓「本打算用却忘了用」的变量。
//   eqeqeq(smart)  —— 只禁 `==`/`!=` 的隐式转换，放行 `== null` 这个惯用法。
//   no-eval        —— eval 是代码注入面。
//   no-new-func    —— new Function 同上（测试夹具里跑源码片段是已知例外，就地 disable）。
//
// 其余一律不开：格式问题交给编辑器和 .editorconfig，别让 lint 变成噪音源。

// 这些是 Node 的运行时全局。ESLint 默认只认识 ECMAScript 内置对象，
// 不认识 console/process/Buffer，不声明就会把每一处都报成 no-undef。
// （不装 globals 包，就为省一个依赖；缺了再往这里加。）
const nodeGlobals = {
  console: 'readonly', process: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  fetch: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', Response: 'readonly',
  Headers: 'readonly', Request: 'readonly', FormData: 'readonly', Blob: 'readonly',
  performance: 'readonly', structuredClone: 'readonly', crypto: 'readonly',
  // Node 21+ 起 WebSocket 是全局（dsh-client.js 与几个探针脚本直接用）。
  WebSocket: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', require: 'readonly', module: 'readonly',
  exports: 'readonly', global: 'readonly',
};

// test-console-ui.mjs 在 vm 里造了个假 document 来跑控制台前端的内联脚本，
// 所以那个文件里满屏 document / getComputedStyle / localStorage。
// 只给这一个文件放行，别扩大到全仓——否则真在 Node 侧误用 DOM 就查不出来了。
const browserGlobals = {
  document: 'readonly', window: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  HTMLElement: 'readonly', Event: 'readonly', CustomEvent: 'readonly', Node: 'readonly',
  XMLHttpRequest: 'readonly', FileReader: 'readonly', atob: 'readonly', btoa: 'readonly',
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', {
    // 函数参数不查：大量回调用 (a, b) 只取一个，报出来全是噪音。
    args: 'none',
    // `catch (e)` 里没用到的 e 也放行（我们的风格是 catch (error) 后只记日志）。
    caughtErrors: 'none',
    // 下划线开头的变量是「我知道没用，故意的」（解构占位、接口对齐）。
    varsIgnorePattern: '^_',
  }],
  // smart：允许 `x == null`（同时判 null/undefined 的惯用法），其余必须 ===。
  eqeqeq: ['warn', 'smart'],
  'no-eval': 'error',
  'no-new-func': 'error',
};

export default [
  {
    // 只扫自己的源码与脚本；node_modules / public 里的第三方与静态页不扫。
    files: ['src/**/*.js', 'src/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    // 仓库里散布着一些 `// eslint-disable-next-line` 注释，是历次踩坑留下的
    // 「这里故意如此」说明。规则调整后它们可能暂时用不上，但注释本身有价值，
    // 不要因为「没用上」就报警告、更不要删。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules,
  },
  {
    files: ['scripts/test-console-ui.mjs'],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
  },
  {
    // scripts/ 下的测试夹具，本质就是「把源码字符串切出来塞进 vm / Function 跑」，
    // new Function 和 eval 是这套手法的必需手段，不是安全漏洞——它们跑的是仓库自己的源码，
    // 不接触外部输入。生产代码（src/）仍然严格禁这两条。
    files: ['scripts/**/*.mjs'],
    rules: { 'no-new-func': 'off', 'no-eval': 'off' },
  },
  {
    // 浏览器侧代码（控制台前端）是内联在 html 里的老式 ES5，不在扫描范围；
    // 这里显式忽略，免得以后有人加 .js 静态资源时误报。
    ignores: ['node_modules/**', 'public/**', 'data/**', 'state/**', 'logs/**', 'tmp/**'],
  },
];
