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

// ── 打印机卡片轮播 ──
let carIndex = 0;        // 当前居中卡片索引
let carCount = 0;        // 卡片总数（含末尾添加卡）
let carouselWired = false;
let carInitialized = false; // 首次渲染时把焦点定位到当前打印机
const RENAME_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

// 型号 → 照片：归一化型号字符串后匹配 assets/printer 下的文件名。
// 顺序敏感：更具体的关键字（a1mini / x1carbon）必须排在宽泛的（a1 / x1）之前。
function printerImage(model) {
  const norm = String(model || '').toLowerCase().replace(/bambu\s*lab/g, '').replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  const table = [
    ['x1carbon', 'X1C'], ['x1c', 'X1C'], ['x1e', 'X1E'], ['x1', 'X1C'],
    ['p1s', 'P1S'], ['p2s', 'P2S'],
    ['a1mini', 'A1mini'], ['a1m', 'A1mini'], ['a2l', 'a2l'], ['a1', 'A1'],
    ['h2d', 'H2D'], ['h2s', 'H2S'], ['h2c', 'h2c'], ['x2d', 'X2D'],
  ];
  for (const [k, img] of table) if (norm.includes(k)) return '../../assets/printer/' + img + '.png';
  return null;
}
// 连接状态类别（快照）——与「是否当前」无关。
function connCls(p) {
  if (p.online === true) return p.printStatus === 'RUNNING' ? 'printing' : 'online';
  if (p.online === false) return 'offline';
  return 'unknown';
}
// 实时标签 → 状态类别（含离线/暂停/打印等）。
function liveCls(key) {
  if (!key) return 'unknown';
  if (key.startsWith('label.offline') || key.startsWith('label.authExpired') || key.startsWith('label.failed')) return 'offline';
  if (key.startsWith('label.paused')) return 'paused';
  if (key.startsWith('label.printing') || key.startsWith('label.stage') || key.startsWith('label.prepare') || key === 'label.changingFilament') return 'printing';
  return 'online';
}
// 类别 → 简短状态文案（详细数字交给统计行，避免胶囊过长换行）。
function shortStatus(cls, p) {
  switch (cls) {
    case 'printing': return t('settings.statusPrinting');
    case 'online': return t('settings.statusOnline');
    case 'offline': return t('settings.statusOffline');
    case 'paused': return t('printers.paused');
    case 'connecting': return t('printers.connecting');
    default: return p && p.hasCloud ? t('settings.statusUnknown') : t('settings.statusNotConnected');
  }
}
// 源标识：图标 + 文案
function sourceChip(source, srcText) {
  const icon = source === 'lan' ? '🏠' : '☁️';
  return '<span class="src-chip">' + icon + ' ' + escapeHtml(srcText[source] || source) + '</span>';
}

// 切换当前打印机后，实时状态需要几秒才连上 —— 期间显示「连接中…」而非误报离线。
let connectingSerial = null;
let connectingUntil = 0;
function markConnecting(serial) {
  connectingSerial = serial; connectingUntil = Date.now() + 5000;
  setTimeout(() => { if (Date.now() >= connectingUntil) renderPrinters(); }, 5200);
}
function isConnecting(serial) { return serial === connectingSerial && Date.now() < connectingUntil; }

