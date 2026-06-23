// 把玩场景元数据的一致性单测。
const test = require('node:test');
const assert = require('node:assert');
const { PLAY_SCENARIOS, playLabelKey, playDescKey } = require('../src/config/play-scenarios');

test('每个把玩场景 scenario 在 mock SCENARIOS 中存在', () => {
  // 多个 id（printing_0/25/50/75）共用同一个 scenario（printing），
  // 与 mock.js 的 SCENARIOS 键一一对应的是 scenario，而非 id。
  const mockSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/core/mock.js'), 'utf8');
  for (const e of PLAY_SCENARIOS) {
    assert.ok(new RegExp('\\b' + e.scenario + ':').test(mockSrc), `mock.js 缺少场景 ${e.scenario}`);
  }
});

test('只有 printing 档带 progress 字段', () => {
  const withProgress = PLAY_SCENARIOS.filter((e) => e.progress !== undefined);
  assert.ok(withProgress.length > 0, '应至少有一个带 progress 的场景');
  // 带 progress 的都是 printing
  for (const e of withProgress) assert.equal(e.scenario, 'printing', `${e.id} 不应带 progress`);
  // 所有 printing 档都带 progress
  for (const e of PLAY_SCENARIOS.filter((e) => e.scenario === 'printing')) {
    assert.ok(e.progress !== undefined, `${e.id} 缺 progress`);
  }
});

test('每个场景都有 icon，且 id 唯一', () => {
  const ids = new Set();
  for (const e of PLAY_SCENARIOS) {
    assert.ok(e.icon && e.icon.length > 0, `${e.id} 缺 icon`);
    assert.ok(!ids.has(e.id), `重复 id ${e.id}`);
    ids.add(e.id);
  }
  assert.equal(PLAY_SCENARIOS.length, 11);
});

test('labelKey / descKey 命名规则', () => {
  const idle = PLAY_SCENARIOS.find((e) => e.id === 'idle');
  assert.equal(playLabelKey(idle), 'play.idle.name');
  assert.equal(playDescKey(idle), 'play.idle.desc');
  // printing 档共用 progressLabel / printing.desc
  const printing = PLAY_SCENARIOS.find((e) => e.scenario === 'printing');
  assert.equal(playLabelKey(printing), 'play.printing.progressLabel');
  assert.equal(playDescKey(printing), 'play.printing.desc');
});
