import { ACTIONS } from "../../hotkeys/actions.mjs";
import { settingNameOf } from "../../hotkeys/settings.mjs";
import { findLocale, msg, problemOf, SYSTEM_LOCALE } from "../../i18n/index.mjs";
import { findModel } from "../../models/catalog.mjs";
import { findProvider, parseModelChoice } from "../../server/providers/index.mjs";
import { findVendor } from "../../server/vendors.mjs";
import { ensureHome } from "../../storage/paths.mjs";
import { overridingEnv, SETTINGS, saveSetting, settingName, unsetSetting } from "../../storage/settings.mjs";
import { THEMES } from "../../themes/index.mjs";
import {
  ConfigError,
  currentSettings,
  noPositionals,
  PACKAGED_RELAUNCH,
  parse,
  progressOf,
  renderOptions,
  UsageError,
} from "../common.mjs";
import { renderConfig, renderThemes, themeTitle } from "../render/settings.mjs";

// 设置：speakmore config、theme，以及打开设置的 speakmore settings。
// 主题、语言、下载源、热键改了当场生效（让正在运行的那个重新读一遍设置），别的要重启后台。
// config set 是手动改设置的后门：只按存设置的规矩查写法，不经过模式那一层（app/modes.mjs）的检查，
// 不在那种模式里的设置也照写、切过去时才用上。平时换模式、换模型走 mode、model、transcriber、polish。

/**
 * 设置改完之后让它生效：在运行就重启，并看重启之后的结果。
 * @param {string | null} undo 这次改动怎么撤回（一条命令），重启后不能用时告诉用户；没有可撤回的时为 null
 * @returns {Promise<number>} 退出码
 */
export async function applySettings(io, undo) {
  const current = await io.daemon.status();
  const { t } = io;
  if (current === null) {
    io.out(t("cli.config.nextLaunch"));
    return 0;
  }
  if (current.packaged) {
    // 从这里重启的话，起来的会是终端启动的那一个，不是它
    io.out(t("cli.config.packaged", { relaunch: PACKAGED_RELAUNCH }));
    return 0;
  }
  io.out(t("cli.config.restarting"));
  await io.daemon.stop();
  const restarted = await io.daemon.start({ onProgress: progressOf(io) });
  // 0.3 的后台应用不报 provider，那时只有 Gemini
  const provider = restarted.provider
    ? findVendor(restarted.provider)
    : findProvider(parseModelChoice(restarted.model ?? "gemini").provider);
  // 模型名、思考档位写得对不对，要问过那一家才知道
  const named = { provider: provider.name, id: provider.id, problem: restarted.key.problem };
  const failed = (key) => {
    io.err(t(key, named));
    if (undo) io.err(t("cli.config.undo", { undo }));
    return 1;
  };
  if (restarted.key.state === "rejected" && restarted.key.cause === "other")
    return failed("cli.config.restartedBroken");
  // 那一家的 key 不能用（存着的过期了、环境变量里的不对）
  if (restarted.key.state === "rejected") return failed("cli.config.restartedKeyBad");
  // 换成了还没有 key 的那一家（config set model 不先问 key）
  if (restarted.key.state === "missing" || restarted.key.state === "unreadable") {
    return failed("cli.config.restartedNoKey");
  }
  if (restarted.starting) io.out(t("cli.config.restartedStarting"));
  else if (restarted.key.verified === false) io.out(t("cli.config.restartedUnverified", named));
  else io.out(t("cli.config.applied"));
  // local 要的本机模型还没下载（config set 不检查）：说怎么下，不替用户下
  const local = restarted.localModel;
  if (local?.state === "missing" && !local.total) {
    io.out(t("cli.local.notDownloadedHint", { model: findModel(local.model)?.name ?? local.model, id: local.model }));
  }
  return 0;
}

/** 语言写成什么："跟随系统"，或者那种语言自己的名字 */
const languageTitle = (t, value) =>
  value === SYSTEM_LOCALE ? t("language.system") : (findLocale(value)?.name ?? value);

/** 当场生效的几项：让正在运行的那个重新读一遍设置用哪条命令，它回答里的哪一项，没换成时怎么说 */
const LIVE = {
  theme: {
    command: "reload-theme",
    overridden: (t, applied, variable) =>
      t("cli.config.themeOverridden", { theme: themeTitle(t, applied.theme), variable }),
  },
  language: {
    command: "reload-language",
    overridden: (t, applied, variable) =>
      t("cli.config.languageOverridden", { language: languageTitle(t, applied.language), variable }),
  },
  modelSource: {
    command: "reload-model-source",
    overridden: (t, applied, variable) =>
      t("cli.config.modelSourceOverridden", { source: t(`modelSources.${applied.modelSource}`), variable }),
  },
  // 每个动作的热键：后台重读设置、重发绑定表、换上新键帽（docs/hotkey-research.md 5.2）
  ...Object.fromEntries(
    ACTIONS.map((action) => {
      const name = settingNameOf(action);
      const overridden = (t, applied, variable) =>
        t("cli.config.hotkeyOverridden", { hotkey: t.text(SETTINGS[name].label(applied[name])), variable });
      return [name, { command: "reload-hotkeys", overridden }];
    }),
  ),
};