function fmtMin(m) { if (m < 60) return m + 'm'; const h = Math.floor(m / 60), mm = m % 60; return mm ? h + 'h' + mm + 'm' : h + 'h'; }
function buildStats(live) {
  const tp = (live && live.temps) || {}; const pr = (live && live.progress) || {};
  const items = [];
  if (Number.isFinite(pr.percent) && pr.percent > 0) {
    const layer = (Number.isFinite(pr.layer) && Number.isFinite(pr.total) && pr.total > 0) ? ' · ' + pr.layer + '/' + pr.total : '';
    items.push('<span class="pcard-stat">📊 ' + pr.percent + '%' + layer + '</span>');
  }
  if (Number.isFinite(tp.nozzleTemp)) items.push('<span class="pcard-stat">🌡️ ' + tp.nozzleTemp + '°</span>');
  if (Number.isFinite(tp.bedTemp)) items.push('<span class="pcard-stat">🛏️ ' + tp.bedTemp + '°</span>');
  if (Number.isFinite(tp.remainingTime) && tp.remainingTime > 0) items.push('<span class="pcard-stat">⏱️ ' + escapeHtml(fmtMin(tp.remainingTime)) + '</span>');
  return items.length ? '<div class="pcard-stats">' + items.join('') + '</div>' : '';
}
// 决定状态胶囊：用简短文案（数字在统计行）；切换中且未拿到「好」状态显示连接中。
function pickStatus(p, isActive, live) {
  let cls = (isActive && live && live.key) ? liveCls(live.key) : connCls(p);
  if (isActive && (cls === 'offline' || cls === 'unknown') && isConnecting(p.serial)) cls = 'connecting';
  return { cls, text: shortStatus(cls, p) };
}

async function renderPrinters() {
  if (!localeStrings) await loadLocales();
  let st = {};
  try { st = (await window.bambu.getStoredState()) || {}; } catch (e) { /* ignore */ }
  const r = await window.bambu.listPrinters();
  const { printers, activeSerial } = r;
  const live = { key: r.liveLabelKey, params: r.liveLabelParams, temps: r.liveTemps, progress: r.liveProgress };
  const srcText = { cloud: t('settings.srcCloud'), lan: t('settings.srcLan'), both: t('settings.srcBoth') };

  // 目标卡片描述（含末尾账号卡 + 添加本地卡）
  const desired = printers.map((p) => ({ key: p.serial, type: 'printer', p, isActive: p.serial === activeSerial }));
  desired.push({ key: '__account', type: 'account' });
  desired.push({ key: '__lan', type: 'lan' });

  const track = el('carTrack');
  const existing = new Map([...track.children].map((c) => [c.dataset.key, c]));
  const order = [];
  let activeIdx = -1;
  desired.forEach((d, i) => {
    let card = existing.get(d.key);
    if (d.type === 'printer') {
      if (d.isActive) activeIdx = i;
      if (!card || card.dataset.model !== (d.p.model || '')) card = buildPrinterCard(d.p);
      fillPrinterCard(card, d.p, d.isActive, srcText, live);   // 原位更新，避免重建闪烁/重置动画
    } else if (d.type === 'account') {
      const sig = 'acct:' + (st && st.hasToken ? 'in:' + (st.account || '') + ':' + (st.region || '') : 'out');
      if (!card || card.dataset.sig !== sig) { card = buildAccountCard(st); card.dataset.key = '__account'; card.dataset.sig = sig; }
    } else { // lan
      if (!card) { card = buildLanCard(); card.dataset.key = '__lan'; }
    }
    order.push(card);
  });
  // 移除多余、按目标顺序排列（保留已有节点，不整体重建）
  [...track.children].forEach((c) => { if (!order.includes(c)) c.remove(); });
  order.forEach((c, i) => { if (track.children[i] !== c) track.insertBefore(c, track.children[i] || null); });

  carCount = order.length;
  if (!carInitialized) { carIndex = activeIdx >= 0 ? activeIdx : 0; carInitialized = true; }
  carIndex = Math.max(0, Math.min(carCount - 1, carIndex));
  buildDots();
  wireCarouselOnce();
  layoutCarousel();
}

// 创建打印机卡骨架（仅一次）：照片浮层固定，动态内容由 fillPrinterCard 填充。
function buildPrinterCard(p) {
  const card = document.createElement('div');
  card.className = 'pcard';
  card.dataset.key = p.serial; card.dataset.serial = p.serial; card.dataset.model = p.model || '';
  card.innerHTML =
    '<div class="pcard-frame">' +
      '<div class="pcard-photo"></div>' +
      '<div class="pcard-body"></div>' +
      '<div class="pcard-actions"></div>' +
    '</div>' +
    '<div class="pcard-pop"></div>';
  const img = printerImage(p.model);
  card.querySelector('.pcard-pop').innerHTML = img
    ? '<img class="pcard-img" src="' + img + '" alt="" draggable="false" />'
    : '<div class="pcard-img pcard-img-fallback">🖨️</div>';
  return card;
}

