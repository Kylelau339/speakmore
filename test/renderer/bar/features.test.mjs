import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS } from "../../../src/hotkeys/actions.mjs";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { FEATURES, featureOf } from "../../../src/renderer/bar/features/index.mjs";
import { findTask } from "../../../src/server/tasks/index.mjs";

const zh = createTranslator("zh-CN");

test("每个说话的动作：悬浮条上有它的功能、服务端有它的任务，协议里的模式名两边一样", () => {
  const spoken = ACTIONS.filter((action) => action.handler === "session").map(({ id }) => id);
  assert.deepEqual(
    FEATURES.map(({ id }) => id),
    spoken,
  );
  for (const id of spoken) {
    const feature = featureOf(id);
    const task = findTask(id);
    assert.ok(task, `${id} 没有服务端的任务`);
    assert.deepEqual([feature.mode, feature.configMode], [task.mode, task.configMode], id);
  }
  assert.equal(featureOf("cancel"), null);
  assert.equal(featureOf("constructor"), null);
});

test("语音输入：开口就发，默认的简体不用发参数、没有胶囊，交付不带别的", () => {
  const dictate = featureOf("dictate");
  const state = dictate.open({ translateTo: ["ja"] });
  assert.equal(state.outputScript, "simplified");
  assert.equal(dictate.parameters(state), null);
  assert.equal(dictate.chip(state), null);
  assert.equal(dictate.finishing, null);
  assert.deepEqual(dictate.delivered(state, { text: "好", source: null }), {});
});

test("语音输入：设置里选了繁体，开口时把字形告诉服务端", () => {
  const dictate = featureOf("dictate");
  assert.deepEqual(dictate.parameters(dictate.open({ outputScript: "traditional-hk" })), {
    output_script: "traditional-hk",
  });
  assert.deepEqual(dictate.parameters(dictate.open({ outputScript: "traditional-tw" })), {
    output_script: "traditional-tw",
  });
});

test("语音翻译：开口译成设置里的第一种；胶囊里列着设置里的几种，临时换的只管这一次", () => {
  const translate = featureOf("translate");
  const config = { translateTo: ["en", "ja"] };
  const state = translate.open(config);
  assert.deepEqual(translate.parameters(state), { output_language: "en" });
  const chip = translate.chip(state);
  assert.equal(zh.text(chip.text), "英文");
  assert.deepEqual(
    chip.options.map(({ id, text, selected }) => [id, zh.text(text), selected]),
    [
      ["en", "英文", true],
      ["ja", "日文", false],
    ],
  );
  const picked = translate.pick(state, "ja");
  assert.deepEqual(translate.parameters(picked), { output_language: "ja" });
  // 设置里没有的不换
  assert.equal(translate.pick(state, "ko"), state);
  // 下一次开口又是第一种
  assert.deepEqual(translate.parameters(translate.open(config)), { output_language: "en" });
  assert.equal(zh.text(translate.finishing), "翻译中");
  assert.deepEqual(translate.delivered(picked, { text: "こんにちは", source: "你好" }), {
    sourceText: "你好",
    outputLanguage: "ja",
  });
});
