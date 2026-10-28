// 下载量和流量观测的计算部分：只吃数据、不碰网络，scripts/ops/stats.mjs 取数后交给这里算。
//
// 下载量从 CDN 访问日志算：每个安装包按"传出去的字节 ÷ 包的大小"折算成完整下载次数，
// 分段下载、下到一半断掉、安全软件预扫都不会把数撑大。同一个 IP 同一种包一天最多算一次：
// 多线程下载器会分段重复拉（10-28 一个 IP 把 126 MB 的安装程序拉了 2.2 GB），不封顶就被算成十几次。
// 代价是公司、学校这类共用出口的，同一天同一种包只算一次。
// 自己的下载（发版核对、验收、自己升级）靠下面几条特征认出来源 IP，整段时间里这个 IP 都算自己的。

import { createHash } from "node:crypto";
import { ARCHS, archiveName, dmgName, WINDOWS_ARCHIVE, WINDOWS_SETUP } from "../release/release-layout.mjs";

// 0.10.1 及以前：终端安装的包是 tar.gz，更新也是整包下这些包（所以那时的"终端安装"里含着更新）。
// 之后更新改成按块下（store/ 下的对象），单独算流量。缓存的日志里老名字还在，照样认
const MAC_CLI = { key: "mac-cli", label: "Mac 终端安装", platform: "mac" };
const PACKAGES = new Map([
  [dmgName("arm64"), { key: "mac-dmg-arm64", label: "Mac 安装包（Apple 芯片）", platform: "mac" }],
  [dmgName("x64"), { key: "mac-dmg-x64", label: "Mac 安装包（Intel）", platform: "mac" }],
  ...ARCHS.flatMap((arch) => [archiveName(arch), `speakmore-darwin-${arch}.tar.gz`]).map((name) => [name, MAC_CLI]),
  [WINDOWS_SETUP, { key: "win-setup", label: "Windows 安装程序", platform: "win" }],
  [WINDOWS_ARCHIVE, { key: "win-cli", label: "Windows 终端安装", platform: "win" }],
]);

/** 更新按块下的对象：/<前缀>/store/<sha256> */
const isObject = (path) => /^\/[^/]+\/store\/[0-9a-f]{64}$/.test(path);
const KINDS = [...new Map([...PACKAGES.values()].map((kind) => [kind.key, kind])).values()];

// 腾讯云 CDN 访问日志一行：时间 IP 域名 路径 字节 省份 运营商 状态码 来源 耗时 "UA" "Range" 方法 ……
const LINE = /^(\d{14}) (\S+) (\S+) (\S+) (\d+) (\S+) (\S+) (\d{3}) (\S+) (\S+) "([^"]*)" "([^"]*)" (\S+)/;

/** 拆一行访问日志；格式不对的行返回 null */
export function parseLogLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, time, ip, , path, bytes, , , status, , , ua, , method] = m;
  return {
    time,
    day: `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`,
    ip,
    path: path.split("?")[0],
    bytes: Number(bytes),
    status: Number(status),
    ua,
    method,
  };
}

/** 路径是哪一种安装包；校验值、脚本、channel.json、更新的对象都不是包，返回 null */
export const packageKind = (path) => PACKAGES.get(path.split("/").pop()) ?? null;

/** 发布包路径里的版本目录：/<前缀>/v1.2.3[-rc.1]/<文件> 里的 v1.2.3；扫描器探的 /api/v1/.env 之类不算 */
const versionOf = (path) => /^\/[^/]+\/(v\d+\.\d+\.\d+[^/]*)\/[^/]+$/.exec(path)?.[1] ?? null;

export const hashIp = (ip) => createHash("sha256").update(ip).digest("hex");

const seconds = (time) =>
  Date.UTC(
    +time.slice(0, 4),
    +time.slice(4, 6) - 1,
    +time.slice(6, 8),
    +time.slice(8, 10),
    +time.slice(10, 12),
    +time.slice(12, 14),
  ) / 1000;
const isOk = (row) => row.status >= 200 && row.status < 300;

/**
 * 认出自己的来源 IP，返回 Map<IP, Set<原因>>。原因有：
 * - ship：curl 在两分钟内拉了至少 4 个不同的 .sha256（ship.sh 收尾时从下载地址逐个核对校验值，用户装一次只拉一两个）
 * - prerelease：请求了预发版（版本号带 -，只有我们自己试链路时才发）
 * - windows-acceptance：不带 UA 拉 Windows 安装程序的校验值（开发机上的验收脚本用 WebClient 核对；
 *   用户是浏览器下的，不会单独去拉它；irm 一行装的只拉 zip 的校验值）
 * - known：记下来的本机出口（known 是 IP 的 sha256）
 */