// 原位填充/更新动态内容（状态、操作、统计等）——重用同一 DOM，避免切换/轮询闪烁。
function fillPrinterCard(card, p, isActive, srcText, live) {
  card.dataset.serial = p.serial;
  card.classList.toggle('is-current', isActive);
  const status = pickStatus(p, isActive, live);
  card.querySelector('.pcard-frame').className = 'pcard-frame pcard-status-' + status.cls;
  card.querySelector('.pcard-body').innerHTML =
    '<div class="pcard-namerow">' +
      '<span class="pcard-name">' + escapeHtml(p.name) + '</span>' +
      '<button class="pc-act-rename" title="' + escapeHtml(t('settings.rename')) + '" aria-label="' + escapeHtml(t('settings.rename')) + '">' + RENAME_ICON + '</button>' +
    '</div>' +
    '<div class="pcard-sub">' + escapeHtml(p.model || t('printers.lanPrinter')) + '</div>' +
    '<div class="pcard-chips">' +
      '<span class="status-chip ' + status.cls + '"><span class="sdot"></span>' + escapeHtml(status.text) + '</span>' +
      sourceChip(p.source, srcText) +
    '</div>' +
    (isActive ? buildStats(live) : '') +
    '<div class="pcard-serial">' + escapeHtml(p.serial) + '</div>';
  card.querySelector('.pc-act-rename').addEventListener('click', (e) => { e.stopPropagation(); startRename(p.serial, card, p.name); });
  const actions = card.querySelector('.pcard-actions');
  // 「当前」表达在主按钮上：当前打印机显示「已是当前」（禁用），否则「设为当前」（可点）
  actions.innerHTML =
    (isActive
      ? '<div class="pc-current">✓ ' + escapeHtml(t('printers.isCurrent')) + '</div>'
      : '<button class="btn pc-act-use">' + escapeHtml(t('settings.setActive')) + '</button>') +
    (p.hasLan ? '<button class="btn btn-danger pc-act-remove">' + escapeHtml(t('settings.remove')) + '</button>' : '');
  const use = actions.querySelector('.pc-act-use');
  if (use) use.addEventListener('click', async (e) => { e.stopPropagation(); markConnecting(p.serial); await window.bambu.setActivePrinter(p.serial); renderPrinters(); });
  const rm = actions.querySelector('.pc-act-remove');
  if (rm) rm.addEventListener('click', async (e) => { e.stopPropagation(); await window.bambu.removeLanPrinter(p.serial); renderPrinters(); });
}

function startRename(serial, card, cur) {
  const nameEl = card.querySelector('.pcard-name');
  nameEl.innerHTML = '<input type="text" class="pc-rename-input" />';
  const input = nameEl.querySelector('.pc-rename-input');
  input.value = cur; input.focus(); input.select();
  let done = false;
  const save = async () => { if (done) return; done = true; const v = input.value.trim(); if (v && v !== cur) await window.bambu.renamePrinter(serial, v); renderPrinters(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { done = true; renderPrinters(); } });
  input.addEventListener('blur', save);
}

