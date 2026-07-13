// Bambu 真机数据源（§7.2 / §7.3）。
// ⚠️ 非官方/逆向接口，字段与登录流程以 pybambu 为事实来源
//    (greghesp/ha-bambulab → custom_components/bambu_lab/pybambu)。
// 实现与 MockDataSource 相同的接口：start() / stop() / onState(cb)。
//
// 两种连接方式（对应 pybambu）：
//   BambuCloudDataSource —— 账号登录换 token → 云 MQTT
//   BambuLanDataSource   —— 本地 IP + access code 直连打印机本机 MQTT
// 报文解析二者一致 → 抽到 BambuMQTTBase 共享。

const mqtt = require('mqtt');
const auth = require('./bambu-auth');
const { REGIONS } = auth;

/**
 * LAN 探活结果分类（纯函数，便于单测）。
 * 仅在探活超时（始终未收到 report）时调用，把观测到的事件映射成精准原因码——
 * 现状是鉴权失败/序列号错误/网络不通全都报「连接超时」，误导用户排障。
 * @param {object} o
 * @param {boolean} o.gotConnect - mqtt `connect` 是否触发过（TLS+CONNACK 通过 = IP/访问码对）
 * @param {Error|{code?:string,message?:string}|null} o.error - 探活期间观测到的最后一个 mqtt 错误
 * @returns {'serial'|'auth'|'network'|'timeout'}
 */
function classifyLanProbe({ gotConnect, error }) {
  // 已连上且鉴权通过，却收不到 device/<serial>/report → 订阅的 topic 序列号多半填错。
  if (gotConnect) return 'serial';
  const msg = String((error && (error.message || error.code)) || '');
  // mqtt.js 对 CONNACK 拒绝抛「Connection refused: Bad username or password / Not authorized」。
  if (/not authoriz|bad username|bad user|password/i.test(msg)) return 'auth';
  // 主动拒绝 / 主机不可达 / DNS 解析失败 → 网络或 IP 问题。
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|ECONNRESET|getaddrinfo/i.test(msg)) return 'network';
  // 全程无事件（SYN 被静默丢弃，如路由器 AP 隔离/访客网络/跨网段）→ 泛化超时。
  return 'timeout';
}

// ── ams / vt_tray 增量深合并 ──
// 真机常规推送是增量 diff：print.ams 往往只带变化的字段（如仅 { version } 或不含
// tray_color 的 tray 条目），并非完整快照。顶层浅合并（{ ..._latest, ...print }）会让
// 这类残缺 ams 整体覆盖已合并的完整快照，tray_now / tray_color 随之丢失，
// resolveFilamentColor 返回 null → 渲染层清掉改色 overlay，打印中的熊猫闪回原始绿；
// 下一帧完整推送（或定时 pushall）到达后又恢复耗材色 —— 表现为「打印同一卷料，
// 颜色每隔几分钟白↔绿来回跳」。故 ams / vt_tray 子树需字段级深合并：
// 对象递归合并，ams.ams / tray 等对象数组按 id 逐条合并。

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 按 id 合并对象数组：patch 条目覆盖同 id 旧条目的对应字段，patch 未提及的旧条目保留。
 * 特例（对齐 pybambu AMSTray.print_update）：patch 条目只有 id 一个键 = 「该槽已空」，
 * 整条替换旧条目而非合并，避免退料后残留旧 tray_color。
 * 任一侧存在无 id 条目时不做按 id 合并，整体以 patch 为准（语义未知，宁可不猜）。
 */
function mergeArrayById(prev, patch) {
  const hasId = (e) => isPlainObject(e) && e.id != null;
  if (!prev.every(hasId) || !patch.every(hasId)) return patch;
  const out = prev.slice();
  for (const entry of patch) {
    const i = out.findIndex((e) => String(e.id) === String(entry.id));
    const emptied = Object.keys(entry).length === 1;
    if (i === -1) out.push(entry);
    else out[i] = emptied ? entry : deepMergePatch(out[i], entry);
  }
  return out;
}

/** 递归合并：对象递归、对象数组按 id 合并、其余以 patch 为准。 */
function deepMergePatch(prev, patch) {
  if (!isPlainObject(prev) || !isPlainObject(patch)) return patch;
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    const p = out[k];
    if (isPlainObject(p) && isPlainObject(v)) out[k] = deepMergePatch(p, v);
    else if (Array.isArray(p) && Array.isArray(v)) out[k] = mergeArrayById(p, v);
    else out[k] = v;
  }
  return out;
}

/**
 * 共享基类：连 MQTT、订阅 device/<serial>/report、维护合并后的 print 状态并回调。
 */
class BambuMQTTBase {
  constructor() {
    this._cb = null;
    this._client = null;
    this._latest = {}; // 维护合并后的 print 状态
    this._canceled = false; // 「本次终止是否为用户取消」的持久标记（详见 _onMessage）
    this._authFailCb = null;
    this._diagCb = null;
  }

  onState(cb) { this._cb = cb; }

