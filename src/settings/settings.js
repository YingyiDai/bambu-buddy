// 设置窗控制器：侧边栏导航 + i18n + 打印机/把玩/外观/关于。
const el = (id) => document.getElementById(id);
const pending = { region: 'global', account: '', password: '', tfaKey: null };
let localeStrings = null;
let currentLocale = 'zh-CN';

function t(key, params) {
  const map = (localeStrings && localeStrings[currentLocale]) || {};
  let s = map[key];
  if (s == null) return key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  return s;
}
function applyLocaleText(node, text) {
  if (node.children.length > 0) {
    for (const c of node.childNodes) if (c.nodeType === Node.TEXT_NODE && c.textContent.trim()) { c.textContent = text; return; }
  }
  node.textContent = text;
}
function renderLocale() { document.querySelectorAll('[data-i18n]').forEach((n) => applyLocaleText(n, t(n.dataset.i18n))); }
async function loadLocales() {
  localeStrings = await window.bambu.getLocaleStrings();
  currentLocale = await window.bambu.getCurrentLocale();
  renderLocale();
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setBusy(b) { for (const x of document.querySelectorAll('button')) x.disabled = b; }
function showError(m) { const e = el('err'); e.textContent = m || ''; e.classList.toggle('hidden', !m); }
function clearError() { showError(''); }

// ── 侧边栏导航 ──
function switchSection(name) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('hidden', s.dataset.section !== name));
  if (name === 'printers') renderPrinters();
  if (name === 'play') initPlay();
  if (name === 'appearance') loadPreferences();
  if (name === 'about') loadAbout();
}
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => switchSection(b.dataset.section)));
// 主进程请求跳转某子页面（设置窗已打开时）
const KNOWN_SECTIONS = ['printers', 'play', 'appearance', 'about'];
window.bambu.onNavigate((section) => { if (KNOWN_SECTIONS.includes(section)) switchSection(section); });

// ── 账号块：登录 / 验证码 / 已登录摘要 ──
function setAccStep(step) { // 'login' | 'verify' | 'summary'
  for (const s of ['Login', 'Verify', 'Summary']) {
    const id = s === 'Summary' ? 'accountSummary' : 'cloud' + s;
    el(id).classList.toggle('hidden', s.toLowerCase() !== step);
  }
  clearError();
}
async function refreshAccountBlock() {
  try {
    const st = await window.bambu.getStoredState();
    if (st.hasToken) {
      el('sumAccount').textContent = st.account || st.activePrinter || '—';
      const rl = { global: t('settings.regionGlobalFull'), china: t('settings.regionChinaFull') };
      el('sumRegion').textContent = rl[st.region] || st.region || '—';
      setAccStep('summary');
      return;
    }
  } catch (e) { /* ignore */ }
  setAccStep('login');
}
el('cloudLoginBtn').addEventListener('click', async () => {
  clearError();
  pending.region = el('cloudRegion').value;
  pending.account = el('cloudAccount').value.trim();
  pending.password = el('cloudPassword').value;
  setBusy(true);
  const r = await window.bambu.submitCredentials(pending.region, pending.account, pending.password);
  setBusy(false);
  if (r.needsVerify) { pending.tfaKey = r.tfaKey; setAccStep('verify'); el('cloudCode').focus(); return; }
  if (r.ok) { await afterLogin(); return; }
  showError(r.error || t('settings.errLoginFailed'));
});
el('cloudVerifyBtn').addEventListener('click', async () => {
  clearError();
  const code = el('cloudCode').value.trim();
  if (!code) { showError(t('settings.errVerifyRequired')); return; }
  setBusy(true);
  const r = await window.bambu.submitVerifyCode(pending.region, pending.account, pending.password, pending.tfaKey, code);
  setBusy(false);
  if (r.ok) { await afterLogin(); return; }
  showError(r.error || t('settings.errVerifyInvalid'));
});
el('cloudVerifyBack').addEventListener('click', () => { pending.tfaKey = null; el('cloudCode').value = ''; setAccStep('login'); });
el('sumLogout').addEventListener('click', async () => {
  await window.bambu.logout();
  el('cloudAccount').value = ''; el('cloudPassword').value = '';
  setAccStep('login'); renderPrinters();
});
// 登录成功：拉取设备并入统一列表（无需单独选设备步骤），刷新账号块 + 列表。
async function afterLogin() {
  setBusy(true);
  await window.bambu.completeCloudLogin();
  setBusy(false);
  await refreshAccountBlock();
  renderPrinters();
}
window.bambu.onError((msg) => { showError(msg || t('settings.errAuthExpired')); setAccStep('login'); });