// 账号卡：未登录 → 云账号登录（含验证码）；已登录 → 账号信息 + 退出登录
function buildAccountCard(st) {
  const card = document.createElement('div');
  card.className = 'pcard pcard-util';
  let body;
  if (st && st.hasToken) {
    const rl = { global: t('settings.regionGlobalFull'), china: t('settings.regionChinaFull') };
    const who = st.account || st.activePrinter || '—';
    const region = rl[st.region] || st.region || '';
    body =
      '<p class="util-status"><span class="acct-dot"></span>' + escapeHtml(t('printers.acctLoggedIn')) + '</p>' +
      '<div class="util-kv"><span class="util-k">' + escapeHtml(t('settings.account')) + '</span><span class="util-v">' + escapeHtml(who) + '</span></div>' +
      (region ? '<div class="util-kv"><span class="util-k">' + escapeHtml(t('settings.region')) + '</span><span class="util-v">' + escapeHtml(region) + '</span></div>' : '') +
      '<button class="btn btn-danger ac-logout">' + escapeHtml(t('settings.logout')) + '</button>';
  } else {
    body =
      '<p class="add-note">' + escapeHtml(t('printers.loginIntro')) + '</p>' +
      '<label><span>' + escapeHtml(t('settings.region')) + '</span><select class="ac-region"><option value="global">' + escapeHtml(t('settings.regionGlobalFull')) + '</option><option value="china">' + escapeHtml(t('settings.regionChinaFull')) + '</option></select></label>' +
      '<label><span>' + escapeHtml(t('settings.account')) + '</span><input class="ac-account" type="text" autocomplete="username" /></label>' +
      '<label><span>' + escapeHtml(t('settings.password')) + '</span><input class="ac-password" type="password" autocomplete="current-password" /></label>' +
      '<button class="btn btn-primary ac-login">' + escapeHtml(t('settings.login')) + '</button>' +
      '<div class="ac-verify hidden">' +
        '<p class="add-note">' + escapeHtml(t('settings.verifyHint')) + '</p>' +
        '<label><span>' + escapeHtml(t('settings.verifyCode')) + '</span><input class="ac-code" type="text" inputmode="numeric" /></label>' +
        '<button class="btn btn-primary ac-verifybtn">' + escapeHtml(t('settings.submit')) + '</button>' +
      '</div>';
  }
  card.innerHTML =
    '<div class="pcard-frame"><div class="util-inner">' +
      '<div class="util-icon">☁️</div>' +
      '<div class="util-title">' + escapeHtml(t('printers.accountTitle')) + '</div>' +
      body +
    '</div></div>';
  wireAccountCard(card);
  attachTilt(card);
  return card;
}

function wireAccountCard(card) {
  const logout = card.querySelector('.ac-logout');
  if (logout) logout.addEventListener('click', async (e) => { e.stopPropagation(); await window.bambu.logout(); renderPrinters(); });
  const loginBtn = card.querySelector('.ac-login');
  if (loginBtn) loginBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); clearError();
    pending.region = card.querySelector('.ac-region').value;
    pending.account = card.querySelector('.ac-account').value.trim();
    pending.password = card.querySelector('.ac-password').value;
    setBusy(true);
    const r = await window.bambu.submitCredentials(pending.region, pending.account, pending.password);
    setBusy(false);
    if (r.needsVerify) { pending.tfaKey = r.tfaKey; card.querySelector('.ac-verify').classList.remove('hidden'); card.querySelector('.ac-code').focus(); return; }
    if (r.ok) { await afterLogin(); return; }
    showError(r.error || t('settings.errLoginFailed'));
  });
  const verifyBtn = card.querySelector('.ac-verifybtn');
  if (verifyBtn) verifyBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); clearError();
    const code = card.querySelector('.ac-code').value.trim();
    if (!code) { showError(t('settings.errVerifyRequired')); return; }
    setBusy(true);
    const r = await window.bambu.submitVerifyCode(pending.region, pending.account, pending.password, pending.tfaKey, code);
    setBusy(false);
    if (r.ok) { await afterLogin(); return; }
    showError(r.error || t('settings.errVerifyInvalid'));
  });
}

