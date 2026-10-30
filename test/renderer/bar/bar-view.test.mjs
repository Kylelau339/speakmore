import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, msg } from "../../../src/i18n/index.mjs";
import {
  controlsIn,
  hintFor,
  LINGER_MS,
  picksChip,
  showsChip,
  showsPreview,
  View,
  viewOf,
} from "../../../src/renderer/bar/bar-view.mjs";

const zh = createTranslator("zh-CN");
const en = createTranslator("en");

import { Phase } from "../../../src/renderer/bar/machine.mjs";

const at = (phase, message = null) => ({ phase, held: false, message });

test("说话的三个阶段各有各的样子", () => {
  assert.equal(viewOf(at(Phase.STARTING), Phase.IDLE), View.STARTING);
  assert.equal(viewOf(at(Phase.RECORDING), Phase.STARTING), View.RECORDING);
  assert.equal(viewOf(at(Phase.FINISHING), Phase.RECORDING), View.FINISHING);
});

test("回到空闲：刚拿到成品就打个勾；取消了的直接消失；有话要说就显示那句话", () => {
  assert.equal(viewOf(at(Phase.IDLE), Phase.FINISHING), View.DONE);
  assert.equal(viewOf(at(Phase.IDLE), Phase.RECORDING), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE), Phase.STARTING), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE), Phase.IDLE), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE, "没有听到声音"), Phase.FINISHING), View.NOTICE);
  assert.equal(viewOf(at(Phase.IDLE, "还没有填 Gemini API key"), Phase.IDLE), View.NOTICE);
  assert.equal(viewOf(at(Phase.ERROR, "连不上 Gemini"), Phase.FINISHING), View.ERROR);
});

test("收尾的样子自己会消失，说话时的样子一直留着", () => {
  assert.equal(LINGER_MS[View.DONE] < LINGER_MS[View.NOTICE], true);
  assert.equal(LINGER_MS[View.NOTICE], LINGER_MS[View.ERROR]);
  for (const view of [View.STARTING, View.RECORDING, View.FINISHING, View.HIDDEN]) {
    assert.equal(LINGER_MS[view], undefined, view);
  }
});

test("上方的那行提示：告诉人现在在干什么、按哪个键；键名单独标出来", () => {
  const options = { keys: ["右⌥"], escKeys: ["esc"], cancellable: true };
  assert.deepEqual(hintFor(View.STARTING, options, zh), ["打开麦克风…"]);
  assert.deepEqual(hintFor(View.RECORDING, options, zh), [
    "再按一下 ",
    { keys: ["右⌥"] },
    " 完成 · ",
    { keys: ["esc"] },
    " 取消",
  ]);
  assert.deepEqual(hintFor(View.FINISHING, options, zh), ["整理中"]);
  for (const view of [View.DONE, View.NOTICE, View.ERROR, View.HIDDEN])
    assert.deepEqual(hintFor(view, options, zh), []);
});

test("英文的提示：键在句子里的位置照英文的说法", () => {
  assert.deepEqual(hintFor(View.RECORDING, { keys: ["Right ⌥"], escKeys: ["esc"], cancellable: true }, en), [
    "Press ",
    { keys: ["Right ⌥"] },
    " to finish · ",
    { keys: ["esc"] },
    " to cancel",
  ]);
  assert.deepEqual(hintFor(View.STARTING, { keys: ["fn"], escKeys: ["esc"], cancellable: true }, en), [
    "Opening microphone…",
  ]);
});

test("设置里关了操作提示（GitHub issue #3）：哪个样子都不写，条上方空着", () => {
  for (const view of Object.values(View)) {
    assert.deepEqual(hintFor(view, { keys: ["右⌥"], escKeys: ["esc"], cancellable: true, shown: false }, zh), [], view);
  }
});

test("取消不了的时候（没有辅助功能权限，截不住 esc）提示里不提 esc", () => {
  assert.deepEqual(hintFor(View.RECORDING, { keys: ["fn"], escKeys: ["esc"], cancellable: false }, zh), [
    "再按一下 ",
    { keys: ["fn"] },
    " 完成",
  ]);
});

test("两个键的组合是一组键帽；取消换了键，提示里写换上的那个", () => {
  assert.deepEqual(hintFor(View.RECORDING, { keys: ["右⌥", "空格"], escKeys: ["F13"], cancellable: true }, zh), [
    "再按一下 ",
    { keys: ["右⌥", "空格"] },
    " 完成 · ",
    { keys: ["F13"] },
    " 取消",
  ]);
});

test("哪个样子下哪个按钮点得动：打开麦克风时只能取消，正在听时取消和完成都行，别的时候都点不动", () => {
  assert.deepEqual(controlsIn(View.STARTING), ["cancel"]);
  assert.deepEqual(controlsIn(View.RECORDING), ["cancel", "confirm"]);
  for (const view of [View.FINISHING, View.DONE, View.NOTICE, View.ERROR, View.HIDDEN]) {
    assert.deepEqual(controlsIn(view), [], view);
  }
});

test("等成品时写功能自己的那句（语音翻译写翻译中）；功能的胶囊只在说话、等成品时画", () => {
  const options = { keys: ["右⌥", "空格"], escKeys: ["esc"], cancellable: true, finishing: msg("bar.translating") };
  assert.deepEqual(hintFor(View.FINISHING, options, zh), ["翻译中"]);
  assert.deepEqual(hintFor(View.FINISHING, options, en), ["Translating"]);
  assert.deepEqual(
    [View.STARTING, View.RECORDING, View.FINISHING, View.DONE, View.NOTICE, View.ERROR, View.HIDDEN].map(showsChip),
    [true, true, true, false, false, false, false],
  );
  // 胶囊只在说话时点得动、要截：等成品时换语言也来不及了，esc 也不该被吞
  assert.deepEqual(
    [View.STARTING, View.RECORDING, View.FINISHING, View.DONE, View.NOTICE, View.ERROR, View.HIDDEN].map(picksChip),
    [true, true, false, false, false, false, false],
  );
});

test("录音时的暂定文字只在正在听时画：打开麦克风、等成品、出错、收起来都不画", () => {
  assert.equal(showsPreview(View.RECORDING), true);
  for (const view of [View.HIDDEN, View.STARTING, View.FINISHING, View.DONE, View.NOTICE, View.ERROR]) {
    assert.equal(showsPreview(view), false, view);
  }
});
