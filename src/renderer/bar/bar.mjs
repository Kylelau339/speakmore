// 悬浮条：把按键和点击喂给状态机，按状态机给出的动作去录音、上传、交付。
// 画面不在这里：该是什么样子由 bar-view.mjs 算，画出来由 bar-ui.mjs 管。
// 说话的功能不止一个（语音输入、语音翻译）：每个功能开口时发什么、提示行左边画什么、交给主进程存什么，
// 都在 features/ 里各管各的，这里只认那个接口，不认功能的名字。

import { chordKeycaps } from "../../hotkeys/chord.mjs";
import { LocalizedError, msg, problemOf } from "../../i18n/index.mjs";
import { localize, setLocale, t } from "../shared/i18n.mjs";
import { createBarUi } from "./bar-ui.mjs";
import { viewOf } from "./bar-view.mjs";
import { featureOf } from "./features/index.mjs";
import { Action, eventTypeOf, initialState, LONG_PRESS_MS, Phase, transition } from "./machine.mjs";
import { startRecording } from "./recorder.mjs";
import { VoiceSocket } from "./voice-socket.mjs";

/** 原版的单次录音上限：9 分钟 */
const MAX_DURATION_MS = 540_000;

// 页面的 lang 跟着界面语言：提示是 aria-live 的，读屏软件按它挑用哪种语言念
localize();
const { serverUrl, hotkeys: initialHotkeys, barControls, barHint } = await window.speakmore.config();
/** 现在每个动作的热键（组合列表）。提示里写开始这一次的那个组合、取消的键帽，按界面语言写 */
let hotkeys = initialHotkeys;
let state = initialState;
/**
 * 开始这一次（或者升级到）的是哪个动作的第几个组合：几个组合都能结束，提示里写按下的那个，不容易看糊涂
 */
let pressed = { action: "dictate", index: 0 };
const keycapsOf = (codes) => (codes ? chordKeycaps(codes).map((cap) => t.text(cap)) : []);
function hintKeys() {
  const action = state.action ?? pressed.action;
  const chords = hotkeys[action] ?? [];
  const index = pressed.action === action ? pressed.index : 0;
  return { keys: keycapsOf(chords[index] ?? chords[0]), escKeys: keycapsOf(hotkeys.cancel?.[0]) };
}
const voice = new VoiceSocket(serverUrl);
const ui = createBarUi({
  document,
  host: { setVisible: window.speakmore.setBarVisible, capture: window.speakmore.captureBarInput },
  keys: hintKeys(),
  t,
  onPick: pick,
});
ui.setControls(barControls);
ui.setHintShown(barHint === "on");
window.speakmore.onBarHint((value) => ui.setHintShown(value === "on"));
window.speakmore.onHotkeysChanged((next) => {
  hotkeys = next;
  pressed = { action: pressed.action, index: 0 };
  ui.setKeys(hintKeys());
});
// 设置里换了语言：悬浮条不重新加载（可能正在听写），换掉翻译，下一句就是新的语言
window.speakmore.onLocaleChanged((locale) => {
  setLocale(locale);
  ui.setKeys(hintKeys());
  ui.setTranslator(t, t.text(state.message));
});

/**
 * 正在进行的那一次：{ audioId, recording, cancelled, feature, state, ready, begun }。
 * feature 是这一次的功能（features/），state 是它这一次的状态（语音翻译译成哪种）；
 * ready 是主进程现读的设置到了、功能定下来了，begun 是服务端那边开始了（之后才能换模式）
 */
let session = null;
let holdTimer = null;
let maxDurationTimer = null;

function dispatch(event) {
  const previous = state;
  const result = transition(state, event);
  state = result.state;
  // 状态没动（比如空闲时松开热键）就不重画
  if (state !== previous) ui.show(viewOf(state, previous.phase), t.text(state.message));
  // 不在听了（停口、取消、出错）：暂定文字立刻收掉，别让它留到整理中或下一次开口
  if (previous.phase === Phase.RECORDING && state.phase !== Phase.RECORDING) ui.setPreview(null);
  for (const action of result.actions) ACTIONS[action]();
}