/**
 * 主题、语言、下载源、热键改完之后让它生效。这几项不用重启：让正在运行的那个重新读一遍设置，开着的窗口当场换。
 * @param {keyof typeof LIVE} name
 * @param {string} wanted 设置里现在写的值
 * @returns {Promise<number>} 退出码
 */
async function applyLive(io, name, wanted) {
  if ((await io.daemon.status()) === null) {
    io.out(io.t("cli.config.nextLaunch"));
    return 0;
  }
  let applied;
  try {
    applied = await io.daemon.request(LIVE[name].command);
  } catch (error) {
    // 正在运行的是升级之前启动的那一个，还不认识这条命令（它的回话是中文的，0.5 以前一直这么说）
    if (!/^不认识的命令/.test(error?.message ?? "")) throw error;
    io.out(io.t("cli.config.oldDaemonLive"));
    return 0;
  }
  if (applied[name] === wanted) io.out(io.t("cli.config.appliedLive"));
  // 盖着它的是改名之前的环境变量时，回答里会说是哪一个（env）
  else io.out(LIVE[name].overridden(io.t, applied, applied.env?.[name] ?? SETTINGS[name].env));
  return 0;
}

/** 模式那一层管的几项平时用哪个命令换：那些命令先检查能不能用，不行就不换 */
const MODE_COMMANDS = {
  mode: "speakmore mode",
  model: "speakmore model",
  transcriber: "speakmore transcriber",
  polish: "speakmore polish",
  customUrl: "speakmore polish",
  customParams: "speakmore polish",
};

/** config set 写了模式那一层的设置：说平时走哪条路；这一项不属于现在的模式时，说切过去才用上 */
function noteModeSetting(io, name) {
  if (Object.hasOwn(MODE_COMMANDS, name)) io.out(io.t("cli.config.modeCommand", { command: MODE_COMMANDS[name] }));
  const { ofMode } = SETTINGS[name];
  const current = currentSettings(io).mode.value;
  if (ofMode && ofMode !== current) io.out(io.t("cli.config.otherMode", { current, mode: ofMode }));
}

/** 命令行写的设置名换成现在的（改名之前的照样认，config set hotkey）。不认识的照 config 的规矩报错 */
function currentName(name) {
  try {
    return settingName(name);
  } catch (error) {
    throw new ConfigError(problemOf(error), { cause: error });
  }
}

/**
 * 校验并存下一项设置
 * @returns {{ value: string, warnings: object[] }} 规整后的值，和能存但要提醒的话（saveSetting）
 */
export function storeSetting(io, name, value) {
  try {
    // 可能是这个目录里的第一个文件
    ensureHome(io.paths);
    return saveSetting(io.paths.settingsFile, name, value);
  } catch (error) {
    throw new ConfigError(problemOf(error), { cause: error });
  }
}

export function warnIfEnvOverrides(io, name) {
  const variable = overridingEnv(name, io.env);
  if (variable !== null) io.out(io.t("cli.config.envWarning", { variable }));
}

export async function config(args, io) {
  const [action, name, value, ...extra] = parse(args).positionals;

  if (action === undefined) {
    io.out(renderConfig({ settings: currentSettings(io), paths: io.paths }, renderOptions(io)));
    return 0;
  }
  if (action === "set" && name !== undefined && value !== undefined && extra.length === 0) {
    const current = currentName(name);
    const { value: saved, warnings } = storeSetting(io, current, value);
    io.out(io.t("cli.config.changed", { name: current, value: saved }));
    for (const warning of warnings) io.out(io.t("cli.config.warning", { warning }));
    warnIfEnvOverrides(io, current);
    noteModeSetting(io, current);
    if (Object.hasOwn(LIVE, current)) return applyLive(io, current, saved);
    return applySettings(io, `speakmore config unset ${current}`);
  }
  if (action === "unset" && name !== undefined && value === undefined) {
    const current = currentName(name);
    try {
      unsetSetting(io.paths.settingsFile, current);
    } catch (error) {
      throw new ConfigError(problemOf(error), { cause: error });
    }
    const { default: initial } = SETTINGS[current];
    io.out(io.t("cli.config.unset", { name: current, value: initial }));
    return Object.hasOwn(LIVE, current) ? applyLive(io, current, initial) : applySettings(io, null);
  }
  throw new UsageError(msg("cli.syntax.config"));
}

export async function theme(args, io) {
  const [wanted, ...extra] = parse(args).positionals;
  if (extra.length > 0) throw new UsageError(msg("cli.syntax.theme"));
  if (wanted === undefined) {
    io.out(renderThemes({ themes: THEMES, setting: currentSettings(io).theme }, renderOptions(io)));
    return 0;
  }
  const { value: saved } = storeSetting(io, "theme", wanted);
  io.out(io.t("cli.config.themeChanged", { theme: themeTitle(io.t, saved) }));
  warnIfEnvOverrides(io, "theme");
  return applyLive(io, "theme", saved);
}

export async function settings(args, io) {
  noPositionals(parse(args).positionals, "settings");
  if ((await io.daemon.status()) === null) {
    io.err(io.t("cli.config.notRunning"));
    return 1;
  }
  await io.daemon.request("show-settings");
  io.out(io.t("cli.config.settingsOpened"));
  return 0;
}
