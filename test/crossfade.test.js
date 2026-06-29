// 渲染层视频控制器单测：交叉淡入的并发安全 + 防抖不可被"饿死"。
// 复现 bug：探索→真机切换后，标签实时刷新为"打印中"，但熊猫视频卡在 offline。
// 根因：标签同步刷新，视频走「每帧 clearTimeout+重置」的一次性防抖 + 非并发安全的 crossfade。
// 用内置 node:test 运行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { createVideoController } = require('../src/renderer/crossfade');

// 最小化的 <video> 假实现：记录 src/load/active，并能手动 fire 'canplay'/'error'。
class FakeVideo {
  constructor(name) {
    this.name = name;
    this._src = '';
    this.loads = 0;
    this._listeners = {};
    const set = new Set();
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    };
  }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  load() { this.loads += 1; }
  play() { return Promise.resolve(); }
  removeAttribute(a) { if (a === 'src') this._src = ''; }
  fire(type) { (this._listeners[type] || []).slice().forEach((f) => f()); }
  listenerCount(type) { return (this._listeners[type] || []).length; }
}

// 可手动推进的假定时器调度器（注入到控制器，替代 setTimeout/clearTimeout）。
function makeScheduler() {
  let now = 0;
  let seq = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, delay) => { const id = seq++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance: (ms) => {
      now += ms;
      // 触发所有到点的定时器（按时间顺序）
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
  };
}

function setup(opts = {}) {
  const layers = [new FakeVideo('A'), new FakeVideo('B')];
  const sch = makeScheduler();
  const ctrl = createVideoController(layers, {
    base: '/anim/',
    holdMs: 250,
    setTimeout: sch.setTimeout,
    clearTimeout: sch.clearTimeout,
    ...opts,
  });
  return { layers, sch, ctrl };
}

// 当前可见层（带 active class 的那个）显示的文件名
function visibleFile(layers, base = '/anim/') {
  const active = layers.find((l) => l.classList.contains('active'));
  return active ? active.src.replace(base, '') : null;
}

test('防抖不可被饿死：突发高频 request 后，视频仍切到最后一帧（复现 bug）', () => {
  const { layers, sch, ctrl } = setup();
  // 模拟切到真机：先 offline，紧接着 pushall 突发多帧 printing（间隔都 < holdMs）。
  ctrl.request('offline.webm');
  sch.advance(50); ctrl.request('printing_0.webm');
  sch.advance(50); ctrl.request('printing_25.webm');
  sch.advance(50); ctrl.request('printing_25.webm');
  sch.advance(50); ctrl.request('printing_25.webm');
  // 突发结束后时间继续走；让任一被挂起的 crossfade 拿到 canplay。
  sch.advance(500);
  layers.forEach((l) => l.fire('canplay'));
  sch.advance(500);
  layers.forEach((l) => l.fire('canplay'));
  // 期望：最终切到 printing_25，而不是卡在 offline。
  assert.equal(visibleFile(layers), 'printing_25.webm');
});

test('并发 crossfade：to() 重入后只翻转一次 activeIndex，可见层=最新文件', () => {
  const { layers, sch, ctrl } = setup();
  ctrl.request('offline.webm');
  sch.advance(250); // 第一次 crossfade 启动（incoming 正在 load，未 canplay）
  // 在 canplay 之前，新一帧到来并再次启动 crossfade
  ctrl.request('printing_25.webm');
  sch.advance(250);
  // 现在让 incoming 触发 canplay
  layers.forEach((l) => l.fire('canplay'));
  assert.equal(visibleFile(layers), 'printing_25.webm');
  // 关键：每层最多只剩一个挂起的 canplay 监听（无监听泄漏/双翻转）
  layers.forEach((l) => assert.ok(l.listenerCount('canplay') <= 1, `${l.name} 监听泄漏`));
});

test('错误恢复：incoming 触发 error 不应卡死，后续同名帧可重试', () => {
  const { layers, sch, ctrl } = setup();
  ctrl.request('printing_25.webm');
  sch.advance(250);
  // 该视频加载失败
  layers.forEach((l) => l.fire('error'));
  // 不应保持任何"已切换到 printing_25"的假象
  assert.notEqual(visibleFile(layers), 'printing_25.webm');
  // 再来一帧同名（真机持续推流），应能重试并成功
  ctrl.request('printing_25.webm');
  sch.advance(250);
  layers.forEach((l) => l.fire('canplay'));
  assert.equal(visibleFile(layers), 'printing_25.webm');
});

test('正常顺序切换：两帧不同文件依次完成，可见层依次跟随', () => {
  const { layers, sch, ctrl } = setup();
  ctrl.request('idle.webm');
  sch.advance(250);
  layers.forEach((l) => l.fire('canplay'));
  assert.equal(visibleFile(layers), 'idle.webm');

  ctrl.request('printing_50.webm');
  sch.advance(250);
  layers.forEach((l) => l.fire('canplay'));
  assert.equal(visibleFile(layers), 'printing_50.webm');
});

test('同一文件重复 request 不重复加载（去重）', () => {
  const { layers, sch, ctrl } = setup();
  ctrl.request('printing_25.webm');
  sch.advance(250);
  layers.forEach((l) => l.fire('canplay'));
  const loadsAfterFirst = layers.reduce((n, l) => n + l.loads, 0);

  ctrl.request('printing_25.webm');
  sch.advance(250);
  layers.forEach((l) => l.fire('canplay'));
  const loadsAfterSecond = layers.reduce((n, l) => n + l.loads, 0);

  assert.equal(loadsAfterSecond, loadsAfterFirst, '同名文件不应再次 load');
});

test('陈旧 cleanup 不得清空已被复用为入场层的层（F1 回归）', () => {
  // 复现：切换 A 完成后会安排 fadeMs 延迟清理「旧 outgoing」层的 src；
  // 但两层乒乓复用，下一次切换 B 很可能就把这个「旧 outgoing」拿去当入场层。
  // 若 B 的 canplay 还没来、陈旧 cleanup 先触发，就会把 B 正在加载的 src 抹掉
  // → 视频卡住、与标签不同步（正是本次提交想根治的那类 bug 换个触发器又回来）。
  const { layers, sch, ctrl } = setup({ fadeMs: 400 });

  // 1) 切到 printing_25 并完成（只 fire 入场层，模拟真实只有入场层在加载）
  ctrl.request('printing_25.webm');
  sch.advance(250);
  layers[1 - ctrl.getActiveIndex()].fire('canplay'); // 完成；安排 cleanup(旧 outgoing)@+fadeMs
  assert.equal(visibleFile(layers), 'printing_25.webm');

  // 2) 紧接着切到 idle —— 复用「旧 outgoing」作入场层，且其加载较慢（暂不 canplay）
  ctrl.request('idle.webm');
  sch.advance(250); // to(idle)：incoming = 上一次的旧 outgoing
  const incoming = layers[1 - ctrl.getActiveIndex()];

  // 3) 时间推进到第 1 次切换当初安排的 cleanup 触发点
  sch.advance(400);

  // 4) idle 真正加载完成
  incoming.fire('canplay');

  // 入场层不该被陈旧 cleanup 抹掉 → 最终可见 idle，而不是空白/卡在 printing_25
  assert.equal(visibleFile(layers), 'idle.webm');
});
