import { ACTIONS, SPOKEN_ACTIONS } from "../../hotkeys/actions.mjs";
import { formatSeconds, formatTokens, formatUsd } from "../../usage/format.mjs";
import { h } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError } from "../shared/setup-text.mjs";
import { createRerunDialog } from "./history-rerun.mjs";
import { slidingIndicators } from "./indicators.mjs";
import { toast } from "./toast.mjs";

// 历史记录：搜得到、放得出录音、能拿另一条路线再跑一次、能导出。按天分组（今天、昨天、再往前写日期），
// 一行一条，鼠标移上去才出现播放、复制、重跑和详情。
// 搜索和按功能筛都在库里做（history:list 的 query、kinds），所以 200 条之外的老记录也搜得到；
// 导出的就是现在看到的这些（同一个筛选和搜索）。

const $ = (id) => document.getElementById(id);

const clock = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDay = new Intl.DateTimeFormat(t.locale, { month: "long", day: "numeric", weekday: "long" });
const longDayWithYear = new Intl.DateTimeFormat(t.locale, {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** 分组的标题：今天、昨天，再往前写几月几日星期几（不是今年的带上年份） */
function dayTitle(day, now) {
  const today = startOfDay(now);
  const days = Math.round((today - day) / 86_400_000);
  if (days === 0) return t("history.today");
  if (days === 1) return t("history.yesterday");
  return (day.getFullYear() === now.getFullYear() ? longDay : longDayWithYear).format(day);
}

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  return whole < 60
    ? t("units.seconds", { value: whole })
    : t("units.minutesSeconds", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

/** 详情：录音多长（说话的功能才有录音，划词没有）、等了模型多久、花了多少，token 细节 */
function detailsOf(row) {
  const lines = SPOKEN_ACTIONS.includes(row.kind)
    ? [t("history.recording", { duration: formatDuration(row.duration) })]
    : [];
  if (row.usage) {
    const cost = row.usage.costUsd === null ? t("history.unpriced") : formatUsd(row.usage.costUsd);
    lines.push(t("history.model", { latency: formatSeconds(row.usage.latencyMs, t), cost }));
    const tokens = { input: formatTokens(row.usage.inputTokens), output: formatTokens(row.usage.outputTokens) };
    lines.push(
      row.usage.calls > 1
        ? t("history.tokensCalls", { ...tokens, calls: row.usage.calls })
        : t("history.tokens", tokens),
    );
  }
  return lines.join("\n");
}

/** 能筛的功能：任何时候都能按的动作（取消不算） */
const FEATURES = ACTIONS.filter((action) => action.when === "always").map(({ id }) => id);

/** 导出的三种格式（和主进程的 history-export.mjs 一样） */
const FORMATS = ["markdown", "json", "csv"];

export function createHistory() {
  const dayTemplate = $("history-day");
  const rowTemplate = $("history-row");
  /** 最近一次拿到的记录；换筛选、换搜索时重新问主进程要 */
  let latest = [];
  /** 筛的是哪个功能；all 是全部 */
  let filter = "all";
  /** 搜的字；空的不过滤 */
  let search = "";
  /** 连着打字时前一次的结果可能后到：只认最后一次 */
  let loadToken = 0;
  let searchTimer;
  const indicators = slidingIndicators(document.querySelector('.page[data-route="history"]'));

  // ---------- 播放录音 ----------

  const player = new Audio();
  /** 正在放的那条：{ id, button, url } */
  let playing = null;

  /** 停下、把按钮还原；换歌、重画、放完都走这里 */
  function stopPlayback() {
    if (playing === null) return;
    const { button, url } = playing;
    playing = null;
    player.pause();
    player.removeAttribute("src");
    player.load();
    URL.revokeObjectURL(url);
    delete button.dataset.playing;
    button.querySelector("use").setAttribute("href", "#i-play");
    button.title = t("history.play");
    button.setAttribute("aria-label", t("history.play"));
  }

  player.addEventListener("ended", stopPlayback);

  async function togglePlay(row, button) {
    if (playing?.id === row.id) {
      stopPlayback();
      return;
    }
    stopPlayback();
    try {
      const bytes = await window.speakmore.historyAudio(row.id);
      if (!bytes) throw new Error(t("rerun.noRecording"));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/webm" }));
      playing = { id: row.id, button, url };
      player.src = url;
      await player.play();
      button.dataset.playing = "";
      button.querySelector("use").setAttribute("href", "#i-pause");
      button.title = t("history.pause");
      button.setAttribute("aria-label", t("history.pause"));
    } catch (error) {
      stopPlayback();
      toast(t("history.playFailed", { reason: describeError(error) }));
    }
  }

  // ---------- 重跑 ----------

  const rerunDialog = createRerunDialog({ onDone: () => refresh() });

  // ---------- 搜索、按功能筛 ----------

  // 分段控件：全部，加每个功能一个
  $("history-filter").append(
    ...["all", ...FEATURES].map((id) =>
      h("button", {
        type: "button",
        class: "segment",
        role: "radio",
        "aria-checked": String(id === filter),
        "data-filter": id,
        text: id === "all" ? t("history.all") : t(`actions.${id}.name`),
        onclick: () => {
          filter = id;
          for (const segment of $("history-filter").querySelectorAll(".segment")) {
            segment.setAttribute("aria-checked", String(segment.dataset.filter === id));
          }
          indicators.place();
          refresh();
        },
      }),
    ),
  );

  // 打字停一下才查：每敲一个字都跑一次 SQL、重画一遍列表，在慢的电脑上会一跳一跳
  $("history-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = $("history-search").value;
      refresh();
    }, 120);
  });

  /** 现在要的是哪些：搜索的字、只看哪几个功能（都是 null 时不过滤） */
  const request = () => ({ query: search.trim() === "" ? null : search, kinds: filter === "all" ? null : [filter] });

  async function refresh() {
    const token = ++loadToken;
    try {
      const rows = await window.speakmore.listHistory(request());
      if (token !== loadToken) return;
      latest = rows;
      $("history-error").hidden = true;
      draw();
    } catch (error) {
      if (token === loadToken) showError(describeError(error));
    }
  }

  // ---------- 导出 ----------

  function showNote(id, message, tone = "") {
    const node = $(id);
    node.textContent = message ?? "";
    node.dataset.tone = tone;
    node.hidden = !message;
  }

  $("history-export").addEventListener("click", () => {
    showNote("history-export-problem", null);
    $("history-export-scope").textContent = t("history.exportScope", { count: latest.length });
    $("history-export-dialog").showModal();
  });
  $("history-export-cancel").addEventListener("click", () => $("history-export-dialog").close());

  async function exportAs(format, button) {
    button.disabled = true;
    showNote("history-export-problem", null);
    try {
      const result = await window.speakmore.exportHistory({ format, ...request() });
      if (result) {
        $("history-export-dialog").close();
        toast(t("history.exportDone", { path: result.path }));
      }
    } catch (error) {
      showNote("history-export-problem", t("history.exportFailed", { reason: describeError(error) }), "problem");
    } finally {
      button.disabled = false;
    }
  }

  for (const format of FORMATS) {
    const button = h("button", {
      type: "button",
      class: "button",
      text: t(`history.formats.${format}`),
      onclick: () => exportAs(format, button),
    });
    $("history-export-formats").append(button);
  }

  // ---------- 画列表 ----------

  /** 翻译的那几条：功能和目标语言的小标签，后面是原文。不是翻译的（没有目标语言）不画 */
  function renderSource(node, row) {
    if (!row.outputLanguage) return;
    const source = node.querySelector(".entry-source");
    source.hidden = false;
    source.querySelector(".tag").textContent =
      `${t(`actions.${row.kind}.name`)} · ${t(`languages.${row.outputLanguage}`)}`;
    const original = source.querySelector(".entry-original");
    original.textContent = row.sourceText ?? "";
    original.title = row.sourceText ?? "";
  }

  function renderRow(row) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const time = node.querySelector("time");
    time.dateTime = row.createdAt;
    time.textContent = clock.format(new Date(row.createdAt));

    const text = node.querySelector(".entry-text");
    const copy = node.querySelector(".copy");
    if (row.status === "failed") {
      node.dataset.kind = "failed";
      // 失败的原因是当时界面上的那句话，记在历史里，不随语言再变
      text.dataset.prefix = t("history.failed");
      text.textContent = row.error;
      copy.hidden = true;
    } else if (row.refinedText === "") {
      // 原版的说法：hub__history__item__empty__text
      node.dataset.kind = "silent";
      text.textContent = t("history.silent");
      copy.hidden = true;
    } else {
      text.textContent = row.refinedText;
      copy.addEventListener("click", async () => {
        try {
          await window.speakmore.copyText(row.refinedText);
          copy.dataset.done = "";
          copy.title = t("history.copied");
        } catch (error) {
          console.error("复制失败", error);
          copy.title = t("history.copyFailed");
        }
        setTimeout(() => {
          delete copy.dataset.done;
          copy.title = t("history.copy");
        }, 1500);
      });
    }

    // 播放和重跑只对有录音的记录（划词没有录音）
    const play = node.querySelector(".play");
    const rerun = node.querySelector(".rerun");
    if (row.audioFile) {
      play.addEventListener("click", () => togglePlay(row, play));
      rerun.addEventListener("click", () => rerunDialog.open(row.id));
    } else {
      play.hidden = true;
      rerun.hidden = true;
    }

    renderSource(node, row);
    const details = node.querySelector(".details");
    details.title = detailsOf(row);
    details.setAttribute("aria-label", details.title);
    return node;
  }

  function draw() {
    // 列表要整块换掉：正在放的那条按钮会跟着没掉，先停下
    stopPlayback();
    const empty = latest.length === 0;
    $("history-empty").hidden = !empty;
    $("history-empty").textContent = search.trim() === "" ? t("history.empty") : t("history.noResults");
    $("history-count").textContent = empty ? "" : t("history.count", { count: latest.length });
    if (empty) {
      $("history-days").replaceChildren();
      return;
    }

    const now = new Date();
    const groups = [];
    for (const row of latest) {
      const day = startOfDay(new Date(row.createdAt));
      const last = groups.at(-1);
      if (last && last.day.getTime() === day.getTime()) last.rows.push(row);
      else groups.push({ day, rows: [row] });
    }
    $("history-days").replaceChildren(
      ...groups.map(({ day, rows }) => {
        const node = dayTemplate.content.firstElementChild.cloneNode(true);
        node.querySelector(".day-title").textContent = dayTitle(day, now);
        node.querySelector(".entries").replaceChildren(...rows.map(renderRow));
        return node;
      }),
    );
  }

  function showError(message) {
    $("history-error").textContent = t("history.loadError", { reason: message });
    $("history-error").hidden = false;
  }

  return {
    /** 重读一遍（主进程说历史变了、换了筛选或搜索、重跑完） */
    refresh,

    /** 页面切到前台时，分段控件的底块要按真实宽度重新放（藏着时量不出来） */
    shown() {
      indicators.reset();
      indicators.place();
    },

    showError,
  };
}
