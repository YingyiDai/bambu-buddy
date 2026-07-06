// 纯函数单测：resolveState 的解析优先级与 labelKey / labelParams。
// 用内置 node:test 运行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { resolveState, extractTemps } = require('../src/core/state-machine');

test('连接断开 → offline', () => {
  const r = resolveState({ connected: false, gcode_state: 'RUNNING' });
  assert.equal(r.stateKey, 'offline');
  assert.equal(r.videoFile, 'offline.webm');
  assert.equal(r.labelKey, 'label.offline');
  assert.deepStrictEqual(r.labelParams, {});
});

test('FAILED 优先于其它', () => {
  const r = resolveState({ connected: true, gcode_state: 'FAILED' });
  assert.equal(r.stateKey, 'failed');
  assert.equal(r.labelKey, 'label.failed');
});

// 致命 HMS（未知含义的码）→ failed，但只显示通用「打印失败」，不把看不懂的裸码挂给用户
test('致命 HMS（未知码）→ failed，不显示裸码', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', hms: [{ code: 'HMS_0300', severity: 'fatal' }] });
  assert.equal(r.stateKey, 'failed');
  assert.equal(r.labelKey, 'label.failed');
});

test('可恢复 HMS（info）不进 failed', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 10, hms: [{ code: 'X', severity: 'info' }] });
  assert.equal(r.stateKey, 'printing_0');
});

// 回归：真机断料 = 可恢复 PAUSE（gcode_state 权威），即使带非零 print_error 诊断码 / HMS
// 也不得升级为「打印失败」。曾出现卡片「离线」+ 熊猫「打印失败 · 131184」的状态不符 bug。
test('PAUSE 断料带 print_error/hms → 仍是 paused，不是 failed', () => {
  const r = resolveState({
    connected: true, gcode_state: 'PAUSE', stg_cur: 6,
    print_error: 131184, hms: [{ attr: 50348039, code: 131184 }],
  });
  assert.equal(r.stateKey, 'paused');
  assert.equal(r.labelKey, 'label.paused.runout');
});

// print_error 是持续型诊断码（跨增量报文残留），RUNNING 时不得据此判失败
test('RUNNING 带残留 print_error → 仍是打印中', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 10, print_error: 131184 });
  assert.equal(r.stateKey, 'printing_0');
});

// 终止失败：state-machine 统一返回通用 label.failed；「打印失败 · 大类」的大类由主进程用官方码表
// 在此之上注入（见 main.js#applyReport + bambu-error-codes 分类），纯函数层不做也不测大类。
test('FAILED → 通用 label.failed（大类由主进程注入）', () => {
  const r = resolveState({ connected: true, gcode_state: 'FAILED', hms: [{ code: 131184 }] });
  assert.equal(r.stateKey, 'failed');
  assert.equal(r.labelKey, 'label.failed');
});

// 回归：用户主动取消任务时打印机同样报 gcode_state=FAILED（且残留 HMS code），但这是用户行为
// 而非故障，不得显示「打印失败」。曾出现取消后熊猫一直挂「打印失败 · 131184」而 Studio 已空闲。
test('取消（print_canceled）盖过 FAILED/HMS → idle，不显示失败', () => {
  const r = resolveState({
    connected: true, gcode_state: 'FAILED', print_canceled: true, hms: [{ code: 131184 }],
  });
  assert.equal(r.stateKey, 'idle');
  assert.equal(r.labelKey, 'label.idle');
  assert.equal(r.videoFile, 'idle.webm');
});

// 冷启动场景（取消后才打开应用）：收不到瞬时取消命令，只有 pushall 的残留状态。
// 真机取证：取消的任务 gcode_state=FAILED + fail_reason='50348044'(0x0300400C=打印被取消) + 残留 HMS。
// 必须靠持续字段 fail_reason 判定为取消 → idle，而非「打印失败」。
test('冷启动取消（fail_reason=50348044，无 print_canceled）→ idle', () => {
  const r = resolveState({
    connected: true, gcode_state: 'FAILED', fail_reason: '50348044', hms: [{ code: 131184 }],
  });
  assert.equal(r.stateKey, 'idle');
  assert.equal(r.labelKey, 'label.idle');
});

// 反向：真正故障（fail_reason 是别的错误码，非取消码）仍判 failed（通用标签，大类由主进程注入）。
test('真故障（fail_reason 非取消码）→ 仍 failed', () => {
  const r = resolveState({
    connected: true, gcode_state: 'FAILED', fail_reason: '50348050', hms: [{ code: 131184 }],
  });
  assert.equal(r.stateKey, 'failed');
  assert.equal(r.labelKey, 'label.failed');
});

test('FINISH → finished', () => {
  const r = resolveState({ connected: true, gcode_state: 'FINISH' });
  assert.equal(r.stateKey, 'finished');
  assert.equal(r.labelKey, 'label.finished');
});

