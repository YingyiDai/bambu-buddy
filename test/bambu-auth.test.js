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
