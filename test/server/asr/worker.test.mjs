import assert from "node:assert/strict";
import { test } from "node:test";
import { serveTranscriber } from "../../../src/server/asr/worker.mjs";

/** 假的通道：把 worker 发出去的消息收起来，测试里手动递消息进去 */
function fakeChannel() {
  const handlers = [];
  const sent = [];
  let exited = null;
  return {
    sent,
    on(event, handler) {
      if (event === "message") handlers.push(handler);
    },
    send: (message) => sent.push(message),
    exit: (code) => {
      exited = code;
    },
    deliver: (message) => {
      for (const handler of handlers) handler(message);
    },
    get exited() {
      return exited;
    },
  };
}

/** 等到 sent 里出现满足条件的消息（队列里每步都是 await，要让出几轮） */
async function until(channel, predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    const found = channel.sent.find(predicate);
    if (found) return found;
    await new Promise((done) => setImmediate(done));
  }
  throw new Error(`等不到${label}：${JSON.stringify(channel.sent)}`);
}

/** 一个可以卡住、再放行的转写器：看得到同时有几个在跑 */
function gatedTranscriber() {
  const gates = [];
  const state = { running: 0, peak: 0, order: [] };
  const transcriber = {
    backend: "fake",
    async transcribe(samples) {
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      state.order.push(samples.length);
      await new Promise((release) => gates.push(release));
      state.running -= 1;
      return { text: `len-${samples.length}` };
    },
    dispose() {},
  };
  return { transcriber, gates, state };
}

test("同一个模型不并发：后到的转写等前一个做完才开始，结果按 id 各自回话", async () => {
  const channel = fakeChannel();
  const { transcriber, gates, state } = gatedTranscriber();
  serveTranscriber(channel, async () => transcriber);

  channel.deliver({ type: "load", model: { id: "fake" }, dir: "/models/fake" });
  await until(channel, (m) => m.type === "loaded", "装好模型");

  channel.deliver({ type: "transcribe", id: 7, samples: new Float32Array(10) });
  channel.deliver({ type: "transcribe", id: 8, samples: new Float32Array(20) });
  await new Promise((done) => setImmediate(done));

  // 第二条还没进去：第一条卡着
  assert.deepEqual(state.order, [10]);
  assert.equal(state.peak, 1);

  gates.shift()();
  await until(channel, (m) => m.id === 7, "第一条回话");
  await new Promise((done) => setImmediate(done));

  gates.shift()();
  await until(channel, (m) => m.id === 8, "第二条回话");

  assert.equal(state.peak, 1);
  assert.deepEqual(state.order, [10, 20]);
  assert.deepEqual(
    channel.sent.filter((m) => m.type === "result").map((m) => [m.id, m.text]),
    [
      [7, "len-10"],
      [8, "len-20"],
    ],
  );
});

test("模型还没装好就先来的转写会等装完再跑，不会说没模型", async () => {
  const channel = fakeChannel();
  let finishLoad;
  const loading = new Promise((resolve) => {
    finishLoad = resolve;
  });
  serveTranscriber(channel, async () => {
    await loading;
    return {
      backend: "fake",
      async transcribe(samples) {
        return { text: `len-${samples.length}` };
      },
      dispose() {},
    };
  });

  channel.deliver({ type: "load", model: { id: "fake" }, dir: "/models/fake" });
  channel.deliver({ type: "transcribe", id: 1, samples: new Float32Array(5) });
  await new Promise((done) => setImmediate(done));
  assert.equal(channel.sent.length, 0);

  finishLoad();
  await until(channel, (m) => m.id === 1, "转写回话");
  assert.deepEqual(
    channel.sent.find((m) => m.id === 1),
    { type: "result", id: 1, text: "len-5" },
  );
});

test("dispose 排在在跑的那条后面：先把话回完，再关进程", async () => {
  const channel = fakeChannel();
  const { transcriber, gates } = gatedTranscriber();
  serveTranscriber(channel, async () => transcriber);

  channel.deliver({ type: "load", model: { id: "fake" }, dir: "/models/fake" });
  await until(channel, (m) => m.type === "loaded", "装好模型");
  channel.deliver({ type: "transcribe", id: 3, samples: new Float32Array(10) });
  channel.deliver({ type: "dispose" });
  await new Promise((done) => setImmediate(done));

  // 前面的还没回话，进程不能先走
  assert.equal(channel.exited, null);

  gates.shift()();
  await until(channel, (m) => m.id === 3, "那条回话");
  await new Promise((done) => setImmediate(done));
  assert.equal(channel.exited, 0);
  assert.equal(channel.sent.find((m) => m.id === 3)?.text, "len-10");
});

test("dispose 之后来的消息不再接：既不回话也不跑", async () => {
  const channel = fakeChannel();
  const { transcriber, state } = gatedTranscriber();
  serveTranscriber(channel, async () => transcriber);

  channel.deliver({ type: "load", model: { id: "fake" }, dir: "/models/fake" });
  await until(channel, (m) => m.type === "loaded", "装好模型");
  channel.deliver({ type: "dispose" });
  await new Promise((done) => setImmediate(done));
  channel.deliver({ type: "transcribe", id: 4, samples: new Float32Array(10) });
  await new Promise((done) => setImmediate(done));

  assert.deepEqual(state.order, []);
  assert.equal(
    channel.sent.some((m) => m.id === 4),
    false,
  );
});

test("转写出错只回给这一条 id，后面的照跑", async () => {
  const channel = fakeChannel();
  serveTranscriber(channel, async () => ({
    backend: "fake",
    async transcribe(samples) {
      if (samples.length === 3) throw new Error("运行库报错");
      return { text: `len-${samples.length}` };
    },
    dispose() {},
  }));

  channel.deliver({ type: "load", model: { id: "fake" }, dir: "/models/fake" });
  await until(channel, (m) => m.type === "loaded", "装好模型");
  channel.deliver({ type: "transcribe", id: 1, samples: new Float32Array(3) });
  channel.deliver({ type: "transcribe", id: 2, samples: new Float32Array(9) });
  await until(channel, (m) => m.id === 2, "第二条回话");

  assert.match(channel.sent.find((m) => m.id === 1)?.message ?? "", /运行库报错/);
  assert.deepEqual(
    channel.sent.find((m) => m.id === 2),
    { type: "result", id: 2, text: "len-9" },
  );
});
