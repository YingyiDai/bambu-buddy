# Release 下载统计：手动下载 vs 自动更新

只用 GitHub Release 的下载计数（不做任何应用内埋点），粗略拆分「用户手动下载」与
「应用内自动更新」的量。**结论只求大概、不求精确**——下面每一处都标了置信度。

配套脚本：[`release-stats.js`](./release-stats.js)（零依赖，可拷到任何装了 Node 的机器上
跑；文末附全文，方便脱离本仓库使用）。

---

## 0. 一句话原理

> **别拿大文件（dmg / exe / zip）当自动更新的计数器，拿小文件（`latest*.yml`、`*.blockmap`）当。**

小文件每次自动更新差不多只被拉一次，且爬虫基本不碰，是最干净的「自动更新脉搏」。
大文件被差量下载的分块请求和爬虫双重污染，只适合估手动量、且置信度低。

---

## 1. 根本限制（先认清能做到什么）

GitHub 的下载计数就是「某资产的下载 URL 每被 GET 一次就 +1」，**不区分人点的还是
electron-updater 程序自动拉的**。所以：

- **macOS 能大致拆开**：手动用户下 `.dmg`，自动更新下 `.zip`——是两个不同资产。
- **Windows 拆不开**：自动更新包**就是** `Setup.exe` 本身，和手动下载同一个文件。
  它的计数天生是「手动 + 自动」的混合，没有任何「只有手动才碰」的独立信号。

这条限制无法用数据清洗绕过，只能用旁证（blockmap）去逼近。

一个利好：本项目日常每 6 小时的「有没有新版本」检查走的是 **GitHub API**
（`/releases/latest`），**不下载任何资产**，因此不会污染资产计数。资产计数只在
「真正发起下载更新」时才增加。

---

## 2. 信号映射：每个文件的计数来自谁

| 资产 | 计数来源 | 用途 |
|---|---|---|
| `*.dmg` | 仅手动下载（自动更新永不碰） | 估 **mac 手动** |
| `latest-mac.yml` | mac 每次发起自动更新时拉一次 | 估 **mac 自动**（最干净） |
| `*-update-macOS-*.zip.blockmap` | mac 自动更新差量索引 | mac 自动的交叉验证 |
| `*-update-macOS-*.zip` | mac 自动更新负载（被分块请求污染） | 参考，不作主计数 |
| `latest.yml` | win 每次发起自动更新时拉一次 | 估 **win 自动**（最干净） |
| `*Setup.exe.blockmap` | win 自动更新差量索引 | win 自动的交叉验证 |
| `*Setup.exe` | 手动 + 自动 **混合** | 估 **win 手动**（弱） |
| `Source code (zip/tar.gz)` | 包工具 / 爬虫，与用户无关 | **忽略** |

---

## 3. 四个估计量与置信度

| 估计量 | 公式 | 置信度 | 说明 |
|---|---|---|---|
| **mac 手动** | `dmg` | 中 | dmg 只被手动碰；噪声主要是爬虫 |
| **mac 自动** | `latest-mac.yml`（退化用 `zip.blockmap`） | 中高 | yml 小、爬虫不碰、每次更新拉一次 |
| **win 自动** | `latest.yml`（退化用 `exe.blockmap`） | 中高 | 同上 |
| **win 手动** | `exe − exe.blockmap` | **低** | exe 被差量 range 请求 + 爬虫双重污染 |

> `win 手动` 为什么低：一次 win 自动更新对 blockmap 是完整拉一次（所以 blockmap ≈ 自动更新
> 次数），但对 exe 是发一堆 range 分块请求，GitHub 如何计入这些分块并不透明；exe 又是爬虫
> 最爱抓的文件。所以 `exe − exe.blockmap` 只能当「量级参考」，不是可信数字。

对早于自动更新（v0.2.3 之前）的老版本，没有 yml/zip/blockmap，公式自动退化为
「自动=0、win 手动=exe 全量」，恰好正确（那些版本的下载确实全是手动）。

---

## 4. 数据清洗手法（这才是把噪声压下去的关键）

