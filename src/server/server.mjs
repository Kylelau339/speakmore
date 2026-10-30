import { WebSocket, WebSocketServer } from "ws";
import { msg } from "../i18n/index.mjs";
import {
  ClientType,
  envelope,
  MAX_CHUNK_BYTES,
  ProtocolError,
  parseClientMessage,
  ServerType,
} from "./protocol/protocol.mjs";
import { RecordingSession } from "./protocol/session.mjs";
import { findTask, taskOfConfigMode, taskOfMode } from "./tasks/index.mjs";

export const WS_PATH = "/ws/rt_voice_flow";

/** 约 25 分钟的录音；Gemini 内联音频的请求上限是 20 MB，base64 之后仍有余量 */
const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const ERROR_DETAIL_MAX_LENGTH = 300;
/** start_audio 里没写 mode 时当语音输入：0.15 以前的页面、只发 audio_id 的工具 */
const DEFAULT_MODE = findTask("dictate").mode;

/**
 * 启动听写服务。refiner 是"音频进、文字出"的那一步（refine），可以带一个开口时先做准备的 prepare，
 * 由调用方传入，测试时换成假的。两个都带上这一次的任务（tasks/：语音输入、语音翻译），refine 回的是任务收好的成品
 * { text, source }。
 * vocabulary 交出用户的词典（storage/vocabulary.mjs 的 terms）：开口时、整理时各读一次，交给 prepare 和 refine，
 * 各个模型按自己的收法用（原版的词典在它的服务端，我们的在本机，读的地方也在这一层）。说话的任务都先要听懂专有名词，都给
 * onActivity 在页面每发来一条消息（开口、每一块音频、说完）时调用：按需装载的本机模型从最后一次动静起算空闲（app/service.mjs）
 * @param {{ vocabulary?: () => readonly string[], onActivity?: () => void }} options
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startServer({
  host = "127.0.0.1",
  port,
  refiner,
  log,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  vocabulary = () => [],
  onActivity = () => {},
}) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host,
      port,
      path: WS_PATH,
      maxPayload: MAX_CHUNK_BYTES,
      verifyClient: ({ origin }) => isLocalOrigin(origin),
    });
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      wss.on("error", (error) => log.error("server_error", { error: String(error) }));
      resolve({ port: wss.address().port, close: () => closeServer(wss) });
    });
    /** 这一次听写用的词典。读不出来（文件坏了）只是这次不带词典，记一条警告，不耽误听写 */
    const vocabularyFor = (audioId) => {
      try {
        return vocabulary();
      } catch (error) {
        log.warn("vocabulary_unavailable", { audio_id: audioId, error: String(error?.message ?? error) });
        return [];
      }
    };
    wss.on("connection", (socket) =>
      handleConnection(socket, { refiner, log, maxAudioBytes, vocabularyFor, onActivity }),
    );
  });
}

/**
 * 服务只听本机端口，但浏览器里任何网页都能连本机端口，替用户花模型额度。
 * 浏览器发起的连接一定带 Origin，所以只放行没有 Origin 的（本机程序）和 file://（Electron 的本地页面）。
 */
function isLocalOrigin(origin) {
  return origin === undefined || origin === "file://";
}

function closeServer(wss) {
  for (const socket of wss.clients) socket.terminate();
  return new Promise((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())));
}

