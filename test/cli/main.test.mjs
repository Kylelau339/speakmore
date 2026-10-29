import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Cancelled } from "../../src/cli/ask-secret.mjs";
import { run } from "../../src/cli/main.mjs";
import { NotRunningError, TimeoutError } from "../../src/control.mjs";
import { ACTIONS } from "../../src/hotkeys/actions.mjs";
import { settingNameOf } from "../../src/hotkeys/settings.mjs";
import { createTranslator, LocalizedError, msg } from "../../src/i18n/index.mjs";
import { downloadSize, findModel } from "../../src/models/catalog.mjs";
import { CHAT_VENDORS } from "../../src/server/chat/vendors.mjs";
import { openHistory } from "../../src/storage/history.mjs";
import { keyFile, oldAppKeyFile, resolvePaths } from "../../src/storage/paths.mjs";
import { resolveSettings, SETTINGS } from "../../src/storage/settings.mjs";
import { createUpdates } from "../../src/update/index.mjs";
import { parseChannel } from "../../src/update/release.mjs";
import { assertOwnerOnlyDir } from "../helpers/owner-only.mjs";

/** 听写的默认键两个系统都是右 Option / 右 Alt；另挑一个两个系统都能绑的 */
const DEFAULT_HOTKEY = '["AltRight"]';
const OTHER_HOTKEY = "ControlRight";
// 默认的听写键：同一个位置，Mac 叫右 Option，Windows 叫右 Alt（键名跟着系统走）
const WINDOWS = process.platform === "win32";
const zhHotkey = WINDOWS ? "右 Alt 键" : "右 Option 键";
const enHotkey = WINDOWS ? "Right Alt" : "Right Option";
const zhKeycap = WINDOWS ? "右 Alt" : "右⌥";
/** fn、⌘ 只有 Mac 有：写着它们的断言在 Windows 上不跑 */
const macOnly = { skip: WINDOWS && "fn、⌘ 只有 Mac 有" };

const READY = {
  pid: 4321,
  version: "0.1.0",
  starting: false,
  "hotkey.dictate": DEFAULT_HOTKEY,
  "hotkey.cancel": '["Escape"]',
  provider: "gemini",
  mode: "native",
  model: "gemini/gemini-3.6-flash",
  thinking: "MINIMAL",
  packaged: false,
  helper: "running",
  key: { state: "ready", source: "stored", problem: null, verified: true },
  permissions: { microphone: "granted", listen: true, trusted: true },
  summary: { ready: true, missing: [], blocker: null, degraded: null },
};
/** 存着的那把被撤销了 */
const REVOKED_KEY = {
  ...READY,
  key: { state: "rejected", source: "stored", cause: "key", problem: "这把 key 无效，检查有没有复制完整" },
  summary: { ready: false, missing: ["Gemini API key"], blocker: "API key 不能用", degraded: null },
};
/** 模型名写错：Gemini 拒绝了请求，key 本身没问题 */
const WRONG_MODEL = {
  ...READY,
  model: "gemini/gemini-nope",
  key: {
    state: "rejected",
    source: "stored",
    cause: "other",
    problem: "Gemini 拒绝了请求：models/gemini-nope is not found",
  },
  summary: { ready: false, missing: ["Gemini 验证"], blocker: "Gemini 验证没通过", degraded: null },
};
const NO_KEY = {
  ...READY,
  key: { state: "missing", source: null, problem: null },
  summary: { ready: false, missing: ["Gemini API key"], blocker: "还没有填 Gemini API key", degraded: null },
};
const NO_PERMISSIONS = {
  ...READY,
  permissions: { microphone: "denied", listen: false, trusted: true },
  summary: { ready: false, missing: ["麦克风权限", "输入监控权限"], blocker: "没有麦克风权限", degraded: null },
};

let dir;
let userDir;
let paths;
/** 有的测试要在家目录以外放东西 */
let outside = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-"));
  // 定位文件放在另一个临时目录里（当成用户目录），不碰这台电脑上真的那个
  userDir = mkdtempSync(join(tmpdir(), "sm-user-"));
  paths = resolvePaths({ SPEAKMORE_HOME: dir }, userDir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  if (outside) rmSync(outside, { recursive: true, force: true });
  outside = null;
});

/**
 * 假的后台应用。running 是它现在的状态（null 表示没在运行），afterStart 是启动之后的状态，
 * saveKey 决定存 key 的结果，stopped 是停止时的说法，hung 为 true 表示它卡住了不答话。
 * reloadTheme、reloadLanguage 是让它重新读主题、语言时的回答，默认和真的一样：照设置文件里现在写的换。
 * changeRoute 是切模式、换各模式里的模型（set-mode、set-model、set-transcriber、set-polish）时的回答。
 * calls 记下命令行对它做过什么。
 */
function fakeDaemon({
  running = null,
  afterStart = READY,
  saveKey = () => ({ ok: true }),
  checkModel = () => ({ ok: true, source: "stored", ms: 812 }),
  changeRoute = () => ({ ok: true }),
  stopped = "quit",
  hung = false,
  reloadTheme = () => ({ theme: resolveSettings({ file: paths.settingsFile, env: {} }).theme.value }),
  reloadLanguage = () => ({ language: resolveSettings({ file: paths.settingsFile, env: {} }).language.value }),
  reloadHotkeys = () => {
    const settings = resolveSettings({ file: paths.settingsFile, env: {} });
    return Object.fromEntries(ACTIONS.map((action) => [settingNameOf(action), settings[settingNameOf(action)].value]));
  },
} = {}) {
  const daemon = {
    calls: [],
    /** 每条命令带的参数 */
    requests: [],
    current: running,
    hung,
    async status(params = {}) {
      if (daemon.hung) throw new TimeoutError("status", 5_000);
      if (params.recheck) daemon.calls.push("recheck");
      return daemon.current;
    },
    async start({ onProgress }) {
      daemon.calls.push("start");
      onProgress("正在验证 key…");
      if (afterStart instanceof Error) throw afterStart;
      daemon.current = afterStart;
      return afterStart;
    },
    async stop() {
      daemon.calls.push("stop");
      const was = daemon.current !== null || daemon.hung;
      daemon.current = null;
      daemon.hung = false;
      return was ? stopped : "not-running";
    },
    async request(cmd, params) {
      daemon.calls.push(cmd);
      daemon.requests.push({ cmd, params });
      if (daemon.current === null) throw new NotRunningError();
      if (cmd === "check-model") return checkModel(params.model);
      if (cmd === "check-polish") return checkModel(params.polish);
      if (cmd === "check-mode") return checkModel(params.changes?.transcriber ?? params.mode);
      if (["set-mode", "set-model", "set-transcriber", "set-polish"].includes(cmd)) return changeRoute(cmd, params);
      if (cmd === "set-key") {
        const result = saveKey(params.key, params.provider);
        // 存 key 只改 key 的状态，用的是哪一家不变
        if (result.ok) daemon.current = { ...daemon.current, key: READY.key, summary: READY.summary };
        return result;
      }
      if (cmd === "forget-key") daemon.current = NO_KEY;
      if (cmd === "reload-theme") return reloadTheme();
      if (cmd === "reload-language") return reloadLanguage();
      if (cmd === "reload-hotkeys") return reloadHotkeys();
      return null;
    },
  };
  return daemon;
}

/** secrets：每次问 key 时依次给出的回答。可以是文字、要抛的错误，或者一个现算的函数 */
function harness({
  daemon = fakeDaemon(),
  interactive = true,
  env = {},
  secrets = [],
  answers = [],
  confirms = [],
  keychain = () => true,
  locale = "zh-CN",
  latest = "v0.1.0",
  installerExit = 0,
  packageDir = paths.appDir,
  app = null,
  /** 下载、核对 App 的安装包时（抛错就是没核对过） */
  appInstall = () => {},
  /** 换上 App 时（抛错就是没换成） */
  appCommit = () => {},
  modelDownload = "finish",
  // 卸载时按哪个系统的样子做；Windows 那几处（windows-system.mjs）换成记下来、照 system 给的回答
  platform = "darwin",
  system = {},
  /** 搬家（src/move）：假的，记下问过、搬过哪里 */
  mover = fakeMover(),
  /** 记着的搬家进程还在不在 */
  moverAlive = () => false,
} = {}) {
  const output = { out: "", err: "" };
  const asked = [];
  /** 普通提问（会回显的，比如选用哪一家）问过的话 */
  const questions = [];
  const tails = [];
  const confirmed = [];
  /**
   * 问下载地址最新版本的次数（带的限时）、让安装脚本装过的版本、装完重新启动家目录那一份的次数（starts）、
   * 找 App 时给的进程号（lookedFor）、下好待换的 App（staged）、换上的 App（apps：版本、位置、换的时候后台还在不在跑）、
   * 没换就删掉的待换 App（discarded）、重新打开过的 App
   */
  const updates = {
    checks: [],
    installs: [],
    starts: [],
    lookedFor: [],
    staged: [],
    apps: [],
    discarded: [],
    opened: [],
  };
  /** 后台没在运行时命令行自己下载、删除的本机模型（假的模型库：下载一报进度就下完，或者没下下来） */
  const local = { downloads: [], removed: [], sources: [] };
  /** Windows 上卸载时删过的 Path 项、认过的快捷方式、要等退出后再删的目录 */
  const windows = { pathEntries: [], shortcuts: [], later: [] };
  const io = {
    out: (text) => {
      output.out += `${text}\n`;
    },
    err: (text) => {
      output.err += `${text}\n`;
    },
    env,
    interactive,
    color: false,
    version: "0.1.0",
    // 原来的断言都是中文的：这些测试按中文跑，英文的另有几条
    t: createTranslator(locale),
    paths,
    daemon,
    now: () => new Date("2026-10-13T07:00:00.000Z"),
    sleep: async () => {},
    localModels: ({ source, onChange = () => {} }) => {
      local.sources.push(source);
      const state = new Map();
      const models = {
        status: (id) => state.get(id) ?? { id, installed: false, download: null, problem: null },
        async download(id) {
          local.downloads.push(id);
          const total = downloadSize(findModel(id));
          state.set(id, { id, installed: false, download: { received: total / 2, total }, problem: null });
          onChange(id);
          if (modelDownload === "finish") {
            haveModel(id);
            state.set(id, { id, installed: true, download: null, problem: null });
          } else {
            state.set(id, {
              id,
              installed: false,
              download: null,
              problem: msg("localModels.downloadFailed", { model: id, reason: modelDownload }),
            });
          }
          onChange(id);
          return { ok: true };
        },
        remove(id) {
          local.removed.push(id);
          rmSync(join(paths.modelsDir, id), { recursive: true, force: true });
          return { ok: true };
        },
      };
      return models;
    },
    timeZone: "Asia/Shanghai",
    openHistory,
    async askSecret(prompt) {
      asked.push(prompt);
      const next = secrets.shift();
      const answer = typeof next === "function" ? next() : next;
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
    async ask(question) {
      questions.push(question);
      const next = answers.shift();
      const answer = typeof next === "function" ? next() : next;
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
    async tail(args) {
      tails.push(args);
      return 0;
    },
    async confirm(question) {
      confirmed.push(question);
      return confirms.shift() ?? false;
    },
    removeKeychainKey: keychain,
    platform,
    system: {
      removePathEntry: (entry) => {
        windows.pathEntries.push(entry);
        return true;
      },
      isOurShortcut: (file) => {
        windows.shortcuts.push(file);
        return system.ourShortcut?.(file) ?? true;
      },
      removeLoginItem: () => system.loginItem ?? false,
      removeAfterExit: (dirs) => windows.later.push(...dirs),
    },
    sharedPreferencesFile: join(dir, "com.github.Electron.plist"),
    packageDir,
    cwd: () => "/work",
    mover: () => mover,
    moverAlive,
  };
  // 版本检查和更新走真的内核（src/update），只把下载地址、App、安装脚本这三样换成假的、记下做过什么
  io.updates = createUpdates({
    paths,
    env,
    packageDir,
    version: io.version,
    instance: daemon,
    platform,
    now: () => io.now(),
    pid: 999_999,
    release: {
      async channel(timeoutSeconds) {
        updates.checks.push(timeoutSeconds);
        const answer = typeof latest === "function" ? latest() : latest;
        if (answer instanceof Error) throw answer;
        return parseChannel(JSON.stringify({ format: 1, version: answer, electron: "44.0.0", targets: {} }));
      },
    },
    bundles: {
      async find({ pid }) {
        updates.lookedFor.push(pid);
        return app;
      },
      clean: () => null,
      async stage({ version }, path) {
        updates.staged.push({ version, path, stillRunning: daemon.current !== null });
        appInstall();
        return {
          downloadedBytes: 1_000_000,
          reusedBytes: 300_000_000,
          commit() {
            updates.apps.push({ version: `v${version}`, path, stillRunning: daemon.current !== null });
            appCommit();
          },
          discard() {
            updates.discarded.push(path);
          },
        };
      },
      async open(path) {
        updates.opened.push(path);
      },
    },
    homes: {
      // 像是用安装脚本装的：程序在家目录的 app 里，或者 Windows 的 versions 下
      find: () => (existsSync(paths.appDir) || existsSync(paths.versionsDir) ? { version: io.version } : null),
      clean: () => null,
      seeds: () => [],
      async stage({ version }) {
        return { dir: `staged-${version}`, version, downloadedBytes: 0, reusedBytes: 0, discard() {} };
      },
      async install(staged) {
        updates.installs.push(`v${staged.version}`);
        // 和真的安装脚本一样：先停掉正在运行的
        daemon.current = null;
        return installerExit;
      },
      async start() {
        updates.starts.push(true);
        daemon.current = READY;
        return 0;
      },
    },
  });
  return {
    io,
    output,
    asked,
    questions,
    tails,
    confirmed,
    daemon,
    updates,
    local,
    windows,
    speakmore: (...argv) => run(argv, io),
  };
}

/**
 * 假的搬家：plan 交回要拷多少（或者抛 problem），run 照 progress 报进度、交回 result（或者抛 failure）。calls 记下做过什么
 */
function fakeMover({ problem = null, failure = null, progress = [], unknown = [], result = {} } = {}) {
  const calls = [];
  return {
    calls,
    async plan(folder) {
      calls.push(["plan", folder]);
      if (problem) throw new LocalizedError(problem);
      return { from: paths.home, to: `${folder}/.speakmore`, files: 1234, bytes: 1_200_000_000, unknown };
    },
    async run({ folder, by, report, onProgress }) {
      calls.push(["run", folder, by]);
      report(msg("move.copying", { to: `${folder}/.speakmore` }));
      for (const bytes of progress) onProgress({ files: 1, bytes, total: { files: 1234, bytes: 1_200_000_000 } });
      if (failure) throw new LocalizedError(failure);
      return {
        from: paths.home,
        to: `${folder}/.speakmore`,
        files: 1234,
        bytes: 1_200_000_000,
        unknown,
        left: [],
        later: false,
        ...result,
      };
    },
  };
}

/** 本机模型下好了：照模型仓的收据写一份（命令行只看收据，不读模型文件） */
function haveModel(id = "qwen3-asr-0.6b-q8") {
  const model = findModel(id);
  const where = join(paths.modelsDir, id);
  mkdirSync(where, { recursive: true });
  const files = Object.fromEntries(Object.values(model.files).map((file) => [file.path, file.sha256]));
  writeFileSync(join(where, ".complete.json"), JSON.stringify({ id, revision: model.origin.revision, files }));
}

/** 假装以前存过一把 key */
const haveStoredKey = () => writeFileSync(keyFile(paths, "gemini"), "密文");

// ---------- 启动 ----------

test("不带参数：没在运行就启动，然后给出状态面板", async () => {
  const { speakmore, output, daemon } = harness();
  assert.equal(await speakmore(), 0);
  assert.deepEqual(daemon.calls, ["start", "recheck"]);
  assert.match(output.out, /正在启动/);
  assert.match(output.out, /SpeakMore 0\.1\.0 · 运行中/);
  assert.match(output.out, new RegExp(`按一下${zhHotkey}开始说话`));
});

test("已经在运行时不再启动一次，只给面板；start 和不带参数是一回事", async () => {
  for (const argv of [[], ["start"]]) {
    const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
    assert.equal(await speakmore(...argv), 0);
    assert.ok(!daemon.calls.includes("start"));
    assert.match(output.out, /运行中/);
  }
});

test("第一次用：先问 key，再启动；存好了直接能用；key 不出现在任何输出里", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  // 等启动的那段时间里终端是照常回显的：要是到那时才想起来要 key，提前粘贴的人会看到 key 显示在屏幕上
  const whenAsked = () => {
    assert.deepEqual(daemon.calls, [], "问 key 的时候还没开始启动");
    return "AIza-my-secret";
  };
  const { speakmore, output, asked } = harness({ daemon, secrets: [whenAsked] });
  assert.equal(await speakmore(), 0);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.deepEqual(saved, ["AIza-my-secret"]);
  assert.equal(asked.length, 1);
  // 去哪申请、存在哪，是和提示一起交给"不回显地问"的那一步的：要先关掉回显再让人看到"要 key 了"
  assert.match(asked[0], /aistudio\.google\.com\/apikey/);
  assert.doesNotMatch(output.out, /aistudio/);
  assert.match(output.out, /已保存，验证通过/);
  assert.match(output.out, /运行中/);
  assert.ok(!(output.out + output.err).includes("AIza-my-secret"));
});

test("第一次用：按模式分组问用哪一家，选 DeepSeek 就进 local 模式、问 DeepSeek 的 key", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "deepseek", mode: "local" } });
  const { speakmore, questions, asked, output } = harness({ daemon, answers: ["4"], secrets: ["sk-ds"] });
  const code = await speakmore();
  assert.equal(code, 0, output.out + output.err);
  assert.match(
    questions[0],
    /native（直出）模式[\s\S]*1.*Gemini[\s\S]*2.*OpenAI[\s\S]*3.*Bailian[\s\S]*local（混合）模式.*850 MB[\s\S]*4.*DeepSeek[\s\S]*5.*Bailian/,
  );
  assert.match(questions[0], /custom\/<模型名> --url/);
  assert.deepEqual([saved("mode"), saved("polish")], ["local", "deepseek/deepseek-flash"]);
  assert.match(asked[0], /DeepSeek API key/);
});

