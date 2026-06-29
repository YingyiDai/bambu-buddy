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
 * 共享基类：连 MQTT、订阅 device/<serial>/report、维护合并后的 print 状态并回调。
 */
class BambuMQTTBase {
  constructor() {
    this._cb = null;
    this._client = null;
    this._latest = {}; // 维护合并后的 print 状态
    this._authFailCb = null;
  }

  onState(cb) { this._cb = cb; }

  /** 鉴权/登录失败时回调（如 token 过期、登录异常），供主进程打开登录窗。 */
  onAuthFailure(cb) { this._authFailCb = cb; }

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

    // 报文为增量更新，合并进最新状态
    this._latest = { ...this._latest, ...print, connected: true };

    // 瞬时事件（§7.3）：print_error / print_canceled 不在持续字段里
    const report = { ...this._latest };
    if (print.command === 'print_error' || print.print_error) report.print_error = true;
    if (print.command === 'print_canceled') report.print_canceled = true;

    // 舱门：部分固件在 home_flag / 单独字段里，pybambu 有解析；此处留出钩子。
    // ⚠️ 未经真机验证：真机大概率不会直接给 print.door_open 布尔字段，
    //    需按 pybambu 从 home_flag 等位字段解析后，door_open 状态才会真正触发。
    if (typeof print.door_open === 'boolean') report.door_open = print.door_open;

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

module.exports = { BambuCloudDataSource, BambuLanDataSource, BambuMQTTBase };
