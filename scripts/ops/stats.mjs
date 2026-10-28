// 下载量和流量观测（只读）：scripts/release/with-cos-key.sh npm run stats
//
//   npm run stats -- --days 30     流量看最近 30 天（默认 14，最多 90）
//   npm run stats -- --offline     不连云：只拿缓存的日志和文件清单重算下载量，不用密钥
//   npm run stats -- --json        输出 JSON，给别的脚本用
//
// 取什么：
// 1. 三个桶的文件清单：发布包每个多大、哪些版本发过，以及各桶的存储量
// 2. 下载地址的 CDN 访问日志，缓存在 .stats/logs/。日志里有真实用户的 IP，不进仓库；
//    CDN 只留 30 天，缓存一直在，所以隔一个月内跑一次，下载量就能一直往前算
// 3. 这台电脑现在的出口 IP（只存哈希，记在 .stats/self-ips.json），之后它的下载都算自测
// 4. 三个 CDN 域名最近几天的流量、请求、状态码、回源，以及用量封顶的配置
// 算法（折算下载、认自测、告警的门槛）在 stats-core.mjs，有单测。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import COS from "cos-nodejs-sdk-v5";
import { cdn } from "tencentcloud-sdk-nodejs-cdn";
import {
  at,
  capOf,
  earlyMisses,
  findSelf,
  gb,
  hashIp,
  knownSizes,
  missAlerts,
  objectMissAlerts,
  parseLogLine,
  summarizeDownloads,
  trafficAlerts,
} from "./stats-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = join(ROOT, ".stats");
const LOGS = join(CACHE, "logs");
const SIZES = join(CACHE, "sizes.json");
const SELF_IPS = join(CACHE, "self-ips.json");

const { values: args } = parseArgs({
  options: { days: { type: "string", default: "14" }, offline: { type: "boolean" }, json: { type: "boolean" } },
});
const DAYS = Math.min(90, Math.max(1, Number(args.days) || 14));

const site = JSON.parse(readFileSync(join(ROOT, "website/site.config.json"), "utf8"));
const download = new URL(site.downloadBase);
// 域名和各自的桶：桶名在 .machine.env，with-cos-key.sh 导进环境
const DOMAINS = [
  { name: download.host, role: "发布包", bucket: process.env.COS_BUCKET },
  { name: new URL(site.mediaBase).host, role: "官网与 README 的图", bucket: process.env.SITE_MEDIA_BUCKET },
];
const PREFIX = download.pathname.replace(/^\/+|\/+$/g, ""); // 发布包在桶里的前缀，speakmore

// 北京时间的日期（CDN 的日志和统计都按 UTC+8）
const beijing = (offsetDays = 0) => new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const TODAY = beijing();
const FROM = beijing(-(DAYS - 1));

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
const progress = (text) => args.json || process.stderr.write(`${text}\n`);

function credentials() {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error(
      "环境里没有腾讯云密钥：用 scripts/release/with-cos-key.sh npm run stats 跑，或加 --offline 只算缓存",
    );
  }
  return { secretId, secretKey };
}

/** 列整个桶：{ key: 字节数 } */
async function listBucket(cos, bucket) {
  const out = {};
  let marker = "";
  for (;;) {
    const res = await cos.getBucket({ Bucket: bucket, Region: process.env.COS_REGION, Marker: marker, MaxKeys: 1000 });
    for (const c of res.Contents) out[c.Key] = Number(c.Size);
    if (res.IsTruncated !== "true") return out;
    // 不带分隔符时 COS 可能不给 NextMarker：接着最后一个往下列，不然会从头无限循环
    marker = res.NextMarker || res.Contents.at(-1).Key;
  }
}

