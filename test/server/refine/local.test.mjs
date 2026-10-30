import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { createLocalRefiner } from "../../../src/server/refine/local.mjs";
import { findTask } from "../../../src/server/tasks/index.mjs";

/** 流水线不认任务的名字，测的时候拿语音输入这件事跑 */
const DICTATION = findTask("dictate").bind({});

const zh = createTranslator("zh-CN");

function recordingLog() {
  const events = [];
  const record = (level) => (event, fields) => events.push({ level, event, ...fields });
  return { events, info: record("info"), warn: record("warn"), error: record("error") };
}

const SAMPLES = new Float32Array(32_000);

/** 三样都是假的：解码回固定的 2 秒样本，转写回固定的原文，润色把原文加上前缀 */
function parts({ transcript = "原文", transcribeError = null, polishError = null } = {}) {
  const seen = { decoded: [], transcribed: [], polished: [] };
  return {
    seen,
    decode: async (audio, mimeType) => {
      seen.decoded.push({ audio, mimeType });
      return SAMPLES;
    },
    transcriber: {
      async transcribe(samples, options) {
        seen.transcribed.push(samples);
        seen.transcribeOptions = options;
        if (transcribeError) throw transcribeError;
        return { text: transcript };
      },
    },
    polisher: {
      warmUps: 0,
      async warmUp() {
        this.warmUps++;
      },
      async polish(text, options) {
        seen.polished.push({ text, options });
        if (polishError) throw polishError;
        return { text: `成品：${text}`, source: null };
      },
    },
  };
}

test("录音 → 统一格式 → 本地转写 → 润色；和原生链路一样的接口", async () => {
  const log = recordingLog();
  const { seen, decode, transcriber, polisher } = parts();
  const refiner = createLocalRefiner({ transcriber, polisher, log, decode });
  const audio = Buffer.from("webm");
  const signal = new AbortController().signal;
  assert.equal(
    (await refiner.refine(audio, { task: DICTATION, mimeType: "audio/webm", signal, audioId: "a1" })).text,
    "成品：原文",
  );
  assert.deepEqual(seen.decoded, [{ audio, mimeType: "audio/webm" }]);
  assert.equal(seen.transcribed[0], SAMPLES);
  assert.deepEqual(seen.polished, [
    { text: "原文", options: { task: DICTATION, signal, audioId: "a1", vocabulary: [] } },
  ]);
  await refiner.prepare({ task: DICTATION });
  await refiner.warmUp();
  assert.equal(polisher.warmUps, 1);
});

test("用户词典：转写和润色两跳都拿到同一份，各按各的收法用", async () => {
  const { seen, decode, transcriber, polisher } = parts();
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  const vocabulary = ["Runzo", "埋点"];
  await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm", audioId: "a9", vocabulary });
  assert.deepEqual(seen.transcribeOptions.vocabulary, vocabulary);
  assert.deepEqual(seen.polished[0].options.vocabulary, vocabulary);
});

test("用户词典：数据隐私模式不润色，词典只交给转写这一跳", async () => {
  const { seen, decode, transcriber } = parts();
  const refiner = createLocalRefiner({ transcriber, polisher: null, log: recordingLog(), decode });
  await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm", vocabulary: ["Runzo"] });
  assert.deepEqual(seen.transcribeOptions.vocabulary, ["Runzo"]);
});

test("每次记一条日志：两跳各花了多久、原文多长，不记原文和成品", async () => {
  const log = recordingLog();
  const { decode, transcriber, polisher } = parts({ transcript: "一二三" });
  await createLocalRefiner({ transcriber, polisher, log, decode }).refine(Buffer.from("x"), {
    task: DICTATION,
    mimeType: "audio/webm",
    audioId: "a2",
  });
  const entry = log.events.find((e) => e.event === "local_refined");
  assert.equal(entry.audio_id, "a2");
  assert.equal(entry.seconds, 2);
  assert.equal(entry.transcript_length, 3);
  for (const field of ["decode_ms", "transcribe_ms", "polish_ms"]) assert.ok(Number.isInteger(entry[field]), field);
  assert.ok(!JSON.stringify(log.events).includes("一二三"));
});

test("本地转写出错：报分好类的 ModelError，说是本地转写的事，原话进 detail", async () => {
  const { decode, transcriber, polisher } = parts({ transcribeError: new Error("转写进程退出了（code 3）") });
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  const error = await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(error.kind, "other");
  assert.match(zh.text(error.problem), /本机转文字失败/);
  assert.match(error.detail, /code 3/);
});