### 4.1 交叉一致性
一次 mac 自动更新会同时碰 `latest-mac.yml`、`zip`、`zip.blockmap`——它们应当同步增长。
若某段时间 `dmg` 猛涨但这三个没动，那波涨的是手动/爬虫，不是自动更新。用 yml 的增量当
「真实自动更新脉冲」，反过来校准别的数。

### 4.2 按时间做快照（最有效）
GitHub 只给累计总数、不给时间序列，而**爬虫噪声往往集中在发版后头几天砸向 dmg/exe**。
所以定期跑 `--snapshot <dir>` 存一份计数，看**周增量**而非累计值：一次性的爬虫尖峰会被
隔离在早期快照里，之后稳定的增量才是真实用户。脚本会自动和目录里更早的快照比对并打印增量。

建议节奏：每周一次（手动跑，或挂个 cron / CI 定时任务），快照 JSON 存进仓库或任意地方。

### 4.3 分清每个 release 的角色
自动更新的下载**累积在新版本**上（v0.2.3 用户升 v0.2.4，流量记在 v0.2.4 的资产）。
所以「当前 latest 版」的 dmg/exe ≈ 新手动用户，它的 yml/blockmap ≈ 从旧版升上来的自动更新；
旧版本被取代后，新增下载基本只剩零星手动 + 爬虫。看趋势时按这个角色去解读。

### 4.4 爬虫底噪的天花板
爬虫抓大文件但极少抓 `.blockmap`。若 `exe` 计数远高于 `exe.blockmap + latest.yml`，
多出来的大概率是爬虫 + 手动的混合——给不出精确拆分，但能得到「手动量最多不超过 X」的上限感。

---

## 5. 用法

```bash
# 默认仓库，直接看表
node scripts/release-stats.js

# 指定仓库
node scripts/release-stats.js owner/repo

# 带 token（免限流：匿名 60 次/时 → 5000 次/时）
GITHUB_TOKEN=ghp_xxx node scripts/release-stats.js

# 看每个 release 的全部原始资产计数
node scripts/release-stats.js --raw

# 输出 JSON（二次处理 / 存档）
node scripts/release-stats.js --json

# 离线：先用 gh 拉数据再喂给脚本（无 Node 联网也行）
gh api repos/OWNER/REPO/releases --paginate > releases.json
node scripts/release-stats.js --file releases.json

# 每周快照 + 增量对比（清爬虫噪声，见 4.2）
node scripts/release-stats.js --snapshot ./stats-snapshots
```

输出示例（数字为示意）：

```
TAG             mac手动(dmg)    mac自动(yml)    win自动(yml)   win手动(exe-bm)
----------------------------------------------------------------------
v0.3.0                 120            81            67             241
v0.2.2                 210             0             0             190
----------------------------------------------------------------------
合计                     330            81            67             431
```

---

## 6. 小结（别忘了的三条）

1. **mac 可拆、win 不可拆**：mac 手动看 dmg、自动看 yml；win 只有自动量（看 yml）较可信，
   手动量是估出来的、置信度低。
2. **看增量、别看累计**：累计值里沉着大量早期爬虫噪声，周增量才接近真实用户。
3. **所有数字都是趋势，不是精确遥测**：GitHub 计数天生带爬虫/镜像噪声，拿来看大致比例和
   走势就好。要精确只能靠应用内埋点（本项目明确不做）。

---

## 附：脚本全文

> 与 [`release-stats.js`](./release-stats.js) 同源，贴在此处方便脱离本仓库单独取用。
> 存成 `release-stats.js`，`node release-stats.js owner/repo` 即可跑。