// ── 统一打印机列表 ──
async function renderPrinters() {
  if (!localeStrings) await loadLocales();
  await refreshAccountBlock();
  const { printers, activeSerial } = await window.bambu.listPrinters();
  const box = el('printerList'); box.innerHTML = '';
  const srcText = { cloud: t('settings.srcCloud'), lan: t('settings.srcLan'), both: t('settings.srcBoth') };
  for (const p of printers) {
    const isActive = p.serial === activeSerial;
    const status = isActive ? t('settings.statusActive')
      : (p.hasCloud ? (p.online === true ? (p.printStatus === 'RUNNING' ? t('settings.statusPrinting') : t('settings.statusOnline')) : (p.online === false ? t('settings.statusOffline') : t('settings.statusUnknown')))
                    : t('settings.statusNotConnected'));
    const card = document.createElement('div');
    card.className = 'printer-card' + (isActive ? ' active' : '');
    card.dataset.serial = p.serial;
    card.innerHTML =
      '<div class="pc-main"><div class="pc-name-row"><span class="pc-name">' + escapeHtml(p.name) + '</span></div>' +
      '<div class="pc-meta">' + escapeHtml(p.model || p.serial) + ' · <span class="badge">' + escapeHtml(srcText[p.source] || p.source) + '</span> · ' + escapeHtml(status) + '</div></div>' +
      '<div class="pc-actions">' +
        (isActive ? '' : '<button class="btn pc-act-use" data-s="' + escapeHtml(p.serial) + '">' + escapeHtml(t('settings.setActive')) + '</button>') +
        '<button class="btn pc-act-rename" data-s="' + escapeHtml(p.serial) + '">' + escapeHtml(t('settings.rename')) + '</button>' +
        (p.hasLan ? '<button class="btn pc-act-remove" data-s="' + escapeHtml(p.serial) + '">' + escapeHtml(t('settings.remove')) + '</button>' : '') +
      '</div>';
    box.appendChild(card);
  }
  box.querySelectorAll('.pc-act-use').forEach((b) => b.addEventListener('click', async () => { await window.bambu.setActivePrinter(b.dataset.s); renderPrinters(); }));
  box.querySelectorAll('.pc-act-remove').forEach((b) => b.addEventListener('click', async () => { await window.bambu.removeLanPrinter(b.dataset.s); renderPrinters(); }));
  box.querySelectorAll('.pc-act-rename').forEach((b) => b.addEventListener('click', () => startRename(b.dataset.s)));
}
function startRename(serial) {
  const card = el('printerList').querySelector('.printer-card[data-serial="' + serial + '"]');
  if (!card) return;
  const row = card.querySelector('.pc-name-row');
  const cur = card.querySelector('.pc-name').textContent;
  row.innerHTML = '<input type="text" class="pc-rename-input" value="' + escapeHtml(cur) + '" />' +
    '<button class="btn pc-rename-save">' + escapeHtml(t('settings.renameSave')) + '</button>' +
    '<button class="btn pc-rename-cancel">' + escapeHtml(t('settings.renameCancel')) + '</button>';
  const input = row.querySelector('.pc-rename-input'); input.focus(); input.select();
  row.querySelector('.pc-rename-save').addEventListener('click', async () => { const v = input.value.trim(); if (v) await window.bambu.renamePrinter(serial, v); renderPrinters(); });
  row.querySelector('.pc-rename-cancel').addEventListener('click', () => renderPrinters());
}
el('pAddBtn').addEventListener('click', async () => {
  const host = el('pAddHost').value.trim(), code = el('pAddCode').value.trim(), serial = el('pAddSerial').value.trim(), name = el('pAddName').value.trim();
  const msg = el('pAddMsg'); msg.textContent = '…';
  const r = await window.bambu.addLanPrinter(host, code, serial, name);
  if (r.ok) { msg.textContent = t('settings.connSuccess'); el('pAddHost').value = el('pAddCode').value = el('pAddSerial').value = el('pAddName').value = ''; renderPrinters(); }
  else msg.textContent = r.error || t('settings.errLanFailed');
});
window.bambu.onPrintersChanged(() => { const sec = document.querySelector('.section[data-section="printers"]'); if (sec && !sec.classList.contains('hidden')) renderPrinters(); });

