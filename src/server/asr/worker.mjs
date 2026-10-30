import { pathToFileURL } from "node:url";
import { loadTranscriber } from "./engines/index.mjs";

// 转写进程的那一头：在 host.mjs 开出来的子进程里装上模型，按父进程发来的消息逐段转写。
// 消息（Node 的 IPC，advanced 序列化，Float32Array 原样过去）：
//   父 → 子  { type: "load", model, dir, options }      装模型，只发一次
//            { type: "transcribe", id, samples, vocabulary }   samples：16 kHz 单声道的 Float32Array；vocabulary：用户词典
//            { type: "dispose" }                        卸掉模型、退出
//   子 → 父  { type: "loaded", backend, loadMs, warmupMs } 或 { type: "failed", message }
//            warmupMs：装上后在显卡上预热花了多久（含在 loadMs 里），不用预热的是 null
//            { type: "result", id, text } 或 { type: "error", id, message }

/**
 * @param {{ on: Function, send: Function, exit?: Function }} channel 子进程自己（process），测试时换成假的
 * @param {typeof loadTranscriber} [load]
 */
export function serveTranscriber(channel, load = loadTranscriber) {
  let transcriber = null;
  channel.on("message", async (message) => {
    switch (message?.type) {
      case "load": {
        const startedAt = performance.now();
        try {
          transcriber = await load({ model: message.model, dir: message.dir, options: message.options });
          channel.send({
            type: "loaded",
            backend: transcriber.backend,
            loadMs: Math.round(performance.now() - startedAt),
            warmupMs: transcriber.warmupMs ?? null,
          });
        } catch (error) {
          channel.send({ type: "failed", message: String(error?.stack ?? error) });
        }
        break;
      }
      case "transcribe": {
        try {
          if (!transcriber) throw new Error("模型还没装上");
          const { text } = await transcriber.transcribe(message.samples, { vocabulary: message.vocabulary ?? [] });
          channel.send({ type: "result", id: message.id, text });
        } catch (error) {
          channel.send({ type: "error", id: message.id, message: String(error?.stack ?? error) });
        }
        break;
      }
      case "dispose":
        transcriber?.dispose();
        transcriber = null;
        channel.exit?.(0);
        break;
      default:
        channel.send({ type: "error", id: message?.id ?? null, message: `不认识的消息：${message?.type}` });
    }
  });
}

// 被 host.mjs 当成子进程启动时才开始听；被测试 import 时不动
if (process.send && import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveTranscriber({
    on: (event, handler) => process.on(event, handler),
    send: (m) => process.send(m),
    exit: process.exit,
  });
  // 父进程没了（崩溃、被强行结束）时跟着走，不留一个占着一两 GB 内存的孤儿进程
  process.on("disconnect", () => process.exit(0));
}
