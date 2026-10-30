import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { openHistory } from "../../src/storage/history.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

const BIN = resolve(import.meta.dirname, "..", "..", "bin", "speakmore.mjs");

// 管道那头关掉时 Windows 报的不是 EPIPE 那一套，而且没有 head 和 bash 可用：只在 macOS 上查
const posixPipes = { skip: process.platform === "win32" && "Windows 上没有 bash 和 head" };

test("输出接到 head 这类只读开头就关掉的程序上：安静地结束，不甩一屏报错", posixPipes, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 历史要多到一次写不完：管道那头关掉时这边还在写
  const history = openHistory(resolvePaths({ SPEAKMORE_HOME: dir }).historyDb);
  for (let index = 0; index < 400; index++) {
    history.add({
      id: `id-${index}`,
      status: "completed",
      refinedText: "一句不短的话。".repeat(60),
      error: null,
      duration: 3,
      audioFile: null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    });
  }
  history.close();

  const result = spawnSync(
    "/bin/bash",
    ["-c", 'set -o pipefail; "$0" "$1" history -n 400 --json | head -c 10 >/dev/null', process.execPath, BIN],
    { encoding: "utf8", env: { ...process.env, SPEAKMORE_HOME: dir } },
  );
  assert.equal(result.stderr, "");
  assert.equal(result.status, 0);
});

test("说什么语言：设置里写了就用它；跟随系统时看终端的 LC_ALL、LC_MESSAGES、LANG；认不出来是英文", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { LC_ALL: _all, LC_MESSAGES: _messages, LANG: _lang, ...base } = process.env;
  const helpIn = (env) =>
    spawnSync(process.execPath, [BIN, "help"], {
      encoding: "utf8",
      env: { ...base, SPEAKMORE_HOME: dir, ...env },
    }).stdout.split("\n")[0];

  assert.equal(helpIn({ LANG: "zh_CN.UTF-8" }), "SpeakMore：按一下热键说话，整理好的文字贴进当前输入框。");
  assert.match(helpIn({ LANG: "en_US.UTF-8" }), /^SpeakMore: press a hotkey/);
  assert.match(helpIn({ LANG: "zh_CN.UTF-8", LC_ALL: "en_GB.UTF-8" }), /^SpeakMore: press a hotkey/);
  // 繁体（TW/HK）用繁体；日文、C：我们没有，用英文
  for (const LANG of ["zh_TW.UTF-8", "zh_HK.UTF-8"]) {
    assert.equal(helpIn({ LANG }), "SpeakMore：按一下熱鍵說話，整理好的文字貼進當前輸入框。", LANG);
  }
  for (const LANG of ["ja_JP.UTF-8", "C"]) assert.match(helpIn({ LANG }), /^SpeakMore: press/, LANG);
  // 什么都没设：macOS 上按英文；Windows 的终端一般不设这几个，按系统的显示语言（i18n 的测试查）
  if (process.platform !== "win32") assert.match(helpIn({}), /^SpeakMore: press/);

  // 设置里定了的话盖过终端的语言；环境变量 SPEAKMORE_LANGUAGE 又盖过设置
  writeFileSync(resolvePaths({ SPEAKMORE_HOME: dir }).settingsFile, JSON.stringify({ language: "zh-CN" }));
  assert.match(helpIn({ LANG: "en_US.UTF-8" }), /^SpeakMore：/);
  assert.match(helpIn({ LANG: "zh_CN.UTF-8", SPEAKMORE_LANGUAGE: "en" }), /^SpeakMore: press/);
  // 设置文件坏了：先按终端的语言说，坏在哪由读设置的命令报
  writeFileSync(resolvePaths({ SPEAKMORE_HOME: dir }).settingsFile, "{ 坏了");
  assert.match(helpIn({ LANG: "zh_CN.UTF-8" }), /^SpeakMore：/);
});

test("Node 太旧：按终端的语言说要哪个版本；旧到连文案那一层都加载不了时用英文说，不甩调用栈", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  /** 装成某个版本的 Node；ancient 时再拿掉 16.9 以前没有的写法 */
  const runAs = (version, { ancient = false, LANG = "zh_CN.UTF-8" } = {}) => {
    const preload = join(dir, `${version}.mjs`);
    writeFileSync(
      preload,
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });\n` +
        (ancient ? "delete String.prototype.replaceAll;\ndelete Object.hasOwn;\n" : ""),
    );
    const { LC_ALL: _all, LC_MESSAGES: _messages, ...base } = process.env;
    // --import 认的是网址：Windows 上的盘符路径要先换成 file://
    return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, BIN, "help"], {
      encoding: "utf8",
      env: { ...base, SPEAKMORE_HOME: dir, LANG },
    });
  };

  const zhTerminal = runAs("20.18.1");
  assert.equal(zhTerminal.status, 1);
  assert.equal(zhTerminal.stderr, "SpeakMore 需要 Node 22.13 或更新的版本（23 系列要 23.4 以上），现在是 20.18.1。\n");

  const ancient = runAs("14.21.3", { ancient: true });
  assert.equal(ancient.status, 1);
  assert.equal(
    ancient.stderr,
    "SpeakMore needs Node 22.13 or newer (23.4 or newer on the 23 line); this is 14.21.3.\n",
  );
});

test("0.13 以前的设置文件（热键存的是旧 id）：直接跑命令，第一次读设置之前就换好，听写还是原来那个键", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settingsFile = resolvePaths({ SPEAKMORE_HOME: dir }).settingsFile;
  writeFileSync(settingsFile, '{"hotkey":"right_control","theme":"indigo"}\n');
  // 终端的 LC_ALL、LC_MESSAGES 会盖过下面指定的 LANG，拿掉它们，免得输出换成别的语言
  const {
    SPEAKMORE_HOTKEY: _old,
    SPEAKMORE_HOTKEY_DICTATE: _new,
    LC_ALL: _all,
    LC_MESSAGES: _messages,
    ...base
  } = process.env;
  const result = spawnSync(process.execPath, [BIN, "config"], {
    encoding: "utf8",
    env: { ...base, SPEAKMORE_HOME: dir, LANG: "zh_CN.UTF-8" },
  });
  assert.equal(result.status, 0, result.stderr);
  // 键帽 Mac 上写右⌃，Windows 上写右 Ctrl
  assert.match(result.stdout, /hotkey\.dictate\s+\["ControlRight"\]\s+右(⌃| Ctrl) · 存在设置文件里/);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), {
    theme: "indigo",
    "hotkey.dictate": ["ControlRight"],
  });
  // 换算记进日志：升级后命令行往往比 App 先跑，App 那边就看不到旧设置了
  const logFile = resolvePaths({ SPEAKMORE_HOME: dir }).logFile;
  const logged = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    logged.map(({ event, from, to, value, stored }) => ({ event, from, to, value, stored })),
    [
      {
        event: "settings_migrated",
        from: "hotkey",
        to: "hotkey.dictate",
        value: "right_control",
        stored: ["ControlRight"],
      },
    ],
  );
  // 只问帮助、版本时不动文件
  writeFileSync(settingsFile, '{"hotkey":"fn"}\n');
  spawnSync(process.execPath, [BIN, "--version"], { env: { ...base, SPEAKMORE_HOME: dir } });
  assert.equal(readFileSync(settingsFile, "utf8"), '{"hotkey":"fn"}\n');
});
