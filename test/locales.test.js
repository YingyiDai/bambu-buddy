// locale 键集一致性 + 把玩文案完整性。
const test = require('node:test');
const assert = require('node:assert');
const { STRINGS } = require('../src/config/locales');
const { PLAY_SCENARIOS, playLabelKey, playDescKey } = require('../src/config/play-scenarios');

test('zh-CN 与 en 键集完全一致', () => {
  const zh = Object.keys(STRINGS['zh-CN']).sort();
  const en = Object.keys(STRINGS['en']).sort();
  assert.deepStrictEqual(zh, en);
});

test('侧边栏与把玩页框架键存在', () => {
  for (const k of ['nav.printers', 'nav.play', 'nav.appearance', 'nav.about',
    'play.title', 'play.subtitle', 'play.nowPlaying', 'play.inLiveMode',
    'play.returnToLive', 'play.draw', 'play.gachaTitle', 'play.gachaSub',
    'play.drawHint', 'play.cardBack', 'play.allStates',
    'printers.sectionAccount', 'printers.sectionList',
    'tray.playMode', 'tray.noPrinter', 'tray.addPrinter']) {
    assert.ok(STRINGS['zh-CN'][k], `zh-CN 缺 ${k}`);
    assert.ok(STRINGS['en'][k], `en 缺 ${k}`);
  }
});

test('每个把玩场景都有 name 与 desc（中英）', () => {
  for (const e of PLAY_SCENARIOS) {
    for (const loc of ['zh-CN', 'en']) {
      assert.ok(STRINGS[loc][playLabelKey(e)], `${loc} 缺 ${playLabelKey(e)}`);
      assert.ok(STRINGS[loc][playDescKey(e)], `${loc} 缺 ${playDescKey(e)}`);
    }
  }
});
