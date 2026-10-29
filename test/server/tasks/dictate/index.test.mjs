import assert from "node:assert/strict";
import { test } from "node:test";
import { dictate } from "../../../../src/server/tasks/dictate/index.mjs";
import { NO_SPEECH_MARK } from "../../../../src/server/tasks/dictate/prompt.mjs";

// 成品字形（设置里的 outputScript）：客户端要繁体时在 set_mode_config 里给 output_script。
// 默认简体：老客户端不发 set_mode_config 也照样用

const TRANSCRIBED = "我而家用紧呢一个platform，然之后我用语音输入文字嘅时候";

test("没给 output_script 时照旧是简体", () => {
  assert.deepEqual(dictate.bind({}).transcribe.finish(TRANSCRIBED), { text: TRANSCRIBED, source: null });
  assert.deepEqual(dictate.bind({ output_script: "simplified" }).native.finish("我們後天開會。"), {
    text: "我们后天开会",
    source: null,
  });
});

test("traditional-hk：成品转成繁体（香港字形），英文和粤语用字不动", () => {
  assert.deepEqual(dictate.bind({ output_script: "traditional-hk" }).transcribe.finish(TRANSCRIBED), {
    text: "我而家用緊呢一個platform，然之後我用語音輸入文字嘅時候",
    source: null,
  });
});

test("traditional-tw：用台湾字形", () => {
  assert.equal(
    dictate.bind({ output_script: "traditional-tw" }).transcribe.finish("这个软件里面设置的模型在哪里？").text,
    "這個軟件裡面設置的模型在哪裡？",
  );
});

test("三种走法都转：直出、整理、离线", () => {
  const bound = dictate.bind({ output_script: "traditional-hk" });
  assert.equal(bound.native.finish("我们后天开会。").text, "我們後天開會");
  assert.equal(bound.polish.finish("这个软件挺好用的。", "这个软件挺好用的").text, "這個軟件挺好用的");
  assert.equal(bound.transcribe.finish("  好的  ").text, "好的");
});

test("没有人声、没有输出时还是空的；不认识的字形抛错，不悄悄按简体做", () => {
  const bound = dictate.bind({ output_script: "traditional-hk" });
  assert.equal(bound.transcribe.finish("").text, "");
  assert.equal(bound.native.finish(NO_SPEECH_MARK).text, "");
  assert.throws(() => dictate.bind({ output_script: "zh-Hant" }), /simplified \/ traditional-hk \/ traditional-tw/);
});
