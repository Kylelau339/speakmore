import en from "./locales/en.mjs";
import zhCN from "./locales/zh-CN.mjs";
import zhTW from "./locales/zh-TW.mjs";

// 界面语言：菜单栏、三个窗口、命令行给人看的每一句话都从这里取。内核（提示词、整理出来的成品）不归这里管。
//
// 文案按语言各放一个文件（locales/），按"区域.名字"取。内核和主进程不直接写某种语言的话，
// 而是交出一句"还没定语言的话"（msg：名字加参数），由最后显示它的那一端按自己的语言翻：
// 后台和命令行可能各用各的语言，界面换语言时已经报上来的状态也跟着换。
//
// 加一种语言：照着 locales/en.mjs 写一个文件，在 LOCALES 里加一行。少了哪句、参数对不上，测试会指出来。
//
// 按系统说法不同的话（⌘V 和 Ctrl+V、"系统设置"和"设置"、活动监视器和任务管理器）：通用的那句照 macOS 写，
// Windows 的写在同一个文件的 windows 一节里、名字照抄（windows.delivery.pasteFailed 盖过 delivery.pasteFailed）。
// 在 Windows 上翻译时先找那一节，没有就用通用的；调用的地方不用分系统。说法本来就不分系统的（中文的"本机"）不用写。

/**
 * 按这个顺序列给用户选。name 用它自己的语言写，不翻（认不出眼前语言的人也找得到自己的）。
 * 界面上列出来时用文案里的 language.<id>，按当前的界面语言写（繁体界面里是"簡體中文"，不是"简体中文"）。
 * separator：并列几样时不用 Intl 的写法（A、B和C），一律用它隔开。中文原来的界面就是全用顿号，
 * 而且"和""或"会紧挨着英文字母（Gemini API key和按键监听）
 */
export const LOCALES = Object.freeze([
  Object.freeze({ id: "en", name: "English", messages: en }),
  Object.freeze({ id: "zh-CN", name: "简体中文", messages: zhCN, separator: "、" }),
  Object.freeze({ id: "zh-TW", name: "繁體中文", messages: zhTW, separator: "、" }),
]);

/** 认不出系统语言、某句没翻时用它 */
export const DEFAULT_LOCALE = "en";

/** 设置里"跟随系统"的写法 */
export const SYSTEM_LOCALE = "system";

/** 按 id 找，大小写和 _、- 不论（zh_CN、zh-cn 都是 zh-CN）。@returns 没有这种语言时是 null */
export function findLocale(id) {
  const wanted = String(id ?? "")
    .replaceAll("_", "-")
    .toLowerCase();
  return LOCALES.find((locale) => locale.id.toLowerCase() === wanted) ?? null;
}

/** 补全成"语言-文字-地区"：zh 是 zh-Hans-CN，zh-TW 是 zh-Hant-TW。写法不对时是 null */
function maximized(tag) {
  try {
    const { language, script, region } = new Intl.Locale(String(tag).replaceAll("_", "-")).maximize();
    return { language, script, region };
  } catch {
    return null;
  }
}

/**
 * 系统偏好的语言（按优先顺序）里第一个我们有的。语言和文字都对得上才算：简体中文的系统用 zh-CN，
 * 繁体（zh-TW、zh-HK、zh-Hant-*）的地名都归 zh-TW，接着看下一个。都没有就用英文。
 * @param {readonly string[]} preferred 比如 Electron 的 app.getPreferredSystemLanguages()
 */
export function matchLocale(preferred) {
  const supported = LOCALES.map(({ id }) => ({ id, ...maximized(id) }));
  for (const tag of preferred ?? []) {
    const wanted = maximized(tag);
    if (wanted === null) continue;
    const same = supported.filter(({ language, script }) => language === wanted.language && script === wanted.script);
    if (same.length > 0) return (same.find(({ region }) => region === wanted.region) ?? same[0]).id;
  }
  return DEFAULT_LOCALE;
}

/**
 * 终端里的"系统语言"：照命令行程序的惯例看 LC_ALL、LC_MESSAGES、LANG（前面的设了就盖过后面的）。
 * zh_CN.UTF-8 → zh-CN；C、POSIX 是"没说"
 * @returns {string[]}
 */
/** 终端用来说语言的环境变量，前面的优先 */
const LOCALE_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG"];

export function localesFromEnv(env) {
  for (const name of LOCALE_VARIABLES) {
    const value = env[name]?.trim();
    if (!value) continue;
    const tag = value.split(/[.@]/)[0];
    return tag === "C" || tag === "POSIX" ? [] : [tag.replaceAll("_", "-")];
  }
  return [];
}

/**
 * 命令行的"系统语言"。先照惯例看 LC_ALL、LC_MESSAGES、LANG；Windows 的终端一般不设这几个，
 * 都没设时用系统的显示语言（Node 从系统取的那个，中文系统是 zh-CN）
 * @param {Record<string, string | undefined>} env
 * @param {{ platform?: NodeJS.Platform, systemLocale?: () => string }} [options] 测试时换掉
 * @returns {string[]}
 */
export function terminalLocales(
  env,
  { platform = process.platform, systemLocale = () => Intl.DateTimeFormat().resolvedOptions().locale } = {},
) {
  // 设了就照它（C、POSIX 这种说的是"不分语言"，用英文）；Windows 上一个都没设时才看系统
  const said = LOCALE_VARIABLES.some((name) => env[name]?.trim());
  if (said || platform !== "win32") return localesFromEnv(env);
  return [systemLocale()];
}

