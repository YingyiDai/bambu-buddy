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
// ⚠️ 未经真机验证：2FA/邮箱验证码完成端点与 body 结构为推测（带 code 复用登录端点）。
//    海外区密码 + 2FA 登录路径尚未对真实账号验证过；若失败，对照 pybambu 修正此处。
const TFA_PATH = '/v1/user-service/user/login';
const DEVICE_LIST_PATH = '/v1/iot-service/api/user/bind';

// 短信验证码登录（中国区）。host/path 与登录端点不同：
//   host 是 bambulab.cn（无 api. 子域），path 带 /api/ 前缀。
// 与 pybambu const.py 的 BambuUrl.SMS_CODE 逐字一致：
//   'https://bambulab.cn/api/v1/user-service/user/sendsmscode'
const SMS_CODE_HOST = 'bambulab.cn';
const SMS_CODE_PATH = '/api/v1/user-service/user/sendsmscode';

// Bambu 云 API 认「官方切片客户端」的请求头，否则（尤其 bambulab.cn 的
// Cloudflare 前置 + 服务端 X-BBL-* 校验）会以 4xx 拒绝——表现为「手机号无效或
// 发送失败」。值与 pybambu bambu_cloud.py `_get_headers()` 对齐（伪装成
// OrcaSlicer 切片器）。缺这组头是短信/密码登录被拒的根因。
//    ⚠️ 不带 Accept-Encoding：一旦声明 gzip，服务端会压缩响应，而下方按纯文本
//       JSON.parse 无法解压。省略即请求 identity，保持解析正确。
const BAMBU_HEADERS = {
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '01.09.05.51',
  'X-BBL-Language': 'en-US',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-OS-Version': '6.2.0',
  'X-BBL-Agent-Version': '01.09.05.01',
  'X-BBL-Executable-info': '{}',
  'X-BBL-Agent-OS-Type': 'linux',
  Accept: 'application/json',
};

// HTTPS JSON 请求（共用）。失败 reject(Error)，由调用方捕获归一化。
function httpsJson(host, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host, path, method,
        headers: {
          ...BAMBU_HEADERS,
          'Content-Type': 'application/json',
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
 * 请求短信验证码（中国区无密码登录第一步）。
 * 命中 bambulab.cn/api/v1/.../sendsmscode，body {phone, type:'codeLogin'}——不需密码、不需鉴权。
 * 服务端响应可能含 tfaKey；若有，loginWithCode 需带回。
 * 返回 {ok:true, tfaKey?} | {ok:false, error}
 */
async function requestSmsCode(region, phone) {
  if (!phone) return { ok: false, error: '请输入手机号' };
  try {
    const res = await httpsJson(SMS_CODE_HOST, SMS_CODE_PATH, 'POST', { phone, type: 'codeLogin' });
    return { ok: true, tfaKey: res && res.tfaKey };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/HTTP 429/.test(msg)) return { ok: false, error: '验证码发送过于频繁，请稍后再试' };
    if (/HTTP 4\d\d/.test(msg)) return { ok: false, error: '手机号无效或发送失败' };
    return { ok: false, error: humanizeError(e) };
  }
}

/**
 * 用短信验证码换 token（中国区无密码登录第二步）。
 * 命中登录端点，body {account, code[, tfaKey]}——不带 password（与 pybambu
 * _get_authentication_token_with_verification_code 一致）。
 * 中国区 token 不透明，uid 缺失时回退 getUid 拉取。
 * 返回 {ok:true, token, uid, account} | {ok:false, error}
 */
async function loginWithCode(region, account, code, tfaKey) {
  if (!account || !code) return { ok: false, error: '请输入手机号和验证码' };
  try {
    const body = { account, code };
    if (tfaKey) body.tfaKey = tfaKey;
    const res = await httpsJson(regionOf(region).api, LOGIN_PATH, 'POST', body);
    if (!res.accessToken) return { ok: false, error: res.message || '验证码无效' };
    let uid = res.uid || decodeUidFromToken(res.accessToken);
    if (!uid) {
      const u = await getUid(region, res.accessToken);
      if (u.ok) uid = u.uid;
    }
    return { ok: true, token: res.accessToken, uid, account };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/HTTP 4\d\d/.test(msg)) return { ok: false, error: '验证码错误或已过期' };
    return { ok: false, error: humanizeError(e) };
  }
}

/**
 * 拉取账号绑定的设备列表。
 * 返回 {ok:true, devices:[{serial,name,model,online,printStatus}]} | {ok:false, error}
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
      // 优先用对外产品名（X2D/P2S），而非内部型号代号（N6-V2/N7-V2）
      model: d.dev_product_name || d.dev_model_name || '',
      online: !!d.online,
      printStatus: d.print_status || null,
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
  requestSmsCode,
  loginWithCode,
  listDevices,
};
