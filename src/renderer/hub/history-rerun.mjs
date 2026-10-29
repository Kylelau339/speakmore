import { fillSelect, h } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError } from "../shared/setup-text.mjs";
import { toast } from "./toast.mjs";

// 重跑对话框：拿这条记录的录音、按另一条路线再跑一次（app/rerun.mjs）。能选什么由主进程给（history:rerun-options），
// 这里只负责画、把选的那一项交回去；跑完关掉，列表自己重读。
// 三种模式各一格：直出挑一个模型；混合挑转文字和润色；离线挑本机模型。没装好、没 key 的选项灰着，鼠标停上去说原因。

/** 一格模式：单选框加它自己的几个下拉 */
function modeBlock(mode, supported) {
  const block = h("div", { class: "history-rerun-mode", "data-mode": mode, "data-supported": String(supported) });
  const radio = h("input", { type: "radio", name: "history-rerun-mode", value: mode });
  radio.disabled = !supported;
  block.append(h("label", {}, radio, h("span", { text: t(`rerun.modes.${mode}`) })));
  const fields = h("div", { class: "history-rerun-fields" });
  block.append(fields);
  if (!supported) fields.append(h("p", { class: "history-dialog-text", text: t("rerun.unsupported") }));
  return { block, radio, fields, selects: [] };
}

/** 一个下拉：标签、选项（没就绪的灰着、写明原因）、默认选第一个就绪的 */
function selectField(label, options, current) {
  const field = h("label", { class: "history-rerun-field" }, h("span", { text: label }));
  const select = h("select", { class: "select" });
  const picked =
    options.find((option) => option.value === current && option.ready) ?? options.find((option) => option.ready);
  fillSelect(
    select,
    options.map((option) => [option.value, option.name]),
    picked?.value ?? current,
  );
  for (const option of select.querySelectorAll("option")) {
    const source = options.find(({ value }) => value === option.value);
    if (source && !source.ready) {
      option.disabled = true;
      option.title = t.text(source.problem);
    }
  }
  field.append(select);
  return { field, select };
}

/** 一个模式的几个下拉都跟着这个模式开、关 */
function syncFields(current) {
  for (const [mode, { radio, selects }] of current.blocks) {
    const active = radio.checked;
    for (const select of selects) select.disabled = !active || !current.options[mode].supported;
  }
}

/**
 * @param {{ onDone: () => void }} deps onDone：重跑成功之后让列表重读
 */
export function createRerunDialog({ onDone }) {
  const dialog = document.getElementById("history-rerun");
  const form = document.getElementById("history-rerun-form");
  const modes = document.getElementById("history-rerun-modes");
  const problem = document.getElementById("history-rerun-problem");
  const runButton = document.getElementById("history-rerun-run");
  /** 这一次开着的：{ id, options, blocks: Map<mode, { radio, selects }> } */
  let current = null;
  let running = false;

  const showProblem = (message, tone = "") => {
    problem.textContent = message ?? "";
    problem.dataset.tone = tone;
    problem.hidden = !message;
  };

  function build(options) {
    modes.replaceChildren();
    const blocks = new Map();

    const native = modeBlock("native", options.native.supported);
    blocks.set("native", native);
    if (options.native.supported) {
      const model = selectField(t("rerun.model"), options.native.models, options.native.current);
      native.fields.append(model.field);
      native.selects.push(model.select);
    }
    modes.append(native.block);

    const local = modeBlock("local", options.local.supported);
    blocks.set("local", local);
    if (options.local.supported) {
      const transcriber = selectField(
        t("rerun.transcriber"),
        options.local.transcribers,
        options.local.current.transcriber,
      );
      const polish = selectField(t("rerun.polish"), options.local.polishes, options.local.current.polish);
      local.fields.append(transcriber.field, polish.field);
      local.selects.push(transcriber.select, polish.select);
    }
    modes.append(local.block);

    const offline = modeBlock("private", options.private.supported);
    blocks.set("private", offline);
    if (options.private.supported) {
      const model = selectField(t("rerun.model"), options.private.models, options.private.current);
      offline.fields.append(model.field);
      offline.selects.push(model.select);
    }
    modes.append(offline.block);

    // 默认选现在用的那种模式；那种模式做不了这个功能时，退到第一种做得了的
    const preferred = blocks.get(options.mode)?.radio;
    const fallback = [...blocks.values()].find(({ radio }) => !radio.disabled)?.radio;
    const chosen = preferred && !preferred.disabled ? preferred : fallback;
    if (chosen) chosen.checked = true;
    return blocks;
  }

  /** 这一次选的是哪条路线 */
  function targetOf() {
    const checked = modes.querySelector('input[name="history-rerun-mode"]:checked');
    if (!checked) return null;
    const mode = checked.value;
    const { selects } = current.blocks.get(mode);
    if (mode === "native") return { mode, model: selects[0].value };
    if (mode === "local") return { mode, transcriber: selects[0].value, polish: selects[1].value };
    return { mode, transcriber: selects[0].value };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!current || running) return;
    const target = targetOf();
    if (!target) return;
    running = true;
    runButton.disabled = true;
    runButton.textContent = t("rerun.running");
    showProblem(null);
    try {
      const result = await window.speakmore.rerunHistory({ id: current.id, target });
      if (result?.ok) {
        dialog.close();
        toast(t("rerun.done"));
        onDone();
      } else {
        showProblem(
          result?.problem ? t.text(result.problem) : t("rerun.failed", { reason: t("common.unknownReason") }),
          "problem",
        );
      }
    } catch (error) {
      showProblem(t("rerun.failed", { reason: describeError(error) }), "problem");
    } finally {
      running = false;
      runButton.disabled = false;
      runButton.textContent = t("rerun.run");
    }
  });

  document.getElementById("history-rerun-cancel").addEventListener("click", () => dialog.close());

  return {
    /** 打开某一条的重跑对话框；读不出选项时说一声，不弹一个空的 */
    async open(id) {
      showProblem(null);
      runButton.disabled = true;
      try {
        const options = await window.speakmore.rerunOptions(id);
        if (!options?.hasAudio) {
          toast(t("rerun.noRecording"));
          return;
        }
        const blocks = build(options);
        current = { id, options, blocks };
        for (const { radio } of blocks.values()) radio.addEventListener("change", () => syncFields(current));
        syncFields(current);
        dialog.showModal();
      } catch (error) {
        toast(t("rerun.optionsFailed", { reason: describeError(error) }));
      } finally {
        runButton.disabled = false;
      }
    },
  };
}
