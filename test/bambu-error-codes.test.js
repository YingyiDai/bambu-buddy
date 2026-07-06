// 官方错误码表（BambuStudio hms_<lang>_<model>.json）解析与查表的纯逻辑单测。
// 数据结构真机取证：data.device_error[<lang>] / data.device_hms[<lang>] = [{ecode, intro}]。
const test = require('node:test');
const assert = require('node:assert');
const {
  parseErrorTable, lookupFailureReason, categorizeFailure, failureCategory,
  modelCodeFromSerial, langForLocale,
} = require('../src/core/bambu-error-codes');

// 仿真官方码表（字段名、层级与真机下载的 hms_zh-cn_20P.json 一致）
const FAKE = {
  data: {
    device_error: { ver: 1, 'zh-cn': [
      { ecode: '0300400C', intro: '任务已取消。' },
      { ecode: '03004006', intro: '喷嘴堵头，请检查耗材是否卡住或挤出机堵头。' },
    ] },
    device_hms: { ver: 1, 'zh-cn': [
      { ecode: '0500060000020070', intro: '' }, // 真机断料码，官方无文案
      { ecode: '0700010000020002', intro: 'AMS A 助力电机过载，可能供料路径阻力大或耗材缠绕。' },
    ] },
  },
};

test('parseErrorTable 建立 ecode→intro 映射（大写归一）', () => {
  const t = parseErrorTable(FAKE, 'zh-cn');
  assert.equal(t.deviceError.get('0300400C'), '任务已取消。');
  assert.equal(t.deviceError.get('03004006'), '喷嘴堵头，请检查耗材是否卡住或挤出机堵头。');
  assert.equal(t.deviceHms.get('0700010000020002'), 'AMS A 助力电机过载，可能供料路径阻力大或耗材缠绕。');
});

test('lookupFailureReason 优先用 fail_reason 查 device_error', () => {
  const t = parseErrorTable(FAKE, 'zh-cn');
  // 50348038 = 0x03004006（十进制字符串，真机 fail_reason 就是这种十进制串）
  const r = lookupFailureReason({ fail_reason: String(0x03004006) }, t);
  assert.equal(r, '喷嘴堵头，请检查耗材是否卡住或挤出机堵头。');
});

test('lookupFailureReason 在 fail_reason 无文案时回退 hms[0]（attr+code 拼 16hex）', () => {
  const t = parseErrorTable(FAKE, 'zh-cn');
  const r = lookupFailureReason({
    fail_reason: '0',
    hms: [{ attr: 0x07000100, code: 0x00020002 }],
  }, t);
  assert.equal(r, 'AMS A 助力电机过载，可能供料路径阻力大或耗材缠绕。');
});

test('lookupFailureReason 命中的 ecode 若 intro 为空 → 视作未命中返回 null', () => {
  const t = parseErrorTable(FAKE, 'zh-cn');
  // 断料 HMS 官方 intro 为空，且无 fail_reason → 无可显示原因
  const r = lookupFailureReason({ hms: [{ attr: 0x05000600, code: 0x00020070 }] }, t);
  assert.equal(r, null);
});

test('lookupFailureReason 无表 / 无匹配 → null', () => {
  const t = parseErrorTable(FAKE, 'zh-cn');
  assert.equal(lookupFailureReason({ fail_reason: '999999' }, t), null);
  assert.equal(lookupFailureReason({ fail_reason: '0' }, null), null);
});

test('modelCodeFromSerial 取序列号前三位（真机 20P6BJ...→20P）', () => {
  assert.equal(modelCodeFromSerial('20P6BJ633100497'), '20P');
  assert.equal(modelCodeFromSerial(''), null);
  assert.equal(modelCodeFromSerial(null), null);
});

test('langForLocale：zh* → zh-cn，其余 → en', () => {
  assert.equal(langForLocale('zh-CN'), 'zh-cn');
  assert.equal(langForLocale('zh-TW'), 'zh-cn');
  assert.equal(langForLocale('en'), 'en');
  assert.equal(langForLocale('en-US'), 'en');
});

// 熊猫只显示「大类」：把官方长句归到断料/堵头/温度/机械/校准/打印板/喷嘴/AMS 之一，认不出则 null。
test('categorizeFailure 按官方中文文本归大类', () => {
  assert.equal(categorizeFailure('左侧挤出机外挂料盘耗材用尽，请装入新的耗材。'), 'runout');
  assert.equal(categorizeFailure('检测到左挤出机冲刷旧料超时，请检查耗材是否卡住或挤出机堵头。'), 'clog');
  assert.equal(categorizeFailure('当前热端温度较低。继续进退料可能损坏挤出机。'), 'temp');
  assert.equal(categorizeFailure('检测到多次运动丢步，请先检查工具头是否有异物阻挡。'), 'motion');
  assert.equal(categorizeFailure('AMS-HT A固件与打印机不匹配，请升级。'), 'ams');
  assert.equal(categorizeFailure('喷嘴冷拔维护尚未完成，无法发起新任务。'), 'nozzle');
  assert.equal(categorizeFailure('任务已取消。'), null); // 取消不归大类（且取消已分流为空闲）
  assert.equal(categorizeFailure(''), null);
  assert.equal(categorizeFailure(null), null);
});

test('categorizeFailure 英文文本也能归类', () => {
  assert.equal(categorizeFailure('The filament has run out, please load new filament.'), 'runout');
  assert.equal(categorizeFailure('Nozzle clog detected, check for tangled filament.'), 'clog');
});

test('failureCategory：报文 → 大类（fail_reason 命中官方文案后归类）', () => {
  const t = parseErrorTable(FAKE, 'zh-cn');
  // FAKE 的 03004006 = 「喷嘴堵头，请检查耗材是否卡住或挤出机堵头。」→ clog
  assert.equal(failureCategory({ fail_reason: String(0x03004006) }, t), 'clog');
  assert.equal(failureCategory({ fail_reason: '999999' }, t), null);
});