test("第一次用：先问用哪一家，选 OpenAI 就记进设置、问 OpenAI 的 key，问完才启动", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" },
    saveKey: (key, provider) => {
      saved.push([key, provider]);
      return { ok: true };
    },
  });
  const whenChosen = () => {
    assert.deepEqual(daemon.calls, [], "选的时候还没开始启动");
    return "2";
  };
  const { speakmore, questions, asked, output } = harness({ daemon, answers: [whenChosen], secrets: ["sk-my-secret"] });
  assert.equal(await speakmore(), 0);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /1.*Gemini/);
  assert.match(questions[0], /2.*OpenAI/);
  // 以后怎么换也说一句，免得以为选了就定死了
  assert.match(questions[0], /speakmore model/);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /platform\.openai\.com\/api-keys/);
  assert.deepEqual(saved, [["sk-my-secret", "openai"]]);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.match(output.out, /OpenAI/);
  assert.ok(!(output.out + output.err).includes("sk-my-secret"));
});

test("第一次用：直接回车就是 Gemini，设置文件不动", async () => {
  const daemon = fakeDaemon({ afterStart: NO_KEY });
  const { speakmore, questions, asked } = harness({ daemon, answers: [""], secrets: ["AIza-key"] });
  assert.equal(await speakmore(), 0);
  assert.equal(questions.length, 1);
  assert.ok(!existsSync(paths.settingsFile));
  assert.match(asked[0], /aistudio\.google\.com/);
});

test("选的时候写名字也认；写错了说能选什么，再问", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "openai" } });
  const { speakmore, questions, output } = harness({ daemon, answers: ["nope", "OpenAI"], secrets: ["sk-key"] });
  assert.equal(await speakmore(), 0);
  assert.equal(questions.length, 2);
  assert.match(output.err, /nope/);
  assert.match(output.err, /1.*2/);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
});

test("别家已经有 key 时标出来；选它就不用再填，直接用它启动", async () => {
  writeFileSync(keyFile(paths, "openai"), "密文");
  const daemon = fakeDaemon({ afterStart: { ...READY, provider: "openai", model: "openai/gpt-audio-mini" } });
  const { speakmore, questions, asked } = harness({ daemon, answers: ["2"] });
  assert.equal(await speakmore(), 0);
  assert.match(questions[0], /OpenAI.*已经有 key/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-key"));
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
});

test("设置里或环境变量里已经定了用哪家：不再问选哪家，直接问那一家的 key", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ model: "openai/gpt-audio-1.5" }));
  const fromFile = harness({ daemon: fakeDaemon({ afterStart: NO_KEY }), secrets: ["sk-key"] });
  assert.equal(await fromFile.speakmore(), 0);
  assert.equal(fromFile.questions.length, 0);
  assert.match(fromFile.asked[0], /OpenAI/);
  rmSync(paths.settingsFile);

  const fromEnv = harness({
    daemon: fakeDaemon({ afterStart: NO_KEY }),
    env: { SPEAKMORE_MODEL: "gemini" },
    secrets: ["AIza"],
  });
  assert.equal(await fromEnv.speakmore(), 0);
  assert.equal(fromEnv.questions.length, 0);
});

test("选哪家时按了 Ctrl-C：不问 key，照默认的启动，面板里说还差 key", async () => {
  const daemon = fakeDaemon({ afterStart: NO_KEY });
  const { speakmore, questions, asked, output } = harness({ daemon, answers: [new Cancelled()] });
  assert.equal(await speakmore(), 0);
  assert.equal(questions.length, 1);
  assert.equal(asked.length, 0);
  assert.deepEqual(daemon.calls, ["start", "recheck"]);
  assert.match(output.out, /还差 1 样/);
});

test("已经有 key（存着的，或者环境变量给的）时直接启动，不问", async () => {
  haveStoredKey();
  const stored = harness();
  assert.equal(await stored.speakmore(), 0);
  assert.equal(stored.asked.length, 0);
  rmSync(keyFile(paths, "gemini"));

  const fromEnv = harness({ env: { GEMINI_API_KEY: "AIza-env" } });
  assert.equal(await fromEnv.speakmore(), 0);
  assert.equal(fromEnv.asked.length, 0);
});

test("问到的 key 样子不对（带换行、空格）：当场说、当场再问，不发给后台，内容不出现在输出里", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  const { speakmore, output, asked } = harness({ daemon, secrets: ["two\nlines-SECRET", "AIza-good"] });
  assert.equal(await speakmore(), 0);
  assert.equal(asked.length, 2);
  assert.deepEqual(saved, ["AIza-good"]);
  assert.match(output.err, /这把 key 里有空格或换行/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("存着的 key 启动后发现已经不能用了：这时再问一把", async () => {
  haveStoredKey();
  const daemon = fakeDaemon({ afterStart: REVOKED_KEY });
  const { speakmore, asked, output } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await speakmore(), 0);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.equal(asked.length, 1);
  assert.match(output.out, /运行中/);
});

test("不是 key 的问题时不问 key：模型名写错、环境变量里的 key 不对，都只在面板里说", async () => {
  haveStoredKey();
  const wrongModel = harness({ daemon: fakeDaemon({ afterStart: WRONG_MODEL }) });
  assert.equal(await wrongModel.speakmore(), 0);
  assert.equal(wrongModel.asked.length, 0);
  assert.match(wrongModel.output.out, /gemini-nope is not found/);
  assert.match(wrongModel.output.out, /speakmore config/);

  const badEnv = { ...REVOKED_KEY, key: { ...REVOKED_KEY.key, source: "env" } };
  const fromEnv = harness({ daemon: fakeDaemon({ afterStart: badEnv }), env: { GEMINI_API_KEY: "AIza-env" } });
  assert.equal(await fromEnv.speakmore(), 0);
  assert.equal(fromEnv.asked.length, 0);
  assert.match(fromEnv.output.out, /环境变量 GEMINI_API_KEY/);
});

test("key 不对时说明原因再问一次", async () => {
  const answers = [{ ok: false, problem: "这把 key 无效，检查有没有复制完整" }, { ok: true }];
  const daemon = fakeDaemon({ afterStart: NO_KEY, saveKey: () => answers.shift() });
  const { speakmore, output, asked } = harness({ daemon, secrets: ["wrong", "right"] });
  assert.equal(await speakmore(), 0);
  assert.equal(asked.length, 2);
  assert.match(output.err, /这把 key 无效/);
  assert.match(output.out, /运行中/);
});

test("问 key 时什么都没填或者按了 Ctrl-C：不纠缠，面板里说还差 key", async () => {
  for (const secret of ["", new Cancelled()]) {
    const daemon = fakeDaemon({ afterStart: NO_KEY });
    const { speakmore, output, asked } = harness({ daemon, secrets: [secret] });
    assert.equal(await speakmore(), 0);
    // 启动前问过一次、他没填，启动后就不再问第二遍
    assert.equal(asked.length, 1);
    assert.ok(!daemon.calls.includes("set-key"));
    assert.match(output.out, /还差 1 样/);
    assert.match(output.out, /speakmore key/);
  }
});

test("不是在终端里运行（脚本、管道）时不问 key，也不弹窗口", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, ...{ permissions: NO_PERMISSIONS.permissions } } });
  const { speakmore, asked, questions } = harness({ daemon, interactive: false });
  assert.equal(await speakmore(), 0);
  assert.equal(asked.length, 0);
  assert.equal(questions.length, 0);
  assert.ok(!daemon.calls.includes("show-settings"));
});

test("第一次用、缺系统权限：打开首次引导，并在面板里说明", async () => {
  const daemon = fakeDaemon({ afterStart: NO_PERMISSIONS });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore(), 0);
  // 请求名沿用 show-settings：老版本的后台不认识 onboarding 这个参数，照样打开设置
  assert.deepEqual(
    daemon.requests.find(({ cmd }) => cmd === "show-settings"),
    { cmd: "show-settings", params: { onboarding: true } },
  );
  assert.match(output.out, /还差 2 样/);
  assert.match(output.out, /已经打开首次引导/);
});

test("用过的人缺了系统权限：只打开设置", async () => {
  haveStoredKey();
  const daemon = fakeDaemon({ afterStart: NO_PERMISSIONS });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore(), 0);
  const request = daemon.requests.find(({ cmd }) => cmd === "show-settings");
  assert.ok(request);
  assert.notEqual(request.params?.onboarding, true);
  assert.match(output.out, /已经打开设置/);
});

test("启动不起来时把原因说出来，以非零退出", async () => {
  const daemon = fakeDaemon({ afterStart: new Error("SpeakMore 没能启动（退出码 2）") });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore(), 1);
  assert.match(output.err, /没能启动（退出码 2）/);
});

// ---------- 停止、重启、状态 ----------

test("stop：在运行就停掉，没在运行就照实说，是强行结束的也照实说", async () => {
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.speakmore("stop"), 0);
  assert.match(running.output.out, /已经停掉/);
  const idle = harness();
  assert.equal(await idle.speakmore("stop"), 0);
  assert.match(idle.output.out, /没有在运行/);
  const stuck = harness({ daemon: fakeDaemon({ hung: true, stopped: "killed" }) });
  assert.equal(await stuck.speakmore("stop"), 0);
  assert.match(stuck.output.out, /强行结束/);
});

test("restart：先停再起", async () => {
  const { speakmore, daemon, output } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("restart"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /运行中/);
});

test("restart：它卡住不答话时照样能重启", async () => {
  haveStoredKey();
  const { speakmore, daemon, output } = harness({ daemon: fakeDaemon({ hung: true, stopped: "killed" }) });
  assert.equal(await speakmore("restart"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /运行中/);
});

test("正在运行的是装成应用的那一个：不代它重启（会被换成终端启动的，权限和 key 是另一套），说怎么办", async () => {
  const packaged = { ...READY, packaged: true };
  const restarting = harness({ daemon: fakeDaemon({ running: packaged }) });
  assert.equal(await restarting.speakmore("restart"), 1);
  assert.deepEqual(restarting.daemon.calls, []);
  assert.match(restarting.output.err, /SpeakMore\.app/);
  assert.match(restarting.output.err, /退出/);

  const configuring = harness({ daemon: fakeDaemon({ running: packaged }) });
  assert.equal(await configuring.speakmore("config", "set", "thinking", "low"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { thinking: "LOW" });
  assert.deepEqual(configuring.daemon.calls, []);
  assert.match(configuring.output.out, /SpeakMore\.app/);
  assert.doesNotMatch(configuring.output.out, /已经生效/);
});

test("它卡住不答话时，别的命令说清楚是卡住了、怎么停，不甩一屏调用栈", async () => {
  for (const argv of [[], ["status"], ["settings"]]) {
    const { speakmore, output } = harness({ daemon: fakeDaemon({ hung: true }) });
    assert.equal(await speakmore(...argv), 1);
    assert.match(output.err, /没有在 5 秒内回话/);
    assert.match(output.err, /speakmore stop/);
  }
});

test("命令做到一半它没了：照实说没有在运行", async () => {
  const daemon = fakeDaemon({ running: READY });
  daemon.request = async () => {
    throw new NotRunningError();
  };
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("settings"), 1);
  assert.match(output.err, /没有在运行/);
});

test("status：只看不动；能用是 0，没在运行或还差东西是 1", async () => {
  const idle = harness();
  assert.equal(await idle.speakmore("status"), 1);
  // 只会让它重新查一遍系统权限，不会把它启动起来
  assert.deepEqual(idle.daemon.calls, ["recheck"]);
  assert.match(idle.output.out, /没有运行/);

  const ready = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await ready.speakmore("status"), 0);
  assert.ok(!ready.daemon.calls.includes("show-settings"));

  const incomplete = harness({ daemon: fakeDaemon({ running: NO_KEY }) });
  assert.equal(await incomplete.speakmore("status"), 1);
});

test("status --json：给程序读的，一行 JSON，带运行状态、设置和统计", async () => {
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: READY }) });
  await speakmore("status", "--json");
  const parsed = JSON.parse(output.out);
  assert.equal(parsed.running, true);
  assert.equal(parsed.status.pid, 4321);
  assert.equal(parsed.settings["hotkey.dictate"].value, DEFAULT_HOTKEY);
  assert.deepEqual(parsed.stats, { today: null, total: null });
});

test("status --json：0.13 以前的旧字段 settings.hotkey 留过一个版本（D13），0.15 起没有了，快捷键只看 hotkey.<动作>", async () => {
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: READY }) });
  await speakmore("status", "--json");
  const { settings } = JSON.parse(output.out);
  assert.equal(Object.hasOwn(settings, "hotkey"), false);
  assert.deepEqual(settings["hotkey.dictate"], { value: DEFAULT_HOTKEY, source: "default" });
});

// ---------- 更新 ----------

/** 像是用安装脚本装的：程序在家目录的 app 里 */
const installed = () => mkdirSync(paths.appDir, { recursive: true });

test("update：下载地址上有更新的版本，就让安装脚本装上它（装哪个版本说定了，不会装到半路又出来的更新的）", async () => {
  installed();
  const { speakmore, output, updates } = harness({ latest: "v0.2.0" });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
  assert.match(output.out, /更新 SpeakMore：0\.1\.0 → 0\.2\.0/);

  // 安装脚本没装成：它说的原因已经在终端上了，这边说一句没装成、原来的版本不变，退出码 1
  const failing = harness({ latest: "v0.2.0", installerExit: 1 });
  assert.equal(await failing.speakmore("update"), 1);
  assert.match(failing.output.err, /安装未完成（安装脚本的退出码是 1）/);
});

const APP = "/Applications/SpeakMore.app";
/** 正在运行的是装在"应用程序"里的那个 */
const APP_RUNNING = { ...READY, packaged: true, pid: 4242 };

test("update：原来没在运行的，换完不替它启动，提醒一句怎么启动", async () => {
  installed();
  const { speakmore, output, updates, daemon } = harness({ latest: "v0.2.0" });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(updates.starts, []);
  assert.deepEqual(updates.lookedFor, [null]);
  assert.deepEqual(updates.apps, []);
  assert.deepEqual(daemon.calls, []);
  assert.match(output.out, /已经更新到 0\.2\.0。运行 speakmore 启动/);
});

test("update：正在跑的是命令行起的这一份：先下好，再停掉它、换上、重新启动", async () => {
  installed();
  const daemon = fakeDaemon({ running: READY });
  const { speakmore, output, updates } = harness({ daemon, latest: "v0.2.0" });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(daemon.calls, ["stop"]);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
  assert.deepEqual(updates.starts, [true]);
  assert.doesNotMatch(output.out, /运行 speakmore 启动/);
});

