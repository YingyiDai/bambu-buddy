// 纯函数单测：中国大陆回退 feed —— parseFeedVersion 解析 yml 版本、checkCnFeed 比对版本。
// 用内置 node:test 运行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { parseFeedVersion, checkCnFeed, CN_UPDATE_FEED } = require('../src/core/updater');

test('parseFeedVersion：正常取 version', () => {
  const yml = 'version: 0.4.2\nfiles:\n  - url: app.exe\n    sha512: abc\npath: app.exe\n';
  assert.equal(parseFeedVersion(yml), '0.4.2');
});

test('parseFeedVersion：值带引号也能取', () => {
  assert.equal(parseFeedVersion("version: '0.5.0'\npath: app.zip\n"), '0.5.0');
  assert.equal(parseFeedVersion('version: "1.2.3"\n'), '1.2.3');
});

test('parseFeedVersion：缺字段 / 空输入 → null', () => {
  assert.equal(parseFeedVersion('files:\n  - url: app.exe\n'), null);
  assert.equal(parseFeedVersion(''), null);
  assert.equal(parseFeedVersion(null), null);
});

// checkCnFeed 用假的 getRaw 注入，验证不同响应下的归一化结果（不发真实网络）。
const okYml = (v) => ({ statusCode: 200, headers: {}, body: `version: ${v}\npath: app\n` });

test('checkCnFeed：feed 版本高于当前 → hasUpdate', async () => {
  const getRaw = async () => okYml('0.4.3');
  const r = await checkCnFeed('0.4.2', 'latest.yml', getRaw);
  assert.deepEqual(r, { hasUpdate: true, latestVersion: '0.4.3', error: null });
});

test('checkCnFeed：feed 版本不高于当前 → 无更新', async () => {
  const getRaw = async () => okYml('0.4.2');
  const r = await checkCnFeed('0.4.2', 'latest.yml', getRaw);
  assert.equal(r.hasUpdate, false);
  assert.equal(r.latestVersion, '0.4.2');
  assert.equal(r.error, null);
});

test('checkCnFeed：请求拼出正确的 host/path（默认 feed）', async () => {
  let seen = null;
  const getRaw = async (host, path) => { seen = { host, path }; return okYml('0.4.3'); };
  await checkCnFeed('0.4.2', 'latest-mac.yml', getRaw);
  const u = new URL(CN_UPDATE_FEED);
  assert.equal(seen.host, u.host);
  assert.equal(seen.path, `${u.pathname}latest-mac.yml`);
});

test('checkCnFeed：HTTP 4xx → error、不误报更新', async () => {
  const getRaw = async () => ({ statusCode: 404, headers: {}, body: 'not found' });
  const r = await checkCnFeed('0.4.2', 'latest.yml', getRaw);
  assert.equal(r.hasUpdate, false);
  assert.match(r.error, /404/);
});

test('checkCnFeed：网络异常 → 归一为网络错误 key、不抛', async () => {
  const getRaw = async () => { throw new Error('net::ERR_CONNECTION_TIMED_OUT'); };
  const r = await checkCnFeed('0.4.2', 'latest.yml', getRaw);
  assert.equal(r.hasUpdate, false);
  assert.equal(r.error, 'updater.errNetwork');
});

test('checkCnFeed：yml 里版本非法 → errNoRelease', async () => {
  const getRaw = async () => ({ statusCode: 200, headers: {}, body: 'version: not-a-version\n' });
  const r = await checkCnFeed('0.4.2', 'latest.yml', getRaw);
  assert.equal(r.hasUpdate, false);
  assert.equal(r.error, 'updater.errNoRelease');
});