// 添加本地打印机卡（仅局域网）
function buildLanCard() {
  const card = document.createElement('div');
  card.className = 'pcard pcard-util';
  card.innerHTML =
    '<div class="pcard-frame"><div class="util-inner">' +
      '<div class="util-icon">🏠</div>' +
      '<div class="util-title">' + escapeHtml(t('settings.addLan')) + '</div>' +
      '<input class="la-host util-field" type="text" placeholder="' + escapeHtml(t('settings.lanIp')) + '（192.168.1.x）" />' +
      '<input class="la-code util-field" type="text" placeholder="' + escapeHtml(t('settings.lanCode')) + '" />' +
      '<input class="la-serial util-field" type="text" placeholder="' + escapeHtml(t('settings.lanSerial')) + '" />' +
      '<input class="la-name util-field" type="text" placeholder="' + escapeHtml(t('settings.nameOptional')) + '" />' +
      '<button class="btn btn-primary la-add">' + escapeHtml(t('settings.addAndConnect')) + '</button>' +
      '<p class="add-msg"></p>' +
    '</div></div>';
  const lanBtn = card.querySelector('.la-add');
  lanBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const host = card.querySelector('.la-host').value.trim();
    const code = card.querySelector('.la-code').value.trim();
    const serial = card.querySelector('.la-serial').value.trim();
    const name = card.querySelector('.la-name').value.trim();
    const msg = card.querySelector('.add-msg'); msg.textContent = '…';
    const r = await window.bambu.addLanPrinter(host, code, serial, name);
    if (r.ok) { msg.textContent = t('settings.connSuccess'); renderPrinters(); }
    else msg.textContent = r.error || t('settings.errLanFailed');
  });
  attachTilt(card);
  return card;
}

// 登录成功：拉取云端设备并入统一列表，刷新整页。
async function afterLogin() {
  setBusy(true);
  await window.bambu.completeCloudLogin();
  setBusy(false);
  renderPrinters();
}

// ── 轮播布局 / 导航 ──
function cardMetrics() {
  // 用 offsetWidth（布局宽度，不含 transform 缩放）——否则缩小的两侧卡会让步长算错，
  // 导致只有前一两张能居中。
  const first = el('carTrack').firstElementChild;
  const w = first ? first.offsetWidth : 216;
  const gap = 20;
  return { w, step: w + gap };
}
function layoutCarousel() {
  const track = el('carTrack');
  const cards = Array.from(track.children);
  if (!cards.length) return;
  const { w, step } = cardMetrics();
  const vw = el('carViewport').clientWidth;
  track.style.transform = 'translateX(' + (vw / 2 - (carIndex * step + w / 2)) + 'px)';
  cards.forEach((c, i) => {
    c.classList.toggle('is-active', i === carIndex);
    c.classList.toggle('is-far', Math.abs(i - carIndex) >= 2);
  });
  updateDots();
  el('carPrev').disabled = carIndex <= 0;
  el('carNext').disabled = carIndex >= carCount - 1;
}
function setIndex(i) { carIndex = Math.max(0, Math.min(carCount - 1, i)); layoutCarousel(); }
function buildDots() {
  const dots = el('carDots'); dots.innerHTML = '';
  for (let i = 0; i < carCount; i++) {
    const d = document.createElement('button');
    d.className = 'cdot'; d.addEventListener('click', () => setIndex(i));
    dots.appendChild(d);
  }
}
function updateDots() {
  Array.from(el('carDots').children).forEach((d, i) => d.classList.toggle('active', i === carIndex));
}
function wireCarouselOnce() {
  if (carouselWired) return; carouselWired = true;
  el('carPrev').addEventListener('click', () => setIndex(carIndex - 1));
  el('carNext').addEventListener('click', () => setIndex(carIndex + 1));
  const vp = el('carViewport');
  // 触摸板横向滑动
  let wheelLock = false;
  vp.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    if (wheelLock || Math.abs(e.deltaX) < 12) return;
    wheelLock = true; setTimeout(() => { wheelLock = false; }, 380);
    setIndex(carIndex + (e.deltaX > 0 ? 1 : -1));
  }, { passive: false });
  // 拖拽 / 滑动
  let dragX = null, movedDuringDrag = false;
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input,select,textarea,button,a')) return;
    dragX = e.clientX; movedDuringDrag = false;
  });
  vp.addEventListener('pointermove', (e) => { if (dragX != null && Math.abs(e.clientX - dragX) > 6) movedDuringDrag = true; });
  vp.addEventListener('pointerup', (e) => {
    if (dragX == null) return;
    const dx = e.clientX - dragX; dragX = null;
    if (Math.abs(dx) > 50) setIndex(carIndex + (dx < 0 ? 1 : -1));
  });
  vp.addEventListener('pointercancel', () => { dragX = null; });
  window.addEventListener('resize', layoutCarousel);
  // 方向键（仅打印机页可见时）
  document.addEventListener('keydown', (e) => {
    const sec = document.querySelector('.section[data-section="printers"]');
    if (!sec || sec.classList.contains('hidden')) return;
    if (e.target.matches('input,select,textarea')) return;
    if (e.key === 'ArrowLeft') setIndex(carIndex - 1);
    else if (e.key === 'ArrowRight') setIndex(carIndex + 1);
  });
}

