// 客户端的通信模块直接对着真的服务端模块跑（模型那一步换成假的），
// 这样两端对协议的理解有出入时，这里会先红。
import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { WebSocketServer } from "ws";
import { createTranslator, LocalizedError, msg } from "../../../src/i18n/index.mjs";
import { VoiceSocket } from "../../../src/renderer/bar/voice-socket.mjs";
import { startServer, WS_PATH } from "../../../src/server/server.mjs";

const zh = createTranslator("zh-CN");
const en = createTranslator("en");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

const silentLog = { info() {}, warn() {}, error() {} };
const webm = (payload) => new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), payload]);

let server;
let voice;
afterEach(async () => {
  voice?.close();
  await server?.close();
  server = undefined;
});

/** refine 给出成品的那段字（语音输入，source 是 null），或者整个成品 { text, source }；preview 是录音时那一眼 */
async function start(refine, { preview = null } = {}) {
  const refiner = {
    async refine(...args) {
      const result = await refine(...args);
      return typeof result === "string" ? { text: result, source: null } : result;
    },
  };
  if (preview) refiner.preview = preview;
  server = await startServer({ port: 0, refiner, log: silentLog });
  voice = new VoiceSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  return voice;
}

test("开始、按序发块、结束，拿到成品；服务端收到的是各块首尾相接", async () => {
  let received;
  const socket = await start(async (audio, { mimeType }) => {
    received = { text: audio.toString("latin1"), mimeType };
    return "成品";
  });
  await socket.begin("a1");
  // 第一块故意大一些：取字节数更慢，不排队的话第二块会抢到前面
  socket.sendChunk(webm("A".repeat(200_000)));
  socket.sendChunk(new Blob(["BBB"]));
  assert.deepEqual(await socket.finish({ durationSeconds: 4.2 }), { text: "成品", source: null });
  assert.equal(received.mimeType, "audio/webm");
  assert.ok(received.text.endsWith(`${"A".repeat(10)}BBB`));
});

test("同一条连接上连着做两次", async () => {
  const socket = await start(async (audio) => `${audio.length}`);
  for (const audioId of ["a1", "a2"]) {
    await socket.begin(audioId);
    socket.sendChunk(webm("xy"));
    assert.equal((await socket.finish({ durationSeconds: 1 })).text, "6");
  }
});

test("服务端整理失败时，finish 抛出带原因的错误", async () => {
  const socket = await start(async () => {
    throw new Error("上游 503");
  });
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  await assert.rejects(socket.finish({ durationSeconds: 1 }), said(/refine_failed.*上游 503/));
});

test("模型那边说得清的原因（problem）原样带过来，悬浮条按界面语言翻", async () => {
  const socket = await start(async () => {
    throw new LocalizedError(msg("model.unreachable", { provider: "Gemini" }));
  });
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const error = await socket.finish({ durationSeconds: 1 }).catch((thrown) => thrown);
  assert.equal(en.text(error.problem), "Can't reach Gemini. Check your network");
  assert.equal(zh.text(error.problem), "连不上 Gemini，检查网络后再试");
});

test("服务端不认的录音格式，在 finish 时报出来", async () => {
  const socket = await start(async () => "不该走到这里");
  await socket.begin("a1");
  socket.sendChunk(new Blob(["RIFF...."]));
  await assert.rejects(socket.finish({ durationSeconds: 1 }), said(/unsupported_audio/));
});

test("等成品超时", async () => {
  const socket = await start(() => new Promise(() => {}));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  await assert.rejects(socket.finish({ durationSeconds: 1, timeoutMs: 50 }), said(/没有等到成品/));
});

test("等成品时连接断了", async () => {
  const socket = await start(() => new Promise(() => {}));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const pending = socket.finish({ durationSeconds: 1 });
  const running = server;
  server = undefined; // 这里自己关，收尾时不要再关一次
  setTimeout(() => running.close(), 20);
  await assert.rejects(pending, said(/连接断了/));
});

test("服务端没开时，begin 直接报连不上", async () => {
  const socket = await start(async () => "");
  await server.close();
  server = undefined;
  await assert.rejects(socket.begin("a1"), said(/连不上服务端/));
});

