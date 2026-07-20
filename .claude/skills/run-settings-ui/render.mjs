// 设置窗 UI 渲染器 —— 把 Electron 设置窗那份真实渲染层（src/settings/index.html
// + style.css + settings.js）加载进预装 Chromium，用打桩的 window.bambu preload
// 桥接层驱动，然后截图。
//
// 为什么不跑真 Electron：设置窗登录/外观/关于这些界面全是渲染层代码，与打印机
// 连接、MQTT 无关。而云端 web session 里 Electron 二进制装不下来——仓库 .npmrc 把
// 下载源指向 npmmirror 镜像，它和 GitHub releases 都被出口代理 403 挡掉；SessionStart
// 钩子也是 --ignore-scripts 跳过二进制下载。于是这里走等价路径：同一份 HTML/CSS/JS
// 在 Chromium 里跑，只把 preload（window.bambu，见 src/preload-settings.js）打桩。
// 得到的是像素级一致的界面截图；唯一没覆盖的是点按钮后主进程真正弹官方登录窗那步
// （那需要真 Electron + 真账号）。
//
// 用法（务必用 xvfb-run 包一层——预装 Chromium 已移除 old headless）：
//   xvfb-run -a node .claude/skills/run-settings-ui/render.mjs [flags]
// flags:
//   --locale en|zh-CN     界面语言（默认 en）
//   --section <name>      printers|play|appearance|about（默认 printers）
//   --state out|in        账号登录态：out=未登录（显示登录卡），in=已登录（默认 out）
//   --region global|china 未登录卡的区域选择：global=海外（浏览器登录），china=中国区
//   --out <path>          输出 PNG 路径（默认 <SHOT_DIR>/settings-<section>-<locale>.png）
//   --preset overseas-login  预设：一次性出海外登录（中/英）+ 中国区对照三张图
// 环境变量 SHOT_DIR 覆盖输出目录（默认 /tmp/shots）。

import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
// 技能目录在 <APP>/.claude/skills/run-settings-ui/ → 上溯三层到仓库根。
const APP = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── 依赖：playwright-core（不在 package.json，SessionStart 也不装它）──
function loadChromium() {
  try {
    return require(path.join(APP, 'node_modules/playwright-core')).chromium;
  } catch {
    console.error('playwright-core 未安装，正在装入项目 node_modules …');
    execSync('npm install playwright-core@1.47.2 --no-save --registry=https://registry.npmjs.org/ --no-audit --no-fund', { cwd: APP, stdio: 'inherit' });
    return require(path.join(APP, 'node_modules/playwright-core')).chromium;
  }
}

// ── 预装 Chromium 二进制路径（PLAYWRIGHT_BROWSERS_PATH 下的 chromium-*，非 headless_shell）──
function chromiumExec() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort();
  for (const d of dirs) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`找不到预装 Chromium（${root}/chromium-*/chrome-linux/chrome）`);
}

const { STRINGS } = require(path.join(APP, 'src/config/locales.js'));
const settingsUrl = pathToFileURL(path.join(APP, 'src/settings/index.html')).href;

