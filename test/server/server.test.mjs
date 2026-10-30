import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import { LocalizedError, msg } from "../../src/i18n/index.mjs";
import { startServer, WS_PATH } from "../../src/server/server.mjs";

/** 任务收好的成品：语音输入只有一段字 */
const done = (text) => ({ text, source: null });
const ogg = (payload) => Buffer.concat([Buffer.from("OggS"), Buffer.from(payload)]);
const silentLog = { info() {}, warn() {}, error() {} };

let server;
const sockets = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.close();
  server = undefined;
});

async function start(refiner, options = {}) {
  server = await startServer({ port: 0, refiner, log: silentLog, ...options });
  return server.port;
}

/** 连上服务端，返回一个能"发一条、等一条"的小客户端 */
async function connect(port, { path = WS_PATH, origin } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
  sockets.push(socket);
  const inbox = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  await once(socket, "open");
  return {
    sendJson: (value) => socket.send(JSON.stringify(value)),
    sendBinary: (buffer) => socket.send(buffer),
    next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiters.push(resolve))),
  };
}

async function sendChunk(client, audioId, index, buffer) {
  client.sendJson({ type: "set_audio_chunk_info", audio_id: audioId, index, size: buffer.length, duration: 3 });
  client.sendBinary(buffer);
  return client.next();
}

test("一次完整的听写：消息顺序和成品字段与抓包一致；整理时带上是哪一次录音，记账要用", async () => {
  const received = [];
  const port = await start({
    async refine(audio, { task, mimeType, audioId }) {
      received.push({ audio, task: task.id, mimeType, audioId });
      return done("整理好的文字");
    },
  });
  const client = await connect(port, { path: `${WS_PATH}?v=clone_0.1.0&m=0` });
  const chunks = [ogg("first-chunk"), ogg("second")];

  client.sendJson({ type: "start_audio", audio_id: "a1", audio_chunk_time: 3, mode: "voice_transcript" });
  const started = await client.next();
  assert.equal(started.K, "audio_session_started");
  assert.equal(started.V.audio_id, "a1");
  assert.equal(typeof started.V.start_time, "number");

  for (const [i, chunk] of chunks.entries()) {
    const ack = await sendChunk(client, "a1", i + 1, chunk);
    assert.equal(ack.K, "received_audio_chunk_count");
    assert.equal(ack.V.index, i + 1);
    assert.equal(ack.V.size, chunk.length);
    assert.equal(typeof ack.V.server_t, "number");
  }

  client.sendJson({ type: "end_audio", audio_id: "a1", total_duration: 5.1 });
  const ending = await client.next();
  assert.deepEqual(ending, {
    K: "audio_session_ending",
    V: { audio_id: "a1", total_chunks: 2, completed_chunks: 2, failed_chunks: 0 },
    T: "json",
    M: false,
    S: "done",
  });
  const completed = await client.next();
  assert.deepEqual(completed.V, {
    audio_id: "a1",
    refined_text: "整理好的文字",
    source_text: null,
    status: true,
    run_index: 1,
    web_metadata: null,
    delivery: null,
    action: null,
    user_prompt: null,
    external_action: null,
  });
  assert.equal(completed.K, "audio_processing_completed");

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    audio: Buffer.concat(chunks),
    task: "dictate",
    mimeType: "audio/ogg",
    audioId: "a1",
  });
});

test("同一条连接上可以接着做第二次听写", async () => {
  const port = await start({ refine: async (audio) => done(`共 ${audio.length} 字节`) });
  const client = await connect(port);
  for (const audioId of ["a1", "a2"]) {
    client.sendJson({ type: "start_audio", audio_id: audioId });
    await client.next();
    await sendChunk(client, audioId, 1, ogg(audioId));
    client.sendJson({ type: "end_audio", audio_id: audioId });
    await client.next();
    const completed = await client.next();
    assert.equal(completed.V.audio_id, audioId);
    assert.equal(completed.V.refined_text, "共 6 字节");
  }
});