/**
 * 设置里写的语言 → 这一次用哪种。
 * @param {string} setting SYSTEM_LOCALE 或者某种语言的 id
 * @param {readonly string[]} systemPreferred 系统偏好的语言，跟随系统时用
 */
export function resolveLocale(setting, systemPreferred) {
  if (setting === SYSTEM_LOCALE) return matchLocale(systemPreferred);
  return findLocale(setting)?.id ?? DEFAULT_LOCALE;
}

/**
 * 一句还没定语言的话。参数可以又是一句 msg（比如原因），翻的时候一起翻。
 * @returns {{ key: string, params?: object }}
 */
export const msg = (key, params) => (params === undefined ? { key } : { key, params });

const isMessage = (value) => value !== null && typeof value === "object" && typeof value.key === "string";

/**
 * 几句话里任一句都行（一个动作绑的几个组合：fn、右⌘），翻的时候按"或"并列（t.either）。和 msg 一样能当参数、能过 JSON
 * @param {Array<object | string>} items
 */
export const alternatives = (items) => ({ alternatives: items });

const isAlternatives = (value) => value !== null && typeof value === "object" && Array.isArray(value.alternatives);

const lookup = (messages, key) => key.split(".").reduce((node, part) => node?.[part], messages);

/**
 * 某种语言的翻译函数。t(名字, 参数)：模板里的 {参数名} 换成参数；模板是 { one, other } 这样分了单复数的，
 * 按参数 count 挑。count 是个数：给数字就按这种语言写（1,234），别的参数原样写（命令里的数不能加逗号）。
 * 找不到的名字原样返回（显得出来，不会悄悄空着），测试保证用到的名字都在。
 * 另外几样：
 *   t.text(话)   msg、alternatives 翻成这种语言；本来就是一段字（模型回的原话、旧版本后台报的中文）照原样；null 是空字符串
 *   t.list(几句) 按这种语言并列（A, B, and C / A、B、C）；t.either(几句) 是"或"（A or B / A、B）
 *   t.parts(名字, 参数) 同 t，但不拼成一段：参数的位置留着参数本身，调用方要把它画成别的样子时用（键帽）
 *   t.number(数) 按这种语言写数字（1,234）
 *   t.locale     这种语言的 id
 */
export function createTranslator(id, platform = defaultPlatform()) {
  const locale = findLocale(id) ?? findLocale(DEFAULT_LOCALE);
  const fallback = findLocale(DEFAULT_LOCALE).messages;
  const plurals = new Intl.PluralRules(locale.id);
  const lists = new Intl.ListFormat(locale.id, { type: "conjunction" });
  const alternatives = new Intl.ListFormat(locale.id, { type: "disjunction" });
  const numbers = new Intl.NumberFormat(locale.id);

  function template(key, params) {
    // 先这种语言（Windows 的说法、通用的），再英文：中文里"本机"不分系统，没写 Windows 那句的照通用的中文
    const variant = platform === "win32" ? `windows.${key}` : null;
    const found =
      (variant && lookup(locale.messages, variant)) ??
      lookup(locale.messages, key) ??
      (variant && lookup(fallback, variant)) ??
      lookup(fallback, key);
    if (typeof found === "string") return found;
    if (found !== null && typeof found === "object" && typeof found.other === "string") {
      return found[plurals.select(Number(params.count))] ?? found.other;
    }
    return key;
  }

  const text = (value) => {
    if (value === null || value === undefined) return "";
    if (isMessage(value)) return t(value.key, value.params);
    if (isAlternatives(value)) return t.either(value.alternatives);
    return String(value);
  };

  function parts(key, params = {}) {
    const pieces = [];
    const source = template(key, params);
    let last = 0;
    for (const match of source.matchAll(/\{(\w+)\}/g)) {
      const name = match[1];
      if (!Object.hasOwn(params, name)) continue;
      const value = name === "count" && typeof params.count === "number" ? numbers.format(params.count) : params[name];
      pieces.push(source.slice(last, match.index), value);
      last = match.index + match[0].length;
    }
    pieces.push(source.slice(last));
    return pieces.filter((piece) => piece !== "");
  }

  function t(key, params = {}) {
    return parts(key, params)
      .map((piece) => text(piece))
      .join("");
  }

  t.text = text;
  t.parts = parts;
  const join = (format) => (items) => {
    const texts = items.map(text);
    return locale.separator ? texts.join(locale.separator) : format.format(texts);
  };
  t.list = join(lists);
  t.either = join(alternatives);
  t.number = (value) => numbers.format(value);
  t.locale = locale.id;
  return t;
}

/**
 * 这一端是哪个系统：Node 里（主进程、命令行、服务端）看 process；页面里没有 process，看预加载脚本给的
 * window.speakmore.platform。都没有（在 Node 里跑页面模块的单元测试也有 process）按 macOS
 */
function defaultPlatform() {
  return globalThis.process?.platform ?? globalThis.window?.speakmore?.platform ?? "darwin";
}

/** 英文的那一份：给日志、给错误的 message 用 */
const english = createTranslator(DEFAULT_LOCALE);

/**
 * 要给人看的错误。problem 是一句 msg，由显示它的那一端翻；message 是英文的，进日志。
 * 内核和命令行共用的模块（设置、路径、厂商清单）出错时抛它。
 */
export class LocalizedError extends Error {
  constructor(problem, options) {
    super(english.text(problem), options);
    this.name = "LocalizedError";
    this.problem = problem;
  }
}

/** 一个错误给人看的那句话：带着 problem 的翻出来，其余的用它自己的 message */
export const problemOf = (error) => error?.problem ?? (error instanceof Error ? error.message : String(error ?? ""));
