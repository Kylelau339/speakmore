// 悬浮条该是什么样子：由状态机的状态算出来，纯函数，不碰页面。
// 真正把它画出来的是 bar-ui.mjs。

import { Phase } from "./machine.mjs";

export const View = Object.freeze({
  HIDDEN: "hidden",
  STARTING: "starting", // 打开麦克风：声波伏着，一明一暗
  RECORDING: "recording", // 正在听：声波跟着声音动
  FINISHING: "finishing", // 整理中：一道匀速滚过的波
  DONE: "done", // 文字贴出去了：打个勾
  NOTICE: "notice", // 一句提示
  ERROR: "error", // 出错：图标加原因
});

/** 收尾的样子在屏幕上留多久再消失。说话时的样子不在这里：它们一直留到阶段变了为止 */
export const LINGER_MS = Object.freeze({
  [View.DONE]: 900,
  [View.NOTICE]: 4_000,
  [View.ERROR]: 4_000,
});

/**
 * @param {{ phase: string, message: object | string | null }} state 状态机现在的状态（message 是一句 msg 或现成的字）
 * @param {string} previousPhase 变成现在这样之前的阶段
 */
export function viewOf(state, previousPhase) {
  switch (state.phase) {
    case Phase.STARTING:
      return View.STARTING;
    case Phase.RECORDING:
      return View.RECORDING;
    case Phase.FINISHING:
      return View.FINISHING;
    case Phase.ERROR:
      return View.ERROR;
    default:
      if (state.message !== null) return View.NOTICE;
      // 刚拿到成品、没有别的话要说：打个勾再走。取消的、提示放完了的，直接消失
      return previousPhase === Phase.FINISHING ? View.DONE : View.HIDDEN;
  }
}

/**
 * 条上方的那行提示。
 * @param {string} view
 * @param {{ keys: string[], escKeys: string[], cancellable: boolean, shown?: boolean, finishing?: object | null }} options
 *   keys：开始这一次的那个组合的键帽，一个键一个；escKeys：取消那个动作的键帽（默认是 esc，能改）；
 *   cancellable：取消键截不截得住；shown：设置里开着操作提示（barHint），关了哪个样子都不写；
 *   finishing：等成品时写的那句（功能自己的，语音翻译是"翻译中"），不给是"整理中"
 * @param {Function} t 界面语言的翻译函数（src/i18n）。键在句子里的位置由各语言自己定
 * @returns {Array<string | { keys: string[] }>} 一段一段的：文字，或者一组要标成键帽的键（docs/hotkey-research.md 5.7）
 */
export function hintFor(view, { keys, escKeys, cancellable, shown = true, finishing = null }, t) {
  if (!shown) return [];
  switch (view) {
    case View.STARTING:
      return [t("bar.opening")];
    case View.RECORDING:
      return t.parts(cancellable ? "bar.recording" : "bar.recordingNoEsc", {
        key: { keys },
        esc: { keys: escKeys },
      });
    case View.FINISHING:
      return [finishing ? t.text(finishing) : t("bar.finishing")];
    default:
      return [];
  }
}

/** 这几种样子下提示行左边画功能的胶囊（语音翻译的目标语言）：说着话、等成品时 */
export const showsChip = (view) => view === View.STARTING || view === View.RECORDING || view === View.FINISHING;

/** 胶囊点得动（换这一次的语言）、要截的样子：说着话时。等成品时只写着：换了也来不及，esc 也不该被吞 */
export const picksChip = (view) => view === View.STARTING || view === View.RECORDING;

/** 这个样子下画不画录音时的暂定文字：只在正在听时。开始（还没声音可听）、等成品、出错都不画 */
export const showsPreview = (view) => view === View.RECORDING;

/** 这个样子下，条上哪几个按钮点得动 */
export function controlsIn(view) {
  if (view === View.STARTING) return ["cancel"];
  if (view === View.RECORDING) return ["cancel", "confirm"];
  return [];
}
