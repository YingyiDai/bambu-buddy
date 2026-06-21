// Mock 数据源（§7.1）：无需打印机即可演示全部状态。
// 实现统一的 DataSource 接口：start() / stop() / onState(cb)。
// 额外提供 mock 专属能力：setScenario(key) 手动切状态、startAutoCycle() 自动轮播。

const { STAGE } = require('../config/state-map');

// 预设场景：key → 生成原始报文的函数（可带动态进度）。
// 这些报文字段与真机 print 对象对齐，交给同一个 resolveState() 解析。
const SCENARIOS = {
  offline: () => ({ connected: false }),
  idle: () => ({ connected: true, gcode_state: 'IDLE' }),
  prepare_preheat: () => ({ connected: true, gcode_state: 'PREPARE', stg_cur: STAGE.HEATBED_PREHEATING }),
  prepare_leveling: () => ({ connected: true, gcode_state: 'PREPARE', stg_cur: STAGE.AUTO_BED_LEVELING }),
  printing: (percent = 0, layer = 1, total = 200) => ({
    connected: true, gcode_state: 'RUNNING', stg_cur: 0,
    mc_percent: percent, layer_num: layer, total_layer_num: total,
  }),
  changing_filament: () => ({ connected: true, gcode_state: 'RUNNING', stg_cur: STAGE.CHANGING_FILAMENT }),
  paused: () => ({ connected: true, gcode_state: 'PAUSE', stg_cur: STAGE.USER_PAUSE }),
  paused_runout: () => ({ connected: true, gcode_state: 'PAUSE', stg_cur: STAGE.FILAMENT_RUNOUT }),
  door_open: () => ({ connected: true, gcode_state: 'PAUSE', door_open: true }),
  finished: () => ({ connected: true, gcode_state: 'FINISH' }),
  failed: () => ({ connected: true, gcode_state: 'FAILED', hms: [{ code: 'HMS_0300', severity: 'fatal' }] }),
};

// 托盘菜单展示用：场景 key → 中文标签
const SCENARIO_LABELS = {
  offline: '未连接',
  idle: '空闲',
  prepare_preheat: '准备中 · 预热热床',
  prepare_leveling: '准备中 · 自动调平',
  printing: '打印中（进度推进）',
  changing_filament: '换料中',
  paused: '已暂停',
  paused_runout: '缺料暂停',
  door_open: '舱门打开',
  finished: '打印完成',
  failed: '打印失败',
};

class MockDataSource {
  constructor() {
    this._cb = null;
    this._autoTimer = null;
    this._printingTimer = null;
    this._current = 'idle';
  }

  onState(cb) {
    this._cb = cb;
  }

  start() {
    // 默认进入空闲
    this.setScenario('idle');
  }

  stop() {
    this._clearTimers();
    this._cb = null;
  }

  _emit(report) {
    if (this._cb) this._cb(report);
  }

  _clearTimers() {
    if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
    if (this._printingTimer) { clearInterval(this._printingTimer); this._printingTimer = null; }
  }

  /**
   * 手动切到某个场景（托盘菜单用）。
   * printing 场景会启动一个内部计时器推进进度 0→100。
   */
  setScenario(key) {
    this._clearTimers();
    this._current = key;
    const make = SCENARIOS[key];
    if (!make) return;

    if (key === 'printing') {
      let percent = 0;
      const total = 200;
      this._emit(SCENARIOS.printing(percent, 1, total));
      this._printingTimer = setInterval(() => {
        percent += 5;
        if (percent > 100) {
          // 打印完成
          clearInterval(this._printingTimer);
          this._printingTimer = null;
          this._emit(SCENARIOS.finished());
          return;
        }
        // 进度到 40% 时穿插一次换料演示
        if (percent === 40) {
          this._emit(SCENARIOS.changing_filament());
          return;
        }
        const layer = Math.max(1, Math.round((percent / 100) * total));
        this._emit(SCENARIOS.printing(percent, layer, total));
      }, 1500);
      return;
    }

    this._emit(make());
  }

  /**
   * 静态设定打印进度（把玩页滑杆用）：清除自动推进计时器，
   * 按给定百分比发一帧打印报文。percent 夹取到 0–100。
   */
  setPrintingProgress(percent) {
    this._clearTimers();
    this._current = 'printing';
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const total = 200;
    const layer = Math.max(1, Math.round((p / 100) * total));
    this._emit(SCENARIOS.printing(p, layer, total));
  }

  /** 当前场景 key（供主进程读取，避免访问私有字段）。 */
  getCurrent() {
    return this._current;
  }

  /**
   * 自动轮播一遍所有状态，便于录屏 demo。
   */
  startAutoCycle() {
    this._clearTimers();
    const order = [
      'offline', 'idle', 'prepare_preheat', 'prepare_leveling',
      'printing', // printing 自带进度推进 + 换料 + 完成
    ];
    let i = 0;
    const next = () => {
      const key = order[i % order.length];
      this.setScenario(key);
      i += 1;
      // printing 场景耗时较长，给它更久的停留
      const dwell = key === 'printing' ? 40000 : 5000;
      this._autoTimer = setTimeout(next, dwell);
    };
    next();
  }

  stopAutoCycle() {
    this._clearTimers();
    this.setScenario(this._current === 'printing' ? 'idle' : this._current);
  }
}

module.exports = { MockDataSource, SCENARIO_LABELS };
