import { msg, problemOf } from "../../i18n/index.mjs";
import { SPEECH_SAMPLE_RATE } from "../audio/pcm.mjs";
import { toSpeech } from "../audio/transcode.mjs";
import { ModelError } from "../providers/errors.mjs";

// 混合和离线：录音 → 统一成 16 kHz 单声道 → 转文字（第一步，本机模型或云端模型）→ 纯文字模型整理（第二步）→ 成品。
// 离线没有第二步：转出来的文字交给任务的 transcribe 那一副收尾。
// 和直出（refiner.mjs）平级，对外的接口一样（warmUp、prepare、refine），服务端不用知道走的是哪一条。
// 两步各是一个策略：转文字用哪个模型由模型清单和转写进程管（asr/），整理交给哪一家由整理器管（polisher.mjs），
// 让模型做什么由每次交进来的任务定（../tasks），这里只管把它们按顺序接起来。
// 记账两跳各记一笔：润色那一笔由润色器记（花钱、有 token），本机转写这一笔在这里记（provider 是 local，不花钱），
// 这样用量里能看出每次听写的时间花在哪一跳、钱花在谁身上。

/**
 * @param {object} options
 * @param {{ transcribe(samples: Float32Array, o: { signal?: AbortSignal, audioId?: string, vocabulary?: readonly string[] }): Promise<{ text: string }> }} options.transcriber
 *   第一跳：本机模型（asr/host.mjs）或云端模型（asr/cloud/transcriber.mjs）。用户词典两跳都交，各按自己的收法用
 *   （收不收、收多少写在模型清单里，见 vocabulary/support.mjs）
 * @param {{ warmUp(): Promise<void>, polish(text: string, o: object): Promise<{ text: string, source: string | null }> } | null} options.polisher
 *   第二步（polisher.mjs）。离线方式不接（null）：原文交给任务的 transcribe 那一副收尾，什么都不往外发
 * @param {{ info: Function, error: Function }} options.log
 * @param {string | null} [options.model] 第一跳是哪个本机模型（models/catalog.mjs 的 id），记账用。
 *   第一跳是云端模型时不写：它自己记账（花钱、按时长或 token 算）
 * @param {(record: object) => void} [options.onCall] 记账，样子同 meter.mjs 的 onCall
 * @param {typeof toSpeech} [options.decode] 测试时换成假的
 */
/**
 * 录音时的预览只转写最近这么多秒。每次都从头转的话越说越慢（Mac 上只用 CPU，136 秒的话一次要近 10 秒，
 * 停口时还得等它跑完），悬浮条上也只放得下最近两行
 */
const PREVIEW_SECONDS = 8;

export function createLocalRefiner({ transcriber, polisher, log, model, onCall = () => {}, decode = toSpeech }) {
  /** 两跳之外的失败（解不开录音、本地转写出错）也报成 ModelError，服务端按同一套规矩告诉用户 */
  const failed = (problem, error) =>
    new ModelError({ kind: "other", problem, detail: String(error?.message ?? error), origin: error?.stack });

  /** 本机转写这一跳记一笔：没有 token、不花钱，只有转了多久。账没记上只是少一笔统计，不耽误这次听写 */
  function record(audioId, latencyMs) {
    try {
      onCall({
        purpose: "dictation",
        audioId,
        provider: "local",
        model,
        inputTokens: 0,
        audioTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        costUsd: 0,
        latencyMs,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      log.error("model_call_not_recorded", { audio_id: audioId, error: String(error?.stack ?? error) });
    }
  }

  return {
    /** 验证润色那一家的 key、地址和模型名，也让第一次润色不慢。转写器在装上的时候已经验过了；不润色时没什么要验的 */
    warmUp: async () => {
      await polisher?.warmUp();
    },

    /** 开口时没什么要先备的：转写模型装在转写进程里，按需装载时由内置服务在开口那一刻装上（app/service.mjs） */
    async prepare() {},

    /**
     * 录音时先听一眼：解开到现在为止的录音，只转写最近 PREVIEW_SECONDS 秒，前面截掉了就在开头加省略号。
     * 不润色、不记账、不写历史，也不算成品：服务端每来一块试一次，文字随时会被下一次取代，出错就丢掉
     * @param {Buffer} audio 到现在为止累积的录音
     * @param {{ mimeType: string, signal?: AbortSignal, vocabulary?: readonly string[], task?: object }} [options]
     *   task：这一次的任务（../tasks 的 bind 回的）。字形在任务的收尾里转（dictate 要繁体时），
     *   暂定文字也走同一步，不然繁体的用户在悬浮条上先看到一片简体
     * @returns {Promise<{ text: string }>}
     */
    async preview(audio, { mimeType, signal, vocabulary = [], task = null } = {}) {
      const samples = await decode(audio, mimeType);
      const window = PREVIEW_SECONDS * SPEECH_SAMPLE_RATE;
      const recent = samples.length > window ? samples.slice(-window) : samples;
      const { text } = await transcriber.transcribe(recent, { signal, vocabulary });
      const shown = task?.transcribe ? task.transcribe.finish(text).text : text;
      return { text: recent !== samples && shown ? `…${shown}` : shown };
    },

    /**
     * @param {{ task: object, mimeType: string, signal?: AbortSignal, audioId?: string, vocabulary?: readonly string[] }} options
     *   task：这一次的任务（../tasks 的 bind 回的）
     * @returns {Promise<{ text: string, source: string | null }>} 任务收好的成品
     */
    async refine(audio, { task, mimeType, signal, audioId = null, vocabulary = [] }) {
      const startedAt = performance.now();
      let samples;
      try {
        samples = await decode(audio, mimeType);
      } catch (error) {
        throw failed(error?.problem ?? msg("local.undecodable", { reason: problemOf(error) }), error);
      }
      const decodedAt = performance.now();
      let transcript;
      try {
        ({ text: transcript } = await transcriber.transcribe(samples, { signal, audioId, vocabulary }));
      } catch (error) {
        // 云端转写已经分好类了（key 不对、暂时够不着……），原样往上交
        if (error instanceof ModelError) throw error;
        // 自己说得清的（模型还在下载、没装上）照它说的；别的是转写进程或运行库出的错
        const problem =
          error?.problem ?? msg("local.transcribeFailed", { reason: String(error?.message ?? error).slice(0, 200) });
        throw failed(problem, error);
      }
      const transcribedAt = performance.now();
      if (model) record(audioId, Math.round(transcribedAt - decodedAt));
      if (!polisher) {
        // 只记长度和耗时：原文是用户说的话
        log.info("local_transcribed", {
          audio_id: audioId,
          seconds: Math.round((samples.length / SPEECH_SAMPLE_RATE) * 10) / 10,
          decode_ms: Math.round(decodedAt - startedAt),
          transcribe_ms: Math.round(transcribedAt - decodedAt),
          transcript_length: transcript.length,
        });
        return task.transcribe.finish(transcript);
      }
      // 转写的这段时间里用户已经断开了：润色要花钱，不必再发
      signal?.throwIfAborted();
      const refined = await polisher.polish(transcript, { task, signal, audioId, vocabulary });
      // 只记长度和耗时：原文和成品都是用户说的话
      log.info("local_refined", {
        audio_id: audioId,
        seconds: Math.round((samples.length / SPEECH_SAMPLE_RATE) * 10) / 10,
        decode_ms: Math.round(decodedAt - startedAt),
        transcribe_ms: Math.round(transcribedAt - decodedAt),
        polish_ms: Math.round(performance.now() - transcribedAt),
        transcript_length: transcript.length,
      });
      return refined;
    },
  };
}
