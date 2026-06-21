// Bambu Cloud 鉴权模块（纯逻辑，不依赖 Electron）。
// ⚠️ 非官方/逆向接口，字段与登录流程以 pybambu 为事实来源
//    (greghesp/ha-bambulab → custom_components/bambu_lab/pybambu)。
//
// 被 BambuCloudDataSource（bambu-mqtt.js）与设置窗（main.js IPC）共用，
// 保证"登录换 token / 设备列表"只有一条事实路径。
//
// 所有方法返回归一化结果对象 {ok, ...}，不抛异常——便于跨 IPC 边界传递。

const https = require('https');

// 区域 → API host / MQTT host
const REGIONS = {
  global: { api: 'api.bambulab.com', mqtt: 'us.mqtt.bambulab.com' },
  china: { api: 'api.bambulab.cn', mqtt: 'cn.mqtt.bambulab.com' },
};

// 端点常量：实现后若与 pybambu 不符，单点修正。
const LOGIN_PATH = '/v1/user-service/user/login';
const TFA_PATH = '/v1/user-service/user/login'; // 2FA/验证码完成：带 code 复用登录端点（待核实）
const DEVICE_LIST_PATH = '/v1/iot-service/api/user/bind';

// HTTPS JSON 请求（共用）。失败 reject(Error)，由调用方捕获归一化。
function httpsJson(host, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host, path, method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'bambu-desktop-pet/0.1',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try {
            const parsed = chunks ? JSON.parse(chunks) : {};
            if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
            else resolve(parsed);
          } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 从 JWT 粗略取 uid（pybambu 即如此处理）
function decodeUidFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.username || payload.sub || payload.uid;
  } catch { return undefined; }
}

function regionOf(region) {
  return REGIONS[region] || REGIONS.global;
}

/**
 * 账号密码登录换 token。
 * 返回 {ok:true, token, uid} | {ok:false, needsVerify:true, tfaKey} | {ok:false, error}
 */
async function login(region, account, password) {
  if (!account || !password) return { ok: false, error: '请输入账号和密码' };
  try {
    const res = await httpsJson(regionOf(region).api, LOGIN_PATH, 'POST', {
      account,
      password,
    });
    // 需要邮箱验证码 / 2FA：带上 tfaKey 由设置窗补充后重试
    if (res.loginType === 'verifyCode' || res.tfaKey) {
      return { ok: false, needsVerify: true, tfaKey: res.tfaKey, raw: res };
    }
    if (!res.accessToken) return { ok: false, error: '登录响应缺少 token' };
    return { ok: true, token: res.accessToken, uid: res.uid || decodeUidFromToken(res.accessToken), account };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}

/**
 * 提交验证码 / 2FA 完成登录。
 * 返回 {ok:true, token, uid} | {ok:false, error}
 */
async function sendVerifyCode(region, account, password, tfaKey, code) {
  try {
    // 待核实：pybambu 用带 code 字段复用登录端点；若实际为独立 /tfa 端点，改 TFA_PATH 即可。
    const res = await httpsJson(regionOf(region).api, TFA_PATH, 'POST', {
      account,
      password,
      tfaKey,
      code,
    });
    if (!res.accessToken) return { ok: false, error: res.message || '验证码无效' };
    return { ok: true, token: res.accessToken, uid: res.uid || decodeUidFromToken(res.accessToken), account };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}

/**
 * 拉取账号绑定的设备列表。
 * 返回 {ok:true, devices:[{serial,name,model,online}]} | {ok:false, error}
 */
async function listDevices(region, token) {
  if (!token) return { ok: false, error: '未登录' };
  try {
    const res = await httpsJson(regionOf(region).api, DEVICE_LIST_PATH, 'GET', null, {
      Authorization: `Bearer ${token}`,
    });
    const list = Array.isArray(res.devices) ? res.devices : [];
    const devices = list.map((d) => ({
      serial: d.dev_id,
      name: d.name || d.dev_id,
      model: d.dev_model_name || d.dev_product_name || '',
      online: !!d.online,
    })).filter((d) => d.serial);
    return { ok: true, devices };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}

/**
 * 取当前账号的数字 uid（MQTT 用户名 u_<uid> 需要它）。
 * 国际区 token 是 JWT、可本地解析；中国区 token 不透明，必须走此接口。
 * 端点 /v1/design-user-service/my/preference 两区都返回 { uid, handle, ... }。
 * 返回 {ok:true, uid} | {ok:false, error}
 */
async function getUid(region, token) {
  if (!token) return { ok: false, error: '未登录' };
  try {
    const res = await httpsJson(
      regionOf(region).api,
      '/v1/design-user-service/my/preference',
      'GET', null, { Authorization: `Bearer ${token}` },
    );
    if (res && res.uid != null) return { ok: true, uid: res.uid };
    return { ok: false, error: '响应缺少 uid' };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}

// 把底层错误转成面向用户的中文提示
function humanizeError(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/HTTP 401|HTTP 403/.test(msg)) return '账号或密码错误';
  if (/HTTP 4/.test(msg)) return `请求失败：${msg}`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(msg)) return '网络连接失败，请检查网络';
  return msg;
}

module.exports = {
  REGIONS,
  httpsJson,
  decodeUidFromToken,
  getUid,
  login,
  sendVerifyCode,
  listDevices,
};
