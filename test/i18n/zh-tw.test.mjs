import assert from "node:assert/strict";
import { test } from "node:test";
import { traditional } from "../../scripts/dev/make-zh-tw.mjs";
import zhCN from "../../src/i18n/locales/zh-CN.mjs";
import zhTW from "../../src/i18n/locales/zh-TW.mjs";

test("繁体文案就是简体转出来的那份：改了简体文案没重新生成，这里会红（运行 npm run i18n:zh-tw）", () => {
  assert.deepEqual(zhTW, traditional(zhCN));
});

test("转成台湾的字形和说法，opencc 转错的几处修好了", () => {
  assert.equal(traditional("默认设置"), "預設設定");
  assert.equal(traditional("离线：只用本机模型"), "離線：只用本機模型");
  assert.equal(traditional("是只用本机模型"), "是只用本機模型");
  assert.equal(traditional("要先给辅助功能权限"), "要先給輔助功能權限");
  assert.equal(traditional("系统的“显示桌面”"), "系統的「顯示桌面」");
  // 参数、单复数的写法原样留着
  assert.deepEqual(traditional({ one: "{count} 个词", other: "{count} 个词" }), {
    one: "{count} 個詞",
    other: "{count} 個詞",
  });
});
