// 听写协议里本服务端用到的那一部分。
// 消息名和字段名照抄 Typeless 抓包的实测结果（docs/05-network-protocol.md），
// 这样仿刻的两端和逆向文档能一一对上。原版还有上下文等消息，这里没有发送方，就不实现。
// 模式（语音输入、语音翻译）照原版：start_audio 里写内部名（voice_translation），要参数的紧跟一条 set_mode_config，
// 写发给服务端的名字（translation）和参数（output_language）。认不认识这个模式、参数对不对由服务端按任务表查（../tasks）。
// 说完之前可以再发 set_mode_config：按语音输入的键开始、又凑成语音翻译的组合时（升级），换成翻译；
// 悬浮条上临时换了目标语言时，换参数。都以最后一条为准。

/** 3 秒一块实测 14–15 KB，这里留足余量；也用作 WebSocket 单帧上限 */
export const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_AUDIO_ID_LENGTH = 128;
const MAX_MODE_LENGTH = 64;

export const ClientType = Object.freeze({
  START: "start_audio",
  MODE_CONFIG: "set_mode_config",
  CHUNK_INFO: "set_audio_chunk_info",
  END: "end_audio",
});

export const ServerType = Object.freeze({
  STARTED: "audio_session_started",
  CHUNK_RECEIVED: "received_audio_chunk_count",
  /** 录音时的暂定文字（本机识别才有）：同一段录音会来好几条，后一条整个取代前一条，不是接着往下拼 */
  AUDIO_TRANSCRIPT_PARTIAL: "audio_transcript_partial",
  ENDING: "audio_session_ending",
  COMPLETED: "audio_processing_completed",
  PROCESSING_ERROR: "audio_processing_error",
  ERROR: "error",
});

/** 客户端发来的东西不合协议。code 给程序判断，detail 给人看 */
export class ProtocolError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "ProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

/** 服务端消息的外壳。T/M/S 在抓包里只见过这一组取值 */
export function envelope(kind, value) {
  return { K: kind, V: value, T: "json", M: false, S: "done" };
}

function audioIdOf(message) {
  const id = message.audio_id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_AUDIO_ID_LENGTH) {
    throw new ProtocolError("invalid_field", `audio_id 要是 1–${MAX_AUDIO_ID_LENGTH} 个字符的字符串`);
  }
  return id;
}

/** 模式名：可以不写（start_audio 里没写就是语音输入），写了要是一段不长的字符串 */
function modeOf(message, { required }) {
  const mode = message.mode;
  if (mode === undefined && !required) return null;
  if (typeof mode !== "string" || mode.length === 0 || mode.length > MAX_MODE_LENGTH) {
    throw new ProtocolError("invalid_field", `mode 要是 1–${MAX_MODE_LENGTH} 个字符的字符串`);
  }
  return mode;
}

/** set_mode_config 的参数：一个 JSON 对象，没写是空的。各项的意思由任务自己认 */
function parametersOf(message) {
  const parameters = message.parameters ?? {};
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ProtocolError("invalid_field", "parameters 要是 JSON 对象");
  }
  return parameters;
}

function positiveInteger(message, field, max) {
  const value = message[field];
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ProtocolError("invalid_field", `${field} 要是 1–${max} 之间的整数`);
  }
  return value;
}

// 用 Map 而不是对象字面量：消息类型来自外部输入，不能让 "constructor" 这类原型属性名查到东西
const PARSERS = new Map([
  [
    ClientType.START,
    (message) => ({ type: ClientType.START, audioId: audioIdOf(message), mode: modeOf(message, { required: false }) }),
  ],
  [
    ClientType.MODE_CONFIG,
    (message) => ({
      type: ClientType.MODE_CONFIG,
      audioId: audioIdOf(message),
      mode: modeOf(message, { required: true }),
      parameters: parametersOf(message),
    }),
  ],
  [
    ClientType.CHUNK_INFO,
    (message) => ({
      type: ClientType.CHUNK_INFO,
      audioId: audioIdOf(message),
      index: positiveInteger(message, "index", Number.MAX_SAFE_INTEGER),
      size: positiveInteger(message, "size", MAX_CHUNK_BYTES),
    }),
  ],
  [ClientType.END, (message) => ({ type: ClientType.END, audioId: audioIdOf(message) })],
]);

/** 解析并校验一条文本消息，只留下服务端用得到的字段 */
export function parseClientMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_json", "文本帧不是合法的 JSON");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new ProtocolError("invalid_message", "消息必须是 JSON 对象");
  }
  const parse = PARSERS.get(message.type);
  if (!parse) {
    throw new ProtocolError("unknown_type", `不认识的消息类型：${String(message.type).slice(0, 64)}`);
  }
  return parse(message);
}
