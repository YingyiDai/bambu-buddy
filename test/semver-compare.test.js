// 纯函数单测：compareSemver —— 版本号比较，决定「有没有新版本 / 要不要下载」。
// 重点是预发布版本（测试包，如 0.4.5-beta.1）：算错会让装了测试包的用户被
// 「更新」回更旧的正式版（见 src/core/updater.js 的 parseSemver 注释）。
// 用内置 node:test 运行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { compareSemver } = require('../src/core/updater');

test('普通版本比较', () => {
  assert.equal(compareSemver('0.4.4', '0.4.4'), 0);
  assert.equal(compareSemver('0.4.3', '0.4.4'), -1);
  assert.equal(compareSemver('0.4.5', '0.4.4'), 1);
  assert.equal(compareSemver('0.5.0', '0.4.9'), 1);
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
});

test('v 前缀与段数不齐都能比', () => {
  assert.equal(compareSemver('v0.4.4', '0.4.4'), 0);
  assert.equal(compareSemver('0.4', '0.4.0'), 0);
  assert.equal(compareSemver('0.4.4.1', '0.4.4'), 1);
});

test('预发布版本比同号正式版更旧', () => {
  assert.equal(compareSemver('0.4.5-beta.1', '0.4.5'), -1);
  assert.equal(compareSemver('0.4.5', '0.4.5-beta.1'), 1);
});

test('预发布版本比上一个正式版更新（测试包不会被更新回旧正式版）', () => {
  // 这条是回归点：旧实现把 '5-beta' 解析成 NaN→0，于是 0.4.5-beta.1 被当成 0.4.0.1，
  // 装了测试包的用户会被判为「有新版本 0.4.4」并静默下载安装，等于回退。
  assert.equal(compareSemver('0.4.5-beta.1', '0.4.4'), 1);
  assert.equal(compareSemver('0.4.4', '0.4.5-beta.1'), -1);
});

test('预发布标识之间的顺序', () => {
  assert.equal(compareSemver('0.4.5-beta.1', '0.4.5-beta.2'), -1);
  assert.equal(compareSemver('0.4.5-beta.10', '0.4.5-beta.9'), 1);   // 按数值而非字典序
  assert.equal(compareSemver('0.4.5-alpha.1', '0.4.5-beta.1'), -1);
  assert.equal(compareSemver('0.4.5-beta', '0.4.5-beta.1'), -1);     // 段少的更小
  assert.equal(compareSemver('0.4.5-beta.1', '0.4.5-beta.1'), 0);
});
