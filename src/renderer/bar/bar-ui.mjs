// 悬浮条的画面：告诉它现在该是什么样子，它把样子画出来、让条出现和消失、把音量画成声波。
// 该是什么样子由 bar-view.mjs 算，这里只管画。它不知道录音和网络的事，也不直接找主进程：
// 要宿主代办的两件事由调用方给。以后换一个壳时，这个文件和 bar.css 不用动，换掉那两个函数就行。
// 提示行左边可以有一个胶囊（功能给的，语音翻译是目标语言）：鼠标移上去展开几个选项，点了交给 onPick。
// 窗口本身点不到，鼠标移动是主进程转过来的（setIgnoreMouseEvents 的 forward），点击和条上两个按钮一样由小帮手截下来。

import { controlsIn, hintFor, LINGER_MS, picksChip, showsChip, showsPreview, View } from "./bar-view.mjs";
import { createWave, REST, WAVE_BARS } from "./wave.mjs";

/** 整理中那道波有几根竖条 */
const THINK_BARS = 11;
/** 条淡出去要多久。和 bar.css 里 data-shown="false" 的过渡一样长 */
const FADE_OUT_MS = 200;
/** 按钮点得到的范围比看到的圆大一圈，正好撑满条的高度 */
const HIT_SLOP = 6;
/** 系统开了"减弱动态效果"时，声波隔这么久才画一次 */
const REDUCED_MOTION_MS = 200;

/**
 * @param {object} options
 * @param {Document} options.document 悬浮条的页面（bar.html）
 * @param {object} options.host 要宿主代办的事
 * @param {(visible: boolean) => void} options.host.setVisible 把悬浮条的窗口显示出来 / 收起来
 * @param {(regions: object[] | null) => void} options.host.capture 开始截 esc 和这几块里的点击
 *   （{ id, x, y, width, height }，窗口里的位置）；null 是不截了
 * @param {{ keys: string[], escKeys: string[] }} options.keys 提示里写的键帽：听写的组合、取消的键，一个键一个
 * @param {Function} options.t 界面语言的翻译函数（src/i18n），提示按它写
 * @param {(id: string) => void} [options.onPick] 在胶囊里点了一项
 */
/** 鼠标离开语言胶囊（和它展开的选项）后过多久收起选单 */
const CHIP_CLOSE_DELAY_MS = 300;

