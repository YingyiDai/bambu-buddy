// 状态文案拼接：桌面标签与设置窗预览共用的那份纯函数。
// 这里锁的是「拼出来的字面」——预览和真标签逐字一致是它存在的全部理由，
// 一旦有人在某一侧偷偷改了格式，这些用例就该红。
const test = require('node:test');
const assert = require('node:assert');
const { buildStatusText } = require('../src/core/label-text');
const { STRINGS } = require('../src/config/locales');

// 基准时刻固定成今晚 23:00，让「完成时刻」可复现（同样的剩余分钟每次都得到同样的钟点）。
function baseNow() {
  const d = new Date();
  d.setHours(23, 0, 0, 0);
  return d.getTime();
}

function ctx(over) {
  return {
    strings: STRINGS,
    locale: 'zh-CN',
    showLayer: false,
    showTime: false,
    showFinishTime: false,
    hour12: false,
    now: baseNow(),
    ...over,
  };
}

const printing = { labelKey: 'label.printing', labelParams: { p: 42, layer: 126, total: 300, remain: '45m', remainMins: 45 } };

test('三个开关全关：只有状态主体', () => {
  assert.strictEqual(buildStatusText(printing, ctx()), '打印中 42%');
});

test('层数 / 剩余 / 完成：按固定顺序用「 · 」平级追加', () => {
  const s = buildStatusText(printing, ctx({ showLayer: true, showTime: true, showFinishTime: true }));
  assert.strictEqual(s, '打印中 42% · 126/300 · 剩余45m · 完成 23:45');
});

test('只开其中一个，其余段不出现', () => {
  assert.strictEqual(buildStatusText(printing, ctx({ showLayer: true })), '打印中 42% · 126/300');
  assert.strictEqual(buildStatusText(printing, ctx({ showTime: true })), '打印中 42% · 剩余45m');
  assert.strictEqual(buildStatusText(printing, ctx({ showFinishTime: true })), '打印中 42% · 完成 23:45');
});

test('完成时刻跨自然日补 +N 后缀（今晚 23:00 起打 9 小时 = 明早）', () => {
  const line = { labelKey: 'label.printing', labelParams: { p: 42, remainMins: 9 * 60 } };
  assert.strictEqual(buildStatusText(line, ctx({ showFinishTime: true })), '打印中 42% · 完成 08:00+1');
});

test('完成时刻天数不封顶：打一星期如实显示 +7', () => {
  const line = { labelKey: 'label.printing', labelParams: { p: 42, remainMins: 7 * 24 * 60 } };
  assert.strictEqual(buildStatusText(line, ctx({ showFinishTime: true })), '打印中 42% · 完成 23:00+7');
});

test('英文走同一套结构，只是文案不同', () => {
  const s = buildStatusText(printing, ctx({ locale: 'en', showLayer: true, showTime: true, showFinishTime: true }));
  assert.strictEqual(s, 'Printing 42% · 126/300 · 45m left · Done 23:45');
});

test('完成态：走相对时间，且不再追加任何指标段', () => {
  const now = baseNow();
  const mk = (agoMs) => ({ labelKey: 'label.finished', labelParams: { finishedAt: now - agoMs, layer: 300, total: 300, remain: '1m', remainMins: 1 } });
  const all = { showLayer: true, showTime: true, showFinishTime: true, now };
  assert.strictEqual(buildStatusText(mk(5 * 1000), ctx(all)), '刚刚完成');
  assert.strictEqual(buildStatusText(mk(12 * 60 * 1000), ctx(all)), '12 分钟前完成');
  assert.strictEqual(buildStatusText(mk(3 * 60 * 60 * 1000), ctx(all)), '3 小时前完成');
});

test('缺数据的段自动省略（没有层数就不拼层数）', () => {
  const line = { labelKey: 'label.printing', labelParams: { p: 42 } };
  assert.strictEqual(buildStatusText(line, ctx({ showLayer: true, showTime: true, showFinishTime: true })), '打印中 42%');
});

test('剩余分钟为 0 / 负数时不产出完成时刻（打印机偶发脏值）', () => {
  for (const remainMins of [0, -5, NaN, null]) {
    const line = { labelKey: 'label.printing', labelParams: { p: 42, remainMins } };
    assert.strictEqual(buildStatusText(line, ctx({ showFinishTime: true })), '打印中 42%', `remainMins=${remainMins}`);
  }
});

test('未知 labelKey 原样返回（不炸，也不吞掉线索）', () => {
  const line = { labelKey: 'label.doesNotExist', labelParams: {} };
  assert.strictEqual(buildStatusText(line, ctx()), 'label.doesNotExist');
});

test('locale 缺失时回落 zh-CN，不会渲染出 key', () => {
  const line = { labelKey: 'label.idle', labelParams: {} };
  assert.strictEqual(buildStatusText(line, ctx({ locale: 'de' })), '空闲');
});