test("整理失败时回 audio_processing_error，连接不断", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      if (calls === 1) throw new Error("上游 503");
      return done("第二次成功");
    },
  });
  const client = await connect(port);

  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  await sendChunk(client, "a1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  await client.next();
  const failed = await client.next();
  assert.equal(failed.K, "audio_processing_error");
  assert.equal(failed.V.audio_id, "a1");
  assert.equal(failed.V.code, "refine_failed");
  assert.match(failed.V.detail, /上游 503/);
  // 说不清的错误不带 problem，悬浮条就用 detail
  assert.equal(failed.V.problem, undefined);

  client.sendJson({ type: "start_audio", audio_id: "a2" });
  await client.next();
  await sendChunk(client, "a2", 1, ogg("y"));
  client.sendJson({ type: "end_audio", audio_id: "a2" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "第二次成功");
});

test("一块音频都没有就结束：不去调模型，回 no_audio", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      return done("不该走到这里");
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  const failed = await client.next();
  assert.equal(failed.K, "audio_processing_error");
  assert.equal(failed.V.code, "no_audio");
  assert.deepEqual(failed.V.problem, msg("voice.noAudio"));
  assert.equal(calls, 0);
});

test("整理失败时带上给人看的那句话（problem），由悬浮条按界面语言翻；原话照旧在 detail 里", async () => {
  const problem = msg("model.unreachable", { provider: "Gemini" });
  const port = await start({
    async refine() {
      throw new LocalizedError(problem);
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  await sendChunk(client, "a1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  await client.next();
  const failed = await client.next();
  assert.equal(failed.V.code, "refine_failed");
  assert.deepEqual(failed.V.problem, problem);
  assert.equal(failed.V.detail, "Can't reach Gemini. Check your network");
});

test("顺序不对的消息回 error，并说明原因", async () => {
  const port = await start({ refine: async () => done("") });
  const client = await connect(port);

  client.sendBinary(ogg("x"));
  assert.deepEqual((await client.next()).V.code, "no_session");

  client.sendJson({ type: "end_audio", audio_id: "a1" });
  assert.equal((await client.next()).V.code, "no_session");

  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  client.sendJson({ type: "set_audio_chunk_info", audio_id: "别的", index: 1, size: 5 });
  const mismatch = await client.next();
  assert.equal(mismatch.K, "error");
  assert.equal(mismatch.V.code, "audio_id_mismatch");

  client.sendJson({ type: "不存在的类型" });
  assert.equal((await client.next()).V.code, "unknown_type");
});

test("网页发起的连接和别的路径都拒绝", async () => {
  const port = await start({ refine: async () => done("") });
  for (const options of [{ origin: "https://evil.example" }, { path: "/other" }]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? WS_PATH}`, {
      origin: options.origin,
    });
    sockets.push(socket);
    const [error] = await once(socket, "error");
    assert.match(error.message, /Unexpected server response: 4\d\d/);
  }
  // Electron 渲染进程从本地文件发起连接时，Origin 是 file://
  await connect(port, { origin: "file://" });
});

test("一开始录音就让模型那边先备好（Gemini 建提示词缓存），不等它；备不好不影响这次听写", async () => {
  let prepared = 0;
  const port = await start({
    async prepare() {
      prepared++;
      throw new Error("建缓存失败");
    },
    refine: async () => done("整理好的文字"),
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "p1" });
  assert.equal((await client.next()).K, "audio_session_started");
  assert.equal(prepared, 1);
  await sendChunk(client, "p1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "p1" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "整理好的文字");
});

test("整理的那一步不做准备（没有 prepare）也照常听写", async () => {
  const port = await start({ refine: async () => done("文字") });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "p2" });
  assert.equal((await client.next()).K, "audio_session_started");
});

test("用户词典：开口时和整理时各读一次，交给 prepare 和 refine", async () => {
  const seen = [];
  const port = await start(
    {
      async prepare(options) {
        seen.push(["prepare", options.vocabulary]);
      },
      async refine(_audio, options) {
        seen.push(["refine", options.vocabulary]);
        return done("Runzo");
      },
    },
    { vocabulary: () => ["Runzo", "埋点"] },
  );
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "v1" });
  await client.next();
  await sendChunk(client, "v1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "v1" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "Runzo");
  assert.deepEqual(seen, [
    ["prepare", ["Runzo", "埋点"]],
    ["refine", ["Runzo", "埋点"]],
  ]);
});

test("用户词典读不出来（文件坏了）：记一条警告，这次照常听写、不带词典", async () => {
  const warnings = [];
  const seen = [];
  server = await startServer({
    port: 0,
    refiner: {
      async refine(_audio, options) {
        seen.push(options.vocabulary);
        return done("文字");
      },
    },
    log: { ...silentLog, warn: (event, fields) => warnings.push({ event, ...fields }) },
    vocabulary: () => {
      throw new LocalizedError(msg("vocabulary.malformed", { file: "/x/vocabulary.json" }));
    },
  });
  const client = await connect(server.port);
  client.sendJson({ type: "start_audio", audio_id: "v2" });
  await client.next();
  await sendChunk(client, "v2", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "v2" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "文字");
  assert.deepEqual(seen, [[]]);
  assert.ok(warnings.some(({ event, audio_id }) => event === "vocabulary_unavailable" && audio_id === "v2"));
});

// ---------- 模式：start_audio 写内部名，要参数的紧跟 set_mode_config（照原版，docs/04-voice-pipeline.md） ----------

test("开口时按模式找任务：准备和整理拿到的是同一个定好的任务；没写模式的当语音输入", async () => {
  const seen = [];
  const port = await start({
    async prepare({ task }) {
      seen.push(["prepare", task]);
    },
    async refine(_audio, { task }) {
      seen.push(["refine", task]);
      return done("好");
    },
  });
  const client = await connect(port);
  for (const [audioId, mode] of [
    ["m1", "voice_transcript"],
    ["m2", undefined],
  ]) {
    client.sendJson({ type: "start_audio", audio_id: audioId, ...(mode ? { mode } : {}) });
    await client.next();
    await sendChunk(client, audioId, 1, ogg("x"));
    client.sendJson({ type: "end_audio", audio_id: audioId });
    await client.next();
    assert.equal((await client.next()).V.refined_text, "好");
  }
  assert.deepEqual(
    seen.map(([step, task]) => [step, task.id]),
    [
      ["prepare", "dictate"],
      ["refine", "dictate"],
      ["prepare", "dictate"],
      ["refine", "dictate"],
    ],
  );
  assert.equal(seen[0][1], seen[1][1]);
});

test("不认识的模式：回协议错误，不调模型", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      return done("不该走到这里");
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "x1", mode: "voice_command" });
  const unknown = await client.next();
  assert.equal(unknown.K, "error");
  assert.equal(unknown.V.code, "unknown_mode");

  client.sendJson({ type: "start_audio", audio_id: "x2", mode: "voice_transcript" });
  await client.next();
  client.sendJson({ type: "set_mode_config", audio_id: "x2", mode: "ask_anything", parameters: {} });
  assert.equal((await client.next()).V.code, "unknown_mode");
  assert.equal(calls, 0);
});

test("说着话再发 set_mode_config：语音输入升级成翻译、换目标语言，都以最后一条为准", async () => {
  const seen = [];
  const port = await start({
    async prepare({ task }) {
      seen.push(["prepare", task.id, task.language ?? null]);
    },
    async refine(_audio, { task }) {
      seen.push(["refine", task.id, task.language]);
      return { text: "こんにちは", source: "你好" };
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "u1", mode: "voice_transcript" });
  await client.next();
  for (const language of ["en", "ja"]) {
    client.sendJson({
      type: "set_mode_config",
      audio_id: "u1",
      mode: "translation",
      parameters: { output_language: language },
    });
  }
  await sendChunk(client, "u1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "u1" });
  await client.next();
  assert.equal((await client.next()).V.source_text, "你好");
  assert.deepEqual(seen, [
    ["prepare", "dictate", null],
    ["prepare", "translate", "en"],
    ["prepare", "translate", "ja"],
    ["refine", "translate", "ja"],
  ]);
});

test("语音翻译：等 set_mode_config 给了目标语言才定下来；词典照样带；成品带着原文", async () => {
  const seen = [];
  let vocabularyReads = 0;
  const port = await start(
    {
      async prepare({ task, vocabulary }) {
        seen.push(["prepare", task.id, task.language, vocabulary]);
      },
      async refine(_audio, { task, vocabulary }) {
        seen.push(["refine", task.id, task.language, vocabulary]);
        return { text: "Let's meet tomorrow", source: "我们明天见" };
      },
    },
    {
      vocabulary: () => {
        vocabularyReads += 1;
        return ["Runzo"];
      },
    },
  );
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "t1", mode: "voice_translation" });
  await client.next();
  client.sendJson({
    type: "set_mode_config",
    audio_id: "t1",
    mode: "translation",
    parameters: { output_language: "en" },
  });
  await sendChunk(client, "t1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "t1" });
  await client.next();
  const completed = await client.next();
  assert.equal(completed.V.refined_text, "Let's meet tomorrow");
  assert.equal(completed.V.source_text, "我们明天见");
  assert.deepEqual(seen, [
    ["prepare", "translate", "en", ["Runzo"]],
    ["refine", "translate", "en", ["Runzo"]],
  ]);
  assert.equal(vocabularyReads, 2);
});

test("语音翻译没等到目标语言、写了不认识的语言：说清楚，不拿默认的语言硬译", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      return done("不该走到这里");
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "t2", mode: "voice_translation" });
  await client.next();
  await sendChunk(client, "t2", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "t2" });
  const missing = await client.next();
  assert.equal(missing.K, "audio_processing_error");
  assert.equal(missing.V.code, "mode_config_missing");

  client.sendJson({ type: "start_audio", audio_id: "t3", mode: "voice_translation" });
  await client.next();
  client.sendJson({
    type: "set_mode_config",
    audio_id: "t3",
    mode: "translation",
    parameters: { output_language: "xx" },
  });
  const invalid = await client.next();
  assert.equal(invalid.K, "error");
  assert.equal(invalid.V.code, "invalid_parameters");
  assert.equal(calls, 0);
});

/** 收到指定的那一种消息为止（中间的进度消息跳过）；等不到就是这次没发，报错 */
async function until(client, kind, limit = 10) {
  for (let i = 0; i < limit; i += 1) {
    const message = await client.next();
    if (message.K === kind) return message;
  }
  throw new Error(`没等到 ${kind}`);
}

test("本机识别：每收一块听一眼，回的整条文字带序号；正式整理用整段录音", async () => {
  const previews = [];
  const refined = [];
  const port = await start({
    async preview(audio, { audioId }) {
      previews.push({ audio, audioId });
      return { text: `听到${previews.length}` };
    },
    async refine(audio) {
      refined.push(audio);
      return done("成品");
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "p1", audio_chunk_time: 3, mode: "voice_transcript" });
  await until(client, "audio_session_started");

  const first = ogg("one");
  await sendChunk(client, "p1", 1, first);
  const firstPartial = await until(client, "audio_transcript_partial");
  assert.deepEqual(firstPartial.V, { audio_id: "p1", sequence: 1, text: "听到1" });
  // 传进去的是到现在为止累积的录音，不是刚到的这一块
  assert.deepEqual(previews[0].audio, first);
  assert.equal(previews[0].audioId, "p1");

  const second = ogg("two");
  await sendChunk(client, "p1", 2, second);
  const secondPartial = await until(client, "audio_transcript_partial");
  assert.deepEqual(secondPartial.V, { audio_id: "p1", sequence: 2, text: "听到2" });
  assert.deepEqual(previews[1].audio, Buffer.concat([first, second]));

  client.sendJson({ type: "end_audio", audio_id: "p1", total_duration: 5 });
  const completed = await until(client, "audio_processing_completed");
  assert.equal(completed.V.refined_text, "成品");
  assert.deepEqual(refined, [Buffer.concat([first, second])]);
});

test("预览出错：只说一次，正式整理照常出成品", async () => {
  const warnings = [];
  const log = {
    info() {},
    warn: (event) => warnings.push(event),
    error() {},
  };
  const port = await start(
    {
      async preview() {
        throw new Error("解不开");
      },
      async refine() {
        return done("成品");
      },
    },
    { log },
  );
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "e1", mode: "voice_transcript" });
  await until(client, "audio_session_started");
  await sendChunk(client, "e1", 1, ogg("one"));
  await sendChunk(client, "e1", 2, ogg("two"));
  client.sendJson({ type: "end_audio", audio_id: "e1", total_duration: 5 });
  const completed = await until(client, "audio_processing_completed");
  assert.equal(completed.V.refined_text, "成品");
  assert.deepEqual(warnings, ["preview_failed"]);
});

test("认识不了预览的路线（原生、云端）：不发 partial，消息和原来一模一样", async () => {
  const port = await start({
    async refine() {
      return done("成品");
    },
  });
  const client = await connect(port);
  const kinds = [];
  const next = client.next;
  client.next = async () => {
    const message = await next();
    kinds.push(message.K);
    return message;
  };
  client.sendJson({ type: "start_audio", audio_id: "n1", mode: "voice_transcript" });
  await client.next();
  await sendChunk(client, "n1", 1, ogg("one"));
  client.sendJson({ type: "end_audio", audio_id: "n1", total_duration: 5 });
  await until(client, "audio_processing_completed");
  assert.deepEqual(kinds, [
    "audio_session_started",
    "received_audio_chunk_count",
    "audio_session_ending",
    "audio_processing_completed",
  ]);
});

test("语音翻译不预览：本机能预览也不发（译的是别的话，听了也只是听写）", async () => {
  const previews = [];
  const port = await start({
    async preview() {
      previews.push(1);
      return { text: "不该出现" };
    },
    async refine() {
      return done("译文");
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "tr1", mode: "voice_translation" });
  await until(client, "audio_session_started");
  client.sendJson({
    type: "set_mode_config",
    audio_id: "tr1",
    mode: "translation",
    parameters: { output_language: "ja" },
  });
  await sendChunk(client, "tr1", 1, ogg("one"));
  client.sendJson({ type: "end_audio", audio_id: "tr1", total_duration: 5 });
  await until(client, "audio_processing_completed");
  assert.deepEqual(previews, []);
});

test("说完了才跑完的那一眼：不发，成品照常（迟到的字不能盖到已经结束的录音上）", async () => {
  let release;
  const port = await start({
    preview: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    async refine() {
      return done("成品");
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "s1", mode: "voice_transcript" });
  await until(client, "audio_session_started");
  await sendChunk(client, "s1", 1, ogg("one"));
  client.sendJson({ type: "end_audio", audio_id: "s1", total_duration: 5 });
  const ending = await client.next();
  assert.equal(ending.K, "audio_session_ending");
  // 正式整理排在预览后面：这一眼跑完，成品才出来；这一眼的结果不往回发
  release({ text: "迟到的字" });
  const completed = await client.next();
  assert.equal(completed.K, "audio_processing_completed");
  assert.equal(completed.V.refined_text, "成品");
});

test("暂定文字按这一次的字形来：要繁体时回来的也是繁体（和成品同一处收尾）", async () => {
  const seen = [];
  const port = await start({
    async preview(_audio, { task }) {
      seen.push(task.id);
      return { text: task.transcribe.finish("设置").text };
    },
    async refine(_audio, { task }) {
      return { text: task.transcribe.finish("设置").text, source: null };
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "hk1", mode: "voice_transcript" });
  await until(client, "audio_session_started");
  client.sendJson({
    type: "set_mode_config",
    audio_id: "hk1",
    mode: "transcript",
    parameters: { output_script: "traditional-hk" },
  });
  await sendChunk(client, "hk1", 1, ogg("one"));
  const partial = await until(client, "audio_transcript_partial");
  assert.equal(partial.V.text, "設置");
  assert.deepEqual(seen, ["dictate"]);
  client.sendJson({ type: "end_audio", audio_id: "hk1", total_duration: 5 });
  const completed = await until(client, "audio_processing_completed");
  assert.equal(completed.V.refined_text, "設置");
});
