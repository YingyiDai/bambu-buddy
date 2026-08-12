#!/usr/bin/env node
// 熊猫标签的「离屏渲染」预览：不装 Electron、不开 GUI，也能看到熊猫下方那行标签的**真实**样子，
// 并出一张对比图。用于改文案/改标签布局时自查，以及在无显示器的云端会话里给人看效果。
//
// 为什么能保真：它加载的是**真的** src/renderer/index.html（真 style.css、真 pet.js、真 webm 动画），
// 只把 Electron 的 IPC 通道 window.pet 换成桩——预加载脚本 preload.js 暴露的就是这一个对象
// （onState / onLocale / onPrefs + 几个上行方法，见 src/preload.js）。桩接住 pet.js 注册的回调，
// 然后由本脚本按真实报文推 state/locale/prefs 进去。于是标签文案、多行布局、折行截断、视频切换
// 全部由产品代码自己算，脚本一行文案都不自己拼——避免「预览好看、真机不一样」。
// 状态本身也走真的 resolveState(report)，多台聚合走真的 pickAttentionItem/buildLabelLines，
// 报文 → 标签行这一段同样不是手搓的。
//
// **页面视口宽度必须等于真机窗口宽**（见 WIN_W）：标签 pill 的 max-width 是相对窗口算的，
// 视口一宽，文案就永远放得下、永远不折行——预览会漂亮得失真。这里按 main.js 的口径复现窗口宽。
//
// 用法：
//   node scripts/preview-label.js [输出.png]
//   node scripts/preview-label.js out.png --locale=en      # 只出英文
//   node scripts/preview-label.js out.png --scale=3        # 更高清（默认 2 倍图）
//   node scripts/preview-label.js out.png --html=/path/to/index.html   # 渲染另一棵树（做前后对比）
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
const { pickAttentionItem, buildLabelLines } = require('../src/core/attention');
const { STRINGS } = require('../src/config/locales');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

// 熊猫尺寸/字号取默认档，与真机默认观感一致。
const PET_PX = 160;
const FONT_PX = 12;

// 以下三个数必须与 main.js 保持一致，否则预览的几何就不是真机的几何：
//   MIN_WIN_WIDTH  窗口宽下限（熊猫比它小时窗口仍保持这么宽）
//   WIN_W          真机窗口宽 = max(熊猫宽, 下限)——**标签可用宽度的唯一来源**
//   LABEL_BASE_PX  熊猫方形内已预留给标签的高度；超出部分才向下加高窗口
const MIN_WIN_WIDTH = 220;
const WIN_W = Math.max(PET_PX, MIN_WIN_WIDTH);
const LABEL_BASE_PX = 26;

// 预览场景：每条 = 一份**报文**（喂给真的 resolveState）+ 一句说明。
// 打印中的完成时刻取决于「当下时间 + 剩余分钟」，故固定一个基准时刻（今晚 23:00）让出图可复现：
// 同样的剩余分钟每次跑都得到同样的钟点，图能直接对比。
const BASE_HOUR = 23;

function printingReport(remainMins) {
  return {
    gcode_state: 'RUNNING', stg_cur: 0, mc_percent: 42,
    layer_num: 126, total_layer_num: 300, mc_remaining_time: remainMins,
  };
}

// 单台：无名字前缀，与单打印机时代观感一致。
function solo(remainMins, note) {
  return {
    group: '单台',
    note,
    hint: `剩余 ${fmtRemainText(remainMins)}`,
    state: resolveState(printingReport(remainMins)),
  };
}

// 多台：走真的聚合链路（pickAttentionItem 选熊猫演哪台 + buildLabelLines 逐台出行），
// 与 main.js buildPetState 拼出的 state 形状一致（含 lines / activeSerial）。
function farm(note, printers) {
  const items = printers.map((p) => ({
    serial: p.serial, name: p.name, state: resolveState(p.report), report: p.report,
  }));
  const top = pickAttentionItem(items);
  return {
    group: '多台',
    note,
    hint: `${printers.length} 台`,
    state: { ...top.state, lines: buildLabelLines(items), activeSerial: top.serial },
  };
}

const PAUSED_USER = { gcode_state: 'PAUSE', stg_cur: 16 };
const IDLE = { gcode_state: 'IDLE' };

const SCENARIOS = [
  solo(45, '当天完成 · 无后缀'),
  solo(90, '跨到明天 · +1'),
  solo(9 * 60, '9 小时后 · 明早 +1'),
  solo(33 * 60, '33 小时后 · +2'),
  solo(7 * 24 * 60, '打一星期 · +7'),
  solo(30 * 24 * 60, '打一个月 · +30'),
  farm('两台：一台打印中 · 一台空闲', [
    { serial: '01P', name: 'P1S', report: printingReport(90) },
    { serial: '01X', name: 'X1C', report: IDLE },
  ]),
  farm('三台全在打 · 最长的一台', [
    { serial: '01P', name: '客厅 P1S', report: printingReport(45) },
    { serial: '01X', name: '工作室 X1C', report: { ...printingReport(33 * 60), mc_percent: 12, layer_num: 40 } },
    { serial: '01A', name: 'A1 mini', report: { ...printingReport(9 * 60), mc_percent: 77, layer_num: 233 } },
  ]),
  farm('长名字 · 一台还暂停了', [
    { serial: '01P', name: '二楼靠窗那台 P1S', report: printingReport(90) },
    { serial: '01X', name: 'X1-Carbon-Studio', report: PAUSED_USER },
  ]),
];