export function findSelf(rows, { known = new Set() } = {}) {
  const self = new Map();
  const mark = (ip, reason) => {
    if (!self.has(ip)) self.set(ip, new Set());
    self.get(ip).add(reason);
  };
  const shas = new Map();
  for (const row of rows) {
    if (row.ua.startsWith("curl/") && row.path.endsWith(".sha256")) {
      if (!shas.has(row.ip)) shas.set(row.ip, []);
      shas.get(row.ip).push(row);
    }
  }
  for (const [ip, list] of shas) {
    list.sort((a, b) => a.time.localeCompare(b.time));
    const hit = list.some((row) => {
      const start = seconds(row.time);
      const paths = new Set(
        list.filter((r) => seconds(r.time) - start >= 0 && seconds(r.time) - start <= 120).map((r) => r.path),
      );
      return paths.size >= 4;
    });
    if (hit) mark(ip, "ship");
  }
  for (const row of rows) {
    if (versionOf(row.path)?.includes("-")) mark(row.ip, "prerelease");
    if (row.ua === "NULL" && row.path.endsWith(`${WINDOWS_SETUP}.sha256`)) mark(row.ip, "windows-acceptance");
    if (known.has(hashIp(row.ip))) mark(row.ip, "known");
  }
  return self;
}

const round2 = (x) => Math.round(x * 100) / 100;
const PHONE = /iPhone|iPad|Android|Mobile/;

/**
 * 下载地址上每个文件多大（折算下载次数用）：在上次记的基础上，用这次从桶里列出来的盖上去。
 * 发过的包一直记着：旧版本从桶里删了，日志里它们的下载照样折算得出来，也不会被当成点到了不存在的文件。
 * 更新的块（store/ 下）成千上万、不算下载量，不记
 * @param {Record<string, number> | null} before 上次记的
 * @param {Record<string, number>} listed 这次从桶里列出来的（对象名 → 字节）
 * @param {string} prefix 发布包在桶里的前缀
 */
export function knownSizes(before, listed, prefix) {
  const fresh = Object.entries(listed).filter(
    ([key]) => key.startsWith(`${prefix}/`) && !key.startsWith(`${prefix}/store/`),
  );
  return { ...(before ?? {}), ...Object.fromEntries(fresh) };
}

/**
 * 折算下载量。sizes：Map<路径, 字节数>（路径带开头的 /）；self：findSelf 的结果。
 * 只算 GET 且 2xx 的；每个包按字节折算，同一个 IP 同一种包一天最多算一次（不分版本），自测的单独记。
 */
export function summarizeDownloads(rows, { sizes, self }) {
  const kinds = new Map(KINDS.map((k) => [k.key, { ...k, total: 0, self: 0, real: 0 }]));
  const days = new Map();
  const perIp = new Map();
  // 每个 IP 每种包每天已经算了多少次，到 1 就不再加
  const counted = new Map();
  let phone = 0;
  const updates = { bytes: 0, self: 0, ips: new Set() };
  for (const row of rows) {
    if (!days.has(row.day)) days.set(row.day, { day: row.day, mac: 0, win: 0 });
    if (isObject(row.path)) {
      if (row.method !== "GET" || !isOk(row)) continue;
      if (self.has(row.ip)) updates.self += row.bytes;
      else {
        updates.bytes += row.bytes;
        updates.ips.add(row.ip);
      }
      continue;
    }
    const kind = packageKind(row.path);
    const size = sizes.get(row.path);
    if (!kind || !size || row.method !== "GET" || !isOk(row)) continue;
    const key = `${row.ip} ${kind.key} ${row.day}`;
    const before = counted.get(key) ?? 0;
    const share = Math.min(row.bytes / size, 1 - before);
    if (share <= 0) continue;
    counted.set(key, before + share);
    const entry = kinds.get(kind.key);
    entry.total += share;
    if (self.has(row.ip)) {
      entry.self += share;
      continue;
    }
    entry.real += share;
    days.get(row.day)[kind.platform] += share;
    perIp.set(row.ip, (perIp.get(row.ip) ?? 0) + share);
    if (PHONE.test(row.ua)) phone += share;
  }
  const list = [...kinds.values()].map((k) => ({
    ...k,
    total: round2(k.total),
    self: round2(k.self),
    real: round2(k.real),
  }));
  const times = rows.map((r) => r.time).sort();
  return {
    kinds: list,
    real: round2(list.reduce((n, k) => n + k.real, 0)),
    self: round2(list.reduce((n, k) => n + k.self, 0)),
    days: [...days.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({ ...d, mac: round2(d.mac), win: round2(d.win) })),
    // 至少下完半个包的真实来源 IP：比次数更接近人数（换网络会多算、共用出口会少算）
    realIps: [...perIp.values()].filter((n) => n >= 0.5).length,
    phone: round2(phone),
    // 更新按块下的流量（字节，不折算次数：每台机器缺的块不一样多）；ips 约等于更新了的机器数
    updates: { bytes: updates.bytes, self: updates.self, ips: updates.ips.size },
    range: { from: times[0] ?? null, to: times.at(-1) ?? null },
  };
}