// hover 倾斜/视差已移除（用户反馈妨碍观察）；保留空函数以兼容调用点。
function attachTilt() { /* no-op */ }

window.bambu.onError((msg) => { showError(msg || t('settings.errAuthExpired')); renderPrinters(); });
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

// ── 把玩探索：抽卡 ──
// 场景表（与 src/config/play-scenarios.js 一致）。printing 拆成 0/25/50/75 四档，各自独立可抽。
// 文案走 locale：play.<id>.name/.desc；printing 档用 play.printing.progressLabel。
// rarity: common(1★) / rare(2★) / epic(3★) —— 仅用于抽卡的趣味呈现
const PLAY_SCENARIOS = [
  { id: 'printing_0',  scenario: 'printing', progress: 0,  icon: '🖨️', rarity: 'common' },
  { id: 'printing_25', scenario: 'printing', progress: 25, icon: '🖨️', rarity: 'common' },
  { id: 'printing_50', scenario: 'printing', progress: 50, icon: '🖨️', rarity: 'common' },
  { id: 'printing_75', scenario: 'printing', progress: 75, icon: '🖨️', rarity: 'common' },
  { id: 'idle',              scenario: 'idle',              icon: '😴', rarity: 'common' },
  { id: 'prepare_leveling',  scenario: 'prepare_leveling',  icon: '📐', rarity: 'common' },
  { id: 'changing_filament', scenario: 'changing_filament', icon: '🔄', rarity: 'rare' },
  { id: 'paused',            scenario: 'paused',            icon: '⏸️', rarity: 'rare' },
  { id: 'finished',          scenario: 'finished',          icon: '🎉', rarity: 'epic' },
  { id: 'failed',            scenario: 'failed',            icon: '😢', rarity: 'rare' },
  { id: 'offline',           scenario: 'offline',           icon: '🔌', rarity: 'common' },
];
const RARITY_STARS = { common: 1, rare: 2, epic: 3 };
let playGalleryBuilt = false;
let applying = false;   // 正在向主进程下发状态：期间忽略回推，避免中间帧闪烁

function playLabel(e) {
  return e.scenario === 'printing'
    ? t('play.printing.progressLabel', { p: e.progress })
    : t('play.' + e.id + '.name');
}
function playDesc(e) {
  return t('play.' + (e.scenario === 'printing' ? 'printing' : e.id) + '.desc');
}
function findEntry(st) {
  return PLAY_SCENARIOS.find((e) =>
    e.scenario === st.currentScenario &&
    (e.scenario !== 'printing' || (e.progress || 0) === (st.percent || 0)));
}
function setCard(e) {
  const card = el('gachaCard');
  el('gachaIcon').textContent = e ? e.icon : '🃏';
  el('gachaName').textContent = e ? playLabel(e) : t('play.cardBack');
  const rarity = e ? (e.rarity || 'common') : 'common';
  card.classList.remove('r-common', 'r-rare', 'r-epic');
  card.classList.add('r-' + rarity);
  el('gachaRarity').textContent = e ? '★'.repeat(RARITY_STARS[rarity] || 1) : '';
}
function spawnSparkles(card) {
  for (let i = 0; i < 9; i++) {
    const s = document.createElement('span');
    s.className = 'gacha-spark'; s.textContent = i % 2 ? '✨' : '⭐';
    const ang = Math.random() * Math.PI * 2, dist = 42 + Math.random() * 46;
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    card.appendChild(s); setTimeout(() => s.remove(), 950);
  }
}
async function applyEntry(e) {
  applying = true;
  try {
    await window.bambu.playSetScenario(e.scenario);
    if (e.scenario === 'printing') await window.bambu.playSetProgress(e.progress);
  } finally {
    applying = false;
  }
  // 下发完成后用最终态刷新一次，避免 printing 两段 IPC 之间的中间帧
  renderPlayState({ isPlaying: true, currentScenario: e.scenario, percent: e.progress || 0 });
}