/** 下载地址的访问日志存进缓存；最近两天的每次重下（晚到的日志会补进同一个包），更早的有了就跳过 */
async function syncLogs(client) {
  mkdirSync(LOGS, { recursive: true });
  const recent = beijing(-1).replaceAll("-", "");
  let fetched = 0;
  for (const area of ["mainland", "overseas"]) {
    for (let offset = 0; ; offset += 1000) {
      const res = await client.DescribeCdnDomainLogs({
        Domain: download.host,
        StartTime: `${beijing(-29)} 00:00:00`,
        EndTime: `${TODAY} 23:59:59`,
        Area: area,
        LogType: "access",
        Offset: offset,
        Limit: 1000,
      });
      const logs = res.DomainLogs ?? [];
      for (const log of logs) {
        const file = join(LOGS, `${area}-${log.LogName}`);
        if (existsSync(file) && log.LogName.slice(0, 8) < recent) continue;
        const r = await fetch(log.LogPath);
        if (!r.ok) throw new Error(`下载访问日志 ${log.LogName} 失败：HTTP ${r.status}`);
        writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        fetched += 1;
      }
      if (logs.length < 1000) break;
    }
  }
  return fetched;
}

function readLogs() {
  if (!existsSync(LOGS)) return [];
  const rows = [];
  for (const name of readdirSync(LOGS).sort()) {
    for (const line of gunzipSync(readFileSync(join(LOGS, name)))
      .toString("utf8")
      .split("\n")) {
      const row = parseLogLine(line);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/** 这台电脑现在的出口 IP（IPv4，有 IPv6 也记），哈希后并进 self-ips.json */
async function rememberEgress() {
  const known = readJson(SELF_IPS, {});
  const found = [];
  for (const url of ["https://api.ipify.org", "https://api64.ipify.org"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await r.text()).trim();
      if (r.ok && ip) found.push(ip);
    } catch (error) {
      progress(`查不到本机出口（${url}）：${error.message}；这次只按特征认自测`);
    }
  }
  for (const ip of new Set(found)) {
    const h = hashIp(ip);
    known[h] = { note: "本机出口", seen: [...new Set([...(known[h]?.seen ?? []), TODAY])] };
  }
  writeFileSync(SELF_IPS, `${JSON.stringify(known, null, 2)}\n`);
  return known;
}

/** CDN 统计按天取，返回 { 日期: 值 }；statusCode 返回 { 日期: { 2xx, 3xx, 4xx, 5xx } } */
async function daily(call, request) {
  const res = await call({ ...request, StartTime: `${FROM} 00:00:00`, EndTime: `${TODAY} 23:59:59`, Interval: "day" });
  const out = {};
  for (const resource of res.Data ?? []) {
    for (const item of resource.CdnData ?? resource.OriginData ?? []) {
      for (const point of item.DetailData ?? []) {
        const day = point.Time.slice(0, 10);
        if (request.Metric === "statusCode") out[day] = { ...out[day], [item.Metric]: point.Value };
        else out[day] = (out[day] ?? 0) + point.Value;
      }
    }
  }
  return out;
}

async function traffic(client) {
  const config = await client.DescribeDomainsConfig({
    Filters: [{ Name: "domain", Value: DOMAINS.map((d) => d.name) }],
    Limit: DOMAINS.length,
  });
  const caps = new Map((config.Domains ?? []).map((d) => [d.Domain, capOf(d.BandwidthAlert)]));
  const out = [];
  for (const d of DOMAINS) {
    progress(`取 ${d.name} 的流量…`);
    const both = async (call, Metric) => {
      const [mainland, overseas] = [
        await daily(call, { Domains: [d.name], Metric, Area: "mainland" }),
        await daily(call, { Domains: [d.name], Metric, Area: "overseas" }),
      ];
      return { mainland, overseas };
    };
    const cdnData = (req) => client.DescribeCdnData(req);
    const originData = (req) => client.DescribeOriginData(req);
    const flux = await both(cdnData, "flux");
    const request = await both(cdnData, "request");
    const status = await both(cdnData, "statusCode");
    const origin = await both(originData, "flux");
    const originRequest = await both(originData, "request");
    const originFail = await both(originData, "failRequest");
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const day = beijing(-i);
      const sum = (pair) => (pair.mainland[day] ?? 0) + (pair.overseas[day] ?? 0);
      const code = (c) => (status.mainland[day]?.[c] ?? 0) + (status.overseas[day]?.[c] ?? 0);
      days.push({
        day,
        flux: { mainland: flux.mainland[day] ?? 0, overseas: flux.overseas[day] ?? 0 },
        request: sum(request),
        status: { "4xx": code("4xx"), "5xx": code("5xx") },
        origin: sum(origin),
        originRequest: sum(originRequest),
        originFail: sum(originFail),
      });
    }
    out.push({ name: d.name, role: d.role, today: TODAY, days, cap: caps.get(d.name) ?? { on: false } });
  }
  return out;
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), today: TODAY, days: DAYS, offline: Boolean(args.offline) };
  let known = readJson(SELF_IPS, {});

  if (!args.offline) {
    const { secretId, secretKey } = credentials();
    const cos = new COS({ SecretId: secretId, SecretKey: secretKey });
    const client = new cdn.v20180606.Client({ credential: { secretId, secretKey }, region: "" });

    progress("列桶里的文件…");
    report.storage = [];
    for (const d of DOMAINS) {
      if (!d.bucket) {
        report.storage.push({ domain: d.name, role: d.role, missing: true });
        continue;
      }
      const files = await listBucket(cos, d.bucket);
      report.storage.push({
        domain: d.name,
        role: d.role,
        files: Object.keys(files).length,
        bytes: Object.values(files).reduce((a, b) => a + b, 0),
      });
      if (d.name === download.host) {
        mkdirSync(CACHE, { recursive: true });
        writeFileSync(SIZES, `${JSON.stringify(knownSizes(readJson(SIZES, null), files, PREFIX))}\n`);
      }
    }
    progress("同步访问日志…");
    report.logsFetched = await syncLogs(client);
    known = await rememberEgress();
    report.traffic = await traffic(client);
  }

  const files = readJson(SIZES, null);
  if (!files) throw new Error("没有缓存的文件清单：先不带 --offline 跑一次");
  const sizes = new Map(Object.entries(files).map(([k, v]) => [`/${k}`, v]));
  const rows = readLogs();
  const self = findSelf(rows, { known: new Set(Object.keys(known)) });
  const reasons = {};
  for (const set of self.values()) for (const r of set) reasons[r] = (reasons[r] ?? 0) + 1;
  report.downloads = summarizeDownloads(rows, { sizes, self });
  report.self = { ips: self.size, reasons };
  report.misses = earlyMisses(rows, { files: new Set(sizes.keys()), self });
  report.alerts = [
    ...(report.traffic ? trafficAlerts(report.traffic) : []),
    // 坏链接只在昨天以来还有人点到时报
    ...missAlerts(report.misses, download.host, `${beijing(-1).replaceAll("-", "")}000000`),
    ...objectMissAlerts(rows, { self, domain: download.host, since: `${beijing(-1).replaceAll("-", "")}000000` }),
  ];

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
}