test("update：正在跑的是 App：先把新的下好（这时它还在跑），再停掉它换上，两份都换，最后重新打开 App", async () => {
  installed();
  const daemon = fakeDaemon({ running: APP_RUNNING });
  const { speakmore, output, updates } = harness({ daemon, latest: "v0.2.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await speakmore("update"), 0);
  // 按正在跑的那个进程去找：用户可能没放在"应用程序"里。下好以后、停之前再按它找一次（下载期间可能换了一个在跑）
  assert.deepEqual(updates.lookedFor, [4242, 4242]);
  assert.deepEqual(updates.staged, [{ version: "0.2.0", path: APP, stillRunning: true }]);
  assert.deepEqual(updates.apps, [{ version: "v0.2.0", path: APP, stillRunning: false }]);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
  // 家目录那一份没在跑，不替它启动；停掉的是 App，重新打开 App
  assert.deepEqual(updates.starts, []);
  assert.deepEqual(updates.opened, [APP]);
  assert.match(output.out, /更新 SpeakMore\.app：0\.1\.0 → 0\.2\.0/);
  assert.match(output.out, /更新 SpeakMore：0\.1\.0 → 0\.2\.0/);
  assert.match(output.out, /已重新打开 SpeakMore\.app/);
});

test("update：只有 App 旧：只换 App；它没在跑就不打开", async () => {
  installed();
  const { speakmore, output, updates } = harness({ latest: "v0.1.0", app: { path: APP, version: "0.0.9" } });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(updates.apps, [{ version: "v0.1.0", path: APP, stillRunning: false }]);
  assert.deepEqual(updates.installs, []);
  assert.deepEqual(updates.opened, []);
  assert.match(output.out, /更新 SpeakMore\.app：0\.0\.9 → 0\.1\.0/);
  assert.doesNotMatch(output.out, /已经是最新的/);
});

test("update：只有 App 旧、正在跑的是命令行那一份：换的是另一个程序，不碍事，不停它", async () => {
  installed();
  const daemon = fakeDaemon({ running: READY });
  const { speakmore, updates } = harness({ daemon, latest: "v0.1.0", app: { path: APP, version: "0.0.9" } });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(daemon.calls, []);
  assert.deepEqual(updates.apps, [{ version: "v0.1.0", path: APP, stillRunning: true }]);
  assert.deepEqual(updates.starts, []);
});

test("update：装着 App、正在跑的是命令行那一份：两份都换，停掉的命令行那一份重新启动，App 不打开", async () => {
  installed();
  const daemon = fakeDaemon({ running: READY });
  const { speakmore, updates } = harness({ daemon, latest: "v0.2.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await speakmore("update"), 0);
  assert.equal(updates.apps.length, 1);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
  assert.deepEqual(updates.starts, [true]);
  assert.deepEqual(updates.opened, []);
});

test("update：装着 App、什么都没在跑：两个都换成新的，谁都不启动", async () => {
  installed();
  const { speakmore, updates } = harness({ latest: "v0.2.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await speakmore("update"), 0);
  assert.equal(updates.apps.length, 1);
  assert.deepEqual(updates.starts, []);
  assert.deepEqual(updates.opened, []);
});

test("update：App 和命令行那一份都是最新的：什么都不做", async () => {
  installed();
  const { speakmore, output, updates } = harness({ latest: "v0.1.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(updates.staged, []);
  assert.deepEqual(updates.installs, []);
  assert.match(output.out, /已经是最新的（0\.1\.0）/);
});

test("update：App 下到的更新数据没核对过：什么都不停、不换，照实说", async () => {
  installed();
  const daemon = fakeDaemon({ running: APP_RUNNING });
  const { speakmore, output, updates } = harness({
    daemon,
    latest: "v0.2.0",
    app: { path: APP, version: "0.1.0" },
    appInstall: () => {
      throw new LocalizedError(msg("update.checksum", { object: "0123456789ab" }));
    },
  });
  assert.equal(await speakmore("update"), 1);
  assert.match(output.err, /下载的更新数据（0123456789ab）与发布的不符/);
  assert.deepEqual(daemon.calls, [], "下载、核对都在停之前：没核对过就什么都不停");
  assert.deepEqual(updates.installs, []);
  assert.deepEqual(updates.opened, []);
});

test("update：App 没换成：命令行那一份也不动，停掉的 App 重新打开（原来那个还在）", async () => {
  installed();
  const daemon = fakeDaemon({ running: APP_RUNNING });
  const { speakmore, output, updates } = harness({
    daemon,
    latest: "v0.2.0",
    app: { path: APP, version: "0.1.0" },
    appCommit: () => {
      throw new LocalizedError(msg("update.appReplace", { path: APP, reason: "EACCES", url: "https://x/y.dmg" }));
    },
  });
  assert.equal(await speakmore("update"), 1);
  assert.match(output.err, /无法替换 \/Applications\/SpeakMore\.app：EACCES/);
  assert.deepEqual(updates.installs, []);
  assert.deepEqual(updates.opened, [APP]);
});

test("update：后台卡住不答话时不知道跑的是哪个：停掉它，App 按装着的位置找，换完不知道打开谁", async () => {
  installed();
  const daemon = fakeDaemon({ hung: true });
  const { speakmore, output, updates } = harness({ daemon, latest: "v0.2.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(daemon.calls, ["stop"]);
  assert.deepEqual(updates.lookedFor, [null]);
  assert.deepEqual(updates.opened, []);
  assert.deepEqual(updates.starts, []);
  assert.match(output.out, /运行 speakmore 启动/);
});

test("update：已经是最新的（或者比下载地址上的还新）就什么都不做", async () => {
  installed();
  for (const latest of ["v0.1.0", "0.1.0", "v0.0.9", "v0.1.0-rc.1"]) {
    const { speakmore, output, updates } = harness({ latest });
    assert.equal(await speakmore("update"), 0, latest);
    assert.deepEqual(updates.installs, [], latest);
    assert.match(output.out, /已经是最新的（0\.1\.0）/, latest);
  }
});

test("update：家目录经过符号链接（比如 /tmp 其实是 /private/tmp）也认得出是装好的那一份", async () => {
  installed();
  outside = mkdtempSync(join(tmpdir(), "sm-link-"));
  const link = join(outside, "home");
  symlinkSync(dir, link);
  const { speakmore, updates } = harness({ latest: "v0.2.0", packageDir: join(link, "app") });
  assert.equal(await speakmore("update"), 0);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
});

test("update：从源码跑的这一份不归更新管，说用 git pull，不去问下载地址", async () => {
  outside = mkdtempSync(join(tmpdir(), "sm-src-"));
  const { speakmore, output, updates } = harness({ latest: "v0.2.0", packageDir: outside });
  assert.equal(await speakmore("update"), 1);
  assert.deepEqual([updates.checks, updates.installs, updates.apps], [[], [], []]);
  assert.match(output.err, /git pull/);
  assert.ok(output.err.includes(outside));
});

test("update（Windows）：程序在家目录 versions 下某个版本里的才是装好的那份；0.9.2 那样直接放在 app 里的不算", async () => {
  const version = join(paths.versionsDir, "0.1.0-1a2b3c4d", "app");
  mkdirSync(version, { recursive: true });
  const current = harness({ latest: "v0.2.0", platform: "win32", packageDir: version });
  assert.equal(await current.speakmore("update"), 0);
  assert.deepEqual(current.updates.installs, ["v0.2.0"]);

  installed();
  const legacy = harness({ latest: "v0.2.0", platform: "win32", packageDir: paths.appDir });
  assert.equal(await legacy.speakmore("update"), 1);
  assert.deepEqual(legacy.updates.installs, []);
});

test("update：问不到最新版本、问到的不像版本号，都照实说，不装", async () => {
  installed();
  const offline = harness({
    latest: new LocalizedError(msg("update.unreachable", { url: "https://x/latest", reason: "curl: (6) 解析不了" })),
  });
  assert.equal(await offline.speakmore("update"), 1);
  assert.match(offline.output.err, /https:\/\/x\/latest/);
  assert.match(offline.output.err, /curl: \(6\)/);
  assert.deepEqual(offline.updates.installs, []);

  const garbled = harness({ latest: "<html>出错了</html>" });
  assert.equal(await garbled.speakmore("update"), 1);
  assert.match(garbled.output.err, /<html>/);
  assert.deepEqual(garbled.updates.installs, []);

  assert.equal(await harness().speakmore("update", "now"), 2);
});

test("update：App 那边正在更新（锁被一个还在的进程拿着）：不跟着换，说清楚", async () => {
  installed();
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.updateLock, String(process.pid));
  const { speakmore, output, updates } = harness({ latest: "v0.2.0" });
  assert.equal(await speakmore("update"), 1);
  assert.match(output.err, /另一个更新正在进行（进程 \d+）/);
  assert.deepEqual(updates.checks, []);
});

test("status：有新版本时提醒一句；一天只问一次下载地址", async () => {
  installed();
  const { io, speakmore, output, updates } = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0" });
  await speakmore("status");
  assert.match(output.out, /有新版本 0\.2\.0（现在是 0\.1\.0）：运行 speakmore update/);
  await speakmore("status");
  assert.equal(updates.checks.length, 1, "问过的一天之内不再问");
  // 过了一天再问
  io.now = () => new Date("2026-10-14T07:00:01.000Z");
  await speakmore("status");
  assert.equal(updates.checks.length, 2);
  // status 不能为这个等太久
  assert.ok(updates.checks.every((seconds) => seconds <= 3));
});

/** 忘掉上一次问下载地址的结果：同一个测试里换一种情形时用 */
const forgetUpdateCheck = () => rmSync(paths.updateCheckFile, { force: true });

test("status：没有新版本、问不到、从源码跑的，都不提，也不影响退出码", async () => {
  installed();
  const same = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await same.speakmore("status"), 0);
  assert.doesNotMatch(same.output.out, /新版本/);

  forgetUpdateCheck();
  const offline = harness({ daemon: fakeDaemon({ running: READY }), latest: new Error("没网") });
  assert.equal(await offline.speakmore("status"), 0);
  assert.doesNotMatch(offline.output.out + offline.output.err, /新版本|没网/);
  // 没问到也记下：一天之内不再每看一次状态都等它
  await offline.speakmore("status");
  assert.equal(offline.updates.checks.length, 1);

  forgetUpdateCheck();
  outside = mkdtempSync(join(tmpdir(), "sm-src-"));
  const source = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0", packageDir: outside });
  await source.speakmore("status");
  assert.deepEqual(source.updates.checks, []);
});

test("status --json：带上有没有新版本（newVersion，没有是 null）", async () => {
  installed();
  const newer = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0" });
  await newer.speakmore("status", "--json");
  assert.equal(JSON.parse(newer.output.out).newVersion, "0.2.0");
  forgetUpdateCheck();
  const same = harness({ daemon: fakeDaemon({ running: READY }) });
  await same.speakmore("status", "--json");
  assert.equal(JSON.parse(same.output.out).newVersion, null);
});

test("status：和 App 看的是同一份记录。App 问过的一天之内不再问；App 正在更新、上一次没更新成，都提一句", async () => {
  installed();
  // App 刚问过：知道有 0.2.0
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.updateCheckFile, JSON.stringify({ checkedAt: "2026-10-13T06:00:00.000Z", latest: "0.2.0" }));
  const seen = harness({ daemon: fakeDaemon({ running: READY }), latest: "v9.9.9" });
  await seen.speakmore("status");
  assert.deepEqual(seen.updates.checks, []);
  assert.match(seen.output.out, /有新版本 0\.2\.0（现在是 0\.1\.0）/);

  // App 正在更新（进程还在）：说正在更新，不再提有新版本
  writeFileSync(
    paths.updateFile,
    JSON.stringify({
      state: "running",
      phase: "downloading",
      version: "0.2.0",
      by: "app",
      pid: process.pid,
      startedAt: "2026-10-13T06:59:00.000Z",
    }),
  );
  const busy = harness({ daemon: fakeDaemon({ running: READY }) });
  await busy.speakmore("status");
  assert.match(busy.output.out, /正在更新到 0\.2\.0…/);
  assert.doesNotMatch(busy.output.out, /有新版本/);

  // 上一次没更新成、新版本还没装上：提原因
  writeFileSync(
    paths.updateFile,
    JSON.stringify({
      state: "failed",
      version: "0.2.0",
      by: "app",
      pid: 1,
      problem: { key: "update.checksum", params: { object: "0123456789ab" } },
    }),
  );
  const failed = harness({ daemon: fakeDaemon({ running: READY }) });
  await failed.speakmore("status");
  assert.match(failed.output.out, /上一次更新没有完成：下载的更新数据（0123456789ab）与发布的不符/);
});

test("status：命令行这一份是新的、只有 App 还是旧的：说是 App 旧了", async () => {
  installed();
  const { speakmore, output } = harness({
    daemon: fakeDaemon({ running: READY }),
    latest: "v0.1.0",
    app: { path: APP, version: "0.0.9" },
  });
  await speakmore("status");
  assert.match(output.out, /SpeakMore\.app 还是 0\.0\.9，有新版本 0\.1\.0：运行 speakmore update/);
});

// ---------- key ----------

test("key：没在运行就先启动，问一把，存好", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  const { speakmore, output } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await speakmore("key"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["start", "set-key"]);
  assert.deepEqual(saved, ["AIza-new"]);
  assert.match(output.out, /已保存，验证通过/);
});

test("key：验证不过时说明原因，以非零退出，不反复问", async () => {
  const daemon = fakeDaemon({
    running: READY,
    saveKey: () => ({ ok: false, problem: "连不上 Gemini，检查网络后再试" }),
  });
  const { speakmore, output, asked } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await speakmore("key"), 1);
  assert.equal(asked.length, 1);
  assert.match(output.err, /连不上 Gemini/);
});

test("key：什么都没读到时不去打扰后台应用", async () => {
  const daemon = fakeDaemon({ running: READY });
  const { speakmore, output } = harness({ daemon, secrets: [""] });
  assert.equal(await speakmore("key"), 1);
  assert.deepEqual(daemon.calls, []);
  assert.match(output.err, /没有读到 key/);
});

test("key：从管道喂进来的内容样子不对（比如多行）：不启动、不发给后台，内容不出现在输出里", async () => {
  const { speakmore, output, daemon } = harness({ secrets: ["line-one-SECRET\nline-two-SECRET"] });
  assert.equal(await speakmore("key"), 1);
  assert.deepEqual(daemon.calls, []);
  assert.match(output.err, /这把 key 里有空格或换行/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("key 后面直接跟着一把 key：不照做，也不把它再打一遍，提醒这样写会进 shell 历史", async () => {
  const { speakmore, output, daemon, asked } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("key", "AIza-typed-SECRET"), 2);
  assert.deepEqual(daemon.calls, []);
  assert.equal(asked.length, 0);
  assert.match(output.err, /历史/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("key --forget：共用的那份和 0.7.0 及以前 App 另存的那份都删掉；在运行的话让它也忘掉", async () => {
  const seed = () => {
    writeFileSync(keyFile(paths, "gemini"), "密文");
    writeFileSync(oldAppKeyFile(paths, "gemini"), "密文");
  };
  seed();
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.speakmore("key", "--forget"), 0);
  assert.deepEqual(running.daemon.calls, ["forget-key"]);
  assert.deepEqual([existsSync(keyFile(paths, "gemini")), existsSync(oldAppKeyFile(paths, "gemini"))], [false, false]);

  seed();
  const idle = harness();
  assert.equal(await idle.speakmore("key", "--forget"), 0);
  assert.deepEqual([existsSync(keyFile(paths, "gemini")), existsSync(oldAppKeyFile(paths, "gemini"))], [false, false]);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /已经删掉/);
});

// ---------- 设置 ----------

test("config：列出每一项和文件位置", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("config"), 0);
  assert.match(output.out, new RegExp(`hotkey\\.dictate\\s+\\["AltRight"\\]\\s+${zhKeycap} · 默认`));
  assert.match(output.out, /hotkey\.cancel\s+\["Escape"\]\s+esc · 默认/);
  assert.match(output.out, /「语音输入」的快捷键：两键以内的任意组合，写法见 README/);
  assert.ok(output.out.includes(paths.settingsFile), output.out);
});

test("config set：存进文件；在运行的话重启让它生效", async () => {
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("config", "set", "thinking", "low"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { thinking: "LOW" });
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /thinking 改成了 LOW/);
  assert.match(output.out, /已经生效/);

  const idle = harness();
  assert.equal(await idle.speakmore("config", "set", "thinking", "low"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /下次启动生效/);
});

test("config set：重启之后 Gemini 不认这个值（比如模型名写错）：不说“已经生效”，说原因和怎么撤回", async () => {
  const daemon = fakeDaemon({ running: READY, afterStart: WRONG_MODEL });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("config", "set", "model", "gemini-nope"), 1);
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.err, /gemini-nope is not found/);
  assert.match(output.err, /speakmore config unset model/);
});

test("config set：重启时没连上 Gemini，新设置对不对还不知道：不说“已经生效”", async () => {
  const unverified = { ...READY, key: { ...READY.key, verified: false } };
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: READY, afterStart: unverified }) });
  assert.equal(await speakmore("config", "set", "model", "gemini-next"), 0);
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.out, /还没验证.*speakmore status/);
});

test("config set：还没启动过就先改设置时，建出来的目录同样只有自己进得去", async () => {
  rmSync(dir, { recursive: true });
  const { speakmore } = harness();
  assert.equal(await speakmore("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assertOwnerOnlyDir(paths.home);
});

test("config set：填错时说哪里不对，不动文件，以 2 退出", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("config", "set", "hotkey", "caps_lock"), 2);
  assert.match(output.err, /hotkey\.dictate 写的是 "caps_lock"，不认识的键 "caps_lock"/);
  assert.equal(existsSync(paths.settingsFile), false);
  // 写法对、这个系统上不让绑的（check）：同样不存
  assert.equal(await speakmore("config", "set", "hotkey.dictate", "ControlRight+KeyC"), 2);
  // Mac 上写"右⌃ C"，Windows 上写"右 Ctrl+C"
  assert.match(output.err, /右(⌃ | Ctrl\+)C：(⌃|Ctrl) 加打字的键/);
  assert.equal(existsSync(paths.settingsFile), false);
  assert.equal(await speakmore("config", "set", "hotkey"), 2);
  assert.equal(await speakmore("config", "dance"), 2);
});

test("config set：这一项正被环境变量盖着时提醒一句（改名前的环境变量也算）", async () => {
  const { speakmore, output } = harness({ env: { SPEAKMORE_HOTKEY: "right_option" } });
  assert.equal(await speakmore("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assert.match(output.out, /环境变量 SPEAKMORE_HOTKEY 现在设着/);
});

test("热键：config set hotkey.<动作> 存成列表，后台当场换（reload-hotkeys），不重启", macOnly, async () => {
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("config", "set", "hotkey.dictate", '["Fn","ControlRight+F13"]'), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), {
    "hotkey.dictate": ["Fn", "ControlRight+F13"],
  });
  assert.deepEqual(daemon.calls, ["reload-hotkeys"]);
  assert.match(output.out, /hotkey\.dictate 改成了 \["Fn","ControlRight\+F13"\]。\n注意：/);
  assert.match(output.out, /已经生效，不用重启/);
  // 能存但要提醒的照存，把提醒说出来
  assert.match(output.out, /注意：fn：地球仪键在系统设置里/);
  assert.equal(await speakmore("config", "set", "hotkey.cancel", "F14"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8"))["hotkey.cancel"], ["F14"]);
});

test("按动作目录逐个动作：config set hotkey.<动作> 都是当场换（LIVE 表里有它），不重启", async () => {
  for (const action of ACTIONS) {
    const name = settingNameOf(action);
    const { speakmore, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
    assert.equal(await speakmore("config", "set", name, SETTINGS[name].default), 0, name);
    assert.deepEqual(daemon.calls, ["reload-hotkeys"], name);
  }
});

test("热键：旧名字 hotkey 和旧 id 照样认（0.13 以前的写法），回话里写的是新名字和新写法", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("config", "set", "hotkey", "right_control"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { "hotkey.dictate": ["ControlRight"] });
  assert.match(output.out, /hotkey\.dictate 改成了 \["ControlRight"\]/);
  assert.equal(await speakmore("config", "unset", "hotkey"), 0);
  assert.match(output.out, /hotkey\.dictate 回到了默认值 \["AltRight"\]/);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), {});
});

