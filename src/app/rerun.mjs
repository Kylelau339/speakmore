import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalizedError, msg, problemOf } from "../i18n/index.mjs";
import { findModel, MODELS } from "../models/catalog.mjs";
import { CHAT_VENDORS, parseChatChoice, parseCustomParams } from "../server/chat/vendors.mjs";
import { keyVendorsOf, taskProblem, usesLocalModel } from "../server/modes.mjs";
import { PROVIDERS, parseModelChoice } from "../server/providers/index.mjs";
import { findTask } from "../server/tasks/index.mjs";
import { resolveSettings, routeOf } from "../storage/settings.mjs";

// 历史里"用另一个模型重跑"：拿存下来的录音按另一条路线再跑一次，结果存成一条新记录。
// 和一次正常听写的区别只有来源：音频不是从悬浮条来的，而是 Recordings 里的那个文件；其余（任务、提示词、收尾、记账）
// 都走同一条路。路线是这一次现砌的，不改设置里正在用的那条。
//
// 选项（重跑对话框要的）由这里算：哪些模型装好了、哪家的 key 在，renderer 不用自己猜。

/**
 * @param {object} deps
 * @param {{ get(id: string): object | null, add(entry: object): void }} deps.history
 * @param {{ keyOf(id: string): { apiKey: string, source: string } | null }} deps.keys
 * @param {{ refineOnce(options: object): Promise<{ text: string, source: string | null }> }} deps.service
 * @param {{ isInstalled(id: string): boolean }} deps.localModels
 * @param {string} deps.settingsFile
 * @param {Record<string, string | undefined>} deps.env
 * @param {string} deps.recordingsDir
 * @param {() => readonly string[]} deps.vocabulary
 * @param {() => void} deps.changed 历史变了：让窗口重读
 * @param {{ info: Function, warn: Function }} deps.log
 * @param {() => string} [deps.uuid]
 * @param {() => Date} [deps.now]
 */
export function createRerun({
  history,
  keys,
  service,
  localModels,
  settingsFile,
  env,
  recordingsDir,
  vocabulary,
  changed,
  log,
  uuid = randomUUID,
  now = () => new Date(),
}) {
  const settings = () => resolveSettings({ file: settingsFile, env });
  const failed = (problem) => ({ ok: false, problem });

  /** 这个模型能不能选：装好了没有；没装好时说清是哪个模型 */
  const localModelOption = (model) => {
    const installed = localModels.isInstalled(model.id);
    return {
      value: model.id,
      name: model.name,
      ready: installed,
      problem: installed ? null : msg("rerun.modelMissing", { model: model.name }),
    };
  };

  /** 润色的选项：清单里每家的每个模型，外加正在用的自定义服务（有地址、有模型名才列，没有就不列） */
  function polishOptions(current) {
    const fromVendors = CHAT_VENDORS.filter(({ id }) => id !== "custom").flatMap((vendor) => {
      const ready = keys.keyOf(vendor.id) !== null;
      return vendor.models.map((model) => ({
        value: `${vendor.id}/${model.id}`,
        name: model.name,
        vendor: vendor.id,
        ready,
        problem: ready ? null : msg("rerun.needKey", { vendor: vendor.name }),
      }));
    });
    if (!current.polish.value.startsWith("custom/")) return fromVendors;
    const vendor = CHAT_VENDORS.find(({ id }) => id === "custom");
    const ready = keys.keyOf("custom") !== null && current.customUrl.value !== "";
    return [
      ...fromVendors,
      {
        value: current.polish.value,
        name: current.polish.value.slice("custom/".length),
        vendor: "custom",
        ready,
        problem: ready ? null : msg("rerun.needKey", { vendor: vendor.name }),
      },
    ];
  }

  return {
    /**
     * 这条记录重跑时能选什么：三种模式各自支不支持这个功能、现在用的是什么、有哪些模型、哪些能选。
     * 记录不在、没有录音时照样回到选项（`hasAudio: false`），让对话框能说清为什么不能重跑
     * @param {string} id
     */
    options(id) {
      const row = history.get(id);
      if (row === null) throw new LocalizedError(msg("history.notFound"));
      const current = settings();
      const hasAudio = row.audioFile !== null && existsSync(join(recordingsDir, row.audioFile));
      const task = findTask(row.kind);
      // 这个功能在这种模式里做不做得了，由任务和路线说（翻译没有离线那一步）
      const supported = (mode) => task !== undefined && taskProblem(routeOf(current, mode), task) === null;

      return {
        id,
        kind: row.kind,
        mode: current.mode.value,
        hasAudio,
        native: {
          supported: supported("native"),
          current: current.model.value,
          models: PROVIDERS.flatMap((provider) =>
            provider.models.map((model) => {
              const ready = keys.keyOf(provider.id) !== null;
              return {
                value: `${provider.id}/${model.id}`,
                name: model.name,
                provider: provider.id,
                ready,
                problem: ready ? null : msg("rerun.needKey", { vendor: provider.name }),
              };
            }),
          ),
        },
        local: {
          supported: supported("local"),
          current: { transcriber: current.transcriber.value, polish: current.polish.value },
          transcribers: MODELS.map(localModelOption),
          polishes: polishOptions(current),
        },
        private: {
          supported: supported("private"),
          current: current.privateTranscriber.value,
          models: MODELS.map(localModelOption),
        },
      };
    },

    /**
     * 按选的那一项重跑，结果存成一条新记录（录音还是原来那个文件）。
     * 选项这里再验一遍，不靠页面：模型装没装、key 在不在、这个功能在那种模式里做不做得了
     * @param {{ id: string, target: { mode: string, model?: string, transcriber?: string, polish?: string } }} request
     * @returns {Promise<{ ok: true, id: string, text: string } | { ok: false, problem: object }>}
     */
    async run({ id, target }) {
      const row = history.get(id);
      if (row === null) return failed(msg("history.notFound"));
      if (row.audioFile === null) return failed(msg("rerun.noRecording"));
      const file = join(recordingsDir, row.audioFile);
      if (!existsSync(file)) return failed(msg("rerun.recordingMissing"));

      const task = findTask(row.kind);
      if (!task) return failed(msg("rerun.unsupportedKind"));
      const current = settings();

      let route;
      let parameters;
      try {
        ({ route, parameters } = routeTo(target, current, row));
      } catch (error) {
        return failed(error instanceof LocalizedError ? error.problem : msg("rerun.badTarget"));
      }
      const unsupported = taskProblem(route, task);
      if (unsupported !== null) return failed(unsupported);
      if (usesLocalModel(route) && !localModels.isInstalled(route.transcriber)) {
        return failed(msg("rerun.modelMissing", { model: findModel(route.transcriber).name }));
      }
      const keyMap = {};
      for (const vendor of keyVendorsOf(route)) {
        const found = keys.keyOf(vendor.id);
        if (found === null) return failed(msg("rerun.needKey", { vendor: vendor.name }));
        keyMap[vendor.id] = found.apiKey;
      }

      let bound;
      try {
        bound = task.bind(parameters);
      } catch (error) {
        return failed(problemOf(error));
      }

      const newId = uuid();
      const startedAt = performance.now();
      try {
        const result = await service.refineOnce({
          route,
          keys: keyMap,
          audio: readFileSync(file),
          task: bound,
          mimeType: "audio/webm",
          audioId: newId,
          vocabulary: vocabulary(),
        });
        history.add({
          id: newId,
          kind: row.kind,
          status: "completed",
          refinedText: result.text,
          sourceText: row.kind === "translate" ? result.source : null,
          outputLanguage: row.kind === "translate" ? row.outputLanguage : null,
          error: null,
          duration: row.duration,
          // 同一条录音：新记录指回原来那个文件，不另存一份
          audioFile: row.audioFile,
          createdAt: now().toISOString(),
        });
        changed();
        log.info("history_rerun", {
          from: id,
          to: newId,
          mode: route.mode,
          ms: Math.round(performance.now() - startedAt),
        });
        return { ok: true, id: newId, text: result.text };
      } catch (error) {
        log.warn("history_rerun_failed", {
          from: id,
          mode: route.mode,
          error: String(error?.message ?? error),
        });
        return failed(problemOf(error));
      }
    },
  };
}

