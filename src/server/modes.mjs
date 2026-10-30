import { LocalizedError, msg } from "../i18n/index.mjs";
import { createCloudTranscriber } from "./asr/cloud/transcriber.mjs";
import { cloudTranscriberOf, findCloudTranscriber } from "./asr/cloud/vendors.mjs";
import { findChatVendor, formatChatChoice } from "./chat/vendors.mjs";
import { findProvider, formatModelChoice } from "./providers/index.mjs";
import { createLocalRefiner } from "./refine/local.mjs";
import { createChatPolisher } from "./refine/polisher.mjs";
import { createModelRefiner } from "./refine/refiner.mjs";

// 识别的三种模式，用户在设置里选一种（mode）。三种平级，谁也不是谁的退路：
//   native   原生，一跳：录音直接交给收音频的大模型，一次请求出成品（refine/refiner.mjs）
//   local    转写加润色，两跳：先把录音转成原文（本机的小模型，或云端的语音识别模型），再交给任意纯文字大模型润色
//            （refine/local.mjs）。id 沿用 0.6 起的 local：设置文件里存的就是它
//   private  数据隐私，一跳：只用本机模型转写，原文直接交出，不润色、不上传任何东西，也不要任何一家的 key
//            （refine/local.mjs 不接润色器）
// 三种模式要选的东西不一样：native 选一个收音频的模型；local 第一跳选转写模型、第二跳选润色的厂商和模型；
// private 选一个本机模型（和 local 的第一跳分开存）。
// 先定模式，再在模式里选模型，各管各的（app/modes.mjs）。
// 装出来的都是同一个接口（warmUp、prepare、refine），服务端只认这个接口。
// 让模型做什么（语音输入、语音翻译……）是另一个维度，由每次说话交进来的任务定（tasks/）。每种模式说自己的成品
// 出在哪一步（step）：直出在 native 那一步，混合在 polish（整理）那一步，离线只有 transcribe（转文字）这一步。
// 任务在那一步上有做法，这种模式就能做它；没有就做不了（supportsTask），不按任务的名字判断。
//
// "路线"（route）写清这一条要用哪些东西，由设置或环境变量拼出来：
//   { mode: "native", model: { provider, model }, thinkingLevel }
//   { mode: "local", transcriber: 本地模型的 id 或 云端的 厂商/模型, polish: { vendor, model }, customUrl, customParams }
//   （customUrl、customParams 是自定义服务的地址和额外参数，没填是 null）
//   { mode: "private", transcriber: 本地模型的 id }
// 第一跳是本机模型时，转写器（装着模型的子进程，asr/host.mjs）由调用方装好交进来：它的去留跟着模型走，
// 换一把 key、换一家润色都不该把模型重装一遍。第一跳是云端模型时，这里按路线装（asr/cloud/transcriber.mjs）。
//
// 一条路线可能要用两家的 key：第一跳交给云端（比如百炼）、润色交给另一家（比如 DeepSeek）。
// keyVendorsOf 列出这条路线要的每一家，主的那家（keyVendorOf：原生是收音频的那家，local 是润色的那家）在最后；
// 装 refiner 时 keys 按家给齐（{ 厂商 id: key }），apiKey 是主的那家的，只给一家时可以只写它。

/** 设置里没写时润色交给谁 */
export const DEFAULT_POLISH = "deepseek";

export const MODES = Object.freeze([
  Object.freeze({
    id: "native",
    /** 成品出在哪一步：任务要在这一步上有做法（tasks/index.mjs 的 steps） */
    step: "native",
    /** 要用谁家的 key，主的那家在最后 */
    keyVendors: (route) => [findProvider(route.model.provider)],
    describe: (route) => formatModelChoice(route.model),
    create: ({ route, keys, log, onCall }) =>
      createModelRefiner({
        choice: route.model,
        apiKey: keys[route.model.provider],
        thinkingLevel: route.thinkingLevel,
        log,
        onCall,
      }),
  }),
  Object.freeze({
    id: "local",
    step: "polish",
    keyVendors(route) {
      const cloud = cloudTranscriberOf(route.transcriber);
      const polish = findChatVendor(route.polish.vendor);
      return cloud && cloud.vendor !== polish.id ? [findCloudTranscriber(cloud.vendor), polish] : [polish];
    },
    describe: (route) => `${route.transcriber} → ${formatChatChoice(route.polish)}`,
    async create({ route, keys, transcriber, log, onCall, decode, fetch }) {
      const cloud = cloudTranscriberOf(route.transcriber);
      if (!cloud && !transcriber) throw new Error(`本地转写链路要先装好转写器（${route.transcriber}）`);
      const firstHop = cloud
        ? await createCloudTranscriber({ choice: cloud, apiKey: keys[cloud.vendor], log, onCall, fetch })
        : transcriber;
      const polisher = await createChatPolisher({
        choice: route.polish,
        customUrl: route.customUrl,
        customParams: route.customParams,
        apiKey: keys[route.polish.vendor],
        log,
        onCall,
        fetch,
      });
      const refiner = createLocalRefiner({
        transcriber: firstHop,
        polisher,
        log,
        // 云端转写自己记账，本机转写这一笔由 local.mjs 记
        model: cloud ? null : route.transcriber,
        onCall,
        ...(decode ? { decode } : {}),
      });
      if (!cloud) return refiner;
      // 第一跳在云端：预览等于每隔几秒把录音再传一次，不做，也不让上层误以为能做
      return {
        ...refiner,
        preview: null,
        // 验证时两跳都要验：第一跳的 key、模型也可能不对
        warmUp: () => Promise.all([firstHop.warmUp(), refiner.warmUp()]).then(() => {}),
      };
    },
  }),
  Object.freeze({
    id: "private",
    step: "transcribe",
    // 不要任何一家的 key
    keyVendors: () => [],
    describe: (route) => route.transcriber,
    async create({ route, transcriber, log, onCall, decode }) {
      // 设置那一层已经只认本机模型（storage/settings.mjs），这里再守一道：数据隐私模式绝不往外发录音
      if (cloudTranscriberOf(route.transcriber)) {
        throw new Error(`数据隐私模式只用本机模型，不能交给云端（${route.transcriber}）`);
      }
      if (!transcriber) throw new Error(`数据隐私模式要先装好转写器（${route.transcriber}）`);
      return createLocalRefiner({
        transcriber,
        polisher: null,
        log,
        model: route.transcriber,
        onCall,
        ...(decode ? { decode } : {}),
      });
    },
  }),
]);