test("热键当场换的时候：后台被环境变量盖着就说清楚；旧版本的后台不认这条命令时说要重启", async () => {
  const overridden = harness({
    daemon: fakeDaemon({
      running: READY,
      reloadHotkeys: () => ({ "hotkey.dictate": DEFAULT_HOTKEY, env: { "hotkey.dictate": "SPEAKMORE_HOTKEY" } }),
    }),
  });
  assert.equal(await overridden.speakmore("config", "set", "hotkey.dictate", "ControlRight"), 0);
  assert.match(
    overridden.output.out,
    new RegExp(`正在运行的 SpeakMore 用的还是${zhKeycap}：启动它的环境里设着 SPEAKMORE_HOTKEY`),
  );

  const old = harness({
    daemon: fakeDaemon({
      running: READY,
      reloadHotkeys: () => {
        throw new Error("不认识的命令：reload-hotkeys");
      },
    }),
  });
  assert.equal(await old.speakmore("config", "set", "hotkey.dictate", "ControlRight"), 0);
  assert.match(old.output.out, /旧版本，不会当场换：运行 speakmore restart/);
});

test("config set 是不检查的后门：模式那一层管的几项照写，说平时用哪个命令换；不在那种模式里的说切过去才用上", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("config", "set", "transcriber", "sensevoice-small-q8"), 0);
  assert.equal(saved("transcriber"), "sensevoice-small-q8");
  assert.match(output.out, /平时用 speakmore transcriber 换.*config set 不检查/);
  assert.match(output.out, /现在是 native 模式，这一项切到 local 模式时才用上/);

  const native = harness();
  assert.equal(await native.speakmore("config", "set", "model", "openai"), 0);
  assert.match(native.output.out, /平时用 speakmore model 换/);
  assert.doesNotMatch(native.output.out, /才用上/);

  // 只有 config set 能改的几项不提别的命令
  const plain = harness();
  assert.equal(await plain.speakmore("config", "set", "thinking", "low"), 0);
  assert.doesNotMatch(plain.output.out, /平时用|才用上/);
  assert.equal(await plain.speakmore("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assert.doesNotMatch(plain.output.out, /平时用|才用上/);
});

test("config set 把 local 的第一跳改成没下载的：重启后说还没下载、怎么下，不替用户下", async () => {
  const missing = { ...LOCAL_READY, localModel: { state: "missing", model: "qwen3-asr-0.6b-q8" } };
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: LOCAL_READY, afterStart: missing }) });
  assert.equal(await speakmore("config", "set", "transcriber", "qwen3-asr-0.6b-q8"), 0);
  assert.match(
    output.out,
    /Qwen3-ASR 0\.6B \(Q8_0\) 还没下载：先运行 speakmore transcriber download qwen3-asr-0\.6b-q8/,
  );
  assert.ok(!daemon.calls.includes("download-model"));
});

test("config unset：回到默认值", async () => {
  const { speakmore, output } = harness();
  await speakmore("config", "set", "thinking", "low");
  assert.equal(await speakmore("config", "unset", "thinking"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), {});
  assert.match(output.out, /thinking 回到了默认值 MINIMAL/);
});

// ---------- 主题 ----------

test("theme：列出有哪几套，标出现在用的是哪套、怎么换", async () => {
  const { speakmore, output, daemon } = harness();
  assert.equal(await speakmore("theme"), 0);
  assert.match(output.out, /● ink\s+墨/);
  assert.match(output.out, / {4}cinnabar\s+朱砂/);
  assert.match(output.out, / {4}indigo\s+靛青/);
  assert.match(output.out, /现在用的是墨（ink）.*默认/);
  assert.match(output.out, /speakmore theme cinnabar/);
  assert.deepEqual(daemon.calls, []);
});

test("theme <名字>：存进设置；在运行的话让它当场换，不重启；写 id 或写中文名都行", async () => {
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("theme", "朱砂"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { theme: "cinnabar" });
  assert.deepEqual(daemon.calls, ["reload-theme"]);
  assert.match(output.out, /主题换成了朱砂（cinnabar）/);
  assert.match(output.out, /已经生效/);

  assert.equal(await speakmore("theme"), 0);
  assert.match(output.out, /● cinnabar\s+朱砂/);
  assert.match(output.out, /现在用的是朱砂（cinnabar）.*存在设置文件里/);

  const idle = harness();
  assert.equal(await idle.speakmore("theme", "indigo"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /下次启动生效/);
});

test("theme：没有的那一套不存，说有哪几套，以 2 退出；多写了参数也是", async () => {
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("theme", "neon"), 2);
  assert.match(output.err, /ink \/ cinnabar \/ indigo/);
  assert.equal(existsSync(paths.settingsFile), false);
  assert.equal(await speakmore("theme", "ink", "cinnabar"), 2);
  assert.deepEqual(daemon.calls, []);
});

test("theme：环境变量盖着时提醒；正在运行的那个带着环境变量启动的话，照实说它用的还是哪套", async () => {
  const daemon = fakeDaemon({ running: READY, reloadTheme: () => ({ theme: "indigo" }) });
  const { speakmore, output } = harness({ daemon, env: { SPEAKMORE_THEME: "indigo" } });
  assert.equal(await speakmore("theme", "cinnabar"), 0);
  assert.match(output.out, /环境变量 SPEAKMORE_THEME 现在设着/);
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.out, /用的还是靛青（indigo）.*SPEAKMORE_THEME/);
});

test("theme：正在运行的是不认识这条命令的旧版本：设置照存，说重启之后才换", async () => {
  const daemon = fakeDaemon({
    running: READY,
    reloadTheme: () => {
      throw new Error('不认识的命令："reload-theme"');
    },
  });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("theme", "cinnabar"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { theme: "cinnabar" });
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.out, /旧版本.*speakmore restart/);
});

test("config set theme / config unset theme：和 theme 命令一样当场换，不重启", async () => {
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("config", "set", "theme", "indigo"), 0);
  assert.deepEqual(daemon.calls, ["reload-theme"]);
  assert.match(output.out, /theme 改成了 indigo/);
  assert.match(output.out, /已经生效/);
  assert.equal(await speakmore("config", "unset", "theme"), 0);
  assert.deepEqual(daemon.calls, ["reload-theme", "reload-theme"]);
  assert.match(output.out, /theme 回到了默认值 ink/);
});

// ---------- 界面语言 ----------

test("英文：帮助、面板、用错了时的说法都是英文的", async () => {
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: READY }), locale: "en" });
  assert.equal(await speakmore("help"), 0);
  assert.match(output.out, /^SpeakMore: press a hotkey, speak/);
  assert.match(output.out, /speakmore theme <name> +Switch theme \(ink Ink \/ cinnabar Cinnabar \/ indigo Indigo\)/);
  assert.match(output.out, /latest 20 by default/);

  assert.equal(await speakmore("status"), 0);
  assert.match(output.out, /SpeakMore 0\.1\.0 · running/);
  assert.match(output.out, new RegExp(`press ${enHotkey} to start talking`));
  assert.match(output.out, /Permissions +Microphone ✓ {3}Input Monitoring ✓ {3}Accessibility ✓/);
  assert.match(output.out, /Model +Gemini gemini-3\.6-flash \(MINIMAL\)/);

  assert.equal(await speakmore("frobnicate"), 2);
  assert.match(output.err, /There's no command called frobnicate\.\nRun speakmore help to see all commands\./);
  assert.doesNotMatch(output.out + output.err, /[\u4e00-\u9fff]/);
});

test("英文：有新版本的提醒、update 说的话", async () => {
  installed();
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: READY }), locale: "en", latest: "v0.2.0" });
  assert.equal(await speakmore("status"), 0);
  assert.match(output.out, /SpeakMore 0\.2\.0 is out \(you have 0\.1\.0\): run speakmore update\./);
  assert.equal(await speakmore("update"), 0);
  assert.match(output.out, /Updating SpeakMore 0\.1\.0 → 0\.2\.0/);

  const withApp = harness({
    daemon: fakeDaemon({ running: APP_RUNNING }),
    locale: "en",
    latest: "v0.2.0",
    app: { path: APP, version: "0.1.0" },
  });
  assert.equal(await withApp.speakmore("update"), 0);
  assert.match(withApp.output.out, /Updating SpeakMore\.app 0\.1\.0 → 0\.2\.0/);
  assert.match(withApp.output.out, /Reopened SpeakMore\.app/);
  output.out += withApp.output.out;
  output.err += withApp.output.err;
  assert.doesNotMatch(output.out + output.err, /[\u4e00-\u9fff]/);
});

test("英文：后台报上来的原因（msg）按命令行的语言翻；0.5 以前的后台报的中文原话照原样", async () => {
  const problem = { key: "model.rejected", params: { provider: "Gemini", said: "models/gemini-nope is not found" } };
  const fresh = {
    ...READY,
    key: { state: "rejected", source: "stored", cause: "other", problem },
    summary: {
      ready: false,
      missing: [{ key: "setup.missing.check", params: { provider: "Gemini" } }],
      blocker: null,
      degraded: null,
    },
  };
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: fresh }), locale: "en" });
  assert.equal(await speakmore("status"), 1);
  assert.match(output.out, /Missing: Gemini check\./);
  assert.match(output.out, /Check failed: Gemini rejected the request: models\/gemini-nope is not found\./);

  const old = harness({ daemon: fakeDaemon({ running: WRONG_MODEL }), locale: "en" });
  assert.equal(await old.speakmore("status"), 1);
  assert.match(old.output.out, /Missing: Gemini 验证\./);
});

test("config set language：存进设置；在运行的话让它当场换，不重启；没在运行就下次启动生效", async () => {
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("config", "set", "language", "zh_cn"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { language: "zh-CN" });
  assert.deepEqual(daemon.calls, ["reload-language"]);
  assert.match(output.out, /language 改成了 zh-CN。\n已经生效，不用重启/);
  assert.equal(await speakmore("config", "unset", "language"), 0);
  assert.deepEqual(daemon.calls, ["reload-language", "reload-language"]);
  assert.match(output.out, /language 回到了默认值 system/);

  const idle = harness();
  assert.equal(await idle.speakmore("config", "set", "language", "en"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /下次启动生效/);

  assert.equal(await idle.speakmore("config", "set", "language", "fr"), 2);
  assert.match(idle.output.err, /system \/ en \/ zh-CN \/ zh-TW/);
});

test("config set language：环境变量盖着时照实说它用的还是哪种；旧版本的后台说要重启", async () => {
  const pinned = fakeDaemon({ running: READY, reloadLanguage: () => ({ language: "en" }) });
  const { speakmore, output } = harness({ daemon: pinned, env: { SPEAKMORE_LANGUAGE: "en" } });
  assert.equal(await speakmore("config", "set", "language", "zh-CN"), 0);
  assert.match(output.out, /环境变量 SPEAKMORE_LANGUAGE 现在设着/);
  assert.match(output.out, /用的还是英文：.*SPEAKMORE_LANGUAGE/);

  const legacy = fakeDaemon({
    running: READY,
    reloadLanguage: () => {
      throw new Error('不认识的命令："reload-language"');
    },
  });
  const old = harness({ daemon: legacy });
  assert.equal(await old.speakmore("config", "set", "language", "en"), 0);
  assert.match(old.output.out, /旧版本.*speakmore restart/);
});

test("面板里写着界面语言：跟随系统时带上实际用的那种", async () => {
  const running = { ...READY, language: "system", locale: "en" };
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running }) });
  assert.equal(await speakmore("status"), 0);
  assert.match(output.out, /语言 +跟随系统 · 英文/);
  const english = harness({
    daemon: fakeDaemon({ running: { ...READY, language: "zh-CN", locale: "zh-CN" } }),
    locale: "en",
  });
  assert.equal(await english.speakmore("status"), 0);
  assert.match(english.output.out, /Language +简体中文/);
});

test("面板里写着正在用的主题", async () => {
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: { ...READY, theme: "cinnabar" } }) });
  assert.equal(await speakmore("status"), 0);
  assert.match(output.out, /主题\s+朱砂（cinnabar）/);
});

test("设置文件被改坏时，任何命令都先把这件事说清楚", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.settingsFile, "{ 坏了");
  const { speakmore, output, daemon } = harness();
  assert.equal(await speakmore(), 2);
  assert.match(output.err, /settings\.json/);
  assert.deepEqual(daemon.calls, []);
});

// ---------- 历史 ----------

function seedHistory() {
  const history = openHistory(paths.historyDb);
  const entry = (id, createdAt, refinedText) => ({
    id,
    status: "completed",
    refinedText,
    error: null,
    duration: 4,
    audioFile: null,
    createdAt,
  });
  history.add(entry("a", "2026-10-12T01:05:00.000Z", "昨天说的"));
  history.add(entry("b", "2026-10-13T06:32:00.000Z", "今天说的"));
  history.close();
}

test("history：一次都没用过时说一句，不凭空建库", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("history"), 0);
  assert.match(output.out, /还没有听写记录/);
  assert.equal(existsSync(paths.historyDb), false);
});

test("history：按天分组列出来；-n 限制条数；后台应用在不在运行都能看", async () => {
  seedHistory();
  const all = harness();
  assert.equal(await all.speakmore("history"), 0);
  assert.match(all.output.out, /今天 · 10月13日\n {2}14:32 {2}今天说的\n\n昨天 · 10月12日\n {2}09:05 {2}昨天说的/);
  assert.deepEqual(all.daemon.calls, []);

  const one = harness();
  assert.equal(await one.speakmore("history", "-n", "1"), 0);
  assert.doesNotMatch(one.output.out, /昨天说的/);
  assert.match(one.output.out, /显示最近 1 条，共 2 条/);
});

test("history --json：原样给出记录", async () => {
  seedHistory();
  const { speakmore, output } = harness();
  await speakmore("history", "--json");
  assert.deepEqual(
    JSON.parse(output.out).map((entry) => entry.refinedText),
    ["今天说的", "昨天说的"],
  );
});

test("history --json：录音给完整路径，按现在的家目录拼（历史里只记文件名，搬过家也对）", async () => {
  const history = openHistory(paths.historyDb);
  history.add({
    id: "a",
    status: "failed",
    refinedText: "",
    error: "超时",
    duration: 3,
    audioFile: "a.webm",
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.close();
  const { speakmore, output } = harness();
  await speakmore("history", "--json");
  const [row] = JSON.parse(output.out);
  assert.equal(row.audioLocalPath, join(paths.recordingsDir, "a.webm"));
  assert.equal("audioFile" in row, false);
});

test("history -n 要是正整数", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("history", "-n", "abc"), 2);
  assert.match(output.err, /-n/);
});

test("有历史时面板里带上今天和累计的数；记过账的话带上花了多少钱", async () => {
  seedHistory();
  const before = harness({ daemon: fakeDaemon({ running: READY }) });
  await before.speakmore("status");
  assert.match(before.output.out, /累计\s+2 次 · 8 字 · 8 秒\n/);

  seedCall();
  const after = harness({ daemon: fakeDaemon({ running: READY }) });
  await after.speakmore("status");
  assert.match(after.output.out, /累计\s+2 次 · 8 字 · 8 秒 · \$0\.0011\n/);
  assert.match(after.output.out, /speakmore usage/);
});

// ---------- 用量 ----------

/** 记一笔账：今天那句话调了一次 Gemini */
function seedCall() {
  const history = openHistory(paths.historyDb);
  history.addCall({
    purpose: "dictation",
    audioId: "b",
    provider: "gemini",
    model: "gemini-3.6-flash",
    inputTokens: 1390,
    audioTokens: 25,
    cachedTokens: 0,
    outputTokens: 4,
    thinkingTokens: 0,
    costUsd: 0.0011,
    latencyMs: 1700,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.close();
}

test("usage：一次都没用过时说一句，不凭空建库", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("usage"), 0);
  assert.match(output.out, /还没有用量记录/);
  assert.equal(existsSync(paths.historyDb), false);
});

test("usage：列出花了多少钱、多少 token、模型多久回话；后台应用不在运行也能看", async () => {
  seedHistory();
  seedCall();
  const { speakmore, output, daemon } = harness();
  assert.equal(await speakmore("usage"), 0);
  assert.match(output.out, /累计\s+\$0\.0011\s+1\.39K\s+1\s+一般 1\.7 秒，慢时 1\.7 秒/);
  assert.match(output.out, /Gemini gemini-3\.6-flash/);
  assert.deepEqual(daemon.calls, []);
});

test("usage --json：原样给出报表；还没有历史库时是 null", async () => {
  const empty = harness();
  await empty.speakmore("usage", "--json");
  assert.equal(JSON.parse(empty.output.out), null);

  seedHistory();
  seedCall();
  const { speakmore, output } = harness();
  await speakmore("usage", "--json");
  const report = JSON.parse(output.out);
  assert.equal(report.total.costUsd, 0.0011);
  assert.equal(report.total.tokens, 1394);
  assert.deepEqual(report.total.latency, { medianMs: 1700, p90Ms: 1700 });
  assert.equal(report.models[0].model, "gemini-3.6-flash");
});