const decode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * 真用户拿到的 404（只看发布包路径，扫描器和自测不算）：
 * - early：桶里现在有这个文件，404 是它传上去之前（发版时链接先换了）或封顶时拿到的，按版本归
 * - missing：桶里没有这个文件（链接写坏了、手敲错了），按路径归
 * files：桶里现有文件的路径（带开头的 /）
 */
export function earlyMisses(rows, { files, self }) {
  const groups = new Map();
  for (const row of rows) {
    const version = versionOf(row.path);
    if (row.status !== 404 || !version || self.has(row.ip)) continue;
    const entry = files.has(row.path) ? { kind: "early", version } : { kind: "missing", path: decode(row.path) };
    const key = `${entry.kind} ${entry.version ?? entry.path}`;
    if (!groups.has(key)) groups.set(key, { ...entry, requests: 0, ips: new Set(), last: row.time });
    const g = groups.get(key);
    g.requests += 1;
    g.ips.add(row.ip);
    if (row.time > g.last) g.last = row.time;
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.version ?? a.path).localeCompare(b.version ?? b.path, undefined, { numeric: true }),
    )
    .map((g) => ({ ...g, ips: g.ips.size }));
}

/** 日志时间 YYYYMMDDHHMMSS 写成 MM-DD HH:MM */
export const at = (time) =>
  time ? `${time.slice(4, 6)}-${time.slice(6, 8)} ${time.slice(8, 10)}:${time.slice(10, 12)}` : "-";

/**
 * 坏链接告警：同一个不存在的文件有两个以上真用户点到，而且 since（YYYYMMDDHHMMSS）之后还有人点到才报。
 * 一个人的多半是手敲错了；很久没人点的多半已经改好了，缓存的日志一直留着，不能天天报。
 */
export const missAlerts = (misses, domain, since) =>
  misses
    .filter((m) => m.kind === "missing" && m.ips >= 2 && m.last >= since)
    .map((m) => ({
      level: "warn",
      domain,
      text: `没有这个文件：${m.path}，${m.ips} 个真用户拿到 404（最近一次 ${at(m.last)}），多半是哪里的链接写坏了`,
    }));

const AREA = { mainland: "境内", overseas: "境外" };
/** 字节换成 GB，和腾讯云控制台一样按 1024 算（控制台里填的"50 GB"封顶是 50 × 1024³ 字节） */
export const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);

/**
 * 流量告警。每个域名：{ name, today, days: [{ day, flux: { mainland, overseas }, status: { "5xx" }, originRequest, originFail }],
 * cap: { on, metric, cycle, threshold, lastTrigger: { mainland, overseas } } }。
 * 封顶按境内、境外分别触发（两个区的上次触发时间分开记），所以分别对照。
 * level：alert 已经影响下载，warn 要留意。
 */
