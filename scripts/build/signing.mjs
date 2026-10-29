// 打 .app 时用哪张证书签名、拿什么公证。这里只认名字：钥匙串里那张证书的名字（MAC_SIGNING_IDENTITY），
// 和 xcrun notarytool store-credentials 存凭据时起的档案名（MAC_NOTARY_PROFILE），不碰密钥本身。
// 环境变量优先，没给的读本机配置 .machine.env（见 .machine.env.example）：证书名里带着人名和团队号，不进仓库。

import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseEnv } from "node:util";

/** 主程序和小帮手的 entitlements：V8 要 JIT，听写要麦克风。签名库默认的那份还开着摄像头、定位、相册这些，用不上 */
export const ENTITLEMENTS = join(import.meta.dirname, "entitlements.plist");

/**
 * @param {string} packageDir 仓库根目录，.machine.env 在这里
 * @returns {{ identity: string, notaryProfile: string | null } | null} null：没配，打不带身份的本机签名
 */
export function signingConfig(packageDir, env = process.env) {
  const file = join(packageDir, ".machine.env");
  const machine = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const value = (name) => (env[name] ?? machine[name] ?? "").trim() || null;
  const identity = value("MAC_SIGNING_IDENTITY");
  const notaryProfile = value("MAC_NOTARY_PROFILE");
  if (identity === null) {
    if (notaryProfile !== null) {
      throw new Error("配了 MAC_NOTARY_PROFILE 却没配 MAC_SIGNING_IDENTITY：公证之前要先用 Developer ID 签名");
    }
    return null;
  }
  return { identity, notaryProfile };
}

/**
 * 交给 @electron/packager 的 osxSign。hardened runtime、时间戳是签名库默认就开的（公证要求这两样）。
 * Chromium 的几个 helper（Renderer、GPU、Plugin）照签名库默认的给，它们的那几份是照 Chrome 配的
 */
export function osxSignOptions(identity) {
  return {
    identity,
    optionsForFile: (filePath) =>
      /\((Renderer|GPU|Plugin)\)\.app/.test(filePath) ? {} : { entitlements: ENTITLEMENTS },
  };
}

/** 带重试的 codesign 所在的目录（codesign-retry/codesign：时间戳服务偶尔连不上，签不上就重签） */
export const CODESIGN_RETRY_DIR = join(import.meta.dirname, "codesign-retry");

/**
 * 把带重试的 codesign 接到 PATH 最前面。签名库（@electron/osx-sign）按 PATH 找 codesign，又不收 env 参数，
 * 只能改这个进程的 PATH；之后这个进程里再签的（安装包，dmg.mjs）也走它。接过一次不再接
 */
export function useCodesignRetry(env = process.env) {
  const parts = (env.PATH ?? "").split(delimiter);
  if (parts[0] !== CODESIGN_RETRY_DIR) env.PATH = [CODESIGN_RETRY_DIR, ...parts].join(delimiter);
}
