// 短信验证码登录的入参校验与导出契约（不触网）。
const test = require('node:test');
const assert = require('node:assert');
const auth = require('../src/core/bambu-auth');

test('requestSmsCode / loginWithCode 已导出', () => {
  assert.strictEqual(typeof auth.requestSmsCode, 'function');
  assert.strictEqual(typeof auth.loginWithCode, 'function');
});

test('requestSmsCode 缺手机号即返回错误，不触网', async () => {
  const r = await auth.requestSmsCode('china', '');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
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
