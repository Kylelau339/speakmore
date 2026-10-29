import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCsv, renderHistory, renderJson, renderMarkdown } from "../../src/app/history-export.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

const zh = createTranslator("zh-CN");

const rows = [
  {
    id: "b",
    kind: "translate",
    status: "completed",
    refinedText: "Let's ship it.",
    sourceText: "我们发布吧",
    outputLanguage: "en",
    error: null,
    duration: 5.5,
    audioFile: "b.webm",
    createdAt: "2026-10-29T09:30:00.000Z",
    usage: { calls: 1, inputTokens: 12, outputTokens: 34, costUsd: 0.0012, latencyMs: 900 },
  },
  {
    id: "a",
    kind: "dictate",
    status: "failed",
    refinedText: "",
    sourceText: null,
    outputLanguage: null,
    error: '服务端 "没有" 回应\n第二行',
    duration: 2,
    audioFile: "a.webm",
    createdAt: "2026-10-28T23:05:00.000Z",
    usage: null,
  },
  {
    id: "c",
    kind: "dictate",
    status: "completed",
    refinedText: "",
    sourceText: null,
    outputLanguage: null,
    error: null,
    duration: 1,
    audioFile: "c.webm",
    createdAt: "2026-10-27T22:00:00.000Z",
    usage: null,
  },
];

test("Markdown：一条一段，翻译的带功能、目标语言和原文，失败写原因，没声音写那句", () => {
  const text = renderMarkdown(rows, zh);
  assert.match(text, /^# 历史\n/);
  assert.match(text, /\*\*\d{2}:\d{2} · 语音翻译 · 英文\*\*/);
  assert.match(text, /Let's ship it\./);
  assert.match(text, /原文: 我们发布吧/);
  // 失败的原因原样留着（含换行和引号）
  assert.match(text, /· 失败\*\*/);
  assert.ok(text.includes('服务端 "没有" 回应\n第二行'));
  assert.match(text, /音频无声/);
  // 按天分节（日期是本机日历上的写法）
  assert.match(text, /^## \d{4}-\d{2}-\d{2}$/m);
});

test("JSON：原样一串，字段和 history.list 一样，可以再读回来", () => {
  const text = renderJson(rows);
  assert.deepEqual(JSON.parse(text), rows);
  assert.ok(text.endsWith("\n"));
});

test("CSV：带 BOM，表头固定英文，引号和换行都按 CSV 的规矩转义，不知道价是空的", () => {
  const text = renderCsv(rows);
  assert.ok(text.startsWith("\uFEFF"));
  const [header, first, second] = text.slice(1).split("\r\n");
  assert.equal(
    header,
    '"created_at","kind","status","duration_seconds","output_language","input_tokens","output_tokens","cost_usd","text","source_text"',
  );
  // 翻译那一条：钱、token、原文都在
  assert.ok(first.includes('"0.0012"'));
  assert.ok(first.includes('"12"'));
  assert.ok(first.includes('"我们发布吧"'));
  // 失败那一条：原因里的引号翻倍，换行留在引号里；没有用量、没有原文的那几空着
  assert.ok(second.includes('"dictate","failed","2","","","",""'));
  assert.ok(second.includes('"服务端 ""没有"" 回应\n第二行"'));
});

test("按格式选：不认识的格式抛错", () => {
  assert.equal(renderHistory(rows, "markdown", zh), renderMarkdown(rows, zh));
  assert.equal(renderHistory(rows, "json", zh), renderJson(rows));
  assert.equal(renderHistory(rows, "csv", zh), renderCsv(rows));
  assert.throws(() => renderHistory(rows, "xml", zh), /不认识的导出格式/);
});
