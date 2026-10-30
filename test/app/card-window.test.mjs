import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardWindow } from "../../src/app/lookup/card-window.mjs";

// 划词卡片平时是隐藏的，按热键才露出来。隐藏的页面被 Chromium 按后台页降频的话，按键那条消息会压到几秒后才处理，
// 卡片看起来像没反应（悬浮条是同一个毛病，10-30 实测条最长 13 秒才出来）。这里盯着窗口建出来时带没带上那个开关。

/** 假的窗口对象：卡片建好以后会调这些方法，测试里什么都不做 */
function stubWindow() {
  return {
    webContents: { on() {}, send() {}, reload() {} },
    setIgnoreMouseEvents() {},
    setVisibleOnAllWorkspaces() {},
    setAlwaysOnTop() {},
    setFullScreenable() {},
    setHiddenInMissionControl() {},
    setBounds() {},
    getBounds: () => ({ x: 0, y: 0 }),
    isVisible: () => false,
    isDestroyed: () => false,
    showInactive() {},
    moveTop() {},
    hide() {},
    destroy() {},
    loadFile() {},
  };
}

const fakeScreen = {
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  screenToDipRect: (_window, rect) => rect,
  dipToScreenRect: (_window, rect) => rect,
};

const fakeIpcMain = { on() {} };
const quietLog = { info() {}, warn() {}, error() {} };

test("划词卡片：隐藏时不让 Chromium 降频，原有的 preload、沙箱、上下文隔离都还在", () => {
  let built = null;
  function BrowserWindow(options) {
    built = options;
    return stubWindow();
  }
  const webPreferences = { preload: "preload.cjs", sandbox: true, contextIsolation: true };
  createCardWindow({
    BrowserWindow,
    screen: fakeScreen,
    ipcMain: fakeIpcMain,
    sourceDir: "/src",
    webPreferences,
    windows: true,
    capture() {},
    onAct() {},
    onGone() {},
    log: quietLog,
  });
  assert.equal(built.webPreferences.backgroundThrottling, false);
  // 只多这一个开关：预加载、沙箱、上下文隔离照旧，别把安全设置盖掉
  assert.deepEqual(built.webPreferences, { ...webPreferences, backgroundThrottling: false });
});