test("usage 不收别的参数", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("usage", "today"), 2);
  assert.match(output.err, /speakmore usage/);
});

// ---------- 搬家 ----------

// 这几条按 macOS 的路径写（/Volumes/T7、正斜杠）；Windows 上的走法在真机端到端里验
const posixOnly = { skip: process.platform === "win32" && "按 macOS 的路径写" };

test("move：不写文件夹就说现在在哪、怎么搬", posixOnly, async () => {
  const { speakmore, output, io } = harness();
  assert.equal(await speakmore("move"), 0);
  assert.match(output.out, new RegExp(`SpeakMore 现在在 ${paths.home}`));
  assert.match(output.out, /speakmore move ~/);
  assert.deepEqual(io.mover().calls, []);
});

test("move：先说清楚搬到哪、拷多少、旧目录里别人的东西不动，再问一句；不答应就什么都不动", posixOnly, async () => {
  const mover = fakeMover({ unknown: ["notes.txt", "Backups"] });
  const declined = harness({ mover, confirms: [false] });
  assert.equal(await declined.speakmore("move", "/Volumes/T7"), 1);
  assert.match(declined.output.out, /从 .* 搬到 \/Volumes\/T7\/\.speakmore：拷 1\.2 GB（1,234 个文件）/);
  assert.match(declined.output.out, /不搬，也不删：notes\.txt、Backups/);
  assert.match(declined.output.out, /没有动/);
  assert.deepEqual(mover.calls, [["plan", "/Volumes/T7"]]);

  const agreed = harness({ mover: fakeMover(), confirms: [true], interactive: true });
  assert.equal(await agreed.speakmore("move", "/Volumes/T7"), 0);
  assert.deepEqual(agreed.io.mover().calls, [
    ["plan", "/Volumes/T7"],
    ["run", "/Volumes/T7", "cli"],
  ]);
  assert.match(agreed.output.out, /正在拷到 \/Volumes\/T7\/\.speakmore…/);
  assert.match(agreed.output.out, /已经搬到 \/Volumes\/T7\/\.speakmore（1,234 个文件，1\.2 GB）/);
  assert.match(agreed.output.out, /旧目录 .* 已经删掉/);
});

test("move：相对路径按当前目录，~ 是用户目录", posixOnly, async () => {
  const { homedir } = await import("node:os");
  const relative = harness({ confirms: [true] });
  await relative.speakmore("move", "disk", "--yes");
  assert.deepEqual(relative.io.mover().calls[0], ["plan", "/work/disk"]);
  const home = harness();
  await home.speakmore("move", "~", "--yes");
  assert.deepEqual(home.io.mover().calls[0], ["plan", homedir()]);
});

test("move：拷的时候每过两成说一次；Windows 上旧目录等退出后再删、留着的别人的东西说出来", async () => {
  const mover = fakeMover({ progress: [100_000_000, 300_000_000, 500_000_000, 750_000_000, 1_200_000_000] });
  const { speakmore, output } = harness({ mover });
  assert.equal(await speakmore("move", "/d", "--yes"), 0);
  assert.deepEqual(output.out.match(/已拷 \d+%/g), ["已拷 20%", "已拷 40%", "已拷 60%", "已拷 100%"]);

  const later = harness({ mover: fakeMover({ result: { later: true } }) });
  await later.speakmore("move", "/d", "--yes");
  assert.match(later.output.out, /等它退出后几秒内删掉/);
  const left = harness({ mover: fakeMover({ result: { left: ["notes.txt"] } }) });
  await left.speakmore("move", "/d", "--yes");
  assert.match(left.output.out, /还留着不是 SpeakMore 的东西，没有动：notes\.txt/);
});

test("move：不在终端里又没给 --yes 时不动手；去不了的在问之前就说，搬不成照实说、退出码 1", async () => {
  const quiet = harness({ interactive: false });
  assert.equal(await quiet.speakmore("move", "/d"), 2);
  assert.match(quiet.output.err, /--yes/);

  const refused = harness({ mover: fakeMover({ problem: msg("move.notEmpty", { home: "/d/.speakmore" }) }) });
  assert.equal(await refused.speakmore("move", "/d"), 1);
  assert.match(refused.output.err, /\/d\/\.speakmore 里已经有东西了/);
  assert.deepEqual(refused.confirmed, []);

  const failed = harness({ mover: fakeMover({ failure: msg("move.rehomeFailed", { code: 3 }) }) });
  assert.equal(await failed.speakmore("move", "/d", "--yes"), 1);
  assert.match(failed.output.err, /安装脚本退出码 3/);
  assert.doesNotMatch(failed.output.out, /已经搬到/);
});

// ---------- 卸载 ----------

/** 摆出装好并用过之后的样子，外加家目录以外的一个命令链接 */
function seedInstalled() {
  for (const file of [
    join(paths.binDir, "speakmore"),
    join(paths.appDir, "package.json"),
    join(paths.runtimeDir, "Electron.app", "Info.plist"),
    paths.settingsFile,
    keyFile(paths, "gemini"),
    paths.historyDb,
    join(paths.recordingsDir, "a.webm"),
    paths.logFile,
    join(paths.cacheDir, "GPUCache", "data_0"),
  ]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "x");
  }
  // 家目录以外的一处（比如 ~/.local/bin）
  outside = mkdtempSync(join(tmpdir(), "sm-bin-"));
  const link = join(outside, "speakmore");
  symlinkSync(join(paths.binDir, "speakmore"), link);
  // 同一个位置上不是我们的东西：别人的同名文件
  const foreign = join(outside, "not-ours");
  writeFileSync(foreign, "别人的");
  writeFileSync(paths.linksFile, `${link}\n${foreign}\n`);
  return { link, foreign };
}

test("uninstall --yes：停掉后台，整个目录、家目录以外的命令链接、钥匙串里的条目，一次删干净", async () => {
  const { link, foreign } = seedInstalled();
  const removedFromKeychain = [];
  const { speakmore, output, daemon } = harness({
    daemon: fakeDaemon({ running: READY }),
    keychain: () => {
      removedFromKeychain.push(true);
      return true;
    },
  });
  assert.equal(await speakmore("uninstall", "--yes"), 0);
  assert.deepEqual(daemon.calls, ["stop"]);
  assert.equal(existsSync(paths.home), false);
  assert.equal(existsSync(link), false);
  assert.equal(removedFromKeychain.length, 1);
  // 记在清单里、但不是指向我们的链接的东西，不碰
  assert.equal(readFileSync(foreign, "utf8"), "别人的");
  assert.match(output.out, /已经卸载/);
  assert.match(output.out, /钥匙串/);
  // 删不了的也照实说
  assert.match(output.out, /权限/);
  assert.doesNotMatch(output.out, /com\.github\.Electron/);
});

test("uninstall：装在默认位置以外的，定位文件一起删；--keep-data 时留着（重装后照它找回数据）", posixOnly, async () => {
  const { writeLocation } = await import("../../src/storage/location.mjs");
  seedInstalled();
  writeLocation(paths.locationFile, { home: paths.home });
  const kept = harness({ daemon: fakeDaemon({ running: null }) });
  assert.equal(await kept.speakmore("uninstall", "--keep-data", "--yes"), 0);
  assert.equal(existsSync(paths.locationFile), true);

  const all = harness({ daemon: fakeDaemon({ running: null }) });
  assert.equal(await all.speakmore("uninstall", "--yes"), 0);
  assert.equal(existsSync(paths.locationFile), false);
  assert.match(all.output.out, /定位文件/);
});

test("正在搬家时不改家目录里的东西（写进旧目录的会跟着它一起删掉）；搬完了照常", async () => {
  const { writeMoveRecord } = await import("../../src/move/state.mjs");
  writeMoveRecord(paths, {
    state: "running",
    pid: 4242,
    to: "/Volumes/T7/.speakmore",
    startedAt: new Date().toISOString(),
  });
  const moving = harness({ moverAlive: () => true });
  assert.equal(await moving.speakmore("dict", "add", "GitHub"), 1);
  assert.match(moving.output.err, /正在从 .* 搬到 \/Volumes\/T7\/\.speakmore/);
  assert.equal(await moving.speakmore("config", "set", "hotkey", "fn"), 1);
  // 搬家的进程没了（断了）：不挡
  assert.equal(await harness({ moverAlive: () => false }).speakmore("dict", "add", "GitHub"), 0);
});

test("uninstall：定位文件坏了也照常卸完，说一声它没删", posixOnly, async () => {
  seedInstalled();
  mkdirSync(dirname(paths.locationFile), { recursive: true });
  writeFileSync(paths.locationFile, "{ 坏了");
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: null }) });
  assert.equal(await speakmore("uninstall", "--yes"), 0);
  assert.equal(existsSync(paths.home), false);
  assert.match(output.out, /定位文件 .* 读不出来/);
});

test("uninstall：上次搬到一半断了，拷过去的那一份一起删（只认这次搬家的记号）", posixOnly, async () => {
  const { writeLocation } = await import("../../src/storage/location.mjs");
  seedInstalled();
  const half = join(userDir, "disk", ".speakmore");
  const startedAt = new Date().toISOString();
  mkdirSync(join(half, "run"), { recursive: true });
  writeFileSync(join(half, "settings.json"), "{}");
  writeFileSync(join(half, "run", "move.json"), JSON.stringify({ state: "running", startedAt, from: paths.home }));
  writeLocation(paths.locationFile, { home: paths.home, moving: { to: half, pid: 2 ** 30, startedAt } });
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: null }) });
  assert.equal(await speakmore("uninstall", "--yes"), 0);
  assert.equal(existsSync(half), false);
  assert.equal(existsSync(paths.locationFile), false);
  assert.match(output.out, /没搬完/);
});

test("uninstall（Windows）：用户 Path 里的那一项、开始菜单的快捷方式、开机启动一起删；不是我们的快捷方式不碰；不提终端的权限", async () => {
  mkdirSync(paths.binDir, { recursive: true });
  // 家目录以外的东西放在另一个临时目录（afterEach 会删）
  outside = mkdtempSync(join(tmpdir(), "sm-link-"));
  const ours = join(outside, "SpeakMore.lnk");
  const theirs = join(outside, "Other.lnk");
  writeFileSync(ours, "快捷方式");
  writeFileSync(theirs, "别人的快捷方式");
  // 照 install.ps1 真写出来的样子：Windows PowerShell 5.1 的 Add-Content -Encoding UTF8 开头带 BOM、按 CRLF 换行
  writeFileSync(
    paths.linksFile,
    `\uFEFFpath %USERPROFILE%\\.speakmore\\bin\r\nshortcut ${ours}\r\nshortcut ${theirs}\r\n`,
  );
  const { speakmore, output, windows } = harness({
    platform: "win32",
    keychain: () => false,
    system: { ourShortcut: (file) => file === ours, loginItem: true },
  });
  assert.equal(await speakmore("uninstall", "--yes"), 0);
  assert.deepEqual(windows.pathEntries, ["%USERPROFILE%\\.speakmore\\bin"]);
  assert.equal(existsSync(ours), false);
  assert.equal(readFileSync(theirs, "utf8"), "别人的快捷方式");
  assert.match(output.out, /用户 Path 里的 %USERPROFILE%/);
  assert.match(output.out, /开机启动/);
  assert.doesNotMatch(output.out, /权限/);
  // bin 里的 speakmore.cmd 正在跑这条命令：cmd 等它退出后还要回头读这个文件，所以 bin 留到退出后连同家目录一起删
  assert.deepEqual(readdirSync(paths.home), ["bin"]);
  assert.deepEqual(windows.later, [paths.home]);
  assert.match(output.out, /等它退出后/);
});

test("uninstall --keep-data（Windows）：bin 也留到退出后再删，你的东西不动", async () => {
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(join(paths.binDir, "speakmore.cmd"), "@echo off");
  writeFileSync(paths.settingsFile, "{}");
  const { speakmore, windows } = harness({ platform: "win32", keychain: () => assert.fail("不该动 key") });
  assert.equal(await speakmore("uninstall", "--keep-data", "--yes"), 0);
  assert.equal(existsSync(join(paths.binDir, "speakmore.cmd")), true);
  assert.equal(existsSync(paths.settingsFile), true);
  assert.deepEqual(windows.later, [paths.binDir]);
});

test("uninstall --keep-data（Windows）：每个版本的程序和 current 都删掉，0.9.2 留在 app、runtime 里的也删", async () => {
  mkdirSync(join(paths.versionsDir, "0.1.0-1a2b3c4d", "app"), { recursive: true });
  writeFileSync(paths.currentFile, "0.1.0-1a2b3c4d");
  mkdirSync(paths.appDir, { recursive: true });
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(paths.settingsFile, "{}");
  const { speakmore } = harness({ platform: "win32", keychain: () => assert.fail("不该动 key") });
  assert.equal(await speakmore("uninstall", "--keep-data", "--yes"), 0);
  for (const gone of [paths.versionsDir, paths.currentFile, paths.appDir, paths.runtimeDir]) {
    assert.equal(existsSync(gone), false, gone);
  }
  assert.equal(existsSync(paths.settingsFile), true);
});

test("uninstall --keep-data（Windows）：缓存里的 Local State 留着，别的缓存照删（留着的 key 要靠它解开）", async () => {
  mkdirSync(join(paths.cacheDir, "GPUCache"), { recursive: true });
  writeFileSync(join(paths.cacheDir, "Local State"), "{}");
  writeFileSync(join(paths.cacheDir, "Preferences"), "{}");
  const { speakmore } = harness({ platform: "win32", keychain: () => assert.fail("不该动 key") });
  assert.equal(await speakmore("uninstall", "--keep-data", "--yes"), 0);
  assert.deepEqual(readdirSync(paths.cacheDir), ["Local State"]);
});

test("uninstall：运行环境在别处留的那个共用的偏好文件，有的话提一句，不删", async () => {
  seedInstalled();
  const { speakmore, output, io } = harness();
  // 测试里家目录就是临时目录本身，所以这个文件放在别处
  io.sharedPreferencesFile = join(outside, "com.github.Electron.plist");
  writeFileSync(io.sharedPreferencesFile, "plist");
  assert.equal(await speakmore("uninstall", "--yes"), 0);
  assert.match(output.out, /com\.github\.Electron\.plist 没有动/);
  assert.equal(existsSync(io.sharedPreferencesFile), true);
});

test("uninstall --keep-data：只删程序，设置、key、历史和录音留着，钥匙串也不动（留着的 key 要靠它解开）", async () => {
  const { link } = seedInstalled();
  // 更新拼了一半的、安装脚本被打断留下的，也是程序
  const leftovers = [".update-0.2.0-abcd1234", ".install.Ab12Cd", "app.old"].map((name) => join(paths.home, name));
  for (const dir of leftovers) mkdirSync(join(dir, "x"), { recursive: true });
  const { speakmore, output } = harness({ keychain: () => assert.fail("不该动钥匙串") });
  assert.equal(await speakmore("uninstall", "--keep-data", "--yes"), 0);
  for (const kept of [
    paths.settingsFile,
    keyFile(paths, "gemini"),
    paths.historyDb,
    join(paths.recordingsDir, "a.webm"),
  ]) {
    assert.equal(existsSync(kept), true, kept);
  }
  for (const gone of [
    paths.binDir,
    paths.appDir,
    paths.runtimeDir,
    paths.cacheDir,
    paths.logFile,
    link,
    ...leftovers,
  ]) {
    assert.equal(existsSync(gone), false, gone);
  }
  assert.match(output.out, /留着/);
});

test("uninstall：先说清楚要删什么再问一句；不答应就什么都不动", async () => {
  seedInstalled();
  const declined = harness({ daemon: fakeDaemon({ running: READY }), confirms: [false] });
  assert.equal(await declined.speakmore("uninstall"), 1);
  assert.equal(declined.confirmed.length, 1);
  assert.match(declined.output.out, /历史和录音/);
  assert.deepEqual(declined.daemon.calls, []);
  assert.equal(existsSync(paths.historyDb), true);

  const agreed = harness({ confirms: [true] });
  assert.equal(await agreed.speakmore("uninstall"), 0);
  assert.equal(existsSync(paths.home), false);
});

test("uninstall：不在终端里运行又没给 --yes 时不动手", async () => {
  seedInstalled();
  const { speakmore, output, confirmed } = harness({ interactive: false });
  assert.equal(await speakmore("uninstall"), 2);
  assert.equal(confirmed.length, 0);
  assert.match(output.err, /--yes/);
  assert.equal(existsSync(paths.historyDb), true);
});

test("uninstall：后台停不掉时不往下删（它还开着那些文件）", async () => {
  seedInstalled();
  const daemon = fakeDaemon({ running: READY });
  daemon.stop = async () => {
    throw new Error("SpeakMore 停不掉（进程号 4321）");
  };
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("uninstall", "--yes"), 1);
  assert.match(output.err, /停不掉/);
  assert.equal(existsSync(paths.appDir), true);
});

test("uninstall：钥匙串里的条目删不掉时照样把别的删完，并说清楚剩了什么", async () => {
  seedInstalled();
  const { speakmore, output } = harness({
    keychain: () => {
      throw new Error("钥匙串锁着");
    },
  });
  assert.equal(await speakmore("uninstall", "--yes"), 0);
  assert.equal(existsSync(paths.home), false);
  assert.match(output.out, /钥匙串锁着/);
  assert.match(output.out, /钥匙串访问/);
});

// ---------- 其余 ----------

