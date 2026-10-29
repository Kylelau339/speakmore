import { Converter } from "opencc-js/cn2t";
import { textFromModelOutput } from "./output.mjs";
import { polishInput, polishPromptWith } from "./polish-prompt.mjs";
import { nativePromptWith, TASK_REMINDER } from "./prompt.mjs";

// 语音输入：他说什么，就写成他想打出来的那段字（删口头禅、改口，分段分点）。
// 三种识别方式都能做，各步用的提示词和收尾都在这个目录里，别的任务不引用这里的东西。

/** 成品只有一段字，没有另外要存的原文 */
const done = (text) => ({ text, source: null });

/** 直出：录音交给听音频的模型 */
const NATIVE = Object.freeze({
  system: (terms) => nativePromptWith(terms),
  reminder: TASK_REMINDER,
  finish: (output) => done(textFromModelOutput(output)),
});

/** 混合的整理那一步：转出来的文字交给文字模型 */
const POLISH = Object.freeze({
  system: (terms) => polishPromptWith(terms),
  input: polishInput,
  finish: (output) => done(textFromModelOutput(output)),
});

/** 离线：转出来的文字去掉首尾空白直接交出，不经任何模型 */
const TRANSCRIBE = Object.freeze({
  finish: (transcript) => done(transcript.trim()),
});

const DICTATION = Object.freeze({ id: "dictate", native: NATIVE, polish: POLISH, transcribe: TRANSCRIBE });

/**
 * 成品的中文字形（set_mode_config 的 output_script，即设置里的 outputScript），值是 opencc 的地区字形。
 * 本机模型只会写简体，提示词也要求简体，所以要繁体时在各步收尾之后统一转；英文、数字、粤语用字（嘅、佢、咗）不变
 */
const SCRIPTS = Object.freeze({ simplified: null, "traditional-hk": "hk", "traditional-tw": "tw" });

/** 能填的字形，按界面上排的先后 */
export const OUTPUT_SCRIPTS = Object.freeze(Object.keys(SCRIPTS));

// 一张转换表要建二三十毫秒，第一次用到才建
const converters = new Map();
function converterOf(script) {
  if (!converters.has(script)) converters.set(script, Converter({ from: "cn", to: SCRIPTS[script] }));
  return converters.get(script);
}

/** 这一步照原样收尾，再把成品转成要的字形 */
const converted = (step, convert) =>
  Object.freeze({ ...step, finish: (...args) => done(convert(step.finish(...args).text)) });

export const dictate = Object.freeze({
  id: "dictate",
  // 协议里的名字照原版（docs/04-voice-pipeline.md 的"模式"）：start_audio 写内部名，set_mode_config 写发给服务端的名字
  mode: "voice_transcript",
  configMode: "transcript",
  /** 要客户端在 set_mode_config 里给的参数：没有，开口就能定。output_script 可以不给（老客户端不发），不给是简体 */
  parameters: Object.freeze([]),
  steps: Object.freeze(["native", "polish", "transcribe"]),
  /** 不认识的字形抛错：服务端报成协议错误，不悄悄按简体做 */
  bind({ output_script: script = "simplified" } = {}) {
    if (!Object.hasOwn(SCRIPTS, script)) {
      throw new Error(`output_script 要是 ${OUTPUT_SCRIPTS.join(" / ")} 之一，现在是 ${JSON.stringify(script)}`);
    }
    if (script === "simplified") return DICTATION;
    const convert = converterOf(script);
    return Object.freeze({
      id: "dictate",
      native: converted(NATIVE, convert),
      polish: converted(POLISH, convert),
      transcribe: converted(TRANSCRIBE, convert),
    });
  },
});