export const DEFAULT_MODE = "native";

/** @returns {(typeof MODES)[number] | null} 大小写不论 */
export function findMode(id) {
  const wanted = String(id ?? "").toLowerCase();
  return MODES.find((mode) => mode.id === wanted) ?? null;
}

/** 用户写的链路 → 它的 id。写错了就抛 LocalizedError，说能填什么 */
export function parseMode(value) {
  const mode = findMode(String(value ?? "").trim());
  if (!mode) {
    throw new LocalizedError(msg("settings.oneOf", { choices: MODES.map(({ id }) => id).join(" / ") }));
  }
  return mode.id;
}

/** 这条路线要用的每一家：[{ id, name, keyEnv, keyPage }]，主的那家在最后，同一家只出现一次；数据隐私模式是空的 */
export const keyVendorsOf = (route) => findMode(route.mode).keyVendors(route);

/** 这条路线主要用谁家的 key（原生是收音频的那家，local 是润色的那家）；数据隐私模式不用 key，是 undefined */
export const keyVendorOf = (route) => keyVendorsOf(route).at(-1);

/** 要不要本机模型：数据隐私模式要；local 模式第一跳写的不是云端的 厂商/模型时要 */
export const usesLocalModel = (route) =>
  route.mode === "private" || (route.mode === "local" && cloudTranscriberOf(route.transcriber) === null);

/**
 * 这条路线做不做得了这个任务：任务在这种模式出成品的那一步上有没有做法
 * @param {object} route
 * @param {{ steps: readonly string[] }} task 任务的定义（tasks/index.mjs 的 TASKS 的一项）
 */
export const supportsTask = (route, task) => task.steps.includes(findMode(route.mode).step);

/**
 * 这条路线做不了这个任务时说的那句话（离线方式不支持语音翻译）；做得了是 null。按键时主进程拿它拦，服务端也拿它挡
 * @param {object} route
 * @param {{ id: string, steps: readonly string[] }} task 任务的定义
 */
export const taskProblem = (route, task) => (supportsTask(route, task) ? null : unsupported(route.mode, task.id));

/** 某种模式不支持某件事：离线方式不支持语音翻译 */
const unsupported = (mode, task) =>
  msg("voice.unsupported", { mode: msg(`plaza.modes.${mode}`), feature: msg(`actions.${task}.name`) });

/** 一句话说清这条路线，给日志和状态用 */
export const describeRoute = (route) => `${route.mode}: ${findMode(route.mode).describe(route)}`;

/**
 * 按路线装出一个 refiner。
 * @param {object} options
 * @param {object} options.route
 * @param {string} [options.apiKey] 主的那家的 key（keyVendorOf）。路线只要一家时写它就够了
 * @param {Record<string, string>} [options.keys] 这条路线要的每一家的 key（keyVendorsOf），按厂商 id
 * @param {object} [options.transcriber] 第一跳是本机模型时要的转写器（asr/host.mjs 的 spawnTranscriber）
 */
export async function createModeRefiner({ apiKey, keys, ...options }) {
  const primary = keyVendorOf(options.route);
  const all = { ...keys, ...(apiKey === undefined || primary === undefined ? {} : { [primary.id]: apiKey }) };
  const mode = findMode(options.route.mode);
  const refiner = await mode.create({ ...options, keys: all });
  // 这种模式做不了的任务在这里挡下，说清是哪种模式不支持什么：按键时主进程已经先挡过一道（supportsTask），
  // 这里是服务端自己的一道，命令行、单独启动的服务端、老版本的页面发来的也挡得住
  return {
    ...refiner,
    async prepare(prepared) {
      if (prepared.task[mode.step]) await refiner.prepare(prepared);
    },
    async refine(audio, refining) {
      if (!refining.task[mode.step]) throw new LocalizedError(unsupported(mode.id, refining.task.id));
      return refiner.refine(audio, refining);
    },
  };
}