test("logs：把日志文件的最后几行打出来，-f 一直跟着；还没有日志时照实说", async () => {
  const empty = harness();
  assert.equal(await empty.speakmore("logs"), 0);
  assert.match(empty.output.out, /还没有日志/);

  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(paths.logFile, "{}\n");
  const { speakmore, tails } = harness();
  await speakmore("logs");
  await speakmore("logs", "-n", "5", "-f");
  assert.deepEqual(tails, [
    { file: paths.logFile, lines: 40, follow: false },
    { file: paths.logFile, lines: 5, follow: true },
  ]);
});

test("settings：在运行时打开设置；没在运行时说先启动", async () => {
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.speakmore("settings"), 0);
  assert.deepEqual(running.daemon.calls, ["show-settings"]);
  const idle = harness();
  assert.equal(await idle.speakmore("settings"), 1);
  assert.match(idle.output.err, /speakmore/);
});

test("help 和 --help 列出全部命令；--version 给版本号", async () => {
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const { speakmore, output } = harness();
    assert.equal(await speakmore(...argv), 0);
    for (const command of [
      "start",
      "stop",
      "restart",
      "status",
      "key",
      "config",
      "history",
      "usage",
      "logs",
      "settings",
      "theme",
      "uninstall",
    ]) {
      assert.match(output.out, new RegExp(`speakmore ${command}`));
    }
  }
  const { speakmore, output } = harness();
  assert.equal(await speakmore("--version"), 0);
  assert.equal(output.out.trim(), "0.1.0");
});

test("不认识的命令和不认识的选项：说一声并指向 help，以 2 退出", async () => {
  const { speakmore, output, daemon } = harness();
  assert.equal(await speakmore("dance"), 2);
  assert.match(output.err, /dance/);
  assert.match(output.err, /speakmore help/);
  assert.equal(await speakmore("status", "--loud"), 2);
  assert.deepEqual(daemon.calls, []);
});

// ---------- 模型 ----------

/** 假装以前给 OpenAI 存过一把 key */
const haveOpenAIKey = () => writeFileSync(keyFile(paths, "openai"), "密文");
const savedModel = () => resolveSettings({ file: paths.settingsFile, env: {} }).model.value;

test("model：列出有哪几家、各用哪个模型、key 有没有、现在用的哪个", async () => {
  haveStoredKey();
  const { speakmore, output } = harness({ env: { OPENAI_API_KEY: "sk-env" } });
  assert.equal(await speakmore("model"), 0);
  assert.match(output.out, /● gemini\s+Gemini\s+gemini-3\.6-flash\s+key 存着/);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini（默认）\s+key 来自环境变量 OPENAI_API_KEY/);
});

test("model <厂商>：有它的 key 就直接换；在运行的话让它当场换，不重启", async () => {
  haveOpenAIKey();
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("model", "openai"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-model", params: { model: "openai/gpt-audio-mini" } });
  assert.match(output.out, /换成了 OpenAI 的 gpt-audio-mini/);
  assert.ok(!daemon.calls.includes("stop"));
  assert.match(output.out, /已经换上，不用重启/);

  const notRunning = harness();
  assert.equal(await notRunning.speakmore("model", "openai/gpt-audio-1.5"), 0);
  assert.equal(savedModel(), "openai/gpt-audio-1.5");
  assert.match(notRunning.output.out, /下次启动生效/);
});

test("model <厂商/模型>：内核换上了，但那家没通过（比如模型名写错）：照实说还不能用，退出码是 1", async () => {
  haveStoredKey();
  const problem = "Gemini 拒绝了请求：models/gemini-typo is not found";
  const daemon = fakeDaemon({
    running: READY,
    changeRoute: () => {
      daemon.current = { ...daemon.current, key: { state: "rejected", cause: "other", problem } };
      return { ok: true };
    },
  });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("model", "gemini/gemini-typo"), 1);
  assert.match(output.out, /已经换上/);
  assert.match(output.err, /还不能用：Gemini 拒绝了请求：models\/gemini-typo is not found/);
});

test("model <厂商>：还没有它的 key 时先问；问到的交给后台验证，存进它那一份，再换", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { speakmore, output, asked } = harness({ daemon, secrets: ["sk-my-secret"] });
  assert.equal(await speakmore("model", "openai"), 0);
  assert.deepEqual(saved, [{ key: "sk-my-secret", provider: "openai" }]);
  // 说的是 OpenAI 的 key、去哪申请
  assert.match(asked[0], /OpenAI API key/);
  assert.match(asked[0], /platform\.openai\.com\/api-keys/);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-model", params: { model: "openai/gpt-audio-mini" } });
  assert.ok(!(output.out + output.err).includes("sk-my-secret"));
});

test("model <厂商>：没有它的 key 又没法问（不在终端里）、或者问了没给：不换，说清先做什么", async () => {
  const quiet = harness({ interactive: false });
  assert.equal(await quiet.speakmore("model", "openai"), 1);
  assert.match(quiet.output.err, /还没有 OpenAI 的 key.*speakmore key openai/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  const declined = harness({ daemon: fakeDaemon({ running: READY }), secrets: [""] });
  assert.equal(await declined.speakmore("model", "openai"), 1);
  assert.match(declined.output.err, /没有换/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  const rejected = harness({
    daemon: fakeDaemon({ running: READY, saveKey: () => ({ ok: false, problem: "这把 key 无效" }) }),
    secrets: ["sk-bad", "", ""],
  });
  assert.equal(await rejected.speakmore("model", "openai"), 1);
  assert.match(rejected.output.err, /这把 key 没有通过：这把 key 无效/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");
});

test("model：不认识的厂商、写错的模型名，以 2 退出并说能填什么；写的是润色的那家时指到 local 模式", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("model", "nope"), 2);
  assert.match(output.err, /gemini \/ openai/);
  assert.equal(await speakmore("model", "deepseek"), 2);
  assert.match(output.err, /DeepSeek.*local.*speakmore polish deepseek/);
  assert.equal(await speakmore("model", "openai/gpt audio"), 2);
  assert.equal(await speakmore("model", "openai", "extra"), 2);
});

test("model check：查现在用的那个，说能不能用、key 从哪来、来回多久", async () => {
  haveStoredKey();
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("model", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-model", params: { model: "gemini/gemini-3.6-flash" } });
  assert.match(output.out, /能用：Gemini 的 gemini-3\.6-flash.*0\.8 秒/);
});

test("model check <模型>：查别的；不能用时说原因和下一步，以 1 退出", async () => {
  const missing = harness({
    daemon: fakeDaemon({
      running: READY,
      checkModel: () => ({ ok: false, cause: "missing", problem: "还没有 OpenAI 的 key：运行 speakmore key openai" }),
    }),
  });
  assert.equal(await missing.speakmore("model", "check", "openai"), 1);
  assert.deepEqual(missing.daemon.requests.at(-1).params, { model: "openai/gpt-audio-mini" });
  assert.match(missing.output.err, /不能用：还没有 OpenAI 的 key/);

  const wrong = harness({
    daemon: fakeDaemon({
      running: READY,
      checkModel: () => ({ ok: false, cause: "other", problem: "OpenAI 没有这个模型，或者这把 key 用不了它：…" }),
    }),
  });
  assert.equal(await wrong.speakmore("model", "check", "openai/gpt-audio-9"), 1);
  assert.match(wrong.output.err, /不能用：OpenAI 没有这个模型/);
});

test("model check：没在运行就先启动；正在运行的是旧版本、不认识这条命令时说要重启", async () => {
  const fresh = harness();
  assert.equal(await fresh.speakmore("model", "check"), 0);
  assert.deepEqual(fresh.daemon.calls, ["start", "check-model"]);

  const old = fakeDaemon({ running: READY });
  old.request = async (cmd) => {
    throw new Error(`不认识的命令：${cmd}`);
  };
  const outdated = harness({ daemon: old });
  assert.equal(await outdated.speakmore("model", "check"), 1);
  assert.match(outdated.output.err, /旧版本.*speakmore restart/);
});

// ---------- 每家一把 key ----------

test("key <厂商>：问的是那一家的 key，存进它那一份；不是正在用的那家时提示怎么换过去（按它在哪一层）", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { speakmore, output, asked } = harness({ daemon, secrets: ["sk-new"] });
  assert.equal(await speakmore("key", "openai"), 0);
  assert.deepEqual(saved, [{ key: "sk-new", provider: "openai" }]);
  assert.match(asked[0], /OpenAI API key/);
  assert.match(output.out, /要换成用它：speakmore model openai/);

  const deepseek = harness({ daemon: fakeDaemon({ running: READY }), secrets: ["sk-ds"] });
  assert.equal(await deepseek.speakmore("key", "deepseek"), 0);
  assert.match(deepseek.asked[0], /DeepSeek API key/);
  // 录音不发给它，只发转出来的文字
  assert.match(deepseek.asked[0], /本机/);
  assert.match(deepseek.asked[0], /platform\.deepseek\.com/);
  // 现在是 native 模式：polish 只在 local 里能用，提示连模式一起切
  assert.match(deepseek.output.out, /要换成用它：speakmore mode local --polish deepseek/);

  const fromLocal = harness({ daemon: fakeDaemon({ running: LOCAL_READY }), secrets: ["sk-ds", "sk-oa"] });
  assert.equal(await fromLocal.speakmore("key", "openai"), 0);
  assert.match(fromLocal.output.out, /要换成用它：speakmore mode native --model openai/);
});

test("key 后面写的不是厂商名：多半是把 key 本身写在了命令里，不照做也不把它打出来", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("key", "sk-proj-SECRET"), 2);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
  assert.match(output.err, /shell 的历史记录/);
});

test("key --forget <厂商>：只删那一家的；不写就删正在用的那家", async () => {
  haveStoredKey();
  haveOpenAIKey();
  writeFileSync(oldAppKeyFile(paths, "openai"), "密文");
  const { speakmore, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("key", "--forget", "openai"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "forget-key", params: { provider: "openai" } });
  assert.equal(existsSync(keyFile(paths, "openai")), false);
  assert.equal(existsSync(oldAppKeyFile(paths, "openai")), false);
  assert.equal(existsSync(keyFile(paths, "gemini")), true);
  assert.match(output.out, /OpenAI 的 key 已经删掉/);
});

test("正在用 OpenAI 时第一次启动：问的是 OpenAI 的 key", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ model: "openai/gpt-audio-mini" }));
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" } });
  const { speakmore, asked } = harness({ daemon, secrets: ["sk-first"] });
  assert.equal(await speakmore(), 0);
  assert.match(asked[0], /OpenAI API key/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-first",
    provider: "openai",
  });
});

test("改了模型、重启之后发现那家没有 key：说清还差它，不说已经生效", async () => {
  const daemon = fakeDaemon({
    running: READY,
    afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" },
  });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("config", "set", "model", "openai"), 1);
  assert.match(output.err, /还没有 OpenAI 的 key.*speakmore key openai/);
  assert.doesNotMatch(output.out, /已经生效/);
});

test("改模型时 GEMINI_MODEL（旧名字）设着：提醒它盖着新值", async () => {
  haveOpenAIKey();
  const { speakmore, output } = harness({ env: { GEMINI_MODEL: "gemini-3.5-flash" } });
  assert.equal(await speakmore("model", "openai"), 0);
  assert.match(output.out, /环境变量 GEMINI_MODEL 现在设着/);
});

test("model：key 是启动后台时从环境变量给的（命令行这边没有）也照实写，不说成还没有", async () => {
  const fromEnv = { ...READY, key: { state: "ready", source: "env", problem: null, verified: true } };
  const { speakmore, output } = harness({ daemon: fakeDaemon({ running: fromEnv }) });
  assert.equal(await speakmore("model"), 0);
  assert.match(output.out, /● gemini\s+Gemini\s+gemini-3\.6-flash\s+key 来自环境变量 GEMINI_API_KEY/);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini（默认）\s+还没有 key/);
});

// ---------- 审查之后补的 ----------

/** 0.3 的后台应用：状态里没有 provider，也不认按厂商存、删 key */
const LEGACY_DAEMON = (() => {
  const { provider: _provider, ...rest } = READY;
  return { ...rest, model: "gemini-3.5-flash" };
})();

test("后台是 0.3 的：给别家存 key、删别家的 key 都先拦下，说要重启；不发请求、不删文件", async () => {
  haveStoredKey();
  haveOpenAIKey();
  const forget = harness({ daemon: fakeDaemon({ running: LEGACY_DAEMON }) });
  assert.equal(await forget.speakmore("key", "--forget", "openai"), 1);
  assert.match(forget.output.err, /旧版本.*speakmore restart/);
  assert.ok(!forget.daemon.calls.includes("forget-key"));
  assert.ok(existsSync(keyFile(paths, "openai")) && existsSync(keyFile(paths, "gemini")));

  const save = harness({ daemon: fakeDaemon({ running: LEGACY_DAEMON }), secrets: ["sk-new"] });
  assert.equal(await save.speakmore("key", "openai"), 1);
  assert.ok(!save.daemon.calls.includes("set-key"));
  assert.equal(save.asked.length, 0);

  // Gemini 的 key 旧后台本来就会存
  const gemini = harness({ daemon: fakeDaemon({ running: LEGACY_DAEMON }), secrets: ["AIza-new"] });
  assert.equal(await gemini.speakmore("key", "gemini"), 0);
});

/** 0.6 及以前的后台应用：状态里没有 mode，只认 Gemini 和 OpenAI 的 key */
const BEFORE_MODES_DAEMON = (() => {
  const { mode: _mode, ...rest } = READY;
  return rest;
})();

test("后台是 0.6 的：切 local 要给 DeepSeek 存 key 时先拦下，说要重启；不发请求、不切；OpenAI 的 key 照常存", async () => {
  haveModel();
  const daemon = fakeDaemon({ running: BEFORE_MODES_DAEMON });
  const { speakmore, output, asked } = harness({ daemon, secrets: ["sk-ds"] });
  assert.equal(await speakmore("mode", "local"), 1);
  assert.match(output.err, /旧版本.*DeepSeek.*speakmore restart/);
  assert.ok(!daemon.calls.includes("set-key") && !daemon.calls.includes("set-mode"));
  assert.equal(saved("mode"), "native");
  // 先拦再问：不让人粘贴了 key 才听说存不了
  assert.equal(asked.length, 0);

  const openai = harness({ daemon: fakeDaemon({ running: BEFORE_MODES_DAEMON }), secrets: ["sk-openai"] });
  assert.equal(await openai.speakmore("key", "openai"), 0);
  assert.ok(openai.daemon.calls.includes("set-key"));
});

test("换模型时那家的 key 被拒：不换，说原因，设置不动，以 1 退出", async () => {
  haveOpenAIKey();
  const daemon = fakeDaemon({
    running: READY,
    changeRoute: () => ({ ok: false, problem: "这把 key 无效，检查有没有复制完整" }),
  });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("model", "openai"), 1);
  assert.match(output.err, /没有换：这把 key 无效/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");
  assert.doesNotMatch(output.out, /已经换上/);
});

test("换模型时正在运行的是旧版本、不认识当场换：存进设置，重启让它生效（老路）", async () => {
  haveOpenAIKey();
  const old = fakeDaemon({ running: READY });
  const request = old.request;
  old.request = async (cmd, params) => {
    if (cmd === "set-model") throw new Error(`不认识的命令：${cmd}`);
    return request(cmd, params);
  };
  const { speakmore, output } = harness({ daemon: old });
  assert.equal(await speakmore("model", "openai"), 0);
  assert.equal(savedModel(), "openai/gpt-audio-mini");
  assert.deepEqual(old.calls.slice(-2), ["stop", "start"]);
  assert.match(output.out, /已经生效/);
});

test("装成应用的在运行：它的 key 存在它自己那一份里，看 key 有没有以它报的为准", async () => {
  const app = { ...READY, packaged: true, keys: { gemini: "stored", openai: "stored" } };
  const { speakmore, output, asked } = harness({ daemon: fakeDaemon({ running: app }) });
  assert.equal(await speakmore("model"), 0);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini（默认）\s+key 存着/);
  // 不再问一遍 key；装成应用的也能当场换，不用退出重开
  assert.equal(await speakmore("model", "openai"), 0);
  assert.equal(asked.length, 0);
  assert.match(output.out, /已经换上，不用重启/);
});