function handleConnection(socket, { refiner, log, maxAudioBytes, vocabularyFor, onActivity }) {
  /** 正在收音频的那一次录音；end_audio 之后清空，整理在后台继续 */
  let session = null;
  /** 正在进行的整理，连接断开时用来取消 */
  const refining = new Set();
  /**
   * 录音时先听一眼：一次只跑一条，跑的时候来了新块只留最新那一份快照。
   * 预览和正式整理用的是同一个本机模型，不能同时跑：停口时正式整理排在 previewChain 后面
   */
  let previewPending = null;
  let previewChain = Promise.resolve();

  const send = (kind, value) => {
    if (socket.readyState !== WebSocket.OPEN) {
      log.warn("send_skipped", { kind, audio_id: value.audio_id, reason: "连接已关闭" });
      return;
    }
    socket.send(JSON.stringify(envelope(kind, value)));
  };

  const requireSession = (audioId) => {
    if (!session) throw new ProtocolError("no_session", "还没有 start_audio");
    if (audioId !== undefined && audioId !== session.audioId) {
      throw new ProtocolError("audio_id_mismatch", `当前录音是 ${session.audioId}，消息里是 ${audioId}`);
    }
    return session;
  };

  const onText = (text) => {
    const message = parseClientMessage(text);
    switch (message.type) {
      case ClientType.START: {
        if (session) {
          // 客户端取消录音时不发 end_audio，直接开始下一次
          log.info("session_abandoned", { audio_id: session.audioId, chunks: session.chunkCount });
        }
        const definition = taskOfMode(message.mode ?? DEFAULT_MODE);
        if (!definition) {
          session = null;
          throw new ProtocolError("unknown_mode", `不认识的模式：${message.mode}`);
        }
        session = new RecordingSession(message.audioId, { maxTotalBytes: maxAudioBytes, definition });
        // 新的一次录音：上一次的预览已经过时，别让它在跑完之后冒出来
        previewPending = null;
        // 不要参数的任务开口就定下来；要参数的（翻译要目标语言）等紧跟着的 set_mode_config
        if (definition.parameters.length === 0) settle(session, {});
        send(ServerType.STARTED, { audio_id: message.audioId, start_time: Date.now() });
        break;
      }
      case ClientType.MODE_CONFIG: {
        // 以 set_mode_config 写的为准（原版发给服务端的就是这一个）：开口时是语音输入、说着话升级成翻译的，
        // 这里换成翻译；同一个模式再发一次是换参数（悬浮条上临时换了目标语言）
        const current = requireSession(message.audioId);
        const definition = taskOfConfigMode(message.mode);
        if (!definition) throw new ProtocolError("unknown_mode", `不认识的模式：${message.mode}`);
        current.definition = definition;
        current.task = null;
        settle(current, message.parameters);
        break;
      }
      case ClientType.CHUNK_INFO:
        requireSession(message.audioId).announceChunk(message);
        break;
      case ClientType.END: {
        const finished = requireSession(message.audioId);
        session = null;
        // 不再排新的预览；正在跑的那一眼让它跑完，正式整理要排在它后面
        previewPending = null;
        // 整理要等上游一两秒，不能卡住这条连接上后面的消息
        finish(finished).catch((error) => failConnection(error));
        break;
      }
    }
  };

  /**
   * 按参数定下这一次的做法，并让模型那边先备好要用的东西（Gemini 建提示词缓存），说完整理时就用得上。
   * 参数不对（翻译写了不认识的语言）是协议错误。准备不等它；备不好只是这一次贵一点，记一笔就算了
   */
  const settle = (current, parameters) => {
    try {
      current.task = current.definition.bind(parameters);
    } catch (error) {
      throw new ProtocolError("invalid_parameters", String(error?.message ?? error));
    }
    const { task } = current;
    Promise.resolve()
      .then(() => refiner.prepare?.({ task, vocabulary: vocabularyFor(current.audioId) }))
      .catch((error) => log.warn("prepare_failed", { audio_id: current.audioId, error: String(error?.message) }));
  };

  /**
   * 收完一块就试着听一眼：只有语音输入、本机识别（refiner 带 preview）才做。
   * 排队用一条链：来新块时只把最新的快照放进去，前面排着的链跑起来发现没活就立刻让开
   */
  const schedulePreview = (current) => {
    if (typeof refiner.preview !== "function") return;
    if (current.definition.id !== "dictate") return;
    if (current.chunkCount === 0) return;
    // 词典一次录音读一次：每块都读没必要，文件坏了还会每块记一条警告
    current.previewVocabulary ??= vocabularyFor(current.audioId);
    previewPending = {
      current,
      audio: current.merge(),
      mimeType: current.mimeType,
      vocabulary: current.previewVocabulary,
      // 这一块到的时候的任务：要繁体的话转字形这一步在任务的收尾里，预览也得按同一份来
      task: current.task,
    };
    previewChain = previewChain.then(runPreview);
  };

  /** 跑一眼预览。失败只是这一次没文字可看，不影响正式整理，也不写历史 */
  const runPreview = async () => {
    const job = previewPending;
    if (!job) return;
    previewPending = null;
    try {
      const { text } = await refiner.preview(job.audio, {
        mimeType: job.mimeType,
        audioId: job.current.audioId,
        vocabulary: job.vocabulary,
        task: job.task,
      });
      // 跑这段时间里录音结束了、换了新的一次、或者切成了语音翻译：这份文字已经过时，不发
      if (job.current !== session || session.definition.id !== "dictate") return;
      if (typeof text === "string" && text.length > 0) {
        send(ServerType.AUDIO_TRANSCRIPT_PARTIAL, { audio_id: session.audioId, text });
      }
    } catch (error) {
      // 同一次录音只记第一条，免得每三秒刷一条
      if (!job.current.previewFailed) {
        job.current.previewFailed = true;
        log.warn("preview_failed", { audio_id: job.current.audioId, error: String(error?.message ?? error) });
      }
    }
  };

  const onChunk = (data) => {
    const current = requireSession();
    const { index, size } = current.addChunk(data);
    send(ServerType.CHUNK_RECEIVED, { index, server_t: Date.now(), size });
    schedulePreview(current);
  };

  const finish = async (finished) => {
    const context = {
      audio_id: finished.audioId,
      task: finished.definition.id,
      chunks: finished.chunkCount,
      bytes: finished.totalBytes,
    };
    if (finished.chunkCount === 0) {
      log.warn("no_audio", context);
      send(ServerType.PROCESSING_ERROR, {
        audio_id: finished.audioId,
        code: "no_audio",
        detail: "no audio received",
        problem: msg("voice.noAudio"),
      });
      return;
    }
    if (finished.task === null) {
      // 要参数的模式（翻译）没等到 set_mode_config：客户端的毛病，说清楚，不拿默认的参数硬做
      log.warn("mode_config_missing", context);
      send(ServerType.PROCESSING_ERROR, {
        audio_id: finished.audioId,
        code: "mode_config_missing",
        detail: `${finished.definition.mode} 要先发 set_mode_config（${finished.definition.parameters.join("、")}）`,
      });
      return;
    }
    send(ServerType.ENDING, {
      audio_id: finished.audioId,
      total_chunks: finished.chunkCount,
      completed_chunks: finished.chunkCount,
      failed_chunks: 0,
    });

    // 预览还在跑就先等它跑完：同一个本机模型不能同时跑两份推理，正式整理排队跟在后面
    await previewChain;

    const abort = new AbortController();
    refining.add(abort);
    const startedAt = performance.now();
    const vocabulary = vocabularyFor(finished.audioId);
    try {
      const result = await refiner.refine(finished.merge(), {
        task: finished.task,
        mimeType: finished.mimeType,
        signal: abort.signal,
        audioId: finished.audioId,
        vocabulary,
      });
      // 日志只记长度：成品是用户说的话，不该留在日志里
      log.info("refined", {
        ...context,
        refine_ms: Math.round(performance.now() - startedAt),
        text_length: result.text.length,
        ...(result.source === null ? {} : { source_length: result.source.length }),
        // 词典里有几个词（每一跳送了几个记在各跳的 vocabulary_fitted）
        vocabulary_terms: vocabulary.length,
      });
      // 后五项在普通听写里实测都是 null，照原样带上，客户端按同一套字段解析。
      // source_text 是我们加的：翻译时他说的那段话（存进历史），语音输入是 null
      send(ServerType.COMPLETED, {
        audio_id: finished.audioId,
        refined_text: result.text,
        source_text: result.source,
        status: true,
        run_index: 1,
        web_metadata: null,
        delivery: null,
        action: null,
        user_prompt: null,
        external_action: null,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        log.info("refine_cancelled", { ...context, reason: "连接已断开" });
        return;
      }
      log.error("refine_failed", {
        ...context,
        refine_ms: Math.round(performance.now() - startedAt),
        error: String(error?.stack ?? error),
        // 模型层的错误（ModelError）给用户的是 problem，模型回的原文（已抹掉 key）在 detail 里
        ...(error?.detail ? { model_said: error.detail.slice(0, 1_000) } : {}),
        ...(error?.origin ? { origin: error.origin.slice(0, 2_000) } : {}),
      });
      // 原版只有 code 和 detail。problem 是我们加的：给用户看的那句话（msg 或原话），由悬浮条按界面语言翻
      send(ServerType.PROCESSING_ERROR, {
        audio_id: finished.audioId,
        code: "refine_failed",
        detail: String(error?.message ?? error).slice(0, ERROR_DETAIL_MAX_LENGTH),
        ...(error?.problem ? { problem: error.problem } : {}),
      });
    } finally {
      refining.delete(abort);
    }
  };

  /** 协议之外的错误说明服务端自己有 bug：记下来并断开，不带着坏状态继续 */
  const failConnection = (error) => {
    log.error("connection_failed", { audio_id: session?.audioId, error: String(error?.stack ?? error) });
    socket.close(1011, "internal error");
  };

  socket.on("message", (data, isBinary) => {
    onActivity();
    try {
      if (isBinary) onChunk(data);
      else onText(data.toString("utf8"));
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        failConnection(error);
        return;
      }
      log.warn("protocol_error", { audio_id: session?.audioId, code: error.code, detail: error.detail });
      send(ServerType.ERROR, { audio_id: session?.audioId ?? null, code: error.code, detail: error.detail });
    }
  });

  socket.on("error", (error) => log.warn("socket_error", { audio_id: session?.audioId, error: String(error) }));

  socket.on("close", (code) => {
    if (session) log.info("session_abandoned", { audio_id: session.audioId, chunks: session.chunkCount, code });
    session = null;
    previewPending = null;
    for (const abort of refining) abort.abort();
  });
}
