#!/usr/bin/env node
// 熊猫标签的「离屏渲染」预览：不装 Electron、不开 GUI，也能看到熊猫下方那行标签的**真实**样子，
// 并出一张对比图。用于改文案/改标签布局时自查，以及在无显示器的云端会话里给人看效果。
//
// 为什么能保真：它加载的是**真的** src/renderer/index.html（真 style.css、真 pet.js、真 webm 动画），
// 只把 Electron 的 IPC 通道 window.pet 换成桩——预加载脚本 preload.js 暴露的就是这一个对象
// （onState / onLocale / onPrefs + 几个上行方法，见 src/preload.js）。桩接住 pet.js 注册的回调，
// 然后由本脚本按真实报文推 state/locale/prefs 进去。于是标签文案、多行布局、跑马灯、视频切换
// 全部由产品代码自己算，脚本一行文案都不自己拼——避免「预览好看、真机不一样」。
// 状态本身也走真的 resolveState(report)，报文 → labelParams 这一段同样不是手搓的。
//
// 用法：
//   node scripts/preview-label.js [输出.png]
//   node scripts/preview-label.js out.png --locale=en      # 只出英文
//   node scripts/preview-label.js out.png --scale=3        # 更高清（默认 2 倍图）
//
// 依赖：playwright-core + 一个 Chromium。二者都不是本仓依赖（仓库只在 Electron 里跑），
// 故按需临时装：npm i playwright-core（不写进 package.json 也行，装在任意目录皆可，
// 用 PREVIEW_PLAYWRIGHT=/path/to/node_modules/playwright-core 指过去）。
// Chromium 路径按以下顺序找：PREVIEW_CHROME 环境变量 → playwright 自带的 → 常见系统路径。
// 云端会话里 Chromium 一般预装在 /opt/pw-browsers，PLAYWRIGHT_BROWSERS_PATH 已指好。

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { resolveState } = require('../src/core/state-machine');
const { STRINGS } = require('../src/config/locales');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

// 熊猫尺寸/字号取默认档，与真机默认观感一致。
const PET_PX = 160;
const FONT_PX = 12;

// 预览场景：每条 = 一份**报文**（喂给真的 resolveState）+ 一句说明。
// 打印中的完成时刻取决于「当下时间 + 剩余分钟」，故固定一个基准时刻（今晚 23:00）让出图可复现：
// 同样的剩余分钟每次跑都得到同样的钟点，图能直接对比。
const BASE_HOUR = 23;

function printing(remainMins, note) {
  return {
    note,
    report: {
      gcode_state: 'RUNNING', stg_cur: 0, mc_percent: 42,
      layer_num: 126, total_layer_num: 300, mc_remaining_time: remainMins,
    },
  };
}

const SCENARIOS = [
  printing(45, '当天完成 · 无后缀'),
  printing(90, '跨到明天 · +1'),
  printing(9 * 60, '9 小时后 · 明早 +1'),
  printing(33 * 60, '33 小时后 · +2'),
  printing(7 * 24 * 60, '打一星期 · +7'),
  printing(30 * 24 * 60, '打一个月 · +30'),
];

function parseArgs(argv) {
  const opts = { out: null, locales: ['zh-CN', 'en'], scale: 2 };
  for (const a of argv) {
    if (a.startsWith('--locale=')) opts.locales = [a.slice(9)];
    else if (a.startsWith('--scale=')) opts.scale = Number(a.slice(8)) || 2;
    else if (!a.startsWith('--')) opts.out = a;
  }
  opts.out = path.resolve(opts.out || path.join(ROOT, 'label-preview.png'));
  return opts;
}

// playwright-core 不是本仓依赖：按几处常见位置找，找不到就给出可照做的提示而不是栈。
function loadPlaywright() {
  const candidates = [
    process.env.PREVIEW_PLAYWRIGHT,
    'playwright-core',
    'playwright',
    path.join(ROOT, 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* 试下一个 */ }
  }
  console.error(
    '找不到 playwright-core。装一个再跑：\n'
    + '  npm i playwright-core        # 装在本仓，或装到别处后用 PREVIEW_PLAYWRIGHT 指过去\n'
    + '浏览器用系统已有的 Chromium 即可：PREVIEW_CHROME=/path/to/chrome',
  );
  process.exit(1);
}

// Chromium 可执行文件：显式指定 > playwright 自带 > 系统常见路径。
// playwright-core 的版本与本机预装 Chromium 版本常对不上（它按自己的版本号找目录），
// 故先探测 /opt/pw-browsers 下实际存在的那个，避免「浏览器未安装」。
function findChrome(playwright) {
  if (process.env.PREVIEW_CHROME) return process.env.PREVIEW_CHROME;
  const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(browsersRoot)) {
    const dirs = fs.readdirSync(browsersRoot).filter((d) => d.startsWith('chromium-'));
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(browsersRoot, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  try {
    const p = playwright.chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* 未装浏览器 */ }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(p)) return p;
  }
  console.error('找不到 Chromium，请用 PREVIEW_CHROME=/path/to/chrome 指定。');
  process.exit(1);
}

// window.pet 桩：必须在 pet.js 之前注入（它加载即注册回调）。
// 只接住回调 + 记录上行调用，不做任何渲染决策——渲染全由 pet.js 自己完成。
const PET_STUB = () => {
  window.__petHandlers = {};
  window.__labelSize = null;
  window.pet = {
    onState: (cb) => { window.__petHandlers.state = cb; },
    onLocale: (cb) => { window.__petHandlers.locale = cb; },
    onPrefs: (cb) => { window.__petHandlers.prefs = cb; },
    // 真机由主进程据此加宽/加高窗口（main.js applyWinWidth）。预览里照抄这个尺寸去裁图，
    // 保证截出来的就是真机窗口该有的大小。
    setLabelSize: (size) => { window.__labelSize = size; },
    setInteractive: () => {},
    dragStart: () => {},
    dragEnd: () => {},
    showMenu: () => {},
  };
};

