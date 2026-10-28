import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capMismatches,
  capOf,
  earlyMisses,
  findSelf,
  hashIp,
  hourlyCap,
  knownSizes,
  missAlerts,
  objectMissAlerts,
  packageKind,
  parseLogLine,
  summarizeDownloads,
  trafficAlerts,
} from "../../../scripts/ops/stats-core.mjs";

// 日志行照腾讯云 CDN 访问日志的格式造：时间 IP 域名 路径 字节 省份 运营商 状态码 来源 耗时 "UA" "Range" 方法 协议 命中 端口
// IP 用文档专用的地址段，不是真人
const line = ({
  t = "20261018120000",
  ip = "203.0.113.9",
  path,
  bytes = 100,
  status = 200,
  ua = "curl/8.7.1",
  method = "GET",
}) => `${t} ${ip} dl.zephyrxiang.com ${path} ${bytes} 22 2 ${status} NULL 12 "${ua}" "(null)" ${method} HTTPS hit 443`;
const rowsOf = (...specs) => specs.map((spec) => parseLogLine(line(spec)));

const DMG = "/speakmore/v0.9.3/SpeakMore-arm64.dmg";
const SETUP = "/speakmore/v0.9.3/SpeakMore-Setup-x64.exe";
const BROWSER_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15";

test("日志行：拆出时间、日期、IP、路径（去掉查询串）、字节、状态码、UA、方法；UA 里有空格也照样拆", () => {
  const row = parseLogLine(line({ path: `${SETUP}?from=readme`, bytes: 199064404, ua: BROWSER_WIN }));
  assert.deepEqual(row, {
    time: "20261018120000",
    day: "2026-10-18",
    ip: "203.0.113.9",
    path: SETUP,
    bytes: 199064404,
    status: 200,
    ua: BROWSER_WIN,
    method: "GET",
  });
  assert.equal(parseLogLine(""), null);
  assert.equal(parseLogLine("garbage line"), null);
});

test("安装包按文件名归类（0.10.1 以前的 tar.gz 也认），校验值、脚本、channel.json、更新的块不算包", () => {
  assert.deepEqual(packageKind(DMG), { key: "mac-dmg-arm64", label: "Mac 安装包（Apple 芯片）", platform: "mac" });
  assert.equal(packageKind("/speakmore/v0.9.3/SpeakMore-x64.dmg").key, "mac-dmg-x64");
  assert.equal(packageKind("/speakmore/v0.9.3/speakmore-darwin-arm64.tar.gz").key, "mac-cli");
  assert.equal(packageKind("/speakmore/v0.9.3/speakmore-darwin-x64.tar.gz").key, "mac-cli");
  assert.equal(packageKind("/speakmore/v0.11.0/speakmore-darwin-arm64.tar.xz").key, "mac-cli");
  assert.equal(packageKind("/speakmore/v0.11.0/speakmore-darwin-x64.tar.xz").key, "mac-cli");
  assert.equal(packageKind(SETUP).key, "win-setup");
  assert.equal(packageKind("/speakmore/v0.9.3/speakmore-win32-x64.zip").key, "win-cli");
  for (const path of [
    `${DMG}.sha256`,
    "/speakmore/latest",
    "/speakmore/channel.json",
    `/speakmore/store/${"a".repeat(64)}`,
    "/speakmore/install.sh",
    "/speakmore/install.ps1",
    "/",
  ]) {
    assert.equal(packageKind(path), null, path);
  }
});

test("自测特征一：curl 在两分钟内拉了至少 4 个不同的 .sha256，是 ship 收尾核对", () => {
  const shas = ["SpeakMore-arm64.dmg", "SpeakMore-x64.dmg", "speakmore-darwin-arm64.tar.gz", "SpeakMore-Setup-x64.exe"];
  const ship = rowsOf(
    ...shas.map((f, i) => ({ ip: "198.51.100.1", t: `2026101712000${i}`, path: `/speakmore/v0.9.3/${f}.sha256` })),
  );
  assert.deepEqual([...findSelf(ship).get("198.51.100.1")], ["ship"]);

  // 只拉了 3 个，或者 4 个分散在十分钟里：都是普通用户装了几次
  const three = rowsOf(...shas.slice(0, 3).map((f) => ({ ip: "198.51.100.2", path: `/speakmore/v0.9.3/${f}.sha256` })));
  const spread = rowsOf(
    ...shas.map((f, i) => ({ ip: "198.51.100.3", t: `202610171${i}0000`, path: `/speakmore/v0.9.3/${f}.sha256` })),
  );
  // 浏览器连着点了四个校验值，也不是 ship
  const browser = rowsOf(
    ...shas.map((f) => ({ ip: "198.51.100.4", ua: BROWSER_WIN, path: `/speakmore/v0.9.3/${f}.sha256` })),
  );
  assert.equal(findSelf([...three, ...spread, ...browser]).size, 0);
});

