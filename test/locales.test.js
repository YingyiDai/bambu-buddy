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
    'play.dragProgress', 'play.autoTour', 'play.autoTourStop', 'play.returnToLive',
    'play.galleryHint', 'printers.sectionAccount', 'printers.sectionList',
    'tray.playMode', 'tray.addPrinter']) {
    assert.ok(STRINGS['zh-CN'][k], `zh-CN 缺 ${k}`);
    assert.ok(STRINGS['en'][k], `en 缺 ${k}`);
  }
});

test('每个把玩场景都有 name 与 desc（中英）', () => {
  for (const s of PLAY_SCENARIOS) {
    for (const loc of ['zh-CN', 'en']) {
      assert.ok(STRINGS[loc][playLabelKey(s.key)], `${loc} 缺 ${playLabelKey(s.key)}`);
      assert.ok(STRINGS[loc][playDescKey(s.key)], `${loc} 缺 ${playDescKey(s.key)}`);
    }
  }
});

// 守护：bambu-auth / updater 以 locale key 形式返回错误（主进程 localizeResult 翻译）。
// key 拼错或漏加词条时，UI 会把裸 key 甩给用户——这里静态扫描源码里的错误 key，
// 保证两种语言的词条都存在。
test('bambu-auth/updater 返回的错误 key 在中英词表中均存在', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/core/bambu-auth.js'), 'utf8')
    + fs.readFileSync(require.resolve('../src/core/updater.js'), 'utf8');
  const keys = [...new Set([...src.matchAll(/'((?:auth|updater|settings)\.err[A-Za-z]+)'/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 10, `应扫出至少 10 个错误 key，实际 ${keys.length}`);
  for (const k of keys) {
    assert.ok(STRINGS['zh-CN'][k], `zh-CN 缺 ${k}`);
    assert.ok(STRINGS['en'][k], `en 缺 ${k}`);
  }
});