function buildGallery() {
  const box = el('playGallery'); box.innerHTML = '';
  for (const e of PLAY_SCENARIOS) {
    const card = document.createElement('button');
    card.className = 'play-card'; card.dataset.id = e.id;
    card.innerHTML = '<div class="pname">' + e.icon + ' ' + escapeHtml(playLabel(e)) + '</div>' +
      '<div class="pdesc">' + escapeHtml(playDesc(e)) + '</div>';
    card.addEventListener('click', () => { applyEntry(e); });
    box.appendChild(card);
  }
  playGalleryBuilt = true;
}

function renderPlayState(st) {
  // st: { isPlaying, currentScenario, percent }
  const e = findEntry(st);
  const card = el('gachaCard');
  if (st.isPlaying && e) {
    el('gachaCap').textContent = t('play.nowPlaying');
    setCard(e);
    card.classList.add('revealed');
  } else {
    el('gachaCap').textContent = t('play.inLiveMode');
    setCard(null);
    card.classList.remove('revealed');
  }
  document.querySelectorAll('.play-card').forEach((c) => c.classList.toggle('active', st.isPlaying && e && c.dataset.id === e.id));
}

async function initPlay() {
  if (!localeStrings) await loadLocales();
  if (!playGalleryBuilt) buildGallery();
  const st = await window.bambu.playGetState();
  renderPlayState(st);
}

// 抽卡：卡牌内容快速轮播（easeOut 减速），定格后只下发一次到熊猫
function drawGacha() {
  if (applying) return;
  applying = true;
  const btn = el('drawBtn'); btn.disabled = true;
  const card = el('gachaCard'); card.classList.add('spinning');
  const final = PLAY_SCENARIOS[Math.floor(Math.random() * PLAY_SCENARIOS.length)];
  const TICKS = 16;
  let i = 0;
  const tick = () => {
    if (i < TICKS) {
      const r = PLAY_SCENARIOS[Math.floor(Math.random() * PLAY_SCENARIOS.length)];
      setCard(r);
      i += 1;
      const p = i / TICKS;                 // easeOutCubic：间隔 55ms → ~220ms
      setTimeout(tick, 55 + 165 * (p * p));
    } else {
      setCard(final);
      card.classList.remove('spinning');
      // 揭晓动效：翻牌弹出 + 全息扫光 + 稀有度光晕
      card.classList.remove('pop', 'shine', 'revealed'); void card.offsetWidth;
      card.classList.add('pop', 'shine', 'revealed');
      setTimeout(() => card.classList.remove('pop', 'shine'), 900);
      if ((final.rarity || 'common') === 'epic') spawnSparkles(card);
      // applyEntry 内部会管理 applying 并在末尾 renderPlayState(final)
      applying = false;
      applyEntry(final).then(() => { btn.disabled = false; });
    }
  };
  tick();
}
el('drawBtn').addEventListener('click', drawGacha);
el('gachaCard').addEventListener('click', drawGacha);  // 点卡面也能抽

// 折叠「全部状态」
el('allStatesToggle').addEventListener('click', () => {
  const toggle = el('allStatesToggle');
  const open = toggle.classList.toggle('open');
  el('playGallery').classList.toggle('hidden', !open);
});

// 回到真机
el('playReturnBtn').addEventListener('click', () => { window.bambu.playReturnToLive(); });
// 主进程推送把玩状态变化（下发过程中忽略，避免中间帧）
window.bambu.onPlayStateChanged((st) => { if (!applying) renderPlayState(st); });

// ── 启动：默认进入打印机区域 ──
// 初始子页面：由窗口创建时的 hash 决定（如 #play），默认打印机
const INITIAL_SECTION = KNOWN_SECTIONS.includes((location.hash || '').slice(1)) ? location.hash.slice(1) : 'printers';
(async function start() { await loadLocales(); switchSection(INITIAL_SECTION); })();