test("润色出的错原样往上报（已经是分好类的）", async () => {
  const failure = new ModelError({ kind: "key", problem: { key: "model.keyInvalid" }, detail: "401" });
  const { decode, transcriber, polisher } = parts({ polishError: failure });
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  assert.equal(
    await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm" }).catch((e) => e),
    failure,
  );
});

test("录音解不开：报 ModelError，不让解码的原始错误直接冒出去", async () => {
  const { transcriber, polisher } = parts();
  const decode = async () => {
    throw new Error("bad webm");
  };
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  const error = await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.match(error.detail, /bad webm/);
});

test("转写完时客户端已经断开：不再花润色的钱", async () => {
  const { seen, decode, transcriber, polisher } = parts();
  const abort = new AbortController();
  transcriber.transcribe = async () => {
    abort.abort();
    return { text: "原文" };
  };
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  await assert.rejects(
    refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm", signal: abort.signal }),
  );
  assert.equal(seen.polished.length, 0);
});

test("本机转写那一跳也记一笔账：是哪个模型、转了多久，不花钱；记不上不耽误这次听写", async () => {
  const { decode, transcriber, polisher } = parts();
  const calls = [];
  const refiner = createLocalRefiner({
    transcriber,
    polisher,
    log: recordingLog(),
    decode,
    model: "qwen3-asr-0.6b-q8",
    onCall: (call) => calls.push(call),
  });
  await refiner.refine(Buffer.from("webm"), { task: DICTATION, mimeType: "audio/webm", audioId: "a1" });
  assert.equal(calls.length, 1);
  const { latencyMs, createdAt, ...rest } = calls[0];
  assert.deepEqual(rest, {
    purpose: "dictation",
    audioId: "a1",
    provider: "local",
    model: "qwen3-asr-0.6b-q8",
    inputTokens: 0,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
  });
  assert.equal(typeof latencyMs, "number");
  assert.ok(Number.isFinite(Date.parse(createdAt)));

  const log = recordingLog();
  const broken = createLocalRefiner({
    transcriber,
    polisher,
    log,
    decode,
    model: "qwen3-asr-0.6b-q8",
    onCall: () => {
      throw new Error("库锁住了");
    },
  });
  assert.equal(
    (await broken.refine(Buffer.from("webm"), { task: DICTATION, mimeType: "audio/webm", audioId: "a2" })).text,
    "成品：原文",
  );
  assert.ok(log.events.some(({ event }) => event === "model_call_not_recorded"));
});

test("预览：只解录音、跑转写，不润色、不记账；整段取代，词典照样带上", async () => {
  const log = recordingLog();
  const { seen, decode, transcriber, polisher } = parts({ transcript: "听到这里" });
  const refiner = createLocalRefiner({ transcriber, polisher, log, decode });
  const vocabulary = ["Runzo"];
  const result = await refiner.preview(Buffer.from("webm"), { mimeType: "audio/webm", vocabulary });
  assert.deepEqual(result, { text: "听到这里" });
  assert.deepEqual(seen.decoded, [{ audio: Buffer.from("webm"), mimeType: "audio/webm" }]);
  assert.equal(seen.transcribed[0], SAMPLES);
  assert.deepEqual(seen.transcribeOptions.vocabulary, vocabulary);
  // 预览不是成品：不走润色，也不记一笔
  assert.deepEqual(seen.polished, []);
  assert.deepEqual(log.events, []);
});

test("预览出错照实抛出来（上层丢掉这一次，只记一条警告）；转写照样能继续", async () => {
  const { decode, transcriber } = parts({ transcribeError: new ModelError({ kind: "asr", detail: "坏了" }) });
  const refiner = createLocalRefiner({ transcriber, polisher: parts().polisher, log: recordingLog(), decode });
  await assert.rejects(() => refiner.preview(Buffer.from("webm"), { mimeType: "audio/webm" }), ModelError);
});

test("预览也按这一次的字形收尾：要繁体时条上不会先出现简体", async () => {
  const { decode, transcriber } = parts({ transcript: "设置" });
  const refiner = createLocalRefiner({ transcriber, polisher: parts().polisher, log: recordingLog(), decode });
  const hk = findTask("dictate").bind({ output_script: "traditional-hk" });
  assert.deepEqual(await refiner.preview(Buffer.from("webm"), { mimeType: "audio/webm", task: hk }), {
    text: "設置",
  });
  // 没给任务（或者要的是简体）就照转写原样交出
  assert.deepEqual(await refiner.preview(Buffer.from("webm"), { mimeType: "audio/webm" }), { text: "设置" });
});
