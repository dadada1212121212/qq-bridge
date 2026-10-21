// [养鱼 2026-10-21] MCP 工具的参数容错。
//
// 由来：一次真实对话里，模型对「搜索关键词」先猜 keyword、对「视频」先猜 bvid，
// 连着三次拿到 `Invalid input: expected string, received undefined at query` 才改对。
// 那句 zod 报错对模型几乎零提示——它不知道自己传的 keyword 该叫 query，只能穷举。
//
// 两头一起修：
//   ① schema 里把常见别名声明成可选（zod 会丢弃未声明的键，不声明 = 传了等于没传）；
//   ② 一个都没传时给一句中文，说清「缺哪个、你传了哪些」，别让模型再猜一轮。
//
// 为什么选择容忍而不是「报错让它改」：这些工具是给模型用的，不是给程序调的 API。
// 多一次往返既慢又烧 token（工具描述本来就占着上下文），而参数名本身没有语义价值。

/** 按优先级取第一个非空字符串参数。数字也接受（BV 号/QQ 号有时被当数字传）。 */
export function pickStr(args, names) {
  if (!args || typeof args !== 'object') return '';
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/** 把实际收到的参数名拼成一句，用于报错时回显「你到底传了什么」。 */
export function argNames(args) {
  if (!args || typeof args !== 'object') return '（空）';
  const keys = Object.keys(args);
  return keys.length ? keys.join(' / ') : '（空）';
}

/** 缺参数时的统一话术：缺哪个、要什么、你传了什么。 */
export function missingArgHint(tool, field, expect, args) {
  return `【参数错误】${tool} 缺少 ${field}（${expect}）。`
    + `\n这次收到的参数是：${argNames(args)}`
    + `\n把 ${field} 补上重新调用即可。`;
}

/** 宽松枚举：把常见说法归一到合法值；认不出返回空串（由调用方决定怎么报错）。 */
export function normEnum(value, aliasMap) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!s) return '';
  return Object.hasOwn(aliasMap, s) ? aliasMap[s] : '';
}

/**
 * 把「别名键」折叠成规范键，并把**认不出的键**原样报出来。
 *
 * 为什么需要：zod 的 object 默认丢弃未声明的键。于是模型传
 * `triggers: { at: true, name: true }`（该写 atMention / nameMention）时，
 * 三个设置被静默吞掉，工具照样返回 ok:true —— 她以为设上了，实际一项没生效。
 * 这比报错糟得多：错可以重试，静默成功会一直错下去。
 *
 * 用法：schema 上加 .passthrough() 让多余的键活着进来，再在这里折叠 + 报告。
 * @returns {{ value: object, dropped: string[] }} dropped = 折叠后仍不认识的键
 */
export function foldAliases(obj, aliasMap) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { value: obj, dropped: [] };
  const out = { ...obj };
  const canonical = new Set(Object.keys(aliasMap));
  const lowerToReal = new Map(Object.keys(out).map((k) => [k.toLowerCase(), k]));
  for (const [name, aliases] of Object.entries(aliasMap)) {
    if (out[name] !== undefined) continue;
    for (const alias of aliases) {
      const real = lowerToReal.get(alias.toLowerCase());
      if (!real || real === name || out[real] === undefined) continue;
      out[name] = out[real];
      delete out[real];
      lowerToReal.delete(real.toLowerCase());
      break;
    }
  }
  const dropped = Object.keys(out).filter((k) => !canonical.has(k));
  // 认不出的键一并删掉再转发：写配置的接口不该把模型瞎编的字段存进 state。
  // 它们已经在 dropped 里被报出来了，不会变成"静默失效"。
  for (const k of dropped) delete out[k];
  return { value: out, dropped };
}

/** 统一成字符串数组：接受数组、"a,b"、"a，b"、"a、b"、"a b"。 */
export function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  if (typeof v === 'string') return v.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * 取「一条或多条消息」参数：字符串原样返回，数组原样返回。
 * 刻意**不**用 asArray 拆空格——那会把「我今天有点累 想早点睡」拆成两条消息发出去。
 */
export function pickStrOrList(args, names) {
  if (!args || typeof args !== 'object') return undefined;
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim())) return v;
  }
  return undefined;
}

/**
 * 给 zod shape 补一组「别名参数」（全部可选、不带描述，避免多占 token）。
 * zod 由调用方传进来，本模块不依赖 zod。
 * 用法：{ query: z.string().optional().describe('...'), ...aliasFields(z, ['query', 'keyword'], 'query') }
 */
export function aliasFields(z, names, primary) {
  const out = {};
  for (const n of names) if (n !== primary) out[n] = z.string().optional();
  return out;
}
