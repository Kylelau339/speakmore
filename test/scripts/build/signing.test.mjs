import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
  CODESIGN_RETRY_DIR,
  ENTITLEMENTS,
  osxSignOptions,
  signingConfig,
  useCodesignRetry,
} from "../../../scripts/build/signing.mjs";

/** 一个临时的仓库根目录，.machine.env 写成 content（null 是没有这个文件） */
function repo(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "sm-signing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (content !== null) writeFileSync(join(dir, ".machine.env"), content);
  return dir;
}

const IDENTITY = "Developer ID Application: Someone (TEAM123456)";

test("什么都没配：不签身份，打本机签名", (t) => {
  assert.equal(signingConfig(repo(t, null), {}), null);
  assert.equal(signingConfig(repo(t, "MAC_SIGNING_IDENTITY=\nMAC_NOTARY_PROFILE=\n"), {}), null);
});

test("从 .machine.env 读证书名和公证档案名，带引号、带空格的照读", (t) => {
  const dir = repo(t, `# 本机配置\nMAC_SIGNING_IDENTITY="${IDENTITY}"\nMAC_NOTARY_PROFILE=speakmore-notary\n`);
  assert.deepEqual(signingConfig(dir, {}), { identity: IDENTITY, notaryProfile: "speakmore-notary" });
});

test("环境变量优先于 .machine.env", (t) => {
  const dir = repo(t, `MAC_SIGNING_IDENTITY="${IDENTITY}"\nMAC_NOTARY_PROFILE=speakmore-notary\n`);
  assert.deepEqual(signingConfig(dir, { MAC_NOTARY_PROFILE: "other" }), { identity: IDENTITY, notaryProfile: "other" });
});

test("只签名不公证也行：本机自己用", (t) => {
  assert.deepEqual(signingConfig(repo(t, `MAC_SIGNING_IDENTITY="${IDENTITY}"\n`), {}), {
    identity: IDENTITY,
    notaryProfile: null,
  });
});

test("配了公证却没配证书：说清楚，不悄悄打一个没签名的", (t) => {
  assert.throws(() => signingConfig(repo(t, "MAC_NOTARY_PROFILE=speakmore-notary\n"), {}), /MAC_SIGNING_IDENTITY/);
});

test("Chromium 的几个 helper 照签名库的默认给，其余只给 JIT 和麦克风两项", () => {
  const { identity, optionsForFile } = osxSignOptions(IDENTITY);
  assert.equal(identity, IDENTITY);
  for (const helper of ["Renderer", "GPU", "Plugin"]) {
    assert.deepEqual(optionsForFile(`/x/SpeakMore.app/Contents/Frameworks/SpeakMore Helper (${helper}).app`), {});
  }
  for (const file of [
    "/x/SpeakMore.app",
    "/x/SpeakMore.app/Contents/Frameworks/SpeakMore Helper.app",
    "/x/SpeakMore.app/Contents/Resources/app/build/key-helper",
  ]) {
    assert.deepEqual(optionsForFile(file), { entitlements: ENTITLEMENTS });
  }
  const keys = [...readFileSync(ENTITLEMENTS, "utf8").matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"]);
});

// 签名重试（scripts/build/codesign-retry/codesign）：拿一个假的 codesign 换掉 /usr/bin/codesign 来试
const shell = { skip: process.platform === "win32" && "签名只在 Mac 上做，套的那一层是 shell 脚本" };
const TIMESTAMP = "a.app: The timestamp service is not available.";

/** 假的 codesign：前 fails 次在 stderr 写 message、退出码 1，之后在 stdout 写 signed 加参数；calls() 是被调了几次 */
function fakeCodesign(t, { fails, message }) {
  const dir = mkdtempSync(join(tmpdir(), "sm-codesign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "codesign");
  const calls = join(dir, "calls");
  writeFileSync(
    path,
    `#!/bin/sh\nn=$(cat "${calls}" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"${calls}"\n` +
      `if [ $n -le ${fails} ]; then echo "${message}" >&2; exit 1; fi\necho "signed $*"\n`,
  );
  chmodSync(path, 0o755);
  return { path, calls: () => Number(readFileSync(calls, "utf8")) };
}

const signWith = (fake) =>
  spawnSync(join(CODESIGN_RETRY_DIR, "codesign"), ["--sign", "X", "a.app"], {
    encoding: "utf8",
    env: { ...process.env, CODESIGN_RETRY_REAL: fake.path, CODESIGN_RETRY_WAIT: "0" },
  });

test("签名重试：时间戳服务没连上就重签，签上了照原样交回 codesign 的输出", shell, (t) => {
  const fake = fakeCodesign(t, { fails: 2, message: TIMESTAMP });
  const result = signWith(fake);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "signed --sign X a.app\n");
  assert.equal(fake.calls(), 3);
  assert.match(result.stderr, /时间戳服务没连上/);
});

test("签名重试：最多签 5 次，还签不上就交回最后一次的错", shell, (t) => {
  const fake = fakeCodesign(t, { fails: 99, message: TIMESTAMP });
  const result = signWith(fake);
  assert.equal(result.status, 1);
  assert.equal(fake.calls(), 5);
  assert.match(result.stderr, /The timestamp service is not available/);
});

test("签名重试：别的错不重试，照原样交回", shell, (t) => {
  const fake = fakeCodesign(t, { fails: 99, message: "a.app: No such file or directory" });
  const result = signWith(fake);
  assert.equal(result.status, 1);
  assert.equal(fake.calls(), 1);
  assert.match(result.stderr, /No such file or directory/);
});

test("签名重试：接到 PATH 最前面，签名库调的 codesign 就是它；接过一次不再接", () => {
  const env = { PATH: ["/usr/bin", "/bin"].join(delimiter) };
  useCodesignRetry(env);
  useCodesignRetry(env);
  assert.equal(env.PATH, [CODESIGN_RETRY_DIR, "/usr/bin", "/bin"].join(delimiter));
});