// ── 外观 ──
async function loadPreferences() {
  if (!localeStrings) await loadLocales();
  const p = await window.bambu.getPreferences();
  el('sizeSlider').value = p.sizePx; el('sizeVal').textContent = p.sizePx + 'px';
  el('fontSizeSlider').value = p.labelFontSize; el('fontSizeVal').textContent = p.labelFontSize + 'px';
  el('showLabelToggle').checked = p.showLabel;
  el('localeSelect').value = p.locale;
  if (p.locale !== currentLocale) { currentLocale = p.locale; renderLocale(); }
  syncAllSliderFills();
}

// ── 滑杆填充轨道：--fill 跟随当前值（拖动时由全局 input 监听更新，
//    程序化赋值后调用 syncAllSliderFills 刷新）──
function syncSliderFill(s) {
  const min = Number(s.min) || 0, max = Number(s.max) || 100;
  const pct = max > min ? ((Number(s.value) - min) / (max - min)) * 100 : 0;
  s.style.setProperty('--fill', pct + '%');
}
function syncAllSliderFills() { document.querySelectorAll('.slider').forEach(syncSliderFill); }
document.addEventListener('input', (e) => { if (e.target.classList && e.target.classList.contains('slider')) syncSliderFill(e.target); });
el('sizeSlider').addEventListener('input', () => { const v = el('sizeSlider').value; el('sizeVal').textContent = v + 'px'; window.bambu.setPreference('sizePx', Number(v)); });
el('fontSizeSlider').addEventListener('input', () => { el('fontSizeVal').textContent = el('fontSizeSlider').value + 'px'; });
el('fontSizeSlider').addEventListener('change', () => window.bambu.setPreference('labelFontSize', Number(el('fontSizeSlider').value)));
el('showLabelToggle').addEventListener('change', () => window.bambu.setPreference('showLabel', el('showLabelToggle').checked));
el('localeSelect').addEventListener('change', () => { currentLocale = el('localeSelect').value; renderLocale(); window.bambu.setPreference('locale', currentLocale); });

// ── 关于 ──
async function loadAbout() {
  if (!localeStrings) await loadLocales();
  const info = await window.bambu.getAppInfo();
  el('aboutName').textContent = info.name;
  el('aboutCurrentVersion').textContent = 'v' + info.version;
  const author = el('aboutAuthor');
  author.textContent = 'YingyiDai';
  author.onclick = (e) => { e.preventDefault(); window.bambu.openExternal('https://makerworld.com.cn/zh/@yingyidai'); };
  el('updateStatus').classList.add('hidden');
  el('checkUpdateBtn').textContent = t('settings.checkUpdate'); el('checkUpdateBtn').disabled = false;
}
el('checkUpdateBtn').addEventListener('click', async () => {
  const btn = el('checkUpdateBtn'), status = el('updateStatus');
  btn.disabled = true; btn.textContent = t('settings.checkingUpdate'); status.classList.add('hidden');
  let result; try { result = await window.bambu.checkForUpdates(); } catch (e) { result = { error: t('settings.updateError') }; }
  status.classList.remove('hidden');
  if (result.error) { status.className = 'update-status error'; status.textContent = result.error; }
  else if (result.hasUpdate) {
    status.className = 'update-status available';
    status.innerHTML = t('settings.updateAvailableHtml', { version: result.latestVersion }) + ' · <a href="#" class="release-link">' + t('settings.viewRelease') + '</a>';
    status.querySelector('.release-link').addEventListener('click', (e) => { e.preventDefault(); window.bambu.openExternal(result.releaseUrl); });
  } else { status.className = 'update-status uptodate'; status.textContent = t('settings.upToDate'); }
  btn.disabled = false; btn.textContent = t('settings.checkUpdate');
});