test('PAUSE 断料 labelKey', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', stg_cur: 6 });
  assert.equal(r.videoFile, 'paused.webm');
  assert.equal(r.labelKey, 'label.paused.runout');
});

// 回归：真机断料暂停常给 gcode_state=PAUSE + stg_cur=0（无细分子阶段）。
// stg=0 的 label.stage.0 文案是「打印中」，绝不能泄漏成暂停熊猫下方的文字/卡片状态。
test('PAUSE 且 stg_cur=0 → 通用暂停文案，不显示「打印中」', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', stg_cur: 0, mc_percent: 68, print_error: 131184 });
  assert.equal(r.stateKey, 'paused');
  assert.equal(r.videoFile, 'paused.webm');
  assert.equal(r.labelKey, 'label.paused.generic');
});

// 暂停时若 stg 属于非暂停类（打印/准备阶段），同样兜底通用暂停，不泄漏该阶段文案
test('PAUSE 且 stg 属于准备类 → 通用暂停文案', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', stg_cur: 1 }); // 1=调平(prepare)
  assert.equal(r.labelKey, 'label.paused.generic');
});

test('PAUSE 舱门打开', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', door_open: true });
  assert.equal(r.labelKey, 'label.doorOpen');
});

test('PREPARE 预热热床 labelKey', () => {
  const r = resolveState({ connected: true, gcode_state: 'PREPARE', stg_cur: 2 });
  assert.equal(r.stateKey, 'prepare');
  assert.equal(r.labelKey, 'label.prepare.heatbed');
});

test('RUNNING 换料 stage → changing_filament', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 4 });
  assert.equal(r.stateKey, 'changing_filament');
  assert.equal(r.labelKey, 'label.changingFilament');
});

// 回归：P1/A1（P1S）打印中换料常停在 stg_cur=0，只由 ams_status（高字节 main==1）体现。
// 无 ams_status 判定时熊猫会一直卡「打印中」，从不进入换料。
test('RUNNING + stg_cur=0 + ams_status 换料 → changing_filament（P1S 修复）', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 0, ams_status: 0x0100, mc_percent: 50 });
  assert.equal(r.stateKey, 'changing_filament');
  assert.equal(r.videoFile, 'changing_filament.webm');
  assert.equal(r.labelKey, 'label.changingFilament');
});

// ams_status 字段位置按机型/固件可能嵌套在 ams 下，两处都应命中
test('RUNNING + 嵌套 ams.ams_status 换料 → changing_filament', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 0, ams: { ams_status: 0x0100 }, mc_percent: 50 });
  assert.equal(r.stateKey, 'changing_filament');
});

// 收窄：只有 main==1 才是换料；assist(3)/rfid(2)/校准(4) 等不得误触发换料
test('RUNNING + ams_status main=3（assist）→ 仍是打印中，不误判换料', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 0, ams_status: 0x0300, mc_percent: 50 });
  assert.equal(r.stateKey, 'printing_50');
});

test('RUNNING 进度分档', () => {
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 0 }).videoFile, 'printing_0.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 24 }).videoFile, 'printing_0.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 25 }).videoFile, 'printing_25.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 50 }).videoFile, 'printing_50.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 75 }).videoFile, 'printing_75.webm');
  assert.equal(resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 99 }).videoFile, 'printing_75.webm');
});

test('RUNNING labelKey 含进度与层数', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 50, layer_num: 100, total_layer_num: 200 });
  assert.equal(r.labelKey, 'label.printing.layer');
  assert.equal(r.labelParams.p, 50);
  assert.equal(r.labelParams.layer, 100);
  assert.equal(r.labelParams.total, 200);
});

test('RUNNING labelKey 仅进度（无层数）', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', mc_percent: 30 });
  assert.equal(r.labelKey, 'label.printing');
  assert.equal(r.labelParams.p, 30);
});

test('IDLE → idle', () => {
  const r = resolveState({ connected: true, gcode_state: 'IDLE' });
  assert.equal(r.stateKey, 'idle');
  assert.equal(r.labelKey, 'label.idle');
});

test('未知状态兜底 idle', () => {
  const r = resolveState({ connected: true, gcode_state: 'WHATEVER' });
  assert.equal(r.stateKey, 'idle');
  assert.equal(r.labelKey, 'label.idle');
});

// extractTemps tests（剩余时间的 locale 格式化在主进程 getMetricsLabel，已不在此模块）
test('extractTemps 取 nozzle_temps 数组第一个元素', () => {
  const r = extractTemps({ nozzle_temps: [220, 0], bed_temps: [55, 0], target_nozzle_temp: 220, target_bed_temp: 55 });
  assert.equal(r.nozzleTemp, 220);
  assert.equal(r.bedTemp, 55);
  assert.equal(r.targetNozzleTemp, 220);
  assert.equal(r.targetBedTemp, 55);
});