test("英文时每个命令的输出里都没有漏翻的中文（用户自己说的话除外）", async () => {
  const history = openHistory(paths.historyDb);
  history.add({
    id: "a",
    status: "completed",
    refinedText: "Let's meet at 9:30.",
    error: null,
    duration: 4,
    audioFile: null,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.add({
    id: "b",
    status: "failed",
    refinedText: "",
    error: null,
    duration: 75,
    audioFile: null,
    createdAt: "2026-10-12T06:32:00.000Z",
  });
  history.addCall({
    purpose: "dictation",
    audioId: "a",
    provider: "gemini",
    model: "gemini-3.6-flash",
    inputTokens: 1390,
    audioTokens: 25,
    cachedTokens: 0,
    outputTokens: 4,
    thinkingTokens: 0,
    costUsd: 0.0011,
    latencyMs: 1700,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.addCall({
    purpose: "check",
    audioId: null,
    provider: "openai",
    model: "gpt-unknown",
    inputTokens: 10,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 1,
    thinkingTokens: 0,
    costUsd: null,
    latencyMs: 900,
    createdAt: "2026-10-13T06:33:00.000Z",
  });
  history.close();
  const missing = { ...NO_PERMISSIONS, summary: { ...NO_PERMISSIONS.summary, missing: [], blocker: null } };
  const commands = [
    [["status"], READY],
    [["status"], missing],
    [["status"], null],
    [["config"], READY],
    [["theme"], READY],
    [["model"], READY],
    [["usage"], null],
    [["history"], null],
    [["logs"], null],
    [["stop"], READY],
    [["settings"], null],
    [["key", "--forget", "openai"], READY],
    [["uninstall"], null],
    [["move"], null],
    [["move", "/d"], null],
    [["model", "nope"], READY],
    [["model", "deepseek"], READY],
    [["mode"], READY],
    [["mode", "local"], READY],
    [["mode", "cloud"], READY],
    [["transcriber"], READY],
    [["polish"], READY],
    [["polish", "custom/m"], READY],
    [["history", "extra"], null],
  ];
  for (const [argv, running] of commands) {
    const { speakmore, output } = harness({ daemon: fakeDaemon({ running }), locale: "en", interactive: false });
    await speakmore(...argv);
    assert.doesNotMatch(output.out + output.err, /[一-鿿]/, argv.join(" "));
  }
});

// ---------- 模式，和各模式里的模型 ----------

/** 假装以前给 DeepSeek 存过一把 key */
const haveDeepSeekKey = () => writeFileSync(keyFile(paths, "deepseek"), "密文");
const saved = (name) => resolveSettings({ file: paths.settingsFile, env: {} })[name].value;
/** 正在 local 模式的后台 */
const LOCAL_READY = {
  ...READY,
  provider: "deepseek",
  mode: "local",
  model: null,
  thinking: null,
  transcriber: "qwen3-asr-0.6b-q8",
  polish: "deepseek/deepseek-flash",
  localModel: { state: "ready", model: "qwen3-asr-0.6b-q8", backend: "MTL0" },
};

/** 数据隐私模式：不用 key，只有一个本机模型 */
const PRIVATE_READY = {
  ...LOCAL_READY,
  provider: null,
  mode: "private",
  polish: null,
  key: { state: "ready", source: "none", problem: null },
};

test("speakmore mode private：不问 key，本机模型下好了就切；状态面板写不用 key、只用本机模型", async () => {
  haveModel();
  const { speakmore, output, daemon, asked } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await speakmore("mode", "private"), 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-mode").params, { mode: "private", changes: {} });
  assert.match(output.out, /本机的 qwen3-asr-0\.6b-q8，不整理、不上传/);

  const panel = harness({ daemon: fakeDaemon({ running: PRIVATE_READY }) });
  assert.equal(await panel.speakmore("status"), 0);
  assert.match(panel.output.out, /不用 key（离线模式）/);
  assert.match(panel.output.out, /离线：只用本机模型，什么都不上传/);
});

test("数据隐私模式里 speakmore transcriber 换的是它自己的那一项，local 的第一跳不动；云端的不收；key 要写明哪一家", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "private" }));
  haveModel("sensevoice-small-q8");
  const { speakmore, output } = harness();
  assert.equal(await speakmore("transcriber", "sensevoice-small-q8"), 0);
  const settings = resolveSettings({ file: paths.settingsFile, env: {} });
  assert.equal(settings.privateTranscriber.value, "sensevoice-small-q8");
  assert.equal(settings.transcriber.value, "qwen3-asr-0.6b-q8");

  assert.equal(await speakmore("transcriber", "bailian/qwen3-asr-flash"), 1);
  assert.match(output.err, /离线方式只用本机模型/);
  assert.equal(await speakmore("key"), 2);
  assert.match(output.err, /离线模式不用 key/);
});

test("第一跳交给云端（审查 4 号）：换成云端、检查、下载、切进 local、第一次启动，都照常说话，不崩", async () => {
  const cloud = harness({ daemon: fakeDaemon({ running: LOCAL_READY }), secrets: ["sk-ws-bailian"] });
  assert.equal(await cloud.speakmore("transcriber", "bailian/qwen3-asr-flash"), 0);
  assert.deepEqual(cloud.daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-ws-bailian",
    provider: "bailian",
    changes: { transcriber: "bailian/qwen3-asr-flash" },
  });
  assert.ok(cloud.daemon.calls.includes("set-transcriber"));

  assert.equal(await cloud.speakmore("transcriber", "check", "bailian/qwen3-asr-flash"), 0);
  assert.deepEqual(cloud.daemon.requests.find(({ cmd }) => cmd === "check-mode").params, {
    mode: "local",
    changes: { transcriber: "bailian/qwen3-asr-flash" },
  });
  assert.equal(await cloud.speakmore("transcriber", "download", "bailian/qwen3-asr-flash"), 2);
  assert.match(cloud.output.err, /云端模型，不用下载/);

  // 设置里第一跳已经是云端的：切进 local 时两家的 key 都问
  writeFileSync(paths.settingsFile, JSON.stringify({ transcriber: "bailian/qwen3-asr-flash" }));
  const switching = harness({ daemon: fakeDaemon({ running: READY }), secrets: ["sk-ws-bailian", "sk-deepseek"] });
  assert.equal(await switching.speakmore("mode", "local"), 0);
  assert.deepEqual(
    switching.daemon.requests.filter(({ cmd }) => cmd === "set-key").map(({ params }) => params.provider),
    ["bailian", "deepseek"],
  );

  const first = harness({ daemon: fakeDaemon({ afterStart: NO_KEY }), answers: ["1"], secrets: ["k"] });
  assert.equal(await first.speakmore(), 0);
});

test("第一次启动的选项里有数据隐私模式：选它不问 key，设置里记成 private", async () => {
  const { speakmore, questions, asked } = harness({
    daemon: fakeDaemon({ afterStart: PRIVATE_READY }),
    answers: ["private"],
  });
  assert.equal(await speakmore(), 0);
  assert.match(questions.join("\n"), /private（离线）模式：只用本机模型转文字/);
  assert.deepEqual(asked, []);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).mode.value, "private");
});

test("mode：列出两种模式、各自用的模型，现在用的打一个点，说怎么切、两种模式里各自怎么换模型", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("mode"), 0);
  assert.match(output.out, /● native\s+直出：录音直接交给模型\s+Gemini 的 gemini-3\.6-flash/);
  assert.match(
    output.out,
    /\n {4}local\s+混合：先转文字，再交给模型整理\s+qwen3-asr-0\.6b-q8 → DeepSeek 的 deepseek-flash/,
  );
  assert.match(output.out, /speakmore mode local/);
  assert.match(output.out, /speakmore model\b/);
  assert.match(output.out, /speakmore transcriber/);
  assert.match(output.out, /speakmore polish/);
});

test("mode <模式>：有那种模式要的 key 就让在运行的那个当场切，不重启", async () => {
  haveModel();
  haveDeepSeekKey();
  const daemon = fakeDaemon({ running: READY });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("mode", "local"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-mode", params: { mode: "local", changes: {} } });
  assert.ok(!daemon.calls.includes("stop"));
  assert.match(output.out, /切到了 local 模式：qwen3-asr-0\.6b-q8 → DeepSeek 的 deepseek-flash/);
  assert.match(output.out, /已经换上，不用重启/);
});

test("mode local：0.7.0 的后台切过去后自己下载模型，照它报的说一声，进度去哪看", async () => {
  haveDeepSeekKey();
  haveModel();
  const downloading = {
    ...LOCAL_READY,
    localModel: { state: "downloading", model: "qwen3-asr-0.6b-q8", received: 425, total: 850 },
  };
  const daemon = fakeDaemon({ running: READY });
  daemon.request = (
    ({ request }) =>
    async (cmd, params) => {
      const result = await request.call(daemon, cmd, params);
      if (cmd === "set-mode") daemon.current = downloading;
      return result;
    }
  )(daemon);
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("mode", "local"), 0);
  assert.match(output.out, /本地模型在后台下载（50%）.*speakmore status/);
});

test("mode <模式>：还没有那种模式要的 key 时先问，拿要切过去的设置验证过存好，再切", async () => {
  haveModel();
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { speakmore, asked, output } = harness({ daemon, secrets: ["sk-ds"] });
  assert.equal(await speakmore("mode", "local"), 0);
  assert.deepEqual(saved, [{ key: "sk-ds", provider: "deepseek" }]);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-ds",
    provider: "deepseek",
    changes: { mode: "local" },
  });
  assert.match(asked[0], /DeepSeek API key/);
  assert.equal(daemon.requests.at(-1).cmd, "set-mode");
  assert.ok(!(output.out + output.err).includes("sk-ds"));
});

test("mode <模式>：没有 key 又没法问时不切，说先做什么；没在运行时存进设置、下次启动生效", async () => {
  haveModel();
  const quiet = harness({ interactive: false });
  assert.equal(await quiet.speakmore("mode", "local"), 1);
  assert.match(quiet.output.err, /还没有 DeepSeek 的 key.*speakmore key deepseek/);
  assert.equal(saved("mode"), "native");

  haveDeepSeekKey();
  const notRunning = harness();
  assert.equal(await notRunning.speakmore("mode", "local"), 0);
  assert.equal(saved("mode"), "local");
  assert.match(notRunning.output.out, /下次启动生效/);
  assert.deepEqual(notRunning.daemon.calls, []);
});

test("mode：写错的模式以 2 退出并说能填什么；切没通过以 1 退出说原因", async () => {
  haveModel();
  const { speakmore, output } = harness();
  assert.equal(await speakmore("mode", "cloud"), 2);
  assert.match(output.err, /native \/ local/);

  haveDeepSeekKey();
  const refused = harness({
    daemon: fakeDaemon({ running: READY, changeRoute: () => ({ ok: false, problem: "DeepSeek 余额不足" }) }),
  });
  assert.equal(await refused.speakmore("mode", "local"), 1);
  assert.match(refused.output.err, /没有换：DeepSeek 余额不足/);
});

test("在 local 模式时换 native 的模型：不能换，说先切回 native；不问 key、不发请求、不改设置", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { speakmore, output, asked } = harness({ daemon, secrets: ["sk-x"] });
  assert.equal(await speakmore("model", "openai"), 1);
  assert.match(output.err, /现在是 local 模式.*收音频的模型.*native 模式.*speakmore mode native/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-model"));
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  // 没在运行时看设置里的模式
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "local" }));
  const offline = harness();
  assert.equal(await offline.speakmore("model", "openai"), 1);
  assert.match(offline.output.err, /现在是 local 模式/);
});

test("在 native 模式时换 local 的两跳：不能换，说先切到 local；列出来看可以，但标明现在用不上", async () => {
  const daemon = fakeDaemon({ running: READY });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("transcriber", "sensevoice-small-q8"), 1);
  assert.match(output.err, /现在是 native 模式.*转文字的模型.*local 模式.*speakmore mode local/);
  assert.equal(await speakmore("polish", "deepseek/deepseek-v4-pro"), 1);
  assert.match(output.err, /整理的模型要在 local 模式里才能换/);
  assert.ok(!daemon.calls.some((call) => call.startsWith("set-")));

  const list = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await list.speakmore("transcriber"), 0);
  assert.match(list.output.out, /现在是 native 模式，用不上.*speakmore mode local/);
});

test("mode local 连带第二跳：没有 DeepSeek 的 key 也能直接用自定义服务进 local", async () => {
  haveModel();
  const daemon = fakeDaemon({ running: READY });
  const { speakmore, asked } = harness({ daemon, secrets: ["sk-custom"] });
  assert.equal(
    await speakmore("mode", "local", "--polish", "custom/qwen3:8b", "--url", "http://127.0.0.1:11434/v1"),
    0,
  );
  assert.match(asked[0], /Custom|自定义服务/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-custom",
    provider: "custom",
    changes: { mode: "local", polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" },
  });
  assert.deepEqual(daemon.requests.at(-1), {
    cmd: "set-mode",
    params: { mode: "local", changes: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" } },
  });
});

test("mode local 连带额外参数：和地址、模型一起验证、一起换", async () => {
  haveModel();
  const daemon = fakeDaemon({ running: READY });
  const { speakmore } = harness({ daemon, secrets: ["sk-custom"] });
  const flags = ["--polish", "custom/gpt-5-mini", "--url", "https://router.example/v1", "--params", '{"n": 1}'];
  assert.equal(await speakmore("mode", "local", ...flags), 0);
  const changes = { polish: "custom/gpt-5-mini", customUrl: "https://router.example/v1", customParams: '{"n":1}' };
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params.changes, { mode: "local", ...changes });
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-mode", params: { mode: "local", changes } });
});

test("mode 连带的设置不是那种模式的：以 2 退出说能带什么", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("mode", "native", "--polish", "deepseek"), 2);
  assert.match(output.err, /--model/);
  assert.equal(await speakmore("mode", "local", "--model", "openai"), 2);
  assert.match(output.err, /--transcriber.*--polish.*--url.*--params/);
});

test("transcriber：列出本机转写模型（第一跳），大小、下载过没有、在下的进度，现在用的打一个点；最后说本机下了几个、怎么下载删除", async () => {
  haveModel("sensevoice-small-q8");
  const { speakmore, output } = harness();
  assert.equal(await speakmore("transcriber"), 0);
  assert.match(output.out, /local 的第一步、private 的模型/);
  assert.match(output.out, /● qwen3-asr-0\.6b-q8\s+Qwen3-ASR 0\.6B \(Q8_0\)\s+850 MB\s+还没下载/);
  assert.match(output.out, /sensevoice-small-q8\s+SenseVoice Small \(Q8_0\)\s+253 MB\s+已下载/);
  assert.match(output.out, /本机已下载 1 \/ 4 个，共 253 MB · 磁盘剩余 /);
  assert.match(output.out, /换一个：speakmore transcriber sensevoice-small-q8/);
  assert.match(output.out, /下载：speakmore transcriber download qwen3-asr-0\.6b-q8 · 停下：cancel · 删除：delete/);

  // 后台在运行：以它报的为准（正在下的进度、上次没下下来的）
  const total = downloadSize(findModel("qwen3-asr-0.6b-q8"));
  const running = {
    ...LOCAL_READY,
    localModels: [
      {
        id: "qwen3-asr-0.6b-q8",
        installed: false,
        download: { received: total / 4, total },
        partial: 0,
        problem: null,
      },
      {
        id: "sensevoice-small-q8",
        installed: false,
        download: null,
        partial: 0,
        problem: "SenseVoice 没下下来：断网了",
      },
    ],
  };
  const busy = harness({ daemon: fakeDaemon({ running }) });
  assert.equal(await busy.speakmore("transcriber"), 0);
  assert.match(busy.output.out, /qwen3-asr-0\.6b-q8.*下载中 25%/);
  assert.match(busy.output.out, /sensevoice-small-q8.*没下下来\n(.*\n){2}.*断网了/);
});

