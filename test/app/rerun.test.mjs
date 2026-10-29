import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createRerun } from "../../src/app/rerun.mjs";
import { createTranslator, LocalizedError } from "../../src/i18n/index.mjs";

const zh = createTranslator("zh-CN");

let dir;
let recordingsDir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "speakmore-rerun-"));
  recordingsDir = join(dir, "Recordings");
  mkdirSync(recordingsDir, { recursive: true });
  writeFileSync(join(recordingsDir, "a1.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (overrides = {}) => ({
  id: "a1",
  kind: "dictate",
  status: "completed",
  refinedText: "旧的成品",
  sourceText: null,
  outputLanguage: null,
  error: null,
  duration: 7.2,
  audioFile: "a1.webm",
  createdAt: "2026-10-29T10:00:00.000Z",
  usage: null,
  ...overrides,
});

/**
 * 一套假的依赖：历史里一条、本机只装了 qwen3、只填了 gemini 和 deepseek 的 key。
 * refineOnce 记下每一次的选项，回一句固定的成品
 */
function setup({ rows = [row()], installed = ["qwen3-asr-0.6b-q8"], keys = ["gemini", "deepseek"] } = {}) {
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ outputScript: "traditional-hk" }));
  const added = [];
  const calls = [];
  let changes = 0;
  const rerun = createRerun({
    history: {
      get: (id) => rows.find((entry) => entry.id === id) ?? null,
      add: (entry) => added.push(entry),
    },
    keys: { keyOf: (id) => (keys.includes(id) ? { apiKey: `key-${id}`, source: "stored" } : null) },
    service: {
      refineOnce: async (options) => {
        calls.push(options);
        return { text: "新的成品", source: "新的原文" };
      },
    },
    localModels: { isInstalled: (id) => installed.includes(id) },
    settingsFile,
    env: {},
    recordingsDir,
    vocabulary: () => ["Claude Code"],
    changed: () => {
      changes++;
    },
    log: { info: () => {}, warn: () => {} },
    uuid: () => "new-id",
    now: () => new Date("2026-10-29T12:00:00.000Z"),
  });
  return { rerun, added, calls, changes: () => changes };
}

test("选项：三种模式各自支不支持、现在用的什么、哪些模型能选、缺什么", () => {
  const { rerun } = setup();
  const options = rerun.options("a1");
  assert.equal(options.kind, "dictate");
  assert.equal(options.hasAudio, true);
  assert.equal(options.native.supported, true);
  assert.equal(options.native.current, "gemini/gemini-3.6-flash");
  const gemini = options.native.models.find(({ value }) => value === "gemini/gemini-3.6-flash");
  const openai = options.native.models.find(({ value }) => value.startsWith("openai/"));
  assert.deepEqual([gemini.ready, gemini.problem], [true, null]);
  assert.equal(openai.ready, false);
  assert.equal(zh.text(openai.problem), "要先配置 OpenAI 的 key，才能选这个模型");

  assert.equal(options.private.supported, true);
  const installed = options.private.models.find(({ value }) => value === "qwen3-asr-0.6b-q8");
  const missing = options.private.models.find(({ value }) => value === "sensevoice-small-q8");
  assert.equal(installed.ready, true);
  assert.equal(missing.ready, false);
  assert.match(zh.text(missing.problem), /SenseVoice/);

  assert.deepEqual(options.local.current, {
    transcriber: "qwen3-asr-0.6b-q8",
    polish: "deepseek/deepseek-flash",
  });
  const polish = options.local.polishes.find(({ value }) => value === "deepseek/deepseek-flash");
  assert.equal(polish.ready, true);
});

test("翻译的记录：离线模式做不了（任务没有那一步），直出和混合可以", () => {
  const { rerun } = setup({
    rows: [row({ kind: "translate", sourceText: "原文", outputLanguage: "en", refinedText: "old" })],
  });
  const options = rerun.options("a1");
  assert.equal(options.native.supported, true);
  assert.equal(options.local.supported, true);
  assert.equal(options.private.supported, false);
});