// ── 把玩探索 ──
// 场景表（key/icon 与 src/config/play-scenarios.js 一致；文案走 locale play.<key>.name/.desc）
const PLAY_SCENARIOS = [
  { key: 'printing', icon: '🖨️', hasProgress: true },
  { key: 'idle', icon: '😴' },
  { key: 'prepare_leveling', icon: '📐' }, { key: 'changing_filament', icon: '🔄' },
  { key: 'paused', icon: '⏸️' },
  { key: 'finished', icon: '🎉' },
  { key: 'failed', icon: '😢' }, { key: 'offline', icon: '🔌' },
];
let playGalleryBuilt = false;
let autoTouring = false;

function buildGallery() {
  const box = el('playGallery'); box.innerHTML = '';
  for (const s of PLAY_SCENARIOS) {
    const card = document.createElement('button');
    card.className = 'play-card'; card.dataset.key = s.key;
    card.innerHTML = '<div class="pname">' + s.icon + ' ' + escapeHtml(t('play.' + s.key + '.name')) + '</div>' +
      '<div class="pdesc">' + escapeHtml(t('play.' + s.key + '.desc')) + '</div>';
    card.addEventListener('click', async () => { await window.bambu.playSetScenario(s.key); });
    box.appendChild(card);
  }
  playGalleryBuilt = true;
}

function renderPlayState(st) {
  // st: { isPlaying, currentScenario, percent }
  const sc = PLAY_SCENARIOS.find((x) => x.key === st.currentScenario);
  if (st.isPlaying && sc) {
    el('playStateLabel').textContent = sc.icon + ' ' + t('play.' + sc.key + '.name');
    document.querySelector('.play-now-cap').textContent = t('play.nowPlaying');
  } else {
    el('playStateLabel').textContent = t('play.inLiveMode');
    document.querySelector('.play-now-cap').textContent = '';
  }
  // 进度滑杆仅在场景声明 hasProgress 时显示（目前仅 printing）
  const showProg = st.isPlaying && !!(sc && sc.hasProgress);
  el('progressRow').classList.toggle('hidden', !showProg);
  if (showProg) { el('playProgress').value = st.percent; el('playProgressVal').textContent = st.percent + '%'; syncSliderFill(el('playProgress')); }
  // 画廊高亮当前
  document.querySelectorAll('.play-card').forEach((c) => c.classList.toggle('active', st.isPlaying && c.dataset.key === st.currentScenario));
}

async function initPlay() {
  if (!localeStrings) await loadLocales();
  if (!playGalleryBuilt) buildGallery();
  const st = await window.bambu.playGetState();
  renderPlayState(st);
}

// 滑杆拖动 → 实时设进度
el('playProgress').addEventListener('input', () => {
  const v = Number(el('playProgress').value);
  el('playProgressVal').textContent = v + '%';
  window.bambu.playSetProgress(v);
});
// 自动巡演开关
el('autoTourBtn').addEventListener('click', async () => {
  autoTouring = !autoTouring;
  await window.bambu.playAutoTour(autoTouring);
  el('autoTourBtn').textContent = t(autoTouring ? 'play.autoTourStop' : 'play.autoTour');
});
// 回到真机
el('playReturnBtn').addEventListener('click', async () => {
  autoTouring = false; el('autoTourBtn').textContent = t('play.autoTour');
  await window.bambu.playReturnToLive();
});
// 主进程推送把玩状态变化
window.bambu.onPlayStateChanged((st) => { autoTouring = false; el('autoTourBtn').textContent = t('play.autoTour'); renderPlayState(st); });

// ── 启动：默认进入打印机区域 ──
// 初始子页面：由窗口创建时的 hash 决定（如 #play），默认打印机
const INITIAL_SECTION = KNOWN_SECTIONS.includes((location.hash || '').slice(1)) ? location.hash.slice(1) : 'printers';
(async function start() { await loadLocales(); switchSection(INITIAL_SECTION); })();
