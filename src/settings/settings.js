// Bambu 连接设置窗：Cloud/LAN 双模式状态机。
// 依赖 preload-settings.js 暴露的 window.bambu（contextBridge）。

const REGION_LABELS = { global: '全球 / Overseas', china: '中国大陆' };

const el = (id) => document.getElementById(id);

// Cloud 登录中间态：验证码 / 已换到的 token（不持久化，仅本次会话）
const pending = { region: 'global', account: '', password: '', tfaKey: null };

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
    el(`cloud${s}`).classList.toggle('hidden', s.toLowerCase() !== step);
  }
  clearError();
}

function showError(msg) {
  const e = el('err');
  e.textContent = msg || '';
  e.classList.toggle('hidden', !msg);
}
function clearError() {
  const e = el('err');
  e.textContent = '';
  e.classList.add('hidden');
}

// ---- 初始化：回读已存配置 ----
async function init() {
  try {
    const st = await window.bambu.getStoredState();
    if (st.mode === 'lan' && st.host) {
      setMode('lan');
      el('lanHost').value = st.host || '';
      el('lanSerial').value = st.serial || '';
      return;
    }
    if (st.mode === 'cloud' && st.hasToken && st.serial) {
      // 已登录 → 摘要
      pending.region = st.region || 'global';
      el('sumName').textContent = st.name || st.serial;
      el('sumSerial').textContent = st.serial;
      el('sumRegion').textContent = REGION_LABELS[st.region] || st.region || '—';
      setCloudStep('summary');
      return;
    }
  } catch (e) {
    /* 忽略，停留在默认登录步 */
  }
  setCloudStep('login');
}

// ---- Cloud: 登录 ----
el('cloudLoginBtn').addEventListener('click', async () => {
  clearError();
  pending.region = el('cloudRegion').value;
  pending.account = el('cloudAccount').value.trim();
  pending.password = el('cloudPassword').value;
  setBusy(true);
  const r = await window.bambu.submitCredentials(pending.region, pending.account, pending.password);
  setBusy(false);
  if (r.needsVerify) {
    pending.tfaKey = r.tfaKey;
    setCloudStep('verify');
    el('cloudCode').focus();
    return;
  }
  if (r.ok) {
    await showDevices();
    return;
  }
  showError(r.error || '登录失败');
});

// ---- Cloud: 提交验证码 ----
el('cloudVerifyBtn').addEventListener('click', async () => {
  clearError();
  const code = el('cloudCode').value.trim();
  if (!code) { showError('请输入验证码'); return; }
  setBusy(true);
  const r = await window.bambu.submitVerifyCode(pending.region, pending.account, pending.password, pending.tfaKey, code);
  setBusy(false);
  if (r.ok) {
    await showDevices();
    return;
  }
  showError(r.error || '验证码无效');
});

el('cloudVerifyBack').addEventListener('click', () => {
  pending.tfaKey = null;
  el('cloudCode').value = '';
  setCloudStep('login');
});

el('cloudDevicesBack').addEventListener('click', () => {
  setCloudStep('login');
});

// ---- Cloud: 设备列表 ----
async function showDevices() {
  setBusy(true);
  const r = await window.bambu.listDevices();
  setBusy(false);
  if (!r.ok) { showError(r.error || '获取设备列表失败'); return; }
  const list = el('deviceList');
  list.innerHTML = '';
  if (!r.devices.length) {
    el('noDevices').classList.remove('hidden');
    setCloudStep('devices');
    return;
  }
  el('noDevices').classList.add('hidden');
  for (const d of r.devices) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="d-name">${escapeHtml(d.name)}</div>` +
      `<div class="d-meta ${d.online ? '' : 'offline'}">${escapeHtml(d.model || '')} · ${d.serial} · ${d.online ? '在线' : '离线'}</div>`;
    li.addEventListener('click', () => saveDevice(d.serial, d.name));
    list.appendChild(li);
  }
  setCloudStep('devices');
}

async function saveDevice(serial, name) {
  setBusy(true);
  const r = await window.bambu.saveDevice(serial, name);
  setBusy(false);
  if (r.ok) {
    window.bambu.close();
    return;
  }
  showError(r.error || '保存失败');
}

// ---- Cloud: 摘要 —— 登出 / 关闭 ----
el('sumLogout').addEventListener('click', async () => {
  await window.bambu.logout();
  el('cloudAccount').value = '';
  el('cloudPassword').value = '';
  setCloudStep('login');
});
el('sumClose').addEventListener('click', () => window.bambu.close());

// ---- LAN: 测试 / 保存 ----
el('lanTestBtn').addEventListener('click', async () => {
  clearError();
  const host = el('lanHost').value.trim();
  const accessCode = el('lanAccessCode').value.trim();
  const serial = el('lanSerial').value.trim();
  if (!host || !accessCode || !serial) { showError('请填写 IP、访问码和序列号'); return; }
  setBusy(true);
  const r = await window.bambu.testLan(host, accessCode, serial);
  setBusy(false);
  if (r.ok) { showError('✓ 连接成功'); return; }
  showError(r.error || '连接失败');
});

el('lanSaveBtn').addEventListener('click', async () => {
  clearError();
  const host = el('lanHost').value.trim();
  const accessCode = el('lanAccessCode').value.trim();
  const serial = el('lanSerial').value.trim();
  if (!host || !accessCode || !serial) { showError('请填写 IP、访问码和序列号'); return; }
  setBusy(true);
  const r = await window.bambu.saveLan(host, accessCode, serial, serial);
  setBusy(false);
  if (r.ok) { window.bambu.close(); return; }
  showError(r.error || '保存失败');
});

// ---- 模式切换 ----
el('modeCloud').addEventListener('click', () => setMode('cloud'));
el('modeLan').addEventListener('click', () => setMode('lan'));

// 后台鉴权失效（如 token 过期）→ 主进程推送，回到登录步
window.bambu.onError((msg) => {
  showError(msg || '连接已失效，请重新登录');
  setCloudStep('login');
});

// ---- 工具 ----
function setBusy(busy) {
  for (const b of document.querySelectorAll('button')) b.disabled = busy;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

init();
