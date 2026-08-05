// 「差几个自然日」单测：打印中那行的完成时刻只有「时:分」，跨天靠 +1 / +2 标出来。
// 重点覆盖「小时数少但已跨天」和「小时数多但没跨天」这两类整除算法会算错的情形。
// 用内置 node:test 运行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { dayOffset } = require('../src/renderer/day-offset');

// 本地时间构造器（测试全程用本机时区，与渲染层口径一致）。
function local(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

test('同一天内任意时刻差为 0', () => {
  assert.strictEqual(dayOffset(local(2026, 8, 5, 0, 0), local(2026, 8, 5, 23, 59)), 0);
  assert.strictEqual(dayOffset(local(2026, 8, 5, 9, 30), local(2026, 8, 5, 9, 30)), 0);
});

test('只差几小时但已跨天 → +1（整除 24 小时会误判为 0）', () => {
  // 今晚 23:00 起打 9 小时 → 明早 08:00，不足一天却是「明天」。
  assert.strictEqual(dayOffset(local(2026, 8, 5, 23, 0), local(2026, 8, 6, 8, 0)), 1);
  // 极端：23:59 → 次日 00:01，只差 2 分钟。
  assert.strictEqual(dayOffset(local(2026, 8, 5, 23, 59), local(2026, 8, 6, 0, 1)), 1);
});

test('差近一天但没跨天 → 0（整除 24 小时会误判为 1）', () => {
  // 00:10 起打 23 小时 40 分 → 当天 23:50，仍是今天。
  assert.strictEqual(dayOffset(local(2026, 8, 5, 0, 10), local(2026, 8, 5, 23, 50)), 0);
});

test('长任务：按自然日累加，不封顶', () => {
  assert.strictEqual(dayOffset(local(2026, 8, 5, 10, 0), local(2026, 8, 7, 9, 0)), 2);
  // 打一星期。
  assert.strictEqual(dayOffset(local(2026, 8, 5, 10, 0), local(2026, 8, 12, 10, 0)), 7);
  // 跨月。
  assert.strictEqual(dayOffset(local(2026, 8, 30, 20, 0), local(2026, 9, 2, 6, 0)), 3);
  // 跨年。
  assert.strictEqual(dayOffset(local(2026, 12, 31, 22, 0), local(2027, 1, 2, 1, 0)), 2);
});

test('跨夏令时切换日仍是准确天数（23/25 小时的那天）', () => {
  // 用美国东部时区跑：3/8 春季前跳（23 小时）、11/1 秋季回拨（25 小时）。
  const orig = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // 23 小时的那天：前一天 12:00 → 当天 12:00 实际只隔 23 小时，仍应是 1 天。
    assert.strictEqual(dayOffset(local(2026, 3, 7, 12, 0), local(2026, 3, 8, 12, 0)), 1);
    // 25 小时的那天：同理仍是 1 天。
    assert.strictEqual(dayOffset(local(2026, 10, 31, 12, 0), local(2026, 11, 1, 12, 0)), 1);
    // 跨过切换日的多天任务不因少/多一小时而错位。
    assert.strictEqual(dayOffset(local(2026, 3, 6, 23, 0), local(2026, 3, 9, 1, 0)), 3);
  } finally {
    if (orig === undefined) delete process.env.TZ; else process.env.TZ = orig;
  }
});

test('时刻早于起点（报文回退/时钟纠偏）→ 负数，调用方据此不显示后缀', () => {
  assert.strictEqual(dayOffset(local(2026, 8, 5, 10, 0), local(2026, 8, 4, 10, 0)), -1);
});

test('非法入参不抛异常，按「不跨天」处理', () => {
  assert.strictEqual(dayOffset(NaN, local(2026, 8, 5)), 0);
  assert.strictEqual(dayOffset(local(2026, 8, 5), undefined), 0);
  assert.strictEqual(dayOffset(null, null), 0);
});