const ACTIONS = {
  [Action.START]: start,
  [Action.CANCEL]: cancel,
  [Action.STOP]: stop,
  [Action.SWITCH]: switchFeature,
  [Action.ARM_HOLD_TIMER]: () => {
    holdTimer = setTimeout(() => dispatch({ type: "LONG_HOLD" }), LONG_PRESS_MS);
  },
  [Action.CLEAR_HOLD_TIMER]: () => clearTimeout(holdTimer),
};

/** 一个错误给人看的那句话：一句 msg（到画出来时才按界面语言翻），或者现成的字 */
const describe = problemOf;

/** 这一次换成某个功能：按设置定下它的状态，提示行跟着换 */
function adopt(current, action, config) {
  const feature = featureOf(action);
  if (feature === null) throw new Error(`悬浮条不认识的说话功能：${action}`);
  current.feature = feature;
  current.state = feature.open(config);
  showFeature(current);
}

function showFeature(current) {
  ui.setFeature({ chip: current.feature.chip(current.state), finishing: current.feature.finishing });
}

/** 把这一次的模式和参数告诉服务端（set_mode_config）：升级成别的功能、换了语言时 */
function sendMode(current) {
  const parameters = current.feature.parameters(current.state) ?? {};
  voice.configure({ configMode: current.feature.configMode, parameters });
}

/**
 * 录音时的暂定文字：只画在悬浮条的录音块上，不进输入栏、不碰剪贴板，也不进历史。
 * 迟到的那一次录音的消息（换过 session）、取消了的、已经不在听的、升级成翻译的，都不算
 */
function showPreview(current, text) {
  if (session !== current || current.cancelled) return;
  if (state.phase !== Phase.RECORDING || current.feature?.id !== "dictate") return;
  ui.setPreview(text);
}

function start() {
  const current = {
    audioId: crypto.randomUUID(),
    recording: null,
    cancelled: false,
    feature: null,
    state: null,
    ready: null,
    begun: null,
  };
  session = current;
  ui.setPreview(null);
  // 设置每次开口时现读：设置里换了目标语言，下一次就按新的
  current.ready = window.speakmore.sessionConfig().then((config) => {
    current.config = config;
    adopt(current, state.action, config);
  });
  current.begun = current.ready.then(() =>
    voice.begin(current.audioId, {
      mode: current.feature.mode,
      configMode: current.feature.configMode,
      parameters: current.feature.parameters(current.state),
      onPartial: (text) => showPreview(current, text),
    }),
  );
  (async () => {
    await current.begun;
    const recording = await startRecording({
      onChunk: (chunk) => voice.sendChunk(chunk),
      onLevel: ui.level,
      onError: (error) => dispatch({ type: "FAILED", message: describe(error) }),
    });
    // 等麦克风的这一小段时间里用户可能已经取消了
    if (current.cancelled) {
      recording.cancel();
      return;
    }
    current.recording = recording;
    maxDurationTimer = setTimeout(() => dispatch({ type: "MAX_DURATION" }), MAX_DURATION_MS);
    dispatch({ type: "MIC_READY" });
  })().catch((error) => {
    console.error("开始录音失败", error);
    if (!current.cancelled) dispatch({ type: "FAILED", message: describeStartError(error) });
  });
}

/** 按着语音输入的键又凑成了语音翻译的组合（升级）：这一次换成它，录音不断，告诉服务端换模式 */
function switchFeature() {
  const current = session;
  if (!current) return;
  const action = state.action;
  current.ready
    .then(() => {
      if (session !== current) return;
      adopt(current, action, current.config);
      // 升级成翻译：刚才那些暂定的听写文字不再作数
      ui.setPreview(null);
      return current.begun.then(() => {
        if (session === current) sendMode(current);
      });
    })
    // 开始那一步失败了的，start 已经报过
    .catch((error) => console.warn("换功能没成", error));
}