// 打桩 window.bambu：覆盖 preload 暴露的全部方法（见 src/preload-settings.js）。
// 登录端点返回失败/取消——静态截图不真正走登录，只保证 click 处理器不抛异常。
function makeInit({ loc, state }) {
  return ({ strings, loc, loggedIn }) => {
    const noop = () => {};
    const prefs = {
      sizePx: 220, labelFontSize: 12, showLabel: true, showLayer: false,
      showTime: false, showFinishTime: false, matchFilamentColor: true,
      autoCheckUpdate: true, locale: loc,
    };
    const storedState = loggedIn
      ? { hasToken: true, account: 'demo@bambu-buddy.example', region: 'global', printers: [] }
      : { hasToken: false };
    window.bambu = {
      getLocaleStrings: async () => strings,
      getCurrentLocale: async () => loc,
      getStoredState: async () => storedState,
      listPrinters: async () => ({ printers: [], telemetry: {} }),
      getPreferences: async () => prefs,
      setPreference: async () => {},
      getAppInfo: async () => ({ name: 'Bambu Buddy', version: '0.4.0' }),
      getUpdateState: async () => ({ phase: 'idle', supported: false }),
      browserLogin: async () => ({ ok: false, canceled: true }),
      requestSmsCode: async () => ({ ok: false }),
      loginWithCode: async () => ({ ok: false }),
      submitCredentials: async () => ({ ok: false }),
      submitVerifyCode: async () => ({ ok: false }),
      completeCloudLogin: async () => ({ ok: true }),
      logout: async () => ({ ok: true }),
      close: noop,
      checkForUpdates: async () => ({ hasUpdate: false }),
      downloadUpdate: async () => ({ ok: false }),
      installUpdate: noop,
      openExternal: noop,
      onNavigate: noop, onCheckUpdate: noop, onError: noop,
      onPrintersChanged: noop, onUpdateState: noop, onPlayStateChanged: noop,
      addLanPrinter: async () => ({ ok: false }),
      removeLanPrinter: async () => ({ ok: true }),
      renamePrinter: async () => ({ ok: true }),
      setHidden: async () => ({ ok: true }),
      refreshCloud: async () => ({ ok: true }),
      playGetState: async () => ({ isPlaying: true }),
      playSetScenario: noop, playSetProgress: noop, playAutoTour: noop,
      playSetFilamentColor: noop, playReturnToLive: noop,
    };
  };
}

function parseArgs(argv) {
  const a = { locale: 'en', section: 'printers', state: 'out', region: 'global', out: null, preset: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--locale') a.locale = argv[++i];
    else if (k === '--section') a.section = argv[++i];
    else if (k === '--state') a.state = argv[++i];
    else if (k === '--region') a.region = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--preset') a.preset = argv[++i];
  }
  return a;
}

async function renderOne(browser, { locale, section, state, region, out }) {
  const ctx = await browser.newContext({ viewport: { width: 740, height: 574 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message));
  await page.addInitScript(makeInit({ loc: locale, state }), { strings: STRINGS, loc: locale, loggedIn: state === 'in' });
  const url = settingsUrl + '#' + section;
  await page.goto(url, { waitUntil: 'networkidle' });
  // 登录卡在 printers 页；其它页不需要选区域。
  if (section === 'printers' && state === 'out') {
    await page.waitForSelector('.ac-region', { timeout: 8000 });
    await page.evaluate((r) => {
      const sel = document.querySelector('.ac-region');
      sel.value = r;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, region);
  }
  await page.waitForTimeout(500);
  const file = out || path.join(SHOT_DIR, `settings-${section}-${state}-${region}-${locale}.png`);
  await page.screenshot({ path: file });
  console.log('screenshot:', file);
  await ctx.close();
}

const args = parseArgs(process.argv.slice(2));
const chromium = loadChromium();
const browser = await chromium.launch({ executablePath: chromiumExec(), headless: false, args: ['--no-sandbox'] });

if (args.preset === 'overseas-login') {
  // 海外登录功能对照组：海外区（浏览器登录）中/英 + 中国区对照。
  await renderOne(browser, { locale: 'en', section: 'printers', state: 'out', region: 'global', out: path.join(SHOT_DIR, 'overseas-login-en.png') });
  await renderOne(browser, { locale: 'zh-CN', section: 'printers', state: 'out', region: 'global', out: path.join(SHOT_DIR, 'overseas-login-zh.png') });
  await renderOne(browser, { locale: 'zh-CN', section: 'printers', state: 'out', region: 'china', out: path.join(SHOT_DIR, 'china-login-zh.png') });
} else {
  await renderOne(browser, args);
}

await browser.close();
console.log('done');
