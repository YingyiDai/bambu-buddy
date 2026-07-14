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