/**
 * 页面上选的那一项 → 这一次走的路线，和要交给任务的参数。不认识的写法抛 LocalizedError
 * @param {{ mode: string, model?: string, transcriber?: string, polish?: string }} target
 * @param {ReturnType<typeof resolveSettings>} settings 现读的设置（自定义服务的地址、思考档位、成品字形都取现在的）
 * @param {object} row 这条历史记录（翻译要它的目标语言）
 */
function routeTo(target, settings, row) {
  const bad = () => new LocalizedError(msg("rerun.badTarget"));
  if (target === null || typeof target !== "object") throw bad();
  const mode = String(target.mode ?? "");
  if (mode === "native") {
    return {
      route: { mode, model: parseModelChoice(String(target.model ?? "")), thinkingLevel: settings.thinking.value },
      parameters: taskParameters(row, settings),
    };
  }
  if (mode === "local") {
    const transcriber = String(target.transcriber ?? "");
    if (!findModel(transcriber)) throw bad();
    return {
      route: {
        mode,
        transcriber,
        polish: parseChatChoice(String(target.polish ?? "")),
        customUrl: settings.customUrl.value || null,
        customParams: settings.customParams.value ? parseCustomParams(settings.customParams.value) : null,
      },
      parameters: taskParameters(row, settings),
    };
  }
  if (mode === "private") {
    const transcriber = String(target.transcriber ?? "");
    if (!findModel(transcriber)) throw bad();
    return {
      route: { mode, transcriber },
      parameters: taskParameters(row, settings),
    };
  }
  throw bad();
}

/** 交给任务的参数：听写带成品字形（设置里现在的），翻译带这条记录原来的目标语言 */
function taskParameters(row, settings) {
  if (row.kind === "translate") {
    if (row.outputLanguage === null) throw new LocalizedError(msg("rerun.badTarget"));
    return { output_language: row.outputLanguage };
  }
  return { output_script: settings.outputScript.value };
}
