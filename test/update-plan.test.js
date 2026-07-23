// 纯函数单测：planUpdateDownload —— 拿到「最新版本号」后决定下一步动作。
// 用内置 node:test 运行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { planUpdateDownload } = require('../src/core/updater');

test('无最新版本号 → noUpdate', () => {
  assert.equal(planUpdateDownload({ appVersion: '0.4.0', latestVersion: null, phase: 'idle', downloadedVersion: null }), 'noUpdate');
});

test('最新版本 <= 当前版本 → noUpdate', () => {
  assert.equal(planUpdateDownload({ appVersion: '0.4.2', latestVersion: '0.4.2', phase: 'idle', downloadedVersion: null }), 'noUpdate');
  assert.equal(planUpdateDownload({ appVersion: '0.4.3', latestVersion: '0.4.2', phase: 'idle', downloadedVersion: null }), 'noUpdate');
});

test('未下载且有更新 → download', () => {
  assert.equal(planUpdateDownload({ appVersion: '0.4.0', latestVersion: '0.4.1', phase: 'idle', downloadedVersion: null }), 'download');
});

test('已下载的就是最新版 → upToDate（短路，不重复下载）', () => {
  assert.equal(planUpdateDownload({ appVersion: '0.4.0', latestVersion: '0.4.1', phase: 'downloaded', downloadedVersion: '0.4.1' }), 'upToDate');
});

test('已下载 0.4.1 但又发布了 0.4.2 → download（重新下载最新版）', () => {
  assert.equal(planUpdateDownload({ appVersion: '0.4.0', latestVersion: '0.4.2', phase: 'downloaded', downloadedVersion: '0.4.1' }), 'download');
});