export function trafficAlerts(domains) {
  const alerts = [];
  for (const d of domains) {
    const add = (level, text) => alerts.push({ level, domain: d.name, text });
    const cap = d.cap ?? { on: false };
    if (!cap.on) {
      add("warn", "没开用量封顶：流量没有上限，被刷时费用也没有上限");
    } else if (cap.metric === "flux" && cap.cycle === 1440 && cap.threshold > 0) {
      const today = d.days.find((x) => x.day === d.today);
      for (const area of Object.keys(AREA)) {
        const used = today?.flux[area] ?? 0;
        const share = used / cap.threshold;
        if (share >= 1) add("alert", `今天${AREA[area]}流量 ${gb(used)} GB，已到封顶，超出部分返回 404`);
        else if (share >= 0.7)
          add(
            "warn",
            `今天${AREA[area]}流量 ${gb(used)} GB，已到每天封顶 ${gb(cap.threshold)} GB 的 ${Math.round(share * 100)}%`,
          );
      }
    }
    const since = d.days[0]?.day ?? d.today;
    for (const area of Object.keys(AREA)) {
      const at = cap.lastTrigger?.[area];
      if (at && at.slice(0, 10) >= since) add("alert", `${AREA[area]}上次触发封顶：${at}`);
    }
    const sum = (pick) => {
      const hit = d.days.filter((x) => pick(x) > 0);
      return { n: hit.reduce((n, x) => n + pick(x), 0), days: hit.map((x) => x.day).join("、") };
    };
    const s5 = sum((x) => x.status?.["5xx"] ?? 0);
    if (s5.n > 0) add("warn", `5xx 共 ${s5.n} 次（${s5.days}）`);
    // 回源失败平时也有零星几次（同期回源 5xx 为 0，多半是超时、断连），按天看失败率：至少 10 次且到 5% 才报
    for (const x of d.days) {
      const fail = x.originFail ?? 0;
      const total = x.originRequest ?? 0;
      if (fail >= 10 && total > 0 && fail / total >= 0.05)
        add("warn", `回源失败率 ${((100 * fail) / total).toFixed(1)}%（${x.day}，${total} 次回源失败 ${fail} 次）`);
    }
  }
  return alerts;
}

/**
 * 用量封顶：累计流量那一档（按天或按小时，scripts/ops/cdn-cap.mjs 设的）；按天的才能和每天的流量直接对照。
 * alert 是腾讯云 CDN 域名配置里的 BandwidthAlert
 */
export function capOf(alert) {
  const total = (alert?.StatisticItems ?? []).find(
    (i) => i.Switch === "on" && i.Metric === "flux" && (i.Cycle === 1440 || i.Cycle === 60),
  );
  return {
    on: alert?.Switch === "on" || Boolean(total),
    metric: total ? "flux" : alert?.Metric,
    cycle: total?.Cycle ?? null,
    threshold: total?.BpsThreshold ?? alert?.BpsThreshold ?? null,
    counterMeasure: total?.CounterMeasure ?? alert?.CounterMeasure ?? null,
    lastTrigger: { mainland: alert?.LastTriggerTime ?? null, overseas: alert?.LastTriggerTimeOverseas ?? null },
  };
}

/**
 * 按小时封顶的配置（cdn-cap.mjs 写进去的那份）：累计流量每小时 gb GB（按 1024 算，和控制台一样），超了全部 404，
 * 一小时后自动恢复，到八成提醒。Cycle 和 UnBlockTime 都是分钟
 */
export function hourlyCap(gb) {
  const threshold = Math.round(gb * 2 ** 30);
  const common = { BpsThreshold: threshold, CounterMeasure: "RETURN_404", AlertSwitch: "on", AlertPercentage: 80 };
  return {
    Switch: "on",
    Metric: "flux",
    ...common,
    StatisticItems: [{ Type: "total", Switch: "on", Metric: "flux", Cycle: 60, UnBlockTime: 60, ...common }],
  };
}

/** 封顶配置里要和 hourlyCap 对得上的那几项：读回来逐项比 */
export function capMismatches(wanted, actual) {
  const item = (alert) => alert?.StatisticItems?.find((it) => it.Type === "total") ?? {};
  const top = ["Switch", "Metric", "CounterMeasure"];
  const inner = [
    "Switch",
    "Metric",
    "Cycle",
    "UnBlockTime",
    "BpsThreshold",
    "CounterMeasure",
    "AlertSwitch",
    "AlertPercentage",
  ];
  return [
    ...top.filter((key) => actual?.[key] !== wanted[key]).map((key) => key),
    ...inner.filter((key) => item(actual)[key] !== item(wanted)[key]).map((key) => `StatisticItems.${key}`),
  ];
}

/**
 * 更新要的块（store/ 下）真用户拿到 404：块没传上去、或者被删了，装着的那份更新不了。since 之后还有人碰到才报
 * （封顶时一切都 404，那种另有封顶的告警）
 */
export function objectMissAlerts(rows, { self, domain, since }) {
  const hits = rows.filter((row) => isObject(row.path) && row.status === 404 && !self.has(row.ip) && row.time >= since);
  if (hits.length === 0) return [];
  const ips = new Set(hits.map((row) => row.ip)).size;
  return [
    {
      level: "warn",
      domain,
      text: `更新要的块 404 了 ${hits.length} 次（${ips} 个真用户，最近一次 ${at(
        hits
          .map((row) => row.time)
          .sort()
          .at(-1),
      )}）：查 store/ 里是不是少了对象`,
    },
  ];
}
