// 浏览器登录（海外区第三方账号支持）的纯逻辑部分：登录页 URL / UA 净化 / token
// cookie 判定。不依赖 Electron，窗口编排在 main.js（openBrowserLogin）。
//
// 原理：弹一个真实 BrowserWindow 加载 bambulab.com 官方登录页，用户在官方页面上
// 完成任意方式登录（含 Google / Apple / Facebook OAuth）；登录成功后站点往会话
// 写 token cookie，我们只监听 cookie 出现——与登录页的耦合面仅三点：URL、cookie
// 名、UA。官方改版登录页不影响本方案（不碰 DOM、不猜端点）。
//
// ⚠️ 红线：绝不向登录窗口注入任何 JS（executeJavaScript / preload）、不读取表单。
//    我们的代码只允许读会话 cookie——密码全程只经过 Bambu 官方页面。
//    这是隐私承诺（README FAQ）的基础，改动此模块时必须维持。
//
// 已知限制（2026-07 真机验证，勿当 bug 修）：指纹 Passkey 在登录窗内点击无反应。
// Electron 内容层没有 Chrome 的平台认证器 UI（electron#24573）；Electron 41/42 新增的
// app.configureWebAuthn 也只是自建应用私有认证器（且需签名 entitlement），用户存在
// iCloud 钥匙串的现成 passkey 依旧够不着（需要 Apple 只发给真浏览器的
// web-browser.public-key-credential 特权）→ 升级 Electron 解决不了。
// 对策：设置页按钮下方提示用户点「Try another way」改用密码/手机确认
//（Google 的替代验证已实测可完整走通）。

// 登录页 URL。仅海外区提供浏览器登录：中国区短信/密码登录已可用，且 bambulab.cn
// 前置 Cloudflare 交互挑战，没必要引入额外变量。
const LOGIN_URLS = {
  global: 'https://bambulab.com/en/sign-in',
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Google OAuth 拒绝内嵌 webview（错误页 disallowed_useragent），识别主要依据 UA
// 中的 Electron/<ver> 与应用名段。去掉这两段、保留纯 Chrome UA 即可通过（业界
// 桌面应用通行做法）。⚠️ Google 政策上不允许嵌入式登录，存在被进一步收紧的
// 长期风险——届时同窗口内的邮箱密码 / Apple / Facebook 登录不受影响。
function sanitizeUserAgent(ua, appName) {
  let s = String(ua || '');
  s = s.replace(/\sElectron\/[\d.]+/gi, '');
  if (appName) {
    // Electron 默认 UA 的应用段有两种形态：package name（bambu-buddy/1.0）
    // 或 app.setName 后的产品名（含空格时按词出现）。两种都清。
    s = s.replace(new RegExp('\\s' + escapeRe(appName).replace(/\s+/g, '[ -]') + '/[\\d.]+', 'gi'), '');
    s = s.replace(new RegExp('\\s' + escapeRe(appName.replace(/\s+/g, '-')) + '/[\\d.]+', 'gi'), '');
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

// 登录成功的判定：bambulab.com（或子域）上出现非空 token cookie。
// 值即 Bambu Cloud access token（Bearer）——与 pybambu 接受现成 auth_token、
// 社区用 MakerWorld cookie 登 ha-bambulab 的事实一致。
function isTokenCookie(cookie) {
  if (!cookie || cookie.name !== 'token' || !cookie.value) return false;
  const d = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return d === 'bambulab.com' || d.endsWith('.bambulab.com');
}

// 从 cookie 数组挑出 token（session.cookies.get 的结果）。无则 null。
function pickTokenCookie(cookies) {
  if (!Array.isArray(cookies)) return null;
  return cookies.find(isTokenCookie) || null;
}

// 主进程 openBrowserLogin 可能返回的错误 key（词条见 locales.js；
// 放这里是让 locales.test.js 的守护测试能静态扫描到）。
const ERR_BUSY = 'auth.errBrowserLoginBusy';
const ERR_UNSUPPORTED_REGION = 'auth.errBrowserLoginRegion';

module.exports = { LOGIN_URLS, sanitizeUserAgent, isTokenCookie, pickTokenCookie, ERR_BUSY, ERR_UNSUPPORTED_REGION };