export function createBarUi({ document, host, keys: initialKeys, t: initialT, onPick = () => {} }) {
  /** 在设置里改了热键时跟着换 */
  let keys = initialKeys;
  /** 在设置里换了语言时跟着换 */
  let t = initialT;
  const { body } = document;
  const hint = document.getElementById("hint");
  const chipHost = document.getElementById("chip");
  const previewText = document.getElementById("preview");
  const message = document.getElementById("message");
  const buttons = { cancel: document.getElementById("cancel"), confirm: document.getElementById("confirm") };
  const window = document.defaultView;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const makeBars = (id, count) => {
    const bars = Array.from({ length: count }, () => document.createElement("i"));
    document.getElementById(id).replaceChildren(...bars);
    return bars;
  };
  const waveBars = makeBars("wave", WAVE_BARS);
  // 每根竖条错开一点起步，连起来才是一道滚过去的波
  for (const [index, bar] of makeBars("think", THINK_BARS).entries()) bar.style.setProperty("--i", index);

  /** 现在画着的样子。条收起来之后是 hidden */
  let view = View.HIDDEN;
  /** 两个按钮点不点得动 */
  let controls = false;
  /** 条上方的操作提示显示不显示（设置里的 barHint） */
  let hintShown = true;
  const wave = createWave({ bars: WAVE_BARS });
  /** 正在听时每帧画一次声波；不在听是 null */
  let waveFrame = null;
  /** 上一次画声波的时间 */
  let drawnAt = -Infinity;
  /** 让宿主截着的那几块，写成一行文字方便比较；没在截是 null */
  let captured = null;
  /** 到时间把条收起来的定时器 */
  let hideTimer = null;
  /** 提示行左边的胶囊：{ text, options: [{ id, text, selected }] }；这一次的功能没有是 null */
  let chip = null;
  /** 鼠标离开胶囊后等着收起选单的那个计时器 */
  let chipCloseTimer = null;
  /** 胶囊的选项展开着没有 */
  let chipOpen = false;
  /** 等成品时提示行写什么（功能自己的那句）；null 是默认的 */
  let finishing = null;
  /** 录音时的暂定文字：服务端每隔几块来一条，整条取代上一条；null 是没有可画的 */
  let preview = null;

  function drawWave(heights) {
    for (const [index, bar] of waveBars.entries()) bar.style.setProperty("--h", heights[index].toFixed(3));
  }

  function animateWave(now) {
    const heights = wave.frame(now);
    // 减弱动态效果时声波还是要动（它在告诉人"听到你了"），只是画得慢
    if (!reducedMotion.matches || now - drawnAt >= REDUCED_MOTION_MS) {
      drawWave(heights);
      drawnAt = now;
    }
    waveFrame = window.requestAnimationFrame(animateWave);
  }

  /** 进了"正在听"从伏着开始一帧一帧画；出来就停下、全部伏着。收起来的时候只停下，照着停下时的样子淡出去 */
  function syncWave() {
    if (view === View.RECORDING) {
      if (waveFrame === null) {
        wave.reset();
        waveFrame = window.requestAnimationFrame(animateWave);
      }
      return;
    }
    if (waveFrame !== null) window.cancelAnimationFrame(waveFrame);
    waveFrame = null;
    if (view !== View.HIDDEN) drawWave(Array(WAVE_BARS).fill(REST));
  }

  function drawHint() {
    const parts = hintFor(view, { ...keys, cancellable: controls, shown: hintShown, finishing }, t);
    hint.replaceChildren(
      ...parts.map((part) => {
        if (typeof part === "string") return part;
        // 一个组合是一组键帽，键帽之间不写加号
        const group = document.createElement("span");
        group.className = "keys";
        group.append(...part.keys.map((key) => Object.assign(document.createElement("kbd"), { textContent: key })));
        return group;
      }),
    );
  }

  /** 胶囊有几个选项可挑、点得动：只有一种语言时只是写着，没得挑；等成品时也只是写着 */
  const choosable = () => chip !== null && chip.options.length > 1 && controls && picksChip(view);

  /** 画胶囊和它的选项。选项从胶囊上方展开，一项一行，选中的那项打勾 */
  function drawChip() {
    const visible = chip !== null && showsChip(view);
    chipHost.hidden = !visible;
    if (!visible) {
      clearTimeout(chipCloseTimer);
      chipOpen = false;
      chipHost.replaceChildren();
      return;
    }
    if (!choosable()) chipOpen = false;
    chipHost.toggleAttribute("data-open", chipOpen);
    const button = document.createElement("span");
    button.className = "chip";
    button.dataset.region = "chip";
    button.append(Object.assign(document.createElement("span"), { textContent: t.text(chip.text) }));
    if (choosable()) {
      button.append(Object.assign(document.createElement("span"), { className: "caret", textContent: "⌄" }));
    }
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "listbox");
    for (const option of chip.options) {
      const item = document.createElement("span");
      item.className = "option";
      item.dataset.region = `chip:${option.id}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.append(Object.assign(document.createElement("span"), { textContent: t.text(option.text) }));
      if (option.selected) {
        item.insertAdjacentHTML(
          "beforeend",
          '<svg class="tick-mark" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" /></svg>',
        );
      }
      menu.append(item);
    }
    chipHost.replaceChildren(menu, button);
  }

  /** 录音时的暂定文字：只在正在听时画；文字只写 textContent，不拼 HTML */
  function drawPreview() {
    const visible = preview !== null && showsPreview(view);
    previewText.hidden = !visible;
    previewText.textContent = visible ? preview : "";
  }

  function setChipOpen(open) {
    const next = open && choosable();
    if (next === chipOpen) return;
    chipOpen = next;
    chipHost.toggleAttribute("data-open", chipOpen);
    syncCapture();
  }

  // 鼠标移上胶囊（或者展开的选项）就展开，移开一会儿才收起。鼠标事件是主进程转过来的，窗口本身仍然点不到。
  // 不能一离开就收：从胶囊往上移到选项要经过两者之间的缝（bar.css 用 .menu::after 垫上了），转过来的鼠标事件也是隔一阵
  // 一个，斜着移、移得快时会落在胶囊和选单外面一下。10-22 他用的时候一往上滑选单就收了，选不上
  chipHost.addEventListener("mouseenter", () => {
    clearTimeout(chipCloseTimer);
    setChipOpen(true);
  });
  chipHost.addEventListener("mouseleave", () => {
    clearTimeout(chipCloseTimer);
    chipCloseTimer = setTimeout(() => setChipOpen(false), CHIP_CLOSE_DELAY_MS);
  });

  /** 要截点击的那一块：条上的两个按钮，或者胶囊和它的选项（data-region） */
  const elementOf = (id) => buttons[id] ?? chipHost.querySelector(`[data-region="${CSS.escape(id)}"]`);

  /** 一个按钮在窗口里的位置。按排版算，不看正在进行的动画：条出现时是从下面浮上来的，量那一刻的位置会偏 */
  function regionOf(id) {
    const button = elementOf(id);
    let x = -HIT_SLOP;
    let y = -HIT_SLOP;
    for (let node = button; node !== null; node = node.offsetParent) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    return { id, x, y, width: button.offsetWidth + 2 * HIT_SLOP, height: button.offsetHeight + 2 * HIT_SLOP };
  }

  /** 这个样子下该截什么就让宿主截什么。和上一次一样就不重复说 */
  function syncCapture() {
    const ids = controls ? [...controlsIn(view)] : [];
    // 胶囊点一下也展开（悬停没转过来时还有这条路）；展开着时每个选项都截
    if (choosable()) ids.push("chip", ...(chipOpen ? chip.options.map(({ id }) => `chip:${id}`) : []));
    const regions = ids.length > 0 ? ids.map(regionOf) : null;
    const next = regions && JSON.stringify(regions);
    if (next === captured) return;
    captured = next;
    host.capture(regions);
  }

  function hide() {
    view = View.HIDDEN;
    chipOpen = false;
    // 收起来时暂定文字一并丢掉：下一次开口不许先闪出上一次的字
    preview = null;
    drawPreview();
    syncCapture();
    syncWave();
    // 样子先不换：照着现在的样子淡出去，淡完再把窗口收起来
    body.dataset.shown = "false";
    hideTimer = setTimeout(() => {
      host.setVisible(false);
      body.dataset.view = View.HIDDEN;
    }, FADE_OUT_MS);
  }

  return {
    /**
     * 换成这种样子。
     * @param {string} next bar-view.mjs 的 View 之一
     * @param {string | null} text 提示或者出错时的那句话
     */
    show(next, text = null) {
      // 还是这个样子、这句话：不重画，免得把正在放的动画和"过几秒收起来"的定时器重新开始
      if (next === view && (text ?? "") === message.textContent) return;
      clearTimeout(hideTimer);
      if (next === View.HIDDEN) {
        hide();
        return;
      }
      view = next;
      body.dataset.view = next;
      message.textContent = text ?? "";
      drawHint();
      drawChip();
      drawPreview();
      syncWave();
      if (body.dataset.shown !== "true") {
        host.setVisible(true);
        body.dataset.shown = "true";
      }
      // 排版定了才量得出按钮在哪
      syncCapture();
      if (LINGER_MS[next] !== undefined) hideTimer = setTimeout(hide, LINGER_MS[next]);
    },

    /**
     * 这一次的功能给的胶囊（语音翻译的目标语言）和等成品时的那句话；没有就是 null。
     * 换了选中的那项也调它：展开着的照样展开
     * @param {{ chip: object | null, finishing: object | null }} decoration
     */
    setFeature({ chip: nextChip, finishing: nextFinishing }) {
      chip = nextChip;
      finishing = nextFinishing;
      if (view === View.HIDDEN) return;
      drawHint();
      drawChip();
      syncCapture();
    },

    /**
     * 小帮手截下来的一次点击，是胶囊上的就在这里处理：点胶囊展开、收起，点选项交给 onPick。
     * @returns {boolean} 处理了是 true；条上两个按钮的点击不归这里，是 false
     */
    click(id) {
      if (id === "chip") {
        setChipOpen(!chipOpen);
        return true;
      }
      if (typeof id !== "string" || !id.startsWith("chip:")) return false;
      setChipOpen(false);
      onPick(id.slice("chip:".length));
      return true;
    },

    /** 正在听时的一个瞬时音量（0–1） */
    level(value) {
      if (view !== View.RECORDING) return;
      wave.hear(value, window.performance.now());
    },

    /**
     * 录音时的暂定文字：后一条整个取代前一条，null 是清掉。只画在这里，不进输入栏、不碰剪贴板；
     * 到底是不是还在听、是不是这条录音，由调用方判断
     * @param {string | null} text
     */
    setPreview(text) {
      const next = typeof text === "string" && text.length > 0 ? text : null;
      if (next === preview) return;
      preview = next;
      if (view !== View.HIDDEN) drawPreview();
    },

    /** 两个按钮点不点得动、esc 截不截得住（要辅助功能权限）。点不动时不画按钮，提示里也不提 esc */
    setControls(enabled) {
      controls = enabled;
      body.dataset.controls = String(enabled);
      if (view !== View.HIDDEN) {
        drawHint();
        drawChip();
      }
      syncCapture();
    },

    /** 设置里开关了操作提示：正显示着的那句当场跟着变 */
    setHintShown(shown) {
      hintShown = shown;
      if (view !== View.HIDDEN) drawHint();
    },

    /** 热键换了（或者这一次是按另一个组合开始的）：提示里写新的那组 */
    setKeys(next) {
      keys = next;
      if (view !== View.HIDDEN) drawHint();
    },

    /**
     * 语言换了：提示按新的语言写，正在显示的那句话换成 text（调用方按新的语言翻好的）。
     * 不走 show：样子没变，不该把动画和"过几秒收起来"重新开始
     */
    setTranslator(next, text = null) {
      t = next;
      if (view === View.HIDDEN) return;
      message.textContent = text ?? "";
      drawHint();
      drawChip();
      drawPreview();
    },
  };
}
