// 多打印机聚合单测：熊猫演哪台（pickAttentionItem）+ 标签行生成（buildLabelLines）。
const test = require('node:test');
const assert = require('node:assert');
const { ATTENTION_RANK, pickAttentionItem, sortByAttention, buildLabelLines } = require('../src/core/attention');

// 造 item 的小工厂：state 只需 stateKey/labelKey/labelParams。
function item(serial, stateKey, extra = {}) {
  return {
    serial,
    name: extra.name !== undefined ? extra.name : `名字${serial}`,
    state: { stateKey, labelKey: `label.${stateKey}`, labelParams: extra.labelParams || {} },
    report: extra.report || null,
  };
}

test('优先级全序：failed > paused > changing_filament > printing > finished > prepare > idle > authExpired > offline', () => {
  const order = ['failed', 'paused', 'changing_filament', 'printing_50', 'finished', 'prepare', 'idle', 'authExpired', 'offline'];
  // 从后往前逐个加入，每次加入更高优先级的台后它都应胜出
  let items = [];
  for (let i = order.length - 1; i >= 0; i--) {
    items = [item(`S${i}`, order[i]), ...items];
    assert.strictEqual(pickAttentionItem(items).state.stateKey, order[i], `${order[i]} 应压过 ${order[i + 1] || '（无）'}`);
  }
});

test('printing 四档同 rank：档位不同不影响平手判定', () => {
  assert.strictEqual(ATTENTION_RANK.printing_0, ATTENTION_RANK.printing_75);
});

test('多台打印中平手：进度更高者胜（不论列表序）', () => {
  const a = item('A', 'printing_25', { report: { mc_percent: 30 } });
  const b = item('B', 'printing_75', { report: { mc_percent: 90 } });
  assert.strictEqual(pickAttentionItem([a, b]).serial, 'B');
  assert.strictEqual(pickAttentionItem([b, a]).serial, 'B');
});

test('非打印平手：列表序在前者稳定胜出', () => {
  const a = item('A', 'paused');
  const b = item('B', 'paused');
  assert.strictEqual(pickAttentionItem([a, b]).serial, 'A');
  assert.strictEqual(pickAttentionItem([b, a]).serial, 'B');
});

test('空列表 / 全无 state → null', () => {
  assert.strictEqual(pickAttentionItem([]), null);
  assert.strictEqual(pickAttentionItem([{ serial: 'X', state: null }]), null);
});

test('未知 stateKey 按空闲对待：压过 offline，但输给 paused', () => {
  const weird = item('W', 'someFutureState');
  assert.strictEqual(pickAttentionItem([item('O', 'offline'), weird]).serial, 'W');
  assert.strictEqual(pickAttentionItem([weird, item('P', 'paused')]).serial, 'P');
});

// ── sortByAttention（托盘折叠优先级）──

test('按关注度升序排（越需要关注越靠前）', () => {
  const idle = item('I', 'idle');
  const fail = item('F', 'failed');
  const print = item('P', 'printing_50');
  const sorted = sortByAttention([idle, print, fail]);
  assert.deepStrictEqual(sorted.map((it) => it.serial), ['F', 'P', 'I']);
});

test('打印中平手：进度高者靠前；其余平手保持列表序（稳定）', () => {
  const a = item('A', 'printing_25', { report: { mc_percent: 30 } });
  const b = item('B', 'printing_75', { report: { mc_percent: 90 } });
  assert.deepStrictEqual(sortByAttention([a, b]).map((it) => it.serial), ['B', 'A']);
  // 两台空闲平手：不重排，列表序保持
  const x = item('X', 'idle');
  const y = item('Y', 'idle');
  assert.deepStrictEqual(sortByAttention([x, y]).map((it) => it.serial), ['X', 'Y']);
});

test('缺 state 的台按空闲档处理，不丢台', () => {
  const starting = { serial: 'S', name: '启动中', state: null, report: null };
  const print = item('P', 'printing_50');
  const sorted = sortByAttention([starting, print]);
  assert.strictEqual(sorted.length, 2);
  assert.strictEqual(sorted[0].serial, 'P');       // 打印中在前
  assert.strictEqual(sorted[1].serial, 'S');       // 无 state 垫后（按 idle）
});

test('不改原数组', () => {
  const arr = [item('I', 'idle'), item('F', 'failed')];
  const copy = arr.slice();
  sortByAttention(arr);
  assert.deepStrictEqual(arr, copy);
});

// ── buildLabelLines ──

test('单台：一行、不带名字前缀（与单打印机时代观感一致）', () => {
  const lines = buildLabelLines([item('A', 'printing_50', { labelParams: { p: 62 } })]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].name, null);
  assert.strictEqual(lines[0].labelKey, 'label.printing_50');
  assert.deepStrictEqual(lines[0].labelParams, { p: 62 });
});

test('多台：每台一行、带名字；name 缺失回退 serial', () => {
  const lines = buildLabelLines([
    item('A', 'printing_50'),
    item('B', 'idle', { name: null }),
  ]);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].name, '名字A');
  assert.strictEqual(lines[1].name, 'B');
});

test('多台时离线/登录失效台不占行（托盘仍全列，标签不堆墓碑）', () => {
  const lines = buildLabelLines([
    item('A', 'offline'),
    item('B', 'printing_25'),
    item('C', 'authExpired'),
  ]);
  assert.deepStrictEqual(lines.map((l) => l.serial), ['B']);
  assert.strictEqual(lines[0].name, '名字B', '有台离线被隐藏时，剩余行仍带名字（多台语境）');
});

test('全部离线/失效：折叠为一条不带名字的行', () => {
  const lines = buildLabelLines([item('A', 'offline'), item('B', 'offline')]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].name, null);
  assert.strictEqual(lines[0].labelKey, 'label.offline');
});

test('全部失效时 authExpired 行胜过 offline（rank 更高）', () => {
  const lines = buildLabelLines([item('A', 'offline'), item('B', 'authExpired')]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].labelKey, 'label.authExpired');
});

test('行序 = 传入的统一列表序', () => {
  const lines = buildLabelLines([
    item('C', 'idle'),
    item('A', 'printing_0'),
    item('B', 'paused'),
  ]);
  assert.deepStrictEqual(lines.map((l) => l.serial), ['C', 'A', 'B']);
});

test('空列表 → 空行数组', () => {
  assert.deepStrictEqual(buildLabelLines([]), []);
});
