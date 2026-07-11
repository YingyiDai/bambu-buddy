// 短信验证码登录的入参校验与导出契约（不触网）。
const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const auth = require('../src/core/bambu-auth');

// 打桩 https.request：回放固定 statusCode/body（不触网）。返回恢复函数。
// bambu-auth 每次调用都取 https.request 属性，替换共享模块对象上的属性即可生效。
// statusCode 传 null 表示「永不响应」，用于测超时。
function stubHttps(statusCode, bodyText) {
  const orig = https.request;
  https.request = (_options, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      if (statusCode == null) return; // 悬死，等调用方超时
      const res = new EventEmitter();
      res.statusCode = statusCode;
      cb(res);
      process.nextTick(() => { res.emit('data', bodyText); res.emit('end'); });
    };
    return req;
  };
  return () => { https.request = orig; };
}

test('requestSmsCode / loginWithCode 已导出', () => {
  assert.strictEqual(typeof auth.requestSmsCode, 'function');
  assert.strictEqual(typeof auth.loginWithCode, 'function');
});

test('requestSmsCode 缺手机号即返回错误，不触网', async () => {
  const r = await auth.requestSmsCode('china', '');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

// 发码端点必须在 api.bambulab.cn，绝不能用官网域名 bambulab.cn/api/...：
// 官网域名 2026-07 起被 Cloudflare 交互式挑战（Just a moment...）前置，非浏览器
// 客户端一律 403；API 域名上同一服务无挑战、可直达（无效号返回业务 400 已实测）。
// pybambu 的 SMS_CODE 常量仍指官网域名——此处故意与它不一致，别按 pybambu 改回去。
test('短信发码端点走 api 域名而非官网域名', () => {
  assert.strictEqual(auth.SMS_CODE_HOST, 'api.bambulab.cn');
  assert.strictEqual(auth.SMS_CODE_PATH, '/v1/user-service/user/sendsmscode');
});

// —— 以下三条守住「发码失败时用户不能卡死/看天书」的底线 ——

// 曾有隐患：4xx 响应体是 HTML（Cloudflare 挑战页正是如此）时 JSON.parse 先抛
// SyntaxError，把状态码整个吞掉，403 分支的友好提示全部失效，用户看到
// 「Unexpected token '<'...」。此测保证 HTML 4xx 仍以带 status 的 HTTP 错误 reject。
test('httpsJson: 4xx + HTML 响应体不吞状态码', async () => {
  const restore = stubHttps(403, '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>');
  try {
    await assert.rejects(
      auth.httpsJson('api.bambulab.cn', '/v1/x', 'POST', { a: 1 }),
      (e) => e.status === 403 && /^HTTP 403/.test(e.message),
    );
  } finally { restore(); }
});

test('requestSmsCode: 被拦截返回 HTML 403 → 给出安全策略拦截提示，而非解析报错', async () => {
  const restore = stubHttps(403, '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>');
  try {
    const r = await auth.requestSmsCode('china', '13800000000');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /安全策略拦截/);
  } finally { restore(); }
});

// 曾有隐患：请求无超时，连接悬死时 Promise 永不 settle，发码按钮永久禁用、
// 登录 busy 永不释放，用户只能重启应用。此测保证悬死请求会以 ETIMEDOUT reject。
test('httpsJson: 请求悬死会超时 reject，不会永久挂起', async () => {
  const restore = stubHttps(null, '');
  try {
    await assert.rejects(
      auth.httpsJson('api.bambulab.cn', '/v1/x', 'POST', { a: 1 }, {}, { timeoutMs: 50 }),
      /ETIMEDOUT/,
    );
  } finally { restore(); }
});

test('httpsJson: 2xx 但响应体非 JSON → 明确报「服务器响应异常」', async () => {
  const restore = stubHttps(200, '<html>not json</html>');
  try {
    await assert.rejects(
      auth.httpsJson('api.bambulab.cn', '/v1/x', 'GET', null),
      /服务器响应异常/,
    );
  } finally { restore(); }
});

test('loginWithCode 缺手机号或验证码即返回错误，不触网', async () => {
  assert.strictEqual((await auth.loginWithCode('china', '', '1234')).ok, false);
  assert.strictEqual((await auth.loginWithCode('china', '138', '')).ok, false);
});

// 验证码登录错误映射：仅 code 1/2 才是验证码问题，其余透出真实原因（曾把一切盖成「验证码错误」）。
test('codeLoginError: code=2 → 验证码错误', () => {
  assert.strictEqual(auth.codeLoginError({ code: 2 }, '兜底'), '验证码错误，请重新输入');
});

test('codeLoginError: code=1 → 验证码已过期', () => {
  assert.strictEqual(auth.codeLoginError({ code: 1 }, '兜底'), '验证码已过期，请重新获取');
});

test('codeLoginError: 非验证码错误 → 透出服务器真实文案，不误报验证码', () => {
  assert.strictEqual(auth.codeLoginError({ code: 99, message: '账号未注册' }, '兜底'), '账号未注册');
  assert.strictEqual(auth.codeLoginError({ error: 'region mismatch' }, '兜底'), 'region mismatch');
});

test('codeLoginError: 无结构化信息 → 回退到兜底文案', () => {
  assert.strictEqual(auth.codeLoginError(null, '网络连接失败，请检查网络'), '网络连接失败，请检查网络');
  assert.strictEqual(auth.codeLoginError({}, '登录失败，请重试'), '登录失败，请重试');
});

test('redactAuth: 抹掉 token 类字段，保留其它', () => {
  const r = auth.redactAuth({ accessToken: 'secret', refreshToken: 'x', code: 2, uid: 42 });
  assert.strictEqual(r.accessToken, '<redacted>');
  assert.strictEqual(r.refreshToken, '<redacted>');
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.uid, 42);
});
