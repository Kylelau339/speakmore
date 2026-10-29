import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alternatives,
  createTranslator,
  DEFAULT_LOCALE,
  findLocale,
  LOCALES,
  LocalizedError,
  localesFromEnv,
  matchLocale,
  msg,
  problemOf,
  resolveLocale,
  SYSTEM_LOCALE,
  terminalLocales,
} from "../../src/i18n/index.mjs";

const en = createTranslator("en");
const zh = createTranslator("zh-CN");

test("默认是英文；登记了英文、简体中文和繁体中文，名字用各自的语言写", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.deepEqual(
    LOCALES.map(({ id, name }) => [id, name]),
    [
      ["en", "English"],
      ["zh-CN", "简体中文"],
      ["zh-TW", "繁體中文"],
    ],
  );
});

test("按 id 找语言：大小写、_ 和 - 都不论；没有的是 null", () => {
  assert.equal(findLocale("zh_cn").id, "zh-CN");
  assert.equal(findLocale("EN").id, "en");
  assert.equal(findLocale("ja"), null);
  assert.equal(findLocale(undefined), null);
});

test("跟随系统：按偏好顺序找第一个有的，语言和文字都对上才算，都没有就用英文", () => {
  // 正：简体中文的几种写法都落到 zh-CN；繁体（TW/HK/MO、Hant）都落到 zh-TW；英文不论哪个地区都是 en
  for (const tag of ["zh-Hans-CN", "zh-CN", "zh", "zh-SG", "zh_CN"]) assert.equal(matchLocale([tag]), "zh-CN", tag);
  for (const tag of ["zh-Hant-TW", "zh-TW", "zh-HK", "zh-Hant-HK", "zh-Hant-MO", "zh-MO", "zh-Hant"])
    assert.equal(matchLocale([tag]), "zh-TW", tag);
  for (const tag of ["en-US", "en-GB", "en"]) assert.equal(matchLocale([tag]), "en", tag);
  // 顺序：第一个有的赢
  assert.equal(matchLocale(["fr-FR", "zh-Hans-CN", "en-US"]), "zh-CN");
  assert.equal(matchLocale(["en-US", "zh-Hans-CN"]), "en");
  assert.equal(matchLocale(["zh-TW", "zh-Hans-CN"]), "zh-TW");
  assert.equal(matchLocale(["zh-Hans-CN", "zh-Hant-HK"]), "zh-CN");
  // 负：认不出就是英文
  assert.equal(matchLocale(["ja-JP", "fr"]), "en");
  // 边界：空的、写法不对的
  assert.equal(matchLocale([]), "en");
  assert.equal(matchLocale(undefined), "en");
  assert.equal(matchLocale(["", "C", "not a tag!"]), "en");
});

test("终端的语言：LC_ALL 盖过 LC_MESSAGES 盖过 LANG；C 和 POSIX 是没说", () => {
  assert.deepEqual(localesFromEnv({ LANG: "zh_CN.UTF-8" }), ["zh-CN"]);
  assert.deepEqual(localesFromEnv({ LANG: "zh_CN.UTF-8", LC_MESSAGES: "en_US.UTF-8" }), ["en-US"]);
  assert.deepEqual(localesFromEnv({ LANG: "en_US.UTF-8", LC_ALL: "zh_CN.GB2312" }), ["zh-CN"]);
  assert.deepEqual(localesFromEnv({ LANG: "de_DE.UTF-8@euro" }), ["de-DE"]);
  assert.deepEqual(localesFromEnv({ LANG: "C" }), []);
  assert.deepEqual(localesFromEnv({ LC_ALL: "POSIX", LANG: "zh_CN.UTF-8" }), []);
  assert.deepEqual(localesFromEnv({ LANG: "  " }), []);
  assert.deepEqual(localesFromEnv({}), []);
});