  /** 鉴权/登录失败时回调（如 token 过期、登录异常），供主进程打开登录窗。 */
  onAuthFailure(cb) { this._authFailCb = cb; }

  /**
   * 连接生命周期诊断回调，供「添加本地打印机」探活区分失败原因（见 classifyLanProbe）。
   * evt: { type: 'connect' } | { type: 'error', error }
   */
  onDiagnostic(cb) { this._diagCb = cb; }
  _emitDiag(evt) { if (this._diagCb) this._diagCb(evt); }

  /** 连接 MQTT broker。tls=true 用 mqtts://，自签名证书传 rejectUnauthorized:false。 */
  _connectMqtt(host, username, password, serial, { tls = true, rejectUnauthorized = true } = {}) {
    const scheme = tls ? 'mqtts' : 'mqtt';
    const port = tls ? 8883 : 1883;
    const url = `${scheme}://${host}:${port}`;
    this._client = mqtt.connect(url, {
      username,
      password,
      reconnectPeriod: 5000,
      rejectUnauthorized,
    });

    this._client.on('connect', () => {
      this._emitDiag({ type: 'connect' });
      this._client.subscribe(`device/${serial}/report`, (err) => {
        if (err) { console.error('[bambu-mqtt] 订阅失败:', err.message); return; }
        // Bambu 打印机只在「被请求」时推送完整状态，否则不会主动发首帧。
        // 订阅后立即发 pushall 请求，触发打印机回传当前完整状态（pybambu 同此）。
        this._requestPushAll(serial);
      });
    });
    this._client.on('message', (_topic, payload) => this._onMessage(payload));
    this._client.on('error', (err) => {
      console.error('[bambu-mqtt] 连接错误:', err && (err.message || err.code));
      this._emitDiag({ type: 'error', error: err });
      this._emitOffline();
    });
    this._client.on('offline', () => this._emitOffline());
    this._client.on('close', () => this._emitOffline());
  }

  /** 向打印机请求完整状态（pushall）。订阅后调用一次，并定时刷新。 */
  _requestPushAll(serial) {
    if (!this._client) return;
    const topic = `device/${serial}/request`;
    const payload = JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } });
    this._client.publish(topic, payload);
    // 定时重发（每 5 分钟），防止长时间空闲漏掉状态或连接静默
    if (this._pushTimer) clearInterval(this._pushTimer);
    this._pushTimer = setInterval(() => {
      if (this._client && this._client.connected) this._client.publish(topic, payload);
    }, 5 * 60 * 1000);
  }

  _onMessage(payload) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    const print = msg.print;
    if (!print) return;

    // 取证钩子（默认关闭）：设 BAMBU_DEBUG_REPORT=1 时打印原始 print 对象，
    // 便于真实 P1S 用户抓多色换料时的 ams_status / stg_cur 实际字段名与取值来核对本地判定。
    if (process.env.BAMBU_DEBUG_REPORT) {
      console.log('[bambu-mqtt] print:', JSON.stringify(print));
    }

    // 报文为增量更新，合并进最新状态。ams / vt_tray 是嵌套子树且增量帧常只带部分字段，
    // 需深合并保住 tray_now / tray_color 等已知值（否则耗材颜色会周期性丢失，见上方注释）。
    const prev = this._latest;
    this._latest = { ...prev, ...print, connected: true };
    if (isPlainObject(print.ams)) {
      this._latest.ams = deepMergePatch(prev.ams, print.ams);
    }
    if (isPlainObject(print.vt_tray)) {
      this._latest.vt_tray = deepMergePatch(prev.vt_tray, print.vt_tray);
    }

    // 「本次终止是否为用户取消」的持久标记。取消事件是瞬时的（只在某一帧带 command=print_canceled），
    // 但取消后 gcode_state=FAILED 会一直残留到下次开印。若不持久记住「这是取消而非故障」，熊猫会
    // 一直显示「打印失败」。故：见到取消事件即置位，直到下次开印（RUNNING/PREPARE/SLICING）再清除。
    // ⚠️ 用本帧增量里的 gcode_state（print.gcode_state）判「开印」，不能用合并后的 this._latest —
    //    取消那一帧往往不带新 gcode_state，合并值仍是 RUNNING，据此清除会把刚置的标记立刻抹掉。
    //    先判清除、后判置位，保证同帧兼有开印与取消时以取消为准。
    const g = print.gcode_state;
    if (g === 'RUNNING' || g === 'PREPARE' || g === 'SLICING') this._canceled = false;
    if (print.command === 'print_canceled') this._canceled = true;

    // 瞬时事件（§7.3）：print_error 不在持续字段里；print_canceled 用上面的持久标记透出
    const report = { ...this._latest };
    if (print.command === 'print_error' || print.print_error) report.print_error = true;
    if (this._canceled) report.print_canceled = true;

    // 舱门：真机不发 door_open 布尔，门态编码在 home_flag 的 bit 23。
    // pybambu 权威：Home_Flag_Values.DOOR_OPEN = 0x00800000。用合并后的 home_flag
    // 派生持久门态（home_flag 为增量字段，取 _latest 里最后已知值）。
    if (typeof print.door_open === 'boolean') {
      report.door_open = print.door_open;
    } else if (Number.isFinite(report.home_flag)) {
      report.door_open = (report.home_flag & 0x00800000) !== 0;
    }

    if (this._cb) this._cb(report);
  }

  _emitOffline() {
    if (this._cb) this._cb({ connected: false });
  }

  _emitAuthFailure() {
    if (this._authFailCb) this._authFailCb();
  }

  // 登录/会话失效（token 过期、登录异常等）：既触发重登提示（onAuthFailure），
  // 又给宠物一个区别于「打印机离线」的状态（authExpired）—— 因为此时打印机大概率好好的，
  // 是我们这端的会话失效了，应提示「登录已失效，请重新登录」而非「离线」。
  _emitAuthExpired() {
    this._emitAuthFailure();
    if (this._cb) this._cb({ connected: false, authExpired: true });
  }

  stop() {
    if (this._pushTimer) { clearInterval(this._pushTimer); this._pushTimer = null; }
    if (this._client) { this._client.end(true); this._client = null; }
    this._canceled = false;
    this._cb = null;
  }
}