// ---------- 报告 ----------

const n = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const REASON = { ship: "ship 核对", prerelease: "预发版", "windows-acceptance": "Windows 验收", known: "本机出口" };
const pad = (text, width) =>
  text + " ".repeat(Math.max(0, width - [...text].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));

function render(r) {
  const out = [];
  const line = (text = "") => out.push(text);
  line(`SpeakMore 下载与流量 · ${r.today}${r.offline ? "（离线，只用缓存）" : ""}`);
  line();

  const d = r.downloads;
  line("下载（按流量折算成完整下载次数，同一个 IP 同一种包一天最多算一次，已扣除自测）");
  line(`  日志范围：${at(d.range.from)} → ${at(d.range.to)}（北京时间）`);
  for (const k of d.kinds) line(`  ${pad(k.label, 26)}真实 ${pad(n(k.real), 7)}自测 ${n(k.self)}`);
  line(`  ${pad("合计", 26)}真实 ${pad(n(d.real), 7)}自测 ${n(d.self)}`);
  line(`  真实来源 IP ${d.realIps} 个（至少下完半个包）；其中 ${n(d.phone)} 次是在手机上点的`);
  const mb = (bytes) => (bytes / 1e6).toFixed(1);
  line(`  更新（按块下）：真实 ${mb(d.updates.bytes)} MB，来自 ${d.updates.ips} 个 IP；自测 ${mb(d.updates.self)} MB`);
  const reasons = Object.entries(r.self.reasons)
    .map(([k, v]) => `${REASON[k] ?? k} ${v}`)
    .join("、");
  line(`  认出的自测来源：${r.self.ips} 个 IP${reasons ? `（${reasons}，一个 IP 可能命中几条）` : ""}`);
  line("  按天（真实）：");
  for (const day of d.days.slice(-r.days))
    line(`    ${day.day.slice(5)}  Mac ${pad(n(day.mac), 7)}Windows ${n(day.win)}`);
  const early = r.misses.filter((m) => m.kind === "early");
  if (early.length)
    line(`  文件传上去之前就点到、拿到 404 的真用户：${early.map((m) => `${m.version} ${m.ips} 个 IP`).join("、")}`);
  for (const m of r.misses.filter((x) => x.kind === "missing"))
    line(`  点到不存在的文件：${m.path}（${m.ips} 个 IP，${m.requests} 次，最近一次 ${at(m.last)}）`);
  line();

  if (r.traffic) {
    line(`CDN 流量（最近 ${r.days} 天，境内 + 境外）`);
    for (const t of r.traffic) {
      const cap = t.cap;
      const capText = !cap.on
        ? "没开封顶"
        : cap.cycle === 1440
          ? `封顶每天 ${gb(cap.threshold)} GB（境内、境外各算）`
          : cap.cycle === 60
            ? `封顶每小时 ${gb(cap.threshold)} GB（境内、境外各算，到下一个小时恢复；这里只有按天的数，没对照）`
            : `封顶 ${cap.metric ?? "?"} ${cap.threshold ?? "?"}（不是按天累计流量，没对照）`;
      line(`  ${t.name}（${t.role}）· ${capText}`);
      line(
        `    ${pad("日期", 8)}${pad("境内GB", 9)}${pad("境外GB", 9)}${pad("请求", 9)}${pad("4xx", 7)}${pad("5xx", 6)}${pad("回源GB", 9)}回源失败`,
      );
      // 上线前全是 0 的那些天不列
      const first = t.days.findIndex((x) => x.request > 0);
      for (const x of first < 0 ? t.days.slice(-1) : t.days.slice(first)) {
        line(
          `    ${pad(x.day.slice(5), 8)}${pad(gb(x.flux.mainland), 9)}${pad(gb(x.flux.overseas), 9)}${pad(String(x.request), 9)}${pad(String(x.status["4xx"]), 7)}${pad(String(x.status["5xx"]), 6)}${pad(gb(x.origin), 9)}${x.originFail} / ${x.originRequest}`,
        );
      }
    }
    line();
    line("COS 存储");
    for (const s of r.storage)
      line(`  ${pad(s.role, 20)}${s.missing ? ".machine.env 里没配这个桶" : `${s.files} 个文件，${gb(s.bytes)} GB`}`);
    line();
  }

  line("告警");
  if (!r.traffic) line("  离线模式不查流量，只报下载相关的");
  if (!r.alerts.length) line("  没有");
  for (const a of r.alerts) line(`  ${a.level === "alert" ? "【告警】" : "【留意】"}${a.domain}：${a.text}`);
  return out.join("\n");
}

main().catch((error) => {
  console.error(`stats：${error.message}`);
  process.exit(1);
});