async function shootScenario(page, { locale, state, scale }) {
  await page.evaluate(({ loc, strings }) => {
    window.__petHandlers.locale(loc, strings);
  }, { loc: locale, strings: STRINGS[locale] });
  await page.evaluate((s) => window.__petHandlers.state(s), state);
  // 等标签量完（reportLabelSize 在 rAF 里上报）+ 视频交叉淡入（350ms）落定。
  await page.waitForFunction(() => window.__labelSize && window.__labelSize.h > 0);
  await page.waitForTimeout(600);
  const size = await page.evaluate(() => window.__labelSize);
  // 真机窗口宽 = max(熊猫宽, 标签宽)，高 = 熊猫高 + 标签高；照此裁剪即得真机窗口的样子。
  const w = Math.max(PET_PX, size.w);
  const h = PET_PX + size.h;
  return page.screenshot({
    clip: { x: (page.viewportSize().width - w) / 2, y: 0, width: w, height: h },
    omitBackground: true,
    scale: scale > 1 ? 'css' : 'device',
  });
}

// 把各场景的截图拼成一张对比长图：深色「桌面」底（pill 是半透明的，必须有底才看得出真实观感）
// + 每格一句说明。拼图页本身也用 Chromium 截，故最终只产出一个文件。
function sheetHtml(cells, locales) {
  const groups = locales.map((loc) => {
    const items = cells.filter((c) => c.locale === loc).map((c) => `
      <figure>
        <img src="data:image/png;base64,${c.png}" style="width:${c.w}px">
        <figcaption>${c.note}<span>剩余 ${c.remainText}</span></figcaption>
      </figure>`).join('');
    return `<section><h2>${loc === 'en' ? 'English' : '简体中文'}</h2><div class="grid">${items}</div></section>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; padding:28px 24px 32px; font:14px/1.5 -apple-system,"PingFang SC","Helvetica Neue",sans-serif;
         color:#e8e8ea; background:linear-gradient(150deg,#2b3a4a 0%,#3d4f52 45%,#4a4038 100%); }
  h1 { margin:0 0 4px; font-size:19px; font-weight:650; }
  p.sub { margin:0 0 22px; font-size:12.5px; opacity:.72; }
  h2 { margin:18px 0 10px; font-size:13px; font-weight:600; opacity:.8; letter-spacing:.04em; }
  .grid { display:flex; flex-wrap:wrap; gap:14px; }
  figure { margin:0; padding:10px 10px 8px; border-radius:12px; background:rgba(255,255,255,.05);
           border:1px solid rgba(255,255,255,.08); display:flex; flex-direction:column; align-items:center; }
  figure img { display:block; image-rendering:auto; }
  figcaption { margin-top:8px; font-size:11.5px; text-align:center; opacity:.85; }
  figcaption span { display:block; font-size:10.5px; opacity:.6; margin-top:2px; }
  </style>
  <h1>熊猫标签预览 · 打印中的预计完成时刻</h1>
  <p class="sub">真实渲染（src/renderer/index.html + style.css + pet.js），基准时刻 ${BASE_HOUR}:00 · 开关：显示层数 / 剩余时间 / 完成时间 全开</p>
  ${groups}`;
}

function fmtRemainText(mins) {
  if (mins < 60) return `${mins} 分钟`;
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)} 天`;
  return `${(mins / 60).toFixed(mins % 60 ? 1 : 0)} 小时`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const playwright = loadPlaywright();
  const executablePath = findChrome(playwright);

  const browser = await playwright.chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({
    viewport: { width: 720, height: 420 },
    deviceScaleFactor: opts.scale,
  });
  await page.addInitScript(PET_STUB);
  await page.goto(pathToFileURL(INDEX_HTML).href);
  await page.evaluate(({ petPx, fontPx }) => window.__petHandlers.prefs({
    sizePx: petPx, labelFontSize: fontPx,
    showLabel: true, showLayer: true, showTime: true, showFinishTime: true,
    matchFilamentColor: true, hour12: false,
  }), { petPx: PET_PX, fontPx: FONT_PX });

  // 让「现在」固定在基准时刻：完成时刻 = 现在 + 剩余分钟，钉住才能出可复现、可对比的图。
  await page.evaluate((hour) => {
    const base = new Date();
    base.setHours(hour, 0, 0, 0);
    const fixed = base.getTime();
    const RealDate = Date;
    // 只钉 Date.now() 与 new Date()（无参）——带参构造仍是真的，dayOffset 照常工作。
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    };
  }, BASE_HOUR);

  const cells = [];
  for (const locale of opts.locales) {
    for (const sc of SCENARIOS) {
      const state = resolveState(sc.report);
      const buf = await shootScenario(page, { locale, state, scale: opts.scale });
      const size = await page.evaluate(() => window.__labelSize);
      cells.push({
        locale, note: sc.note, png: buf.toString('base64'),
        w: Math.max(PET_PX, size.w),
        remainText: fmtRemainText(sc.report.mc_remaining_time),
      });
    }
  }

  const sheet = await browser.newPage({ viewport: { width: 980, height: 400 }, deviceScaleFactor: opts.scale });
  await sheet.setContent(sheetHtml(cells, opts.locales));
  await sheet.waitForTimeout(150);
  fs.writeFileSync(opts.out, await sheet.screenshot({ fullPage: true }));
  await browser.close();
  console.log(`预览已生成：${opts.out}（${cells.length} 格 / ${opts.locales.join(', ')}）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
