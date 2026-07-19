// 浏览器登录纯逻辑：UA 净化 / token cookie 判定 / 登录页 URL 契约。
const test = require('node:test');
const assert = require('node:assert');
const bl = require('../src/core/browser-login');

// —— UA 净化：Google OAuth 拒绝内嵌 webview 的识别依据是 UA 里的 Electron/应用名段 ——

test('sanitizeUserAgent: 去掉 Electron 段与应用名段（package name 形态）', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) bambu-buddy/0.4.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
  const out = bl.sanitizeUserAgent(ua, 'bambu-buddy');
  assert.ok(!/Electron/i.test(out), `仍含 Electron: ${out}`);
  assert.ok(!/bambu-buddy/i.test(out), `仍含应用名: ${out}`);
  assert.ok(/Chrome\/130/.test(out), 'Chrome 段必须保留');
  assert.ok(/Safari\/537\.36$/.test(out), 'Safari 段必须保留');
  assert.ok(!/\s{2,}/.test(out), '不得留双空格');
});

test('sanitizeUserAgent: 应用名含空格（app.setName 产品名形态）也能清掉', () => {
  const ua = 'Mozilla/5.0 AppleWebKit/537.36 Bambu-Buddy/0.4.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
  const out = bl.sanitizeUserAgent(ua, 'Bambu Buddy');
  assert.ok(!/Electron|Bambu/i.test(out), `未清干净: ${out}`);
});

test('sanitizeUserAgent: 空值/无 Electron 段安全通过', () => {
  assert.strictEqual(bl.sanitizeUserAgent('', 'x'), '');
  assert.strictEqual(bl.sanitizeUserAgent('Mozilla/5.0 Chrome/1.0', 'x'), 'Mozilla/5.0 Chrome/1.0');
});

// —— token cookie 判定：只认 bambulab.com（含子域）上的非空 token ——

test('isTokenCookie: 认 bambulab.com 与子域、前导点域名', () => {
  assert.ok(bl.isTokenCookie({ name: 'token', value: 'x', domain: 'bambulab.com' }));
  assert.ok(bl.isTokenCookie({ name: 'token', value: 'x', domain: '.bambulab.com' }));
  assert.ok(bl.isTokenCookie({ name: 'token', value: 'x', domain: 'api.bambulab.com' }));
});

test('isTokenCookie: 拒绝其它域名 / 其它名字 / 空值', () => {
  assert.ok(!bl.isTokenCookie({ name: 'token', value: 'x', domain: 'evil-bambulab.com' }));
  assert.ok(!bl.isTokenCookie({ name: 'token', value: 'x', domain: 'notbambulab.com' }));
  assert.ok(!bl.isTokenCookie({ name: 'refreshToken', value: 'x', domain: 'bambulab.com' }));
  assert.ok(!bl.isTokenCookie({ name: 'token', value: '', domain: 'bambulab.com' }));
  assert.ok(!bl.isTokenCookie(null));
});

test('pickTokenCookie: 从数组挑第一个合规 token，无则 null', () => {
  const good = { name: 'token', value: 'x', domain: '.bambulab.com' };
  assert.strictEqual(bl.pickTokenCookie([{ name: 'a' }, good]), good);
  assert.strictEqual(bl.pickTokenCookie([{ name: 'a' }]), null);
  assert.strictEqual(bl.pickTokenCookie(undefined), null);
});

// —— 契约：登录页 URL 仅海外区；错误 key 已在词表（详见 locales 守护测试）——

test('LOGIN_URLS: 仅 global，指向官方登录页', () => {
  assert.deepStrictEqual(Object.keys(bl.LOGIN_URLS), ['global']);
  assert.match(bl.LOGIN_URLS.global, /^https:\/\/bambulab\.com\//);
});

// 红线守护：本模块与 main.js 的浏览器登录编排绝不向登录页注入 JS——
// 一旦出现 executeJavaScript / 给登录窗配 preload，隐私承诺（密码只经过官方页面）即被打破。
test('源码防线：浏览器登录路径无 executeJavaScript', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/main.js'), 'utf8');
  const seg = src.slice(src.indexOf('BROWSER_LOGIN_PARTITION'), src.indexOf("ipcMain.handle('bambu:login'"));
  assert.ok(seg.length > 0, '未找到浏览器登录代码段');
  assert.ok(!/\.executeJavaScript\s*\(/.test(seg), '浏览器登录代码段出现 executeJavaScript 调用');
  assert.ok(!/preload\s*:/.test(seg), '浏览器登录窗口不得配置 preload');
});
