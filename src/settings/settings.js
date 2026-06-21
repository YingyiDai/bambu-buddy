// Bambu 设置窗：三 Tab + i18n。
const el = (id) => document.getElementById(id);
const pending = { region: 'global', account: '', password: '', tfaKey: null };

let localeStrings = null;
let currentLocale = 'zh-CN';

function t(key, params) {
  const map = (localeStrings && localeStrings[currentLocale]) || {};
  let template = map[key];
  if (template == null) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return template;
}

// 遍历所有 [data-i18n] 元素，替换文本
function applyLocaleText(el, text) {
  if (el.children.length > 0) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        node.textContent = text; return;
      }
    }
  }
  el.textContent = text;
}

function renderLocale() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    applyLocaleText(el, t(el.dataset.i18n));
  });
}

async function loadLocales() {
  localeStrings = await window.bambu.getLocaleStrings();
  currentLocale = await window.bambu.getCurrentLocale();
  renderLocale();
}

function setRegionLabels() {
  // REGION_LABELS are now locale-aware — used in summary display
  return {
    global: t('settings.regionGlobalFull'),
    china: t('settings.regionChinaFull'),
  };
}

// ---- Tab 切换 ----
function switchTab(tab) {
  for (const t of ['connection', 'appearance', 'about']) {
    el('tab' + t[0].toUpperCase() + t.slice(1)).classList.toggle('active', t === tab);
    el('pane' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hidden', t !== tab);
  }
}
el('tabConnection').addEventListener('click', () => switchTab('connection'));
el('tabAppearance').addEventListener('click', () => { switchTab('appearance'); loadPreferences(); });
el('tabAbout').addEventListener('click', () => { switchTab('about'); loadAbout(); });

// ---- 连接模式切换 ----
function setMode(mode) {
  document.body.dataset.mode = mode;
  el('modeCloud').classList.toggle('active', mode === 'cloud');
  el('modeLan').classList.toggle('active', mode === 'lan');
  el('cloudPane').classList.toggle('hidden', mode !== 'cloud');
  el('lanPane').classList.toggle('hidden', mode !== 'lan');
  clearError();
}

function setCloudStep(step) {
  document.body.dataset.step = step;
  for (const s of ['Login', 'Verify', 'Devices', 'Summary']) {
    el('cloud' + s).classList.toggle('hidden', s.toLowerCase() !== step);
  }
  clearError();
}

function showError(msg) { const e = el('err'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }
function clearError() { const e = el('err'); e.textContent = ''; e.classList.add('hidden'); }

// ---- 连接 Tab 初始化 ----
async function init() {
  await loadLocales();
  try {
    const st = await window.bambu.getStoredState();
    if (st.mode === 'lan' && st.host) {
      setMode('lan');
      el('lanHost').value = st.host || '';
      el('lanSerial').value = st.serial || '';
      return;
    }
    if (st.mode === 'cloud' && st.hasToken && st.activePrinter) {
      pending.region = st.region || 'global';
      const activePrinter = (st.printers || []).find(p => p.serial === st.activePrinter);
      el('sumName').textContent = activePrinter ? activePrinter.name : (st.name || st.activePrinter);
      el('sumSerial').textContent = st.activePrinter;
      const labels = setRegionLabels();
      el('sumRegion').textContent = labels[st.region] || st.region || '—';
      setCloudStep('summary');
      return;
    }
  } catch (e) { /* ignore */ }
  setCloudStep('login');
}

// ---- Cloud 登录流程 ----
el('cloudLoginBtn').addEventListener('click', async () => {
  clearError();
  pending.region = el('cloudRegion').value;
  pending.account = el('cloudAccount').value.trim();
  pending.password = el('cloudPassword').value;
  setBusy(true);
  const r = await window.bambu.submitCredentials(pending.region, pending.account, pending.password);
  setBusy(false);
  if (r.needsVerify) { pending.tfaKey = r.tfaKey; setCloudStep('verify'); el('cloudCode').focus(); return; }
  if (r.ok) { await showDevices(); return; }
  showError(r.error || t('settings.errLoginFailed'));
});

el('cloudVerifyBtn').addEventListener('click', async () => {
  clearError();
  const code = el('cloudCode').value.trim();
  if (!code) { showError(t('settings.errVerifyRequired')); return; }
  setBusy(true);
  const r = await window.bambu.submitVerifyCode(pending.region, pending.account, pending.password, pending.tfaKey, code);
  setBusy(false);
  if (r.ok) { await showDevices(); return; }
  showError(r.error || t('settings.errVerifyInvalid'));
});

el('cloudVerifyBack').addEventListener('click', () => { pending.tfaKey = null; el('cloudCode').value = ''; setCloudStep('login'); });
el('cloudDevicesBack').addEventListener('click', () => setCloudStep('login'));

async function showDevices() {
  setBusy(true);
  const r = await window.bambu.listDevices();
  const st = await window.bambu.getStoredState();
  setBusy(false);
  if (!r.ok) { showError(r.error || t('settings.errDeviceListFailed')); return; }
  const list = el('deviceList');
  list.innerHTML = '';
  if (!r.devices.length) { el('noDevices').classList.remove('hidden'); setCloudStep('devices'); return; }
  el('noDevices').classList.add('hidden');
  const knownSerials = new Set((st.printers || []).map(p => p.serial));
  const onlineText = t('settings.deviceOnline');
  const offlineText = t('settings.deviceOffline');
  for (const d of r.devices) {
    const isKnown = knownSerials.has(d.serial);
    const li = document.createElement('li');
    li.className = isKnown ? 'known' : '';
    li.innerHTML = '<div class="d-name">' + escapeHtml(d.name) + (isKnown ? ' ✓' : '') + '</div>' +
      '<div class="d-meta ' + (d.online ? '' : 'offline') + '">' + escapeHtml(d.model || '') + ' · ' + d.serial + ' · ' + (d.online ? onlineText : offlineText) + '</div>';
    li.addEventListener('click', () => saveDevice(d.serial, d.name, d.model || ''));
    list.appendChild(li);
  }
  setCloudStep('devices');
}

async function saveDevice(serial, name, model) {
  setBusy(true);
  const r = await window.bambu.saveDevice(serial, name, model || '');
  setBusy(false);
  if (r.ok) { window.bambu.close(); return; }
  showError(r.error || t('settings.errSaveFailed'));
}

el('sumLogout').addEventListener('click', async () => {
  await window.bambu.logout();
  el('cloudAccount').value = '';
  el('cloudPassword').value = '';
  setCloudStep('login');
});
el('sumClose').addEventListener('click', () => window.bambu.close());

// ---- LAN ----
el('lanTestBtn').addEventListener('click', async () => {
  clearError();
  const host = el('lanHost').value.trim(), accessCode = el('lanAccessCode').value.trim(), serial = el('lanSerial').value.trim();
  if (!host || !accessCode || !serial) { showError(t('settings.errLanFields')); return; }
  setBusy(true);
  const r = await window.bambu.testLan(host, accessCode, serial);
  setBusy(false);
  if (r.ok) { showError(t('settings.connSuccess')); return; }
  showError(r.error || t('settings.errLanFailed'));
});

el('lanSaveBtn').addEventListener('click', async () => {
  clearError();
  const host = el('lanHost').value.trim(), accessCode = el('lanAccessCode').value.trim(), serial = el('lanSerial').value.trim();
  if (!host || !accessCode || !serial) { showError(t('settings.errLanFields')); return; }
  setBusy(true);
  const r = await window.bambu.saveLan(host, accessCode, serial, serial);
  setBusy(false);
  if (r.ok) { window.bambu.close(); return; }
  showError(r.error || t('settings.errSaveFailed'));
});

el('modeCloud').addEventListener('click', () => setMode('cloud'));
el('modeLan').addEventListener('click', () => setMode('lan'));

window.bambu.onError((msg) => {
  showError(msg || t('settings.errAuthExpired'));
  setCloudStep('login');
});

// ---- 外观 Tab ----
async function loadPreferences() {
  if (!localeStrings) await loadLocales();
  const prefs = await window.bambu.getPreferences();
  el('sizeSlider').value = prefs.sizePx;
  el('sizeVal').textContent = prefs.sizePx + 'px';
  el('fontSizeSlider').value = prefs.labelFontSize;
  el('fontSizeVal').textContent = prefs.labelFontSize + 'px';
  el('showLabelToggle').checked = prefs.showLabel;
  el('localeSelect').value = prefs.locale;
  if (prefs.locale !== currentLocale) {
    currentLocale = prefs.locale;
    renderLocale();
  }
}

el('sizeSlider').addEventListener('input', () => {
  const v = el('sizeSlider').value;
  el('sizeVal').textContent = v + 'px';
  window.bambu.setPreference('sizePx', Number(v));
});

el('fontSizeSlider').addEventListener('input', () => {
  el('fontSizeVal').textContent = el('fontSizeSlider').value + 'px';
});
el('fontSizeSlider').addEventListener('change', () => {
  window.bambu.setPreference('labelFontSize', Number(el('fontSizeSlider').value));
});

el('showLabelToggle').addEventListener('change', () => {
  window.bambu.setPreference('showLabel', el('showLabelToggle').checked);
});

el('localeSelect').addEventListener('change', () => {
  const newLocale = el('localeSelect').value;
  currentLocale = newLocale;
  renderLocale();
  window.bambu.setPreference('locale', newLocale);
});

// ---- 关于 Tab ----
async function loadAbout() {
  if (!localeStrings) await loadLocales();
  const info = await window.bambu.getAppInfo();
  el('aboutName').textContent = info.name;
  el('aboutVersion').textContent = 'v' + info.version;
}

// ---- 工具 ----
function setBusy(busy) { for (const b of document.querySelectorAll('button')) b.disabled = busy; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

init();