test("自测特征二：请求预发版（版本号带 -）；正式版本号哪怕没发过也不算，那可能是 README 指错了、真用户拿到 404，要报出来", () => {
  const rows = rowsOf(
    { ip: "198.51.100.5", path: "/speakmore/v0.2.0-rc.1/speakmore-darwin-arm64.tar.gz" },
    { ip: "198.51.100.6", path: "/speakmore/v0.7.1-dev.2/SpeakMore-arm64.dmg", status: 404 },
    { ip: "203.0.113.19", path: "/speakmore/v9.9.9/x", status: 404 },
    { ip: "203.0.113.20", path: "/speakmore/v0.9.1/SpeakMore-Setup-x64.exe", status: 404 },
  );
  const self = findSelf(rows);
  assert.deepEqual([...self.keys()], ["198.51.100.5", "198.51.100.6"]);
  assert.deepEqual([...self.get("198.51.100.5")], ["prerelease"]);
});

test("自测特征三：不带 UA 拉 Windows 安装程序的校验值，是 Windows 开发机上的验收脚本", () => {
  const rows = rowsOf(
    { ip: "198.51.100.7", ua: "NULL", path: `${SETUP}.sha256` },
    { ip: "203.0.113.21", ua: BROWSER_WIN, path: `${SETUP}.sha256` },
    // irm 一行装的真用户：install.ps1 不带 UA 拉 zip 的校验值，不能当成我们
    { ip: "203.0.113.22", ua: "NULL", path: "/speakmore/v0.9.3/speakmore-win32-x64.zip.sha256" },
  );
  const self = findSelf(rows);
  assert.deepEqual([...self.keys()], ["198.51.100.7"]);
  assert.deepEqual([...self.get("198.51.100.7")], ["windows-acceptance"]);
});

test("自测特征四：记下来的本机出口（存的是哈希）", () => {
  const rows = rowsOf({ ip: "198.51.100.8", path: DMG });
  const self = findSelf(rows, { known: new Set([hashIp("198.51.100.8")]) });
  assert.deepEqual([...self.get("198.51.100.8")], ["known"]);
  assert.match(hashIp("198.51.100.8"), /^[0-9a-f]{64}$/);
});

test("下载量：按流量折算成完整下载（分段下载拼起来算一次），扣掉自测，按天、按平台、按包汇总", () => {
  const size = 1000;
  const sizes = new Map([
    [DMG, size],
    [SETUP, size],
  ]);
  const rows = rowsOf(
    // 真用户 A：分两段下完一个 dmg
    { ip: "203.0.113.30", t: "20261017100000", path: DMG, bytes: 600, status: 206, ua: "Mozilla/5.0 (Macintosh)" },
    { ip: "203.0.113.30", t: "20261017100010", path: DMG, bytes: 400, status: 206, ua: "Mozilla/5.0 (Macintosh)" },
    // 真用户 B：在手机上点了 Windows 安装程序
    { ip: "203.0.113.31", t: "20261018090000", path: SETUP, bytes: size, ua: PHONE },
    // 真用户 C：下了一半断了；HEAD 和 404 不算
    { ip: "203.0.113.32", t: "20261018090000", path: SETUP, bytes: 300, ua: BROWSER_WIN },
    { ip: "203.0.113.33", t: "20261018090000", path: SETUP, bytes: size, method: "HEAD" },
    { ip: "203.0.113.34", t: "20261018090000", path: SETUP, bytes: size, status: 404 },
    // 我们自己：下了两次 dmg
    { ip: "198.51.100.1", t: "20261018100000", path: DMG, bytes: size },
    { ip: "198.51.100.1", t: "20261018100100", path: DMG, bytes: size },
  );
  const self = new Map([["198.51.100.1", new Set(["ship"])]]);
  const s = summarizeDownloads(rows, { sizes, self });

  // 自测同一天下了两次 dmg，只算一次
  const dmg = s.kinds.find((k) => k.key === "mac-dmg-arm64");
  assert.deepEqual([dmg.total, dmg.self, dmg.real], [2, 1, 1]);
  const setup = s.kinds.find((k) => k.key === "win-setup");
  assert.deepEqual([setup.total, setup.self, setup.real], [1.3, 0, 1.3]);
  assert.equal(s.real, 2.3);
  assert.equal(s.self, 1);
  assert.deepEqual(s.days, [
    { day: "2026-10-17", mac: 1, win: 0 },
    { day: "2026-10-18", mac: 0, win: 1.3 },
  ]);
  // 至少下完半个包的真用户：A、B（C 只下了 0.3 个）
  assert.equal(s.realIps, 2);
  assert.equal(s.phone, 1);
  assert.deepEqual(s.range, { from: "20261017100000", to: "20261018100100" });
  assert.deepEqual(s.updates, { bytes: 0, self: 0, ips: 0 });
});

