// 把玩场景元数据的一致性单测。
const test = require('node:test');
const assert = require('node:assert');
const { PLAY_SCENARIOS, playLabelKey, playDescKey } = require('../src/config/play-scenarios');

test('每个把玩场景 key 在 mock SCENARIOS 中存在', () => {
  const mockSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/core/mock.js'), 'utf8');
  for (const s of PLAY_SCENARIOS) {
    assert.ok(new RegExp('\\b' + s.key + ':').test(mockSrc), `mock.js 缺少场景 ${s.key}`);
  }
});

test('恰有一个场景带进度滑杆（printing）', () => {
  const withProgress = PLAY_SCENARIOS.filter((s) => s.hasProgress);
  assert.equal(withProgress.length, 1);
  assert.equal(withProgress[0].key, 'printing');
});

test('每个场景都有 icon，且 key 唯一', () => {
  const keys = new Set();
  for (const s of PLAY_SCENARIOS) {
    assert.ok(s.icon && s.icon.length > 0, `${s.key} 缺 icon`);
    assert.ok(!keys.has(s.key), `重复 key ${s.key}`);
    keys.add(s.key);
  }
  assert.equal(PLAY_SCENARIOS.length, 11);
});

test('labelKey / descKey 命名规则', () => {
  assert.equal(playLabelKey('idle'), 'play.idle.name');
  assert.equal(playDescKey('idle'), 'play.idle.desc');
});