test('extractTemps 兼容 nozzle_temp 标量字段', () => {
  const r = extractTemps({ nozzle_temp: 210, bed_temp: 60 });
  assert.equal(r.nozzleTemp, 210);
  assert.equal(r.bedTemp, 60);
});

test('extractTemps 数组优先于标量', () => {
  const r = extractTemps({ nozzle_temps: [230, 0], nozzle_temp: 210 });
  assert.equal(r.nozzleTemp, 230);
});

test('extractTemps 缺失字段返回 null', () => {
  const r = extractTemps({});
  assert.equal(r.nozzleTemp, null);
  assert.equal(r.bedTemp, null);
  assert.equal(r.targetNozzleTemp, null);
  assert.equal(r.targetBedTemp, null);
  assert.equal(r.chamberTemp, null);
  assert.equal(r.remainingTime, null);
});

test('extractTemps chamber_temp 通过', () => {
  const r = extractTemps({ chamber_temp: 35 });
  assert.equal(r.chamberTemp, 35);
});

test('extractTemps remaining_time 通过', () => {
  const r = extractTemps({ remaining_time: 83 });
  assert.equal(r.remainingTime, 83);
});

// 真机权威字段名（pybambu）：扁平 *_temper + mc_remaining_time。
test('extractTemps 读真机扁平字段 *_temper / mc_remaining_time', () => {
  const r = extractTemps({
    nozzle_temper: 218.6, nozzle_target_temper: 220,
    bed_temper: 54.9, bed_target_temper: 55,
    chamber_temper: 33.2, mc_remaining_time: 42,
  });
  assert.equal(r.nozzleTemp, 219);
  assert.equal(r.targetNozzleTemp, 220);
  assert.equal(r.bedTemp, 55);
  assert.equal(r.targetBedTemp, 55);
  assert.equal(r.chamberTemp, 33);
  assert.equal(r.remainingTime, 42);
});

// 新固件：温度嵌套在 device.* 且低16位=当前 / 高16位=目标。
test('extractTemps 读新固件嵌套 device.* 打包温度', () => {
  const r = extractTemps({
    device: {
      extruder: { info: [{ id: 0, temp: (220 << 16) | 219 }] },
      bed: { info: { temp: (55 << 16) | 54 } },
      ctc: { info: { temp: 34 } },
    },
  });
  assert.equal(r.nozzleTemp, 219);
  assert.equal(r.targetNozzleTemp, 220);
  assert.equal(r.bedTemp, 54);
  assert.equal(r.targetBedTemp, 55);
  assert.equal(r.chamberTemp, 34);
});

test('extractTemps 非数字容错', () => {
  const r = extractTemps({ nozzle_temp: 'abc', bed_temps: null });
  assert.equal(r.nozzleTemp, null);
  assert.equal(r.bedTemp, null);
});

// ── Bambu Studio 全阶段富集（stg_cur → 最贴近动画 + 精确文案）──
test('PREPARE 长尾阶段 → prepare 动画 + 精确 stage 文案', () => {
  const r = resolveState({ connected: true, gcode_state: 'PREPARE', stg_cur: 11 }); // 识别打印板类型
  assert.equal(r.videoFile, 'prepare.webm');
  assert.equal(r.labelKey, 'label.stage.11');
});

test('RUNNING 中途校准 → prepare 动画', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 8 }); // 动态流量校准
  assert.equal(r.videoFile, 'prepare.webm');
  assert.equal(r.labelKey, 'label.stage.8');
});

test('RUNNING 退料 → changing_filament 动画 + 精确文案', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 22 }); // 退料中
  assert.equal(r.videoFile, 'changing_filament.webm');
  assert.equal(r.labelKey, 'label.stage.22');
});

test('PAUSE 长尾原因 → paused 动画 + 精确文案', () => {
  const r = resolveState({ connected: true, gcode_state: 'PAUSE', stg_cur: 26 }); // AMS 离线
  assert.equal(r.videoFile, 'paused.webm');
  assert.equal(r.labelKey, 'label.stage.26');
});

test('RUNNING 正常打印（stg=0）仍按进度选档', () => {
  const r = resolveState({ connected: true, gcode_state: 'RUNNING', stg_cur: 0, mc_percent: 60 });
  assert.equal(r.videoFile, 'printing_50.webm');
  assert.equal(r.labelKey, 'label.printing');
});

// ── 登录/会话失效（token 过期）区别于打印机离线 ──
test('authExpired → 登录已失效（优先于离线）', () => {
  const r = resolveState({ connected: false, authExpired: true });
  assert.equal(r.stateKey, 'authExpired');
  assert.equal(r.labelKey, 'label.authExpired');
  assert.equal(r.videoFile, 'offline.webm');
});

test('普通离线（无 authExpired）仍是 offline', () => {
  const r = resolveState({ connected: false });
  assert.equal(r.stateKey, 'offline');
  assert.equal(r.labelKey, 'label.offline');
});