test("同一个 IP 同一种包一天最多算一次：多线程下载器重复拉、同一天换个版本再下都只算一次；换一天、换一种包另算", () => {
  const size = 1000;
  const SETUP_092 = "/speakmore/v0.9.2/SpeakMore-Setup-x64.exe";
  const sizes = new Map([
    [DMG, size],
    [SETUP, size],
    [SETUP_092, size],
  ]);
  const A = "203.0.113.50";
  const rows = rowsOf(
    // A：下载器分段重复拉，一天传出去 4.8 个包
    ...Array.from({ length: 8 }, (_, i) => ({ ip: A, t: `2026102811500${i}`, path: SETUP, bytes: 600, status: 206 })),
    // A 同一天又下了另一个版本的安装程序，还是同一种包
    { ip: A, t: "20261028120000", path: SETUP_092, bytes: size },
    // A 同一天下 dmg：换了一种包，另算
    { ip: A, t: "20261028120100", path: DMG, bytes: size },
    // A 第二天又下了半个安装程序
    { ip: A, t: "20261029090000", path: SETUP, bytes: 500 },
    // B 没到一次，照样按字节折算
    { ip: "203.0.113.51", t: "20261028130000", path: SETUP, bytes: 400, status: 206 },
    { ip: "203.0.113.51", t: "20261028130005", path: SETUP, bytes: 400, status: 206 },
    // 自测的一样封顶
    { ip: "198.51.100.1", t: "20261028140000", path: DMG, bytes: size },
    { ip: "198.51.100.1", t: "20261028140100", path: DMG, bytes: size },
  );
  const self = new Map([["198.51.100.1", new Set(["ship"])]]);
  const s = summarizeDownloads(rows, { sizes, self });

  const setup = s.kinds.find((k) => k.key === "win-setup");
  assert.deepEqual([setup.total, setup.self, setup.real], [2.3, 0, 2.3]);
  const dmg = s.kinds.find((k) => k.key === "mac-dmg-arm64");
  assert.deepEqual([dmg.total, dmg.self, dmg.real], [2, 1, 1]);
  assert.equal(s.real, 3.3);
  assert.deepEqual(s.days, [
    { day: "2026-10-28", mac: 1, win: 1.8 },
    { day: "2026-10-29", mac: 0, win: 0.5 },
  ]);
  assert.equal(s.realIps, 2);
});

test("更新的流量：store/ 下的块按字节加起来（不折算次数），自测的单独记；HEAD、404 不算", () => {
  const object = (n) => `/speakmore/store/${String(n).repeat(64)}`;
  const rows = rowsOf(
    { ip: "203.0.113.40", path: object(1), bytes: 30_000 },
    { ip: "203.0.113.40", path: object(2), bytes: 20_000 },
    { ip: "203.0.113.41", path: object(1), bytes: 30_000 },
    { ip: "203.0.113.42", path: object(3), bytes: 9_000, method: "HEAD" },
    { ip: "203.0.113.42", path: object(4), bytes: 500, status: 404 },
    { ip: "198.51.100.1", path: object(1), bytes: 30_000 },
  );
  const self = new Map([["198.51.100.1", new Set(["known"])]]);
  const s = summarizeDownloads(rows, { sizes: new Map(), self });
  assert.deepEqual(s.updates, { bytes: 80_000, self: 30_000, ips: 2 });
  assert.equal(s.real, 0, "块不算安装包的下载");
});