function parseArgs(argv) {
  const opts = { out: null, locales: ['zh-CN', 'en'], scale: 2, html: INDEX_HTML };
  for (const a of argv) {
    if (a.startsWith('--locale=')) opts.locales = [a.slice(9)];
    else if (a.startsWith('--scale=')) opts.scale = Number(a.slice(8)) || 2;
    else if (a.startsWith('--html=')) opts.html = path.resolve(a.slice(7));
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
    // 真机由主进程据此加高窗口（main.js applyWinWidth）。预览里照抄这个高度去裁图，
    // 保证截出来的就是真机窗口该有的大小。
    setLabelSize: (size) => { window.__labelSize = size; },
    setInteractive: () => {},
    dragStart: () => {},
    dragEnd: () => {},
    showMenu: () => {},
  };
};

// 真机窗口高 = 熊猫方形 + 标签超出预留带的部分（main.js targetExtraHeight）。
function winHeightFor(labelH) {
  return PET_PX + Math.max(0, labelH - LABEL_BASE_PX);
}

async function shootScenario(page, { locale, state, scale }) {
  await page.evaluate(({ loc, strings }) => {
    window.__petHandlers.locale(loc, strings);
  }, { loc: locale, strings: STRINGS[locale] });
  await page.evaluate((s) => window.__petHandlers.state(s), state);
  // 等标签量完（reportLabelSize 在 rAF 里上报）+ 视频交叉淡入（350ms）落定。
  await page.waitForFunction(() => window.__labelSize && window.__labelSize.h > 0);
  await page.waitForTimeout(600);
  const size = await page.evaluate(() => window.__labelSize);
  // 视口宽即真机窗口宽，故整幅横向都要（x=0），不必再居中裁。
  return page.screenshot({
    clip: { x: 0, y: 0, width: WIN_W, height: winHeightFor(size.h) },
    omitBackground: true,
    scale: scale > 1 ? 'css' : 'device',
  });
}

// 把各场景的截图拼成一张对比长图：深色「桌面」底（pill 是半透明的，必须有底才看得出真实观感）
// + 每格一句说明。拼图页本身也用 Chromium 截，故最终只产出一个文件。
function sheetHtml(cells, locales, subtitle) {
  const groups = locales.map((loc) => {
    const inLocale = cells.filter((c) => c.locale === loc);
    const names = [...new Set(inLocale.map((c) => c.group))];
    const blocks = names.map((g) => {
      const items = inLocale.filter((c) => c.group === g).map((c) => `
        <figure>
          <img src="data:image/png;base64,${c.png}" style="width:${WIN_W}px">
          <figcaption>${c.note}<span>${c.hint}</span></figcaption>
        </figure>`).join('');
      return `<h3>${g}</h3><div class="grid">${items}</div>`;
    }).join('');
    return `<section><h2>${loc === 'en' ? 'English' : '简体中文'}</h2>${blocks}</section>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; padding:28px 24px 32px; font:14px/1.5 -apple-system,"PingFang SC","Helvetica Neue",sans-serif;
         color:#e8e8ea; background:linear-gradient(150deg,#2b3a4a 0%,#3d4f52 45%,#4a4038 100%); }
  h1 { margin:0 0 4px; font-size:19px; font-weight:650; }
  p.sub { margin:0 0 22px; font-size:12.5px; opacity:.72; }
  h2 { margin:18px 0 10px; font-size:13px; font-weight:600; opacity:.8; letter-spacing:.04em; }
  h3 { margin:14px 0 8px; font-size:12px; font-weight:600; opacity:.6; }
  .grid { display:flex; flex-wrap:wrap; gap:14px; align-items:flex-start; }
  figure { margin:0; padding:10px 10px 8px; border-radius:12px; background:rgba(255,255,255,.05);
           border:1px solid rgba(255,255,255,.08); display:flex; flex-direction:column; align-items:center; }
  figure img { display:block; image-rendering:auto; }
  figcaption { margin-top:8px; font-size:11.5px; text-align:center; opacity:.85; }
  figcaption span { display:block; font-size:10.5px; opacity:.6; margin-top:2px; }
  </style>
  <h1>熊猫标签预览 · 窗口宽 ${WIN_W}px（真机口径）</h1>
  <p class="sub">${subtitle}</p>
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
  // 视口宽 = 真机窗口宽（标签可用宽度由它决定，见文件头注释）；高给足，按标签实际高度裁。
  const page = await browser.newPage({
    viewport: { width: WIN_W, height: 520 },
    deviceScaleFactor: opts.scale,
  });
  await page.addInitScript(PET_STUB);
  await page.goto(pathToFileURL(opts.html).href);
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
      const buf = await shootScenario(page, { locale, state: sc.state, scale: opts.scale });
      cells.push({ locale, group: sc.group, note: sc.note, hint: sc.hint, png: buf.toString('base64') });
    }
  }

  const subtitle = `真实渲染（${path.relative(ROOT, opts.html) || opts.html} + style.css + pet.js），`
    + `基准时刻 ${BASE_HOUR}:00 · 熊猫 ${PET_PX}px / 字号 ${FONT_PX}px · 开关：显示层数 / 剩余时间 / 完成时间 全开`;
  const sheet = await browser.newPage({ viewport: { width: 980, height: 400 }, deviceScaleFactor: opts.scale });
  await sheet.setContent(sheetHtml(cells, opts.locales, subtitle));
  await sheet.waitForTimeout(150);
  fs.writeFileSync(opts.out, await sheet.screenshot({ fullPage: true }));
  await browser.close();
  console.log(`预览已生成：${opts.out}（${cells.length} 格 / ${opts.locales.join(', ')}）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