test("放弃一次录音后，它迟到的成品不会算到下一次头上", async () => {
  const releases = [];
  const socket = await start((audio) => new Promise((resolve) => releases.push(() => resolve(`${audio.length}`))));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const first = socket.finish({ durationSeconds: 1, timeoutMs: 60 });
  await assert.rejects(first, said(/没有等到成品/));

  await socket.begin("a2");
  socket.sendChunk(webm("xyz"));
  const second = socket.finish({ durationSeconds: 1 });
  // 等两次整理都进到服务端，再先放行第一次（迟到的那个）
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  releases[1]();
  assert.equal((await second).text, "7");
});

test("语音翻译：开口时带上模式和目标语言；说着话换语言，服务端按最后一次的译；成品带着原文", async () => {
  let seen;
  const socket = await start(async (_audio, { task }) => {
    seen = { id: task.id, language: task.language };
    return { text: "Hello", source: "你好" };
  });
  await socket.begin("t1", {
    mode: "voice_translation",
    configMode: "translation",
    parameters: { output_language: "en" },
  });
  socket.sendChunk(webm("xy"));
  socket.configure({ configMode: "translation", parameters: { output_language: "ja" } });
  assert.deepEqual(await socket.finish({ durationSeconds: 1 }), { text: "Hello", source: "你好" });
  assert.deepEqual(seen, { id: "translate", language: "ja" });
});

test("升级：开口时是语音输入，说着话换成语音翻译", async () => {
  let seen;
  const socket = await start(async (_audio, { task }) => {
    seen = task.id;
    return "Hi";
  });
  await socket.begin("u1");
  socket.configure({ configMode: "translation", parameters: { output_language: "en" } });
  socket.sendChunk(webm("xy"));
  await socket.finish({ durationSeconds: 1 });
  assert.equal(seen, "translate");
  assert.throws(() => socket.configure({ configMode: "translation" }), /还没有开始录音/);
});

test("录音时的暂定文字：每块回一条，忙碌时只留最新的快照；成品照旧", async () => {
  const seen = [];
  let calls = 0;
  const socket = await start(async () => "成品", {
    async preview(audio) {
      calls += 1;
      const text = `第${calls}次:${audio.length}`;
      // 第一眼故意慢一点：后面两块这时都到了，只有最后那块该再听一遍
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 120));
      return { text };
    },
  });
  await socket.begin("a1", { onPartial: (text) => seen.push(text) });
  socket.sendChunk(webm("one"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.sendChunk(webm("two"));
  socket.sendChunk(webm("333"));
  // 等这两眼跑完再停口：停口之后跑完的那一眼不算数（服务端那边已经收掉这一次了）
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await socket.finish({ durationSeconds: 9 }), { text: "成品", source: null });
  // 第一条是第一块；第二条已经是三块首尾相接的了（中间那块来不及单独听）
  assert.deepEqual(seen, ["第1次:7", "第2次:21"]);
  assert.equal(calls, 2);
});

test("暂定文字只认这一次录音的，空的不要；收起来以后再来的也不要", async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => new Promise((resolve) => wss.close(resolve)));
  await once(wss, "listening");
  let peer = null;
  wss.on("connection", (connected) => {
    peer = connected;
  });
  const socket = new VoiceSocket(`ws://127.0.0.1:${wss.address().port}${WS_PATH}`);
  voice = socket;
  t.after(() => socket.close());
  const seen = [];
  await socket.begin("p1", { onPartial: (text) => seen.push(text) });
  while (peer === null) await new Promise((resolve) => setTimeout(resolve, 5));

  const say = (value) =>
    peer.send(JSON.stringify({ K: "audio_transcript_partial", V: value, T: "json", M: false, S: "done" }));
  say({ audio_id: "别的", text: "不是这一次的" });
  say({ audio_id: "p1", text: "第一次" });
  say({ audio_id: "p1", text: "" });
  say({ audio_id: "p1", text: "第二次" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, ["第一次", "第二次"]);

  // 收起来之后（取消了、换下一次了）再来的一概不算
  socket.abandon();
  say({ audio_id: "p1", text: "收起来以后的" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, ["第一次", "第二次"]);
});