/** 在胶囊里选了一项（语音翻译临时换一种语言）：只管这一次 */
function pick(id) {
  const current = session;
  if (!current?.feature) return;
  const next = current.feature.pick(current.state, id);
  if (next === current.state) return;
  current.state = next;
  showFeature(current);
  current.begun
    .then(() => {
      if (session === current) sendMode(current);
    })
    .catch((error) => console.warn("换语言没发出去", error));
}

function describeStartError(error) {
  if (error?.name === "NotAllowedError") return msg("bar.noMicPermission");
  if (error?.name === "NotFoundError") return msg("bar.noMicrophone");
  return describe(error);
}

function cancel() {
  clearTimeout(maxDurationTimer);
  if (!session) return;
  session.cancelled = true;
  session.recording?.cancel();
  session = null;
  voice.abandon();
  ui.setFeature({ chip: null, finishing: null });
}

async function stop() {
  clearTimeout(maxDurationTimer);
  const current = session;
  session = null;
  let recorded = null;
  try {
    recorded = await current.recording.stop();
    if (!recorded.hadSignal) {
      voice.abandon();
      throw new LocalizedError(msg("bar.noSignal"));
    }
    const result = await voice.finish({ durationSeconds: recorded.durationSeconds });
    const { notice } = await window.speakmore.deliver({
      audioId: current.audioId,
      kind: current.feature.id,
      text: result.text,
      ...current.feature.delivered(current.state, result),
      durationSeconds: recorded.durationSeconds,
      audio: await recorded.blob.arrayBuffer(),
    });
    dispatch({ type: "RESULT", message: notice });
  } catch (error) {
    console.error("这次听写失败", error);
    const message = describe(error);
    // 录音还在的话交给主进程存下来，失败了话也不会白说。历史里记的是这一刻界面上的那句话
    if (recorded) {
      await window.speakmore
        .reportFailure({
          audioId: current.audioId,
          kind: current.feature.id,
          ...current.feature.delivered(current.state, { text: "", source: null }),
          error: t.text(message),
          durationSeconds: recorded.durationSeconds,
          audio: await recorded.blob.arrayBuffer(),
        })
        .catch((saveError) => console.error("失败记录没有存上", saveError));
    }
    dispatch({ type: "FAILED", message });
  }
  // 这一次完了：胶囊收掉，下一次开口时不先画出这一次的语言（新的一次那时还没开始，session 是空的）
  if (session === null) ui.setFeature({ chip: null, finishing: null });
}

// ---------- 来自主进程的事件 ----------

window.speakmore.onInput((input) => {
  // 胶囊上的点击（展开、选一项）由画面自己处理
  if (input.event === "click" && ui.click(input.id)) return;
  const type = eventTypeOf(input);
  if (type === undefined) {
    console.warn("不认识的输入事件", input);
    return;
  }
  if (type === null) return;
  dispatch({ type, action: input.action, to: input.to });
  // 开始这一次、或者升级到的那个组合（主进程带着是第几个）：提示里写它
  if (type === "KEY_DOWN" && input.action === state.action && Number.isInteger(input.chord)) {
    if (state.phase === Phase.STARTING || state.phase === Phase.RECORDING) {
      pressed = { action: input.action, index: input.chord };
      ui.setKeys(hintKeys());
    }
  }
});

window.speakmore.onBarControls(ui.setControls);

window.speakmore.onNotice((message) => {
  // 权限之类的提醒只在空闲时显示，不打断正在进行的听写
  if (state.phase !== Phase.IDLE && state.phase !== Phase.ERROR) return;
  state = { ...state, message };
  ui.show(viewOf(state, state.phase), t.text(message));
});
