import { Converter } from "opencc-js/cn2t";
import { textFromModelOutput } from "./output.mjs";
import { polishInput, polishPromptWith } from "./polish-prompt.mjs";
import { nativePromptWith, TASK_REMINDER } from "./prompt.mjs";

// 语音输入：他说什么，就写成他想打出来的那段字（删口头禅、改口，分段分点）。
// 三种识别方式都能做，各步用的提示词和收尾都在这个目录里，别的任务不引用这里的东西。

/**
 * 成品的中文字形（客户端在 set_mode_config 里给的 output_script）。本机模型只会写简体，原生和整理两步的提示词
 * 也要求写简体，所以要繁体的人在成品交出去的最后一步统一转一次。英文、数字、粤语用字（嘅、佢、咗）两种写法相同，不动。
 * 名字是设置里的写法（storage/settings.mjs 的 outputScript），值是 opencc 的地区字形：tw 是台湾字形，hk 是香港字形。
 */
const VARIANTS = Object.freeze({ simplified: null, "traditional-hk": "hk", "traditional-tw": "tw" });

/** 能填的字形，按界面上排的先后 */
export const OUTPUT_SCRIPTS = Object.freeze(Object.keys(VARIANTS));

/** 每种字形怎么转。转换表不小，第一次用到才建，建一次留着 */
const converters = new Map();

function converterOf(script) {
  if (script === "simplified") return (text) => text;
  if (!converters.has(script)) converters.set(script, Converter({ from: "cn", to: VARIANTS[script] }));
  return converters.get(script);
}

/** 成品只有一段字，没有另外要存的原文 */
const done = (text) => ({ text, source: null });

/** 直出：录音交给听音频的模型 */
const NATIVE = Object.freeze({
  system: (terms) => nativePromptWith(terms),
  reminder: TASK_REMINDER,
});

/** 混合的整理那一步：转出来的文字交给文字模型 */
const POLISH = Object.freeze({
  system: (terms) => polishPromptWith(terms),
  input: polishInput,
});

export const dictate = Object.freeze({
  id: "dictate",
  // 协议里的名字照原版（docs/04-voice-pipeline.md 的"模式"）：start_audio 写内部名，set_mode_config 写发给服务端的名字
  mode: "voice_transcript",
  configMode: "transcript",
  /**
   * 要客户端在 set_mode_config 里给的参数：没有 —— 成品字形（output_script）是可选的，不写进这张表：
   * 老客户端不发 set_mode_config 也照样能听写，按简体
   */
  parameters: Object.freeze([]),
  steps: Object.freeze(["native", "polish", "transcribe"]),
  /**
   * @param {{ output_script?: string }} parameters
   * 不认识的字形抛错：服务端报成协议错误，不悄悄按简体做
   */
  bind({ output_script: wanted = "simplified" } = {}) {
    if (!Object.hasOwn(VARIANTS, wanted)) {
      throw new Error(`output_script 要是 ${OUTPUT_SCRIPTS.join(" / ")} 之一，现在是 ${JSON.stringify(wanted)}`);
    }
    const toScript = converterOf(wanted);
    return Object.freeze({
      id: "dictate",
      native: Object.freeze({ ...NATIVE, finish: (output) => done(toScript(textFromModelOutput(output))) }),
      polish: Object.freeze({ ...POLISH, finish: (output) => done(toScript(textFromModelOutput(output))) }),
      /** 离线：转出来的文字去掉首尾空白直接交出，不经任何模型 */
      transcribe: Object.freeze({ finish: (transcript) => done(toScript(transcript.trim())) }),
    });
  },
});