test("真用户拿到的 404：桶里现在有的文件记成 early（当时还没传上去），桶里没有的按路径记成 missing；扫描器和自测的不算", () => {
  const SETUP_091 = "/speakmore/v0.9.1/SpeakMore-Setup-x64.exe";
  const rows = rowsOf(
    { ip: "203.0.113.40", t: "20261017214941", path: SETUP_091, status: 404 },
    { ip: "203.0.113.40", t: "20261017214945", path: SETUP_091, status: 404 },
    // 回复里链接后面紧跟着中文括号，被当成了网址的一部分
    {
      ip: "203.0.113.42",
      t: "20261017100000",
      path: "/speakmore/v0.9.0/SpeakMore-Setup-x64.exe%EF%BC%88Windows",
      status: 404,
    },
    {
      ip: "203.0.113.43",
      t: "20261018090000",
      path: "/speakmore/v0.9.0/SpeakMore-Setup-x64.exe%EF%BC%88Windows",
      status: 404,
    },
    { ip: "203.0.113.44", path: "/api/v1/.env", status: 404 },
    { ip: "203.0.113.44", path: "/wp-json/wp/v2/docs/settings", status: 404 },
    { ip: "203.0.113.45", path: "/speakmore/v0.9.2", status: 404 },
    { ip: "198.51.100.6", path: "/speakmore/v9.9.9/SpeakMore-arm64.dmg", status: 404 },
  );
  const self = new Map([["198.51.100.6", new Set(["prerelease"])]]);
  const misses = earlyMisses(rows, { files: new Set([SETUP_091]), self });
  assert.deepEqual(misses, [
    { kind: "early", version: "v0.9.1", requests: 2, ips: 1, last: "20261017214945" },
    {
      kind: "missing",
      path: "/speakmore/v0.9.0/SpeakMore-Setup-x64.exe（Windows",
      requests: 2,
      ips: 2,
      last: "20261018090000",
    },
  ]);
  // 两个人以上拿到同一个坏链接、而且 since 之后还有人点到才报：一个人的多半是手敲错了，很久没人点的多半已经改好了
  assert.deepEqual(missAlerts(misses, "dl.zephyrxiang.com", "20261018000000"), [
    {
      level: "warn",
      domain: "dl.zephyrxiang.com",
      text: "没有这个文件：/speakmore/v0.9.0/SpeakMore-Setup-x64.exe（Windows，2 个真用户拿到 404（最近一次 10-18 09:00），多半是哪里的链接写坏了",
    },
  ]);
  assert.deepEqual(missAlerts(misses, "dl.zephyrxiang.com", "20261019000000"), []);
  assert.deepEqual(missAlerts(misses.slice(0, 1), "dl.zephyrxiang.com", "20261018000000"), []);
});

// 和腾讯云控制台一样按 1024 算：控制台里填的"50 GB"封顶是 50 × 1024³ 字节
const GB = 2 ** 30;
const domain = (over = {}) => ({
  name: "dl.zephyrxiang.com",
  today: "2026-10-18",
  days: [
    {
      day: "2026-10-17",
      flux: { mainland: 10 * GB, overseas: 8 * GB },
      status: { "5xx": 0 },
      originRequest: 2000,
      originFail: 9,
    },
    {
      day: "2026-10-18",
      flux: { mainland: 20 * GB, overseas: 5 * GB },
      status: { "5xx": 0 },
      originRequest: 300,
      originFail: 14,
    },
  ],
  cap: { on: true, metric: "flux", cycle: 1440, threshold: 50 * GB, lastTrigger: { mainland: null, overseas: null } },
  ...over,
});

test("流量告警：今天的流量按境内、境外分别对照每天的封顶，七成起提醒、到顶告警；平时没有告警", () => {
  assert.deepEqual(trafficAlerts([domain()]), []);

  const near = domain();
  near.days[1].flux.mainland = 36 * GB;
  assert.deepEqual(trafficAlerts([near]), [
    { level: "warn", domain: "dl.zephyrxiang.com", text: "今天境内流量 36.0 GB，已到每天封顶 50.0 GB 的 72%" },
  ]);

  const full = domain();
  full.days[1].flux.overseas = 50 * GB;
  assert.equal(trafficAlerts([full])[0].level, "alert");
  assert.match(trafficAlerts([full])[0].text, /境外.*已到封顶，超出部分返回 404/);
});

