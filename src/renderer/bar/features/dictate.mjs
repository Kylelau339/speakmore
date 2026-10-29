// 悬浮条上的语音输入：开口就能说，没有要选的，成品只有一段字；字形按设置（通用 › 输出字形）。接口见 index.mjs
export const dictate = Object.freeze({
  id: "dictate",
  mode: "voice_transcript",
  configMode: "transcript",
  /** @param {{ outputScript?: string }} config 开口时主进程现读的设置 */
  open: ({ outputScript = "simplified" } = {}) => Object.freeze({ outputScript }),
  // 默认的简体不用发：服务端本来就是简体，少发一条 set_mode_config，也少让它把提示词缓存备一遍
  parameters: (state) => (state.outputScript === "simplified" ? null : { output_script: state.outputScript }),
  chip: () => null,
  pick: (state) => state,
  finishing: null,
  delivered: () => ({}),
});