test("transcriber <模型>：不用 key，让在运行的那个当场换；写错了以 2 退出说能填什么", async () => {
  haveModel("sensevoice-small-q8");
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { speakmore, output, asked } = harness({ daemon });
  assert.equal(await speakmore("transcriber", "sensevoice-small-q8"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-transcriber", params: { transcriber: "sensevoice-small-q8" } });
  assert.equal(asked.length, 0);
  assert.match(output.out, /转文字的模型换成了 sensevoice-small-q8/);

  const wrong = harness();
  assert.equal(await wrong.speakmore("transcriber", "gemini"), 2);
  assert.match(wrong.output.err, /qwen3-asr-0\.6b-q8/);
});

// ---------- 本机模型：下载、停下、删除 ----------

/**
 * 会下载的后台：download-model 之后每看一次状态前进一截，第二次看时下好了（outcome 为 "fail" 时报没下下来）。
 * delete-model 照内核的规矩：正在用的（local 模式的第一跳）不让删
 */
function modelDaemon({ running = LOCAL_READY, outcome = "finish" } = {}) {
  const daemon = fakeDaemon({ running });
  const total = (id) => downloadSize(findModel(id));
  const views = new Map();
  const view = (id) =>
    views.get(id) ?? {
      id,
      installed: existsSync(join(paths.modelsDir, id, ".complete.json")),
      download: null,
      partial: 0,
      problem: null,
    };
  const polls = new Map();
  const status = daemon.status;
  daemon.status = async (params) => {
    const current = await status.call(daemon, params);
    if (current === null) return null;
    for (const [id, count] of polls) {
      polls.set(id, count + 1);
      if (count >= 1) {
        polls.delete(id);
        if (outcome === "finish") {
          haveModel(id);
          views.delete(id);
        } else views.set(id, { ...view(id), download: null, problem: `${id} 没下下来：${outcome}` });
      }
    }
    return { ...current, localModels: ["qwen3-asr-0.6b-q8", "sensevoice-small-q8"].map(view) };
  };
  const request = daemon.request;
  daemon.request = async (cmd, params) => {
    if (cmd === "download-model") {
      daemon.calls.push(cmd);
      daemon.requests.push({ cmd, params });
      views.set(params.id, {
        ...view(params.id),
        download: { received: total(params.id) / 2, total: total(params.id) },
      });
      polls.set(params.id, 0);
      return { ok: true };
    }
    if (cmd === "cancel-download") {
      daemon.calls.push(cmd);
      polls.delete(params.id);
      views.delete(params.id);
      return { ok: true };
    }
    if (cmd === "delete-model") {
      daemon.calls.push(cmd);
      const current = daemon.current;
      if (current.mode === "local" && current.transcriber === params.id) {
        return { ok: false, problem: `${params.id} 正在用，删不了：先换一个模型，或切回 native` };
      }
      rmSync(join(paths.modelsDir, params.id), { recursive: true, force: true });
      return { ok: true };
    }
    return request.call(daemon, cmd, params);
  };
  return daemon;
}

test("transcriber <模型>：要换的还没下载时先问；答是就交给后台下完再换，进度一截一截说", async () => {
  const daemon = modelDaemon();
  const { speakmore, output, confirmed } = harness({ daemon, confirms: [true] });
  assert.equal(await speakmore("transcriber", "sensevoice-small-q8"), 0);
  assert.match(confirmed[0], /SenseVoice Small \(Q8_0\) 还没下载（253 MB，从魔搭下）。现在下载吗/);
  assert.match(output.out, /交给后台下了：按 Ctrl-C 只是不看进度/);
  assert.match(output.out, /下载中 50%/);
  assert.match(output.out, /SenseVoice Small \(Q8_0\) 下好了/);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-transcriber", params: { transcriber: "sensevoice-small-q8" } });
});

test("transcriber <模型>：不想下就不下也不换；不能问时说先运行哪条命令；没下下来时不换", async () => {
  const declined = harness({ daemon: modelDaemon(), confirms: [false] });
  assert.equal(await declined.speakmore("transcriber", "sensevoice-small-q8"), 1);
  assert.match(declined.output.out, /没有下载，也没有换/);
  assert.ok(!declined.daemon.calls.includes("download-model") && !declined.daemon.calls.includes("set-transcriber"));

  const quiet = harness({ daemon: modelDaemon(), interactive: false });
  assert.equal(await quiet.speakmore("transcriber", "sensevoice-small-q8"), 1);
  assert.match(quiet.output.err, /还没下载：先运行 speakmore transcriber download sensevoice-small-q8/);

  const failing = harness({ daemon: modelDaemon({ outcome: "断网了" }), confirms: [true] });
  assert.equal(await failing.speakmore("transcriber", "sensevoice-small-q8"), 1);
  assert.match(failing.output.err, /没下下来：断网了/);
  assert.ok(!failing.daemon.calls.includes("set-transcriber"));
});

test("transcriber download：用户自己点的，不再问；后台没在运行就在命令行这个进程里下；已经下好的直说", async () => {
  const idle = harness();
  assert.equal(await idle.speakmore("transcriber", "download", "qwen3-asr-0.6b-q8"), 0);
  assert.deepEqual(idle.local.downloads, ["qwen3-asr-0.6b-q8"]);
  assert.deepEqual(idle.local.sources, ["cn"]);
  assert.match(idle.output.out, /下载 Qwen3-ASR 0\.6B \(Q8_0\)（850 MB，从魔搭）/);
  assert.match(idle.output.out, /下好了/);
  assert.equal(idle.confirmed.length, 0);

  const again = harness();
  assert.equal(await again.speakmore("transcriber", "download", "qwen3-asr-0.6b-q8"), 0);
  assert.match(again.output.out, /已经下载好了/);
  assert.deepEqual(again.local.downloads, []);

  const failing = harness({ modelDownload: "磁盘写不进去" });
  assert.equal(await failing.speakmore("transcriber", "download", "sensevoice-small-q8"), 1);
  assert.match(failing.output.err, /没下下来：磁盘写不进去/);

  const wrong = harness();
  assert.equal(await wrong.speakmore("transcriber", "download"), 2);
  assert.equal(await wrong.speakmore("transcriber", "download", "gemini"), 2);
});

test("transcriber check：交给后台念一句、转一次，说念的、转出来的和用了多久；不写就查现在选的", async () => {
  haveModel();
  const daemon = modelDaemon();
  const request = daemon.request;
  daemon.request = async (cmd, params, options) => {
    if (cmd !== "check-transcriber") return request.call(daemon, cmd, params, options);
    daemon.calls.push(cmd);
    daemon.requests.push({ cmd, params });
    if (params.id === "sensevoice-small-q8") {
      return { ok: false, problem: "SenseVoice Small (Q8_0) 还没下载（253 MB）：先下载再用" };
    }
    const said = "今天下午三点开会，记得带上电脑。";
    return { ok: true, said, text: said, transcribeMs: 312, loadMs: 1840, backend: "metal" };
  };
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("transcriber", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-transcriber", params: { id: "qwen3-asr-0.6b-q8" } });
  assert.match(output.out, /正在检查 Qwen3-ASR 0\.6B \(Q8_0\)/);
  assert.match(
    output.out,
    /能用。念的是「今天下午三点开会，记得带上电脑。」，转出来「今天下午三点开会，记得带上电脑。」，用了 0\.3 秒/,
  );
  assert.match(output.out, /临时装上用了 1\.8 秒/);

  // 没下载的不去问后台，直接说怎么下
  const asked = daemon.calls.filter((cmd) => cmd === "check-transcriber").length;
  assert.equal(await speakmore("transcriber", "check", "sensevoice-small-q8"), 1);
  assert.match(output.err, /还没下载：先运行 speakmore transcriber download sensevoice-small-q8/);
  assert.equal(daemon.calls.filter((cmd) => cmd === "check-transcriber").length, asked);
  assert.equal(await speakmore("transcriber", "check", "gemini"), 2);
  assert.equal(await speakmore("transcriber", "check", "qwen3-asr-0.6b-q8", "extra"), 2);
});

test("transcriber cancel：后台正在下的停下；没在下的直说", async () => {
  const daemon = modelDaemon();
  const { speakmore, output } = harness({ daemon });
  await daemon.request("download-model", { id: "sensevoice-small-q8" });
  assert.equal(await speakmore("transcriber", "cancel", "sensevoice-small-q8"), 0);
  assert.ok(daemon.calls.includes("cancel-download"));
  assert.match(output.out, /停下了 SenseVoice Small \(Q8_0\) 的下载/);
  assert.equal(await speakmore("transcriber", "cancel", "sensevoice-small-q8"), 0);
  assert.match(output.out, /没有在下载/);
});

test("transcriber delete：先确认；--yes 不问；不能问又没 --yes 时以 2 退出；正在用的删不了；没下载的不用删", async () => {
  haveModel("sensevoice-small-q8");
  const asked = harness({ daemon: modelDaemon(), confirms: [false] });
  assert.equal(await asked.speakmore("transcriber", "delete", "sensevoice-small-q8"), 1);
  assert.match(asked.confirmed[0], /删掉 SenseVoice Small \(Q8_0\)（253 MB）/);
  assert.match(asked.output.out, /没有删/);
  assert.ok(existsSync(join(paths.modelsDir, "sensevoice-small-q8")));

  const quiet = harness({ daemon: modelDaemon(), interactive: false });
  assert.equal(await quiet.speakmore("transcriber", "delete", "sensevoice-small-q8"), 2);
  assert.match(quiet.output.err, /--yes/);

  const sure = harness({ daemon: modelDaemon() });
  assert.equal(await sure.speakmore("transcriber", "delete", "sensevoice-small-q8", "--yes"), 0);
  assert.match(sure.output.out, /删掉了 SenseVoice Small \(Q8_0\)，腾出 253 MB/);
  assert.equal(existsSync(join(paths.modelsDir, "sensevoice-small-q8")), false);

  haveModel("qwen3-asr-0.6b-q8");
  const inUse = harness({ daemon: modelDaemon() });
  assert.equal(await inUse.speakmore("transcriber", "delete", "qwen3-asr-0.6b-q8", "--yes"), 1);
  assert.match(inUse.output.err, /正在用，删不了/);

  const nothing = harness();
  assert.equal(await nothing.speakmore("transcriber", "delete", "sensevoice-small-q8", "--yes"), 0);
  assert.match(nothing.output.out, /本来就没下载/);
});

test("transcriber delete：后台没在运行时自己删；设置里 local 模式用的就是它就不删", async () => {
  haveModel("sensevoice-small-q8");
  const idle = harness();
  assert.equal(await idle.speakmore("transcriber", "delete", "sensevoice-small-q8", "--yes"), 0);
  assert.deepEqual(idle.local.removed, ["sensevoice-small-q8"]);

  haveModel("qwen3-asr-0.6b-q8");
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "local" }));
  const inUse = harness();
  assert.equal(await inUse.speakmore("transcriber", "delete", "qwen3-asr-0.6b-q8", "--yes"), 1);
  assert.match(inUse.output.err, /正在用，删不了/);
  assert.deepEqual(inUse.local.removed, []);
});

test("mode local：要用的本机模型还没下载时先问；不下就不切，也不问 key", async () => {
  const daemon = modelDaemon({ running: READY });
  const { speakmore, output, asked } = harness({ daemon, confirms: [false] });
  assert.equal(await speakmore("mode", "local"), 1);
  assert.match(output.out, /没有下载，也没有换/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-mode"));

  haveDeepSeekKey();
  const yes = harness({ daemon: modelDaemon({ running: READY }), confirms: [true] });
  assert.equal(await yes.speakmore("mode", "local"), 0);
  assert.match(yes.output.out, /下好了[\s\S]*切到了 local 模式/);
});

test("polish：列出润色的那几家（第二跳），各家能挑的模型、key 有没有，自定义服务怎么填", async () => {
  haveDeepSeekKey();
  const { speakmore, output } = harness();
  assert.equal(await speakmore("polish"), 0);
  assert.match(output.out, /local 模式的第二步/);
  assert.match(output.out, /● deepseek\s+DeepSeek\s+deepseek-flash\s+key 存着/);
  assert.match(output.out, /deepseek-v4-pro/);
  assert.match(output.out, /custom\s+自定义服务/);
  assert.match(output.out, /speakmore polish custom\/<模型名> --url <地址>/);
});

test("polish <厂商>/<模型>：有 key 就让在运行的那个当场换", async () => {
  haveDeepSeekKey();
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("polish", "deepseek/deepseek-v4-pro"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-polish", params: { polish: "deepseek/deepseek-v4-pro" } });
  assert.match(output.out, /整理的模型换成了 DeepSeek 的 deepseek-v4-pro/);
});

test("polish custom/<模型> --url <地址>：先问自定义服务的 key，连模型和地址一起验证，再换", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { speakmore, asked } = harness({ daemon, secrets: ["sk-custom"] });
  assert.equal(await speakmore("polish", "custom/qwen3:8b", "--url", "http://127.0.0.1:11434/v1/chat/completions"), 0);
  // 自定义服务没有申请 key 的页面
  assert.doesNotMatch(asked[0], /申请/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-custom",
    provider: "custom",
    changes: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" },
  });
  assert.deepEqual(daemon.requests.at(-1), {
    cmd: "set-polish",
    params: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" },
  });
});

test("polish custom/<模型> --url --params：额外参数规整后连模型和地址一起验证、一起换（issue #8）", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { speakmore, output } = harness({ daemon, secrets: ["sk-custom"] });
  const params = '{ "max_completion_tokens": 1024 }';
  assert.equal(
    await speakmore("polish", "custom/gpt-5-mini", "--url", "https://router.example/v1", "--params", params),
    0,
  );
  const changes = {
    polish: "custom/gpt-5-mini",
    customUrl: "https://router.example/v1",
    customParams: '{"max_completion_tokens":1024}',
  };
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params.changes, changes);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-polish", params: changes });
  assert.match(output.out, /整理的模型换成了 router\.example 的 gpt-5-mini/);
});

test("polish --params：写坏了、给的不是自定义服务，以 2 退出说清楚", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("polish", "custom/m", "--url", "https://x.example/v1", "--params", "{bad}"), 2);
  assert.match(output.err, /JSON/);
  assert.equal(await speakmore("polish", "deepseek", "--params", '{"temperature": 0.2}'), 2);
  assert.match(output.err, /--params.*自定义服务/);
});

test("polish：自定义服务带着额外参数时，列表里写出来", async () => {
  writeFileSync(
    paths.settingsFile,
    JSON.stringify({
      polish: "custom/gpt-5-mini",
      customUrl: "https://router.example/v1",
      customParams: '{"reasoning_effort":"minimal"}',
    }),
  );
  const { speakmore, output } = harness();
  assert.equal(await speakmore("polish"), 0);
  assert.match(output.out, /额外参数：\{"reasoning_effort":"minimal"\}/);
});

test("polish：自定义服务没给地址、写的是收音频的那家，以 2 退出说清楚", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("polish", "custom/m"), 2);
  assert.match(output.err, /--url/);
  assert.equal(await speakmore("polish", "openai"), 2);
  // 说出能用的每一家
  assert.ok(output.err.includes(CHAT_VENDORS.map(({ id }) => id).join(" / ")), output.err);
});

test("polish check：查第二跳现在用的那个能不能用", async () => {
  haveDeepSeekKey();
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { speakmore, output } = harness({ daemon });
  assert.equal(await speakmore("polish", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-polish", params: { polish: "deepseek/deepseek-flash" } });
  assert.match(output.out, /能用：DeepSeek 的 deepseek-flash/);
});

test("polish check custom/<模型> --url --params：按填的额外参数查，不换掉正在用的", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { speakmore } = harness({ daemon });
  assert.equal(
    await speakmore(
      "polish",
      "check",
      "custom/gpt-5-mini",
      "--url",
      "https://router.example/v1",
      "--params",
      '{"max_completion_tokens":1024}',
    ),
    0,
  );
  assert.deepEqual(daemon.requests.at(-1), {
    cmd: "check-polish",
    params: {
      polish: "custom/gpt-5-mini",
      customUrl: "https://router.example/v1",
      customParams: '{"max_completion_tokens":1024}',
    },
  });
});

// ---------- speakmore dict：词典只是本机的一个文件，直接读写，不经过后台应用 ----------

const storedTerms = () => JSON.parse(readFileSync(paths.vocabularyFile, "utf8")).terms;

test("dict：空词典说一句怎么加；加几个词、新加的在前；不碰后台应用", async () => {
  const empty = harness();
  assert.equal(await empty.speakmore("dict"), 0);
  assert.match(empty.output.out, /词典是空的/);

  const add = harness();
  assert.equal(await add.speakmore("dict", "add", "Runzo", "  Claude   Code "), 0);
  assert.match(add.output.out, /已添加：Runzo\n已添加：Claude Code/);
  assert.deepEqual(storedTerms(), ["Claude Code", "Runzo"]);
  assert.deepEqual(add.daemon.calls, []);

  const list = harness();
  assert.equal(await list.speakmore("dict"), 0);
  assert.match(list.output.out, /2 个词/);
  assert.match(list.output.out, /Claude Code\n {2}Runzo/);

  const json = harness();
  await json.speakmore("dict", "--json");
  assert.deepEqual(JSON.parse(json.output.out), ["Claude Code", "Runzo"]);
});

test("dict add：重复的说清楚、其余照加，有没加上的就以 1 退出；不给词是用法错", async () => {
  await harness().speakmore("dict", "add", "GitHub");
  const { speakmore, output } = harness();
  assert.equal(await speakmore("dict", "add", "github", "埋点"), 1);
  assert.match(output.err, /github.*“GitHub”已在词典中/);
  assert.deepEqual(storedTerms(), ["埋点", "GitHub"]);
  assert.equal(await harness().speakmore("dict", "add"), 2);
});

test("dict remove：删几个词，说删了几个；有不在词典里的照实说、以 1 退出（同 add）", async () => {
  await harness().speakmore("dict", "add", "a", "b", "c");
  const removed = harness();
  assert.equal(await removed.speakmore("dict", "remove", "A", "c", "zzz", "yyy"), 1);
  assert.match(removed.output.out, /已删除 2 个词/);
  assert.match(removed.output.err, /词典中没有“zzz、yyy”/);
  assert.deepEqual(storedTerms(), ["b"]);
  const none = harness();
  assert.equal(await none.speakmore("dict", "remove", "zzz"), 1);
  assert.match(none.output.err, /词典中没有/);
});

test("dict import：一列的 CSV 或一行一个词，已有的、无效的跳过，说清各几个；文件读不出来照实说", async () => {
  await harness().speakmore("dict", "add", "Runzo");
  const file = join(paths.home, "words.csv");
  writeFileSync(file, `Runzo\nmultica,备注\n"Hello, World"\n${"x".repeat(60)}\n`);
  const { speakmore, output } = harness();
  assert.equal(await speakmore("dict", "import", file), 0);
  assert.match(output.out, /已导入 2 个词.*已在词典中 1 个.*文件内重复 0 个.*无效 1 个/);
  assert.deepEqual(storedTerms(), ["multica", "Hello, World", "Runzo"]);
  const missing = harness();
  assert.equal(await missing.speakmore("dict", "import", join(paths.home, "nope.csv")), 1);
  assert.match(missing.output.err, /nope\.csv/);
});

test("dict import：GBK 存的 CSV（中文 Windows 上 Excel 的默认）照样认；不是文本的文件不导", async () => {
  const gbk = join(paths.home, "gbk.csv");
  // "埋点,备注" 的 GBK
  writeFileSync(gbk, Buffer.from([0xc2, 0xf1, 0xb5, 0xe3, 0x2c, 0xb1, 0xb8, 0xd7, 0xa2]));
  const { speakmore } = harness();
  assert.equal(await speakmore("dict", "import", gbk), 0);
  assert.deepEqual(storedTerms(), ["埋点"]);
  const binary = join(paths.home, "bin.csv");
  writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
  const refused = harness();
  assert.equal(await refused.speakmore("dict", "import", binary), 1);
  assert.match(refused.output.err, /不是文本文件/);
  assert.deepEqual(storedTerms(), ["埋点"]);
});

test("dict：--json 只给看词典用，加、删、导入带上它是用法错", async () => {
  assert.equal(await harness().speakmore("dict", "add", "x", "--json"), 2);
});

test("dict：不认识的子命令是用法错，说怎么用", async () => {
  const { speakmore, output } = harness();
  assert.equal(await speakmore("dict", "frobnicate"), 2);
  assert.match(output.err, /speakmore dict/);
});