test("流量告警：没开封顶、窗口内触发过封顶、出现 5xx、某天回源失败率到 5%（至少 10 次），各报一条", () => {
  const off = domain({ cap: { on: false } });
  assert.deepEqual(trafficAlerts([off]), [
    { level: "warn", domain: "dl.zephyrxiang.com", text: "没开用量封顶：流量没有上限，被刷时费用也没有上限" },
  ]);

  const bad = domain();
  bad.cap.lastTrigger.overseas = "2026-10-17 21:00:00";
  bad.days[0].status["5xx"] = 3;
  bad.days[1].originFail = 15;
  assert.deepEqual(
    trafficAlerts([bad]).map((a) => [a.level, a.text]),
    [
      ["alert", "境外上次触发封顶：2026-10-17 21:00:00"],
      ["warn", "5xx 共 3 次（2026-10-17）"],
      ["warn", "回源失败率 5.0%（2026-10-18，300 次回源失败 15 次）"],
    ],
  );
});

test("封顶：按天、按小时的累计流量那一档都认得出；没开的说没开", () => {
  const daily = {
    Switch: "on",
    StatisticItems: [{ Switch: "on", Metric: "flux", Cycle: 1440, BpsThreshold: 50 * 2 ** 30 }],
  };
  assert.deepEqual([capOf(daily).on, capOf(daily).cycle, capOf(daily).threshold], [true, 1440, 50 * 2 ** 30]);
  const hourly = hourlyCap(4);
  assert.deepEqual([capOf(hourly).cycle, capOf(hourly).threshold], [60, 4 * 2 ** 30]);
  assert.equal(capOf({ Switch: "off", StatisticItems: [] }).on, false);
});

test("按小时封顶：每小时 4 GB（按 1024 算）、超了 404、一小时后恢复、八成提醒；读回来逐项比，哪项不一样说哪项", () => {
  const wanted = hourlyCap(4);
  const [item] = wanted.StatisticItems;
  assert.deepEqual(
    [
      item.Type,
      item.Metric,
      item.Cycle,
      item.UnBlockTime,
      item.BpsThreshold,
      item.CounterMeasure,
      item.AlertPercentage,
    ],
    ["total", "flux", 60, 60, 4294967296, "RETURN_404", 80],
  );
  assert.deepEqual(capMismatches(wanted, structuredClone(wanted)), []);
  // 读回来的会多几项（OpenAt、LastTriggerTime 这些），不算不一样
  const actual = structuredClone(wanted);
  actual.LastTriggerTime = null;
  actual.StatisticItems[0].OpenAt = 1;
  assert.deepEqual(capMismatches(wanted, actual), []);
  actual.StatisticItems[0].Cycle = 1440;
  actual.Switch = "off";
  assert.deepEqual(capMismatches(wanted, actual), ["Switch", "StatisticItems.Cycle"]);
});

test("更新要的块真用户拿到 404：报出来；自测的、早于 since 的不算", () => {
  const object = `/speakmore/store/${"a".repeat(64)}`;
  const rows = rowsOf(
    { ip: "203.0.113.50", t: "20261019100000", path: object, status: 404 },
    { ip: "203.0.113.51", t: "20261019110000", path: object, status: 404 },
    { ip: "203.0.113.52", t: "20261017100000", path: object, status: 404 },
    { ip: "198.51.100.1", t: "20261019120000", path: object, status: 404 },
    { ip: "203.0.113.53", t: "20261019120000", path: object, status: 200 },
  );
  const self = new Map([["198.51.100.1", new Set(["known"])]]);
  const alerts = objectMissAlerts(rows, { self, domain: "dl.example", since: "20261018000000" });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /404 了 2 次（2 个真用户，最近一次 10-19 11:00）/);
  assert.deepEqual(objectMissAlerts(rows.slice(2), { self, domain: "dl.example", since: "20261018000000" }), []);
});

test("包的大小：发过的一直记着（桶里删了旧版本，它们的下载照样折算得出来）；块不记；新列出来的为准", () => {
  const before = { "speakmore/v0.10.1/SpeakMore-arm64.dmg": 100, "speakmore/install.sh": 10 };
  const listed = {
    "speakmore/v0.11.0/SpeakMore-arm64.dmg": 105,
    "speakmore/install.sh": 18,
    "speakmore/store/abc": 5,
    "other/x": 1,
  };
  assert.deepEqual(knownSizes(before, listed, "speakmore"), {
    "speakmore/v0.10.1/SpeakMore-arm64.dmg": 100,
    "speakmore/install.sh": 18,
    "speakmore/v0.11.0/SpeakMore-arm64.dmg": 105,
  });
  assert.deepEqual(knownSizes(null, { "speakmore/a": 1 }, "speakmore"), { "speakmore/a": 1 });
});