test("重跑（离线）：用本机模型再跑一次，结果存成一条新记录，录音指回原文件", async () => {
  const { rerun, added, calls, changes } = setup();
  const result = await rerun.run({ id: "a1", target: { mode: "private", transcriber: "qwen3-asr-0.6b-q8" } });
  assert.deepEqual(result, { ok: true, id: "new-id", text: "新的成品" });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.deepEqual(call.route, { mode: "private", transcriber: "qwen3-asr-0.6b-q8" });
  assert.equal(call.audioId, "new-id");
  assert.equal(call.mimeType, "audio/webm");
  assert.deepEqual(call.vocabulary, ["Claude Code"]);
  assert.deepEqual(call.keys, {});
  // 设置里选了繁体：成品字形跟着现在的设置走
  assert.equal(call.task.transcribe.finish("我们后天开会。").text, "我們後天開會。");

  assert.deepEqual(added, [
    {
      id: "new-id",
      kind: "dictate",
      status: "completed",
      refinedText: "新的成品",
      sourceText: null,
      outputLanguage: null,
      error: null,
      duration: 7.2,
      audioFile: "a1.webm",
      createdAt: "2026-10-29T12:00:00.000Z",
    },
  ]);
  assert.equal(changes(), 1);
});

test("重跑（直出）：带上那家的 key；翻译的记录把原来的目标语言交给任务", async () => {
  const { rerun, added, calls } = setup({
    rows: [
      row({
        kind: "translate",
        sourceText: "我们发布吧",
        outputLanguage: "en",
        refinedText: "Let's ship it.",
      }),
    ],
  });
  const result = await rerun.run({ id: "a1", target: { mode: "native", model: "gemini/gemini-3.6-flash" } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].keys, { gemini: "key-gemini" });
  // 任务收到的是这条记录原来的目标语言
  assert.match(calls[0].task.native.system([]), /English/);
  assert.deepEqual(added[0].sourceText, "新的原文");
  assert.equal(added[0].outputLanguage, "en");
});

test("缺 key、模型没装、没有录音、录音文件不在、记录不在：都说清楚，不硬跑", async () => {
  const noKey = setup({ keys: [] });
  assert.deepEqual(noKey.calls.length, 0);
  assert.equal(
    zh.text(
      (await noKey.rerun.run({ id: "a1", target: { mode: "native", model: "gemini/gemini-3.6-flash" } })).problem,
    ),
    "要先配置 Gemini 的 key，才能选这个模型",
  );

  const notInstalled = setup({ installed: [] });
  assert.equal(
    zh.text(
      (await notInstalled.rerun.run({ id: "a1", target: { mode: "private", transcriber: "qwen3-asr-0.6b-q8" } }))
        .problem,
    ),
    "本机没有装 Qwen3-ASR 0.6B (Q8_0)，先下载再重跑",
  );

  const noRecording = setup({ rows: [row({ audioFile: null })] });
  assert.equal(
    zh.text(
      (await noRecording.rerun.run({ id: "a1", target: { mode: "private", transcriber: "qwen3-asr-0.6b-q8" } }))
        .problem,
    ),
    "这条记录没有录音，不能重跑",
  );

  rmSync(join(recordingsDir, "a1.webm"));
  const gone = setup();
  assert.equal(
    zh.text(
      (await gone.rerun.run({ id: "a1", target: { mode: "private", transcriber: "qwen3-asr-0.6b-q8" } })).problem,
    ),
    "录音文件不在录音目录里了，不能重跑",
  );

  const unknown = setup();
  assert.equal(
    zh.text(
      (await unknown.rerun.run({ id: "nope", target: { mode: "private", transcriber: "qwen3-asr-0.6b-q8" } })).problem,
    ),
    "找不到这条记录",
  );
  assert.throws(() => unknown.rerun.options("nope"), LocalizedError);
});

test("翻译的记录选了离线模式：说这种模式做不了，不调模型", async () => {
  const { rerun, calls } = setup({
    rows: [row({ kind: "translate", sourceText: "原文", outputLanguage: "en" })],
  });
  const result = await rerun.run({ id: "a1", target: { mode: "private", transcriber: "qwen3-asr-0.6b-q8" } });
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /离线方式不支持/);
  assert.equal(calls.length, 0);
});

test("不认识的目标：拒绝，不猜", async () => {
  const { rerun, calls } = setup();
  for (const target of [{ mode: "turbo" }, { mode: "private", transcriber: "没这个模型" }, null]) {
    const result = await rerun.run({ id: "a1", target });
    assert.equal(result.ok, false);
    assert.equal(zh.text(result.problem), "重跑的模型没选对，重新选一个");
  }
  assert.equal(calls.length, 0);
});