/**
 * Bambu Cloud 真机：账号登录换 token → 云 MQTT。
 */
class BambuCloudDataSource extends BambuMQTTBase {
  /**
   * @param {object} opts
   * @param {string} opts.region - 'global' | 'china'
   * @param {string} [opts.token] - 已有 access token（优先，免登录）
   * @param {string} [opts.username] - 账号（邮箱）
   * @param {string} [opts.password] - 密码
   * @param {string} [opts.serial] - 打印机序列号
   * @param {string} [opts.uid] - 用户 uid（用于 MQTT 用户名 u_<uid>）
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.region = REGIONS[opts.region] || REGIONS.global;
  }

  /**
   * 登录换 token。委托给 bambu-auth，返回 { accessToken, uid, needsVerify? }。
   */
  async login() {
    if (this.opts.token) return { accessToken: this.opts.token, uid: this.opts.uid };
    const r = await auth.login(this.opts.region, this.opts.username, this.opts.password);
    if (r.ok) return { accessToken: r.token, uid: r.uid };
    if (r.needsVerify) return { needsVerify: true, tfaKey: r.tfaKey };
    throw new Error(r.error || '登录失败');
  }

  async start() {
    let token = this.opts.token;
    let uid = this.opts.uid;
    try {
      if (!token) {
        const r = await this.login();
        if (r.needsVerify) {
          // 需要验证码：token 缺失，交给设置窗处理
          this._emitAuthExpired();
          return;
        }
        token = r.accessToken;
        uid = r.uid;
      }
    } catch (e) {
      // 登录失败（账号/密码/token 异常）→ 提示重登 + 登录已失效状态
      this._emitAuthExpired();
      return;
    }

    const serial = this.opts.serial;
    if (!serial) {
      // 未选择设备：交给设置窗
      this._emitAuthFailure();
      this._emitOffline();
      return;
    }

    // 取 uid（MQTT 用户名 u_<uid> 需要）：
    //   1) 国际区 token 是 JWT，可本地解析；
    //   2) 中国区 token 不透明，需调 API 取（design-user-service/my/preference）。
    if (!uid && token) uid = auth.decodeUidFromToken(token);
    if (!uid && token) {
      const r = await auth.getUid(this.opts.region, token);
      if (r.ok) uid = r.uid;
      else console.error('[bambu-mqtt] 取 uid 失败:', r.error);
    }

    if (!uid) {
      // 仍拿不到 uid（多为 token 过期 / 会话失效）→ 提示重登 + 登录已失效状态
      this._emitAuthExpired();
      return;
    }

    // JWT username 格式为 u_<uid>，API 返回的 uid 可能不带前缀；pybambu 直接用 JWT username
    const username = String(uid).startsWith('u_') ? String(uid) : `u_${uid}`;
    this._connectMqtt(this.region.mqtt, username, token, serial, {
      tls: true,
      rejectUnauthorized: true,
    });
  }
}

/**
 * Bambu LAN 本地直连：IP + access code → 打印机本机 MQTT。
 */
class BambuLanDataSource extends BambuMQTTBase {
  /**
   * @param {object} opts
   * @param {string} opts.host - 打印机本地 IP
   * @param {string} opts.accessCode - 打印机访问码（机身屏幕可查）
   * @param {string} [opts.serial] - 打印机序列号（订阅 device/<serial>/report）
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
  }

  async start() {
    const { host, accessCode, serial } = this.opts;
    if (!host || !accessCode || !serial) {
      // 配置不全：交给设置窗
      this._emitAuthFailure();
      this._emitOffline();
      return;
    }
    // 打印机本地 broker 证书为自签名，必须放宽校验；username 固定为 bblp。
    this._connectMqtt(host, 'bblp', accessCode, serial, {
      tls: true,
      rejectUnauthorized: false,
    });
  }
}

module.exports = { BambuCloudDataSource, BambuLanDataSource, BambuMQTTBase, classifyLanProbe };
