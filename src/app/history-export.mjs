// 历史的导出：Markdown（给人看）、JSON（备份、再处理）、CSV（表格）。
// 这里是纯函数：行从 history.list 来，翻译、格式都不碰磁盘；写文件、弹保存对话框由 main 做。
// 时间是本机日历上的写法（和界面、命令行看历史一致），JSON 里保留原来的 ISO 时间。

export const FORMATS = Object.freeze(["markdown", "json", "csv"]);

/** 每种格式存成什么副档名（保存对话框的过滤器、默认文件名用） */
export const EXTENSIONS = Object.freeze({ markdown: "md", json: "json", csv: "csv" });

const pad = (value) => String(value).padStart(2, "0");

/** 本机日历上的 YYYY-MM-DD 和 HH:MM */
const dayOf = (iso) => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const timeOf = (iso) => {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 一条记录右上角那行：时间 · 功能（翻译的带上目标语言） · 失败/无声 */
function headline(row, t) {
  const parts = [timeOf(row.createdAt), t(`actions.${row.kind}.name`)];
  if (row.outputLanguage) parts.push(t(`languages.${row.outputLanguage}`));
  if (row.status === "failed") parts.push(t("history.failedLabel"));
  return parts.join(" · ");
}

/** 正文：失败写原因，没听到声音写那句，其余写成品 */
function bodyOf(row, t) {
  if (row.status === "failed") return row.error ?? "";
  if (row.refinedText === "") return t("history.silent");
  return row.refinedText;
}

/** Markdown：按天分节，一条一段；翻译的下面附原文 */
export function renderMarkdown(rows, t) {
  const lines = [`# ${t("history.title")}`, ""];
  let day = null;
  for (const row of rows) {
    const rowDay = dayOf(row.createdAt);
    if (rowDay !== day) {
      if (day !== null) lines.push("");
      lines.push(`## ${rowDay}`, "");
      day = rowDay;
    }
    lines.push(`**${headline(row, t)}**`, "", bodyOf(row, t));
    if (row.sourceText) lines.push("", `${t("history.original")}: ${row.sourceText}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** JSON：原样一串（字段和 history.list 一致，含 usage），给人备份和写脚本用 */
export function renderJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** CSV 的一个字段：一律加引号，里面的引号翻倍；换行留在引号里（Excel 认） */
const csvField = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

/**
 * CSV：一行一条，表头固定英文（给脚本、表格认，不随界面语言变）。
 * 钱不知道价时是空的（不是 0），时长按秒
 */
export function renderCsv(rows) {
  const header = [
    "created_at",
    "kind",
    "status",
    "duration_seconds",
    "output_language",
    "input_tokens",
    "output_tokens",
    "cost_usd",
    "text",
    "source_text",
  ];
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.createdAt,
        row.kind,
        row.status,
        row.duration,
        row.outputLanguage ?? "",
        row.usage?.inputTokens ?? "",
        row.usage?.outputTokens ?? "",
        row.usage?.costUsd ?? "",
        row.status === "failed" ? (row.error ?? "") : row.refinedText,
        row.sourceText ?? "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  // Excel 打开中文 CSV 要先看到 BOM 才不乱码
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * 按格式渲染
 * @param {object[]} rows history.list 的形状
 * @param {"markdown" | "json" | "csv"} format
 * @param {Function} t 翻译（createTranslator）
 * @returns {string}
 */
export function renderHistory(rows, format, t) {
  if (format === "markdown") return renderMarkdown(rows, t);
  if (format === "json") return renderJson(rows);
  if (format === "csv") return renderCsv(rows);
  throw new Error(`不认识的导出格式：${JSON.stringify(format)}`);
}