test("设置里的语言：跟随系统时看系统，写了某种就用它，写了没有的退回英文", () => {
  assert.equal(SYSTEM_LOCALE, "system");
  assert.equal(resolveLocale("system", ["zh-Hans-CN"]), "zh-CN");
  assert.equal(resolveLocale("system", ["zh-Hant-HK"]), "zh-TW");
  assert.equal(resolveLocale("system", ["ja-JP"]), "en");
  assert.equal(resolveLocale("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLocale("zh-TW", ["en-US"]), "zh-TW");
  assert.equal(resolveLocale("en", ["zh-Hans-CN"]), "en");
  assert.equal(resolveLocale("klingon", ["zh-Hans-CN"]), "en");
});

test("翻译：参数填进模板；不认识的语言按英文；找不到的名字原样返回", () => {
  assert.equal(en("tray.version", { version: "0.6.0" }), "Version 0.6.0");
  assert.equal(zh("tray.version", { version: "0.6.0" }), "版本 0.6.0");
  assert.equal(createTranslator("ja")("tray.version", { version: "1" }), "Version 1");
  assert.equal(createTranslator("ja").locale, "en");
  assert.equal(zh.locale, "zh-CN");
  assert.equal(en("no.such.key"), "no.such.key");
  // 没给的参数原样留着，看得出漏了
  assert.equal(en("tray.version"), "Version {version}");
});

test("单复数按 count 挑：英文分 one 和 other，中文只有一种", () => {
  assert.equal(en("units.days", { count: 1 }), "day");
  assert.equal(en("units.days", { count: 3 }), "days");
  assert.equal(en("units.days", { count: 0 }), "days");
  assert.equal(zh("units.days", { count: 1 }), "天");
});

test("参数可以又是一句话；t.text 认 msg、认现成的字、认 null", () => {
  const problem = msg("model.unreachable", { provider: "Gemini" });
  assert.equal(
    en("setup.blocker.keyRejected", { problem }),
    "API key not working: Can't reach Gemini. Check your network",
  );
  assert.equal(zh.text(problem), "连不上 Gemini，检查网络后再试");
  // 模型回的原话、旧版本后台报上来的中文：照原样
  assert.equal(en.text("models/x is not found"), "models/x is not found");
  assert.equal(en.text(null), "");
  assert.equal(en.text(undefined), "");
});

test("count 是个数：按语言写成 1,234 并据此挑单复数；别的参数里的数原样写（命令里的数不能加逗号）", () => {
  assert.equal(en("cli.status.dictations", { count: 1 }), "1 dictation");
  assert.equal(en("cli.status.dictations", { count: 12345 }), "12,345 dictations");
  assert.equal(zh("cli.status.dictations", { count: 12345 }), "12,345 次");
  assert.equal(en("cli.history.more", { shown: 20, total: 1234 }).includes("-n 1234"), true);
});

test("并列和数字按语言写；中文一律用顿号隔开（和原来的中文界面一样，英文字母不挨着“和”“或”）", () => {
  assert.equal(en.list(["A", "B", "C"]), "A, B, and C");
  assert.equal(zh.list(["Gemini API key", "按键监听"]), "Gemini API key、按键监听");
  assert.equal(zh.list(["A", "B", "C"]), "A、B、C");
  assert.equal(zh.either(["1（Gemini）", "2（OpenAI）"]), "1（Gemini）、2（OpenAI）");
  assert.equal(zh.list(["A"]), "A");
  assert.equal(zh.list([]), "");
  assert.equal(en.list([msg("setup.missing.microphone")]), "microphone access");
  assert.equal(en.either(["1 (Gemini)", "2 (OpenAI)"]), "1 (Gemini) or 2 (OpenAI)");
  assert.equal(en.number(12345), "12,345");
});

test("几句里任一句（alternatives）：翻的时候按“或”并列，能当参数，也能嵌在别的话里", () => {
  // 键名按系统不同（Windows 上右⌘ 叫右 Win），这里按 Mac 的说
  const zhMac = createTranslator("zh-CN", "darwin");
  const enMac = createTranslator("en", "darwin");
  const keys = alternatives([msg("keys.Fn.keycap"), msg("keys.MetaRight.keycap")]);
  assert.equal(zhMac.text(keys), "fn、右⌘");
  assert.equal(enMac.text(keys), "fn or Right ⌘");
  assert.equal(zhMac("tray.ready", { keycap: keys }), zhMac("tray.ready", { keycap: "fn、右⌘" }));
  assert.equal(zh.text(alternatives([])), "");
  // 主进程交给页面、命令行的是普通对象，过一遍 JSON 还认得
  assert.equal(enMac.text(JSON.parse(JSON.stringify(keys))), "fn or Right ⌘");
});

test("t.parts 不拼起来：参数留在原位，调用方可以把它画成键帽", () => {
  const keycap = { key: "Right ⌥" };
  assert.deepEqual(en.parts("bar.recording", { key: keycap, esc: { key: "esc" } }), [
    "Press ",
    keycap,
    " to finish · ",
    { key: "esc" },
    " to cancel",
  ]);
  assert.deepEqual(zh.parts("bar.recording", { key: keycap, esc: { key: "esc" } }), [
    "再按一下 ",
    keycap,
    " 完成 · ",
    { key: "esc" },
    " 取消",
  ]);
});

test("LocalizedError：problem 留着给显示的那端翻，message 是英文的进日志", () => {
  const error = new LocalizedError(msg("key.empty"));
  assert.ok(error instanceof Error);
  assert.equal(error.message, "No key entered");
  assert.deepEqual(error.problem, { key: "key.empty" });
  assert.equal(zh.text(problemOf(error)), "还没有填 key");
  // 别的错误用它自己的 message
  assert.equal(problemOf(new Error("磁盘满了")), "磁盘满了");
  assert.equal(problemOf("一句话"), "一句话");
});

test("按系统说法不同的话：Windows 上先找 windows 那一节，没有就用通用的；中文没写 Windows 那句时用通用的中文，不掉回英文", () => {
  const macZh = createTranslator("zh-CN", "darwin");
  const winZh = createTranslator("zh-CN", "win32");
  const winEn = createTranslator("en", "win32");
  assert.match(macZh("delivery.pasteFailed"), /⌘V/);
  assert.match(winZh("delivery.pasteFailed"), /Ctrl\+V/);
  assert.match(winEn("delivery.pasteFailed"), /Ctrl\+V/);
  // 英文分 Mac 和 PC，中文都是"本机"
  assert.equal(createTranslator("en", "darwin")("plaza.via.local"), "This Mac");
  assert.equal(winEn("plaza.via.local"), "This PC");
  assert.equal(winZh("plaza.via.local"), "本机");
  // 不分系统的照常
  assert.equal(winZh("actions.dictate.name"), "语音输入");
});

test("命令行的语言：先看 LC_ALL、LC_MESSAGES、LANG；Windows 的终端一般都不设，这时用系统的显示语言", () => {
  const systemLocale = () => "zh-CN";
  assert.deepEqual(terminalLocales({ LANG: "en_US.UTF-8" }, { platform: "win32", systemLocale }), ["en-US"]);
  assert.deepEqual(terminalLocales({}, { platform: "win32", systemLocale }), ["zh-CN"]);
  // 明写了 C（Git Bash 这类终端会设）就照它，认不出的语言用英文，不再退回系统语言
  assert.deepEqual(terminalLocales({ LANG: "C" }, { platform: "win32", systemLocale }), []);
  assert.deepEqual(terminalLocales({ LANG: "  " }, { platform: "win32", systemLocale }), ["zh-CN"]);
  // macOS 的终端都会设，没设就是没说，不去猜
  assert.deepEqual(terminalLocales({}, { platform: "darwin", systemLocale }), []);
});