```js
#!/usr/bin/env node
/*
 * release-stats.js —— 仅用 GitHub Release 下载计数，粗估「手动下载 vs 自动更新」。
 *
 * 零依赖（只用 Node 内置 https/fs），可拷到任何装了 Node 的机器上跑。
 * 方法论、口径、置信度详见 download-stats.md。
 *
 * 用法：
 *   node scripts/release-stats.js                      # 默认仓库 YingyiDai/bambu-buddy
 *   node scripts/release-stats.js owner/repo           # 指定仓库
 *   REPO=owner/repo node scripts/release-stats.js      # 或用环境变量
 *   GITHUB_TOKEN=ghp_xxx node scripts/release-stats.js # 带 token（免限流：60→5000 次/时）
 *
 * 选项：
 *   --raw                    额外打印每个 release 的全部资产原始计数
 *   --json                   以 JSON 输出（便于二次处理 / 存档）
 *   --file <path>            不请求 API，改从本地 JSON 读 releases
 *                            （可先 `gh api repos/OWNER/REPO/releases --paginate > r.json`）
 *   --snapshot <dir>         把本次原始计数存为 <dir>/<日期>.json；若目录里已有更早的
 *                            快照，则额外打印「距上次快照的增量」——这是清爬虫噪声最有效的办法
 *                            （详见文档「按时间做快照」一节）。
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function optVal(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const RAW = args.includes('--raw');
const AS_JSON = args.includes('--json');
const FILE = optVal('--file');
const SNAPSHOT = optVal('--snapshot');
// 位置参数（owner/repo）：排除选项本身及其取值，避免把 --file/--snapshot 的路径误当成仓库名
const OPT_VALS = new Set([FILE, SNAPSHOT].filter(Boolean));
const positional = args.filter((a) => !a.startsWith('--') && !OPT_VALS.has(a));
const REPO = process.env.REPO || positional.find((a) => /^[^/]+\/[^/]+$/.test(a)) || 'YingyiDai/bambu-buddy';
const TOKEN = process.env.GITHUB_TOKEN || '';

// ---- 拉取 releases（分页跟随 Link 头）----
function apiGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: 'api.github.com', path: pathname, headers: {
        'User-Agent': 'release-stats', Accept: 'application/vnd.github+json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          resolve({ headers: res.headers, data: JSON.parse(body) });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

function nextPage(linkHeader) {
  if (!linkHeader) return null;
  const m = String(linkHeader).split(',').find((s) => s.includes('rel="next"'));
  if (!m) return null;
  const url = m.match(/<([^>]+)>/);
  return url ? url[1].replace('https://api.github.com', '') : null;
}

async function fetchReleases(repo) {
  let out = [];
  let p = `/repos/${repo}/releases?per_page=100`;
  while (p) {
    const { headers, data } = await apiGet(p);
    out = out.concat(data);
    p = nextPage(headers.link);
  }
  return out;
}

// ---- 资产分类（按文件名后缀；顺序要紧：blockmap 先于其裸文件）----
function classify(name) {
  const n = name.toLowerCase();
  if (n === 'latest-mac.yml') return 'mac_pulse';       // mac 自动更新脉搏（最干净）
  if (n === 'latest.yml') return 'win_pulse';           // win 自动更新脉搏（最干净）
  if (n.endsWith('.dmg.blockmap')) return 'mac_dmg_bm'; // 旧版遗留，现已不生成
  if (n.endsWith('.zip.blockmap')) return 'mac_zip_bm'; // mac 自动更新差量索引
  if (n.endsWith('.exe.blockmap')) return 'win_exe_bm'; // win 自动更新差量索引
  if (n.endsWith('.dmg')) return 'mac_dmg';             // mac 手动下载（自动更新不碰）
  if (n.endsWith('.zip')) return 'mac_zip';             // mac 自动更新负载包
  if (n.endsWith('.exe')) return 'win_exe';             // win 手动 + 自动 混合
  return 'other';
}

// ---- 单个 release 的估算 ----
function estimate(release) {
  const counts = {};
  for (const a of release.assets || []) {
    const k = classify(a.name);
    counts[k] = (counts[k] || 0) + (a.download_count || 0);
  }
  const g = (k) => counts[k] || 0;
  // mac 自动：优先 yml（最干净），无则退而用 zip.blockmap，再无则用 zip 负载
  const macAuto = g('mac_pulse') || g('mac_zip_bm') || g('mac_zip');
  // win 自动：优先 yml，无则用 exe.blockmap
  const winAuto = g('win_pulse') || g('win_exe_bm');
  return {
    tag: release.tag_name,
    macManual: g('mac_dmg'),                       // 置信度：中
    macAuto,                                        // 置信度：中高
    winAuto,                                        // 置信度：中高
    winManual: Math.max(0, g('win_exe') - g('win_exe_bm')), // 置信度：低（exe 被差量/爬虫污染）
    raw: counts,
  };
}

// ---- 快照：存原始计数，并与上一份快照比增量 ----
function doSnapshot(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const cur = {};
  for (const r of rows) cur[r.tag] = r.raw;
  const curPath = path.join(dir, `${today}.json`);
  fs.writeFileSync(curPath, JSON.stringify(cur, null, 2));
  // 找一份更早的快照做对比
  const prev = fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f) && f < `${today}.json`).sort().pop();
  if (!prev) { console.log(`\n📸 已存快照 ${curPath}（暂无更早快照可比）`); return; }
  const old = JSON.parse(fs.readFileSync(path.join(dir, prev), 'utf8'));
  console.log(`\n📸 距上次快照（${prev.replace('.json', '')}）的增量——过滤爬虫首日尖峰后更可信：`);
  for (const r of rows) {
    const o = old[r.tag] || {};
    const dMacManual = (r.raw.mac_dmg || 0) - (o.mac_dmg || 0);
    const dMacAuto = (r.raw.mac_pulse || 0) - (o.mac_pulse || 0);
    const dWinAuto = (r.raw.win_pulse || 0) - (o.win_pulse || 0);
    if (dMacManual || dMacAuto || dWinAuto) {
      console.log(`  ${r.tag.padEnd(10)} mac手动 +${dMacManual}  mac自动 +${dMacAuto}  win自动 +${dWinAuto}`);
    }
  }
}

// ---- 输出表格 ----
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function padL(s, n) { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; }

function printTable(rows) {
  const H = ['TAG', 'mac手动(dmg)', 'mac自动(yml)', 'win自动(yml)', 'win手动(exe-bm)'];
  console.log('');
  console.log(`${pad(H[0], 12)}${padL(H[1], 14)}${padL(H[2], 14)}${padL(H[3], 14)}${padL(H[4], 16)}`);
  console.log('-'.repeat(70));
  const tot = { macManual: 0, macAuto: 0, winAuto: 0, winManual: 0 };
  for (const r of rows) {
    console.log(`${pad(r.tag, 12)}${padL(r.macManual, 14)}${padL(r.macAuto, 14)}${padL(r.winAuto, 14)}${padL(r.winManual, 16)}`);
    tot.macManual += r.macManual; tot.macAuto += r.macAuto; tot.winAuto += r.winAuto; tot.winManual += r.winManual;
  }
  console.log('-'.repeat(70));
  console.log(`${pad('合计', 12)}${padL(tot.macManual, 14)}${padL(tot.macAuto, 14)}${padL(tot.winAuto, 14)}${padL(tot.winManual, 16)}`);
  console.log('\n置信度：mac自动/win自动=中高（yml 脉搏最干净）；mac手动=中（dmg 仅手动，含爬虫噪声）；');
  console.log('        win手动=低（exe 被差量 range 请求 + 爬虫双重污染，只当量级参考）。详见 download-stats.md。');
}

function printRaw(rows) {
  console.log('\n=== 每个 release 的原始资产计数 ===');
  for (const r of rows) {
    console.log(`\n${r.tag}`);
    for (const [k, v] of Object.entries(r.raw)) console.log(`  ${pad(k, 14)} ${v}`);
  }
}

(async () => {
  try {
    let releases;
    if (FILE) {
      releases = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!Array.isArray(releases)) throw new Error('--file 内容应为 releases 数组');
    } else {
      releases = await fetchReleases(REPO);
    }
    const rows = releases.map(estimate);
    if (AS_JSON) { console.log(JSON.stringify(rows, null, 2)); return; }
    const src = FILE ? `本地文件 ${FILE}` : `仓库 ${REPO}${TOKEN ? '（已用 token）' : '（未用 token，注意 60 次/时限流）'}`;
    console.log(`来源：${src}   release 数：${rows.length}`);
    printTable(rows);
    if (RAW) printRaw(rows);
    if (SNAPSHOT) doSnapshot(SNAPSHOT, rows);
  } catch (e) {
    console.error('出错：', e.message);
    process.exit(1);
  }
})();
```
