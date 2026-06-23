# Bambu 账号「短信验证码登录」可行性调研与实现指南

> 调研日期：2026-06-23
> 结论：**技术可行**（中国区），但有一个端点需实测确认后才能定稿请求体。
> 本文供实现者使用：先跑 Stage A 实测，再按 Stage B 落地。

---

## 一、问题与结论

**需求**：当前 Bambu 账号登录是「账号 + 密码」，但登录时还需要收短信验证码。能否直接改成「纯短信验证码登录」（手机号 → 短信码 → 登录，不要密码）？两种登录方式并存可切换，且**只做中国区短信**（海外区仍走密码登录）。

**结论**：**可行**。Bambu 服务端支持无密码的验证码登录路径；ha-bambulab「做不到」是**架构原因**（pybambu 公开 API 被设计成密码优先，未暴露独立的「发码→码登录」入口），并非服务端不支持。

**唯一未验证点**：`{account, code}` 不带密码、不带 tfaKey 直接换 token——是从端点形态推断的，**没有任何已知项目实际跑通过**（本项目 `src/core/bambu-auth.js:95` 自己也标了「待核实」）。必须先用真实手机号实测一次（见 Stage A）。

---

## 一·补：实现时核对结果（2026-06-23）

落地前逐字核对了 pybambu 上游源码（greghesp/ha-bambulab → `pybambu/const.py` 与 `bambu_cloud.py`），并核对了本项目现状。结论：**文档基本准确，且核心机制比文档自评更有把握**。

**已逐字证实（不再是「推断」）：**
- 发码端点确为 `https://bambulab.cn/api/v1/user-service/user/sendsmscode`（host 是 `bambulab.cn`、无 `api.` 子域；path 带 `/api/` 前缀）。const.py 原文一致。
- 码登录 body 确为 `{account, code}`——**不带 password、不带 tfaKey**。pybambu `_get_authentication_token_with_verification_code(code)` 就是这么发的（用于邮箱/短信码换 token）。所以文档「核心未知」其实**有上游代码背书**，并非纯臆测。
- 本项目现状描述（IPC 链路、`bambuAccount` 不存密码、UI 两阶段表单、locale 键）核对无误。

**补充/修正：**
- **uid 解析**：中国区 token 不透明，码登录响应未必带 uid。已在 `loginWithCode` 内加 `getUid` 回退（uid 缺失时拉 `/my/preference`），比仅靠 `decodeUidFromToken` 更稳。
- **错误文案**：码登录 4xx 统一映射为「验证码错误或已过期」，发码 429/4xx 映射为「发送过于频繁」「手机号无效或发送失败」，避免 `humanizeError` 把它们误报成「账号或密码错误」。
- **未跑 Stage A**：实现环境无真实中国手机号 / 短信通道，**Stage A 实测未执行**。代码已按上游契约落地，但「真机能否用 `{account, code}` 换到 token、account 是否需带国码、`api.bambulab.cn` 是否与 `.com` 行为一致」仍需一次真机验证。
- **默认区域**：按需求已将登录默认区域从「全球」改为「中国大陆」（区域选择器中国大陆置顶即默认选中），中国区默认进入「验证码登录」。

**实现状态：已完成 Stage B**（见下）。`bambu-auth.js:95` 的「待核实」注释保留——它针对的是**密码 2FA**（`sendVerifyCode` 复用登录端点带 code），与本次新增的无密码码登录是两条不同路径，仍未实测。

---

## 二、当前实现（现状）

文件：`src/core/bambu-auth.js`（以 pybambu 为事实来源，逆向接口）

### 端点常量
```js
const REGIONS = {
  global: { api: 'api.bambulab.com', mqtt: 'us.mqtt.bambulab.com' },
  china:  { api: 'api.bambulab.cn',  mqtt: 'cn.mqtt.bambulab.com' },
};
const LOGIN_PATH       = '/v1/user-service/user/login';
const TFA_PATH         = '/v1/user-service/user/login'; // 复用登录端点，带 code（待核实）
const DEVICE_LIST_PATH = '/v1/iot-service/api/user/bind';
```

### 现有流程（密码 + 二次验证码）
1. `login(region, account, password)`（`bambu-auth.js:71`）：POST `/login` `{account, password}`。
   - 若响应 `loginType==='verifyCode'` 或含 `tfaKey` → 返回 `{ok:false, needsVerify:true, tfaKey}`。
   - 否则取 `accessToken` → `{ok:true, token, uid}`。
2. `sendVerifyCode(region, account, password, tfaKey, code)`（`bambu-auth.js:93`）：POST `/login` `{account, password, tfaKey, code}`——**仍带 password**。换 token。
3. `listDevices(region, token)`（`:113`）：GET `/bind`，Bearer token。
4. `getUid(region, token)`（`:140`）：中国区 token 是 opaque，需 GET `/v1/design-user-service/my/preference` 取 uid；海外区 token 是 JWT，本地 `decodeUidFromToken` 解析。

### IPC 链路
- `src/preload-settings.js:8-11`：`submitCredentials` / `submitVerifyCode`。
- `src/main.js:536-550`：`ipcMain.handle('bambu:login' / 'bambu:verify')`，成功后设 `pendingAuth = {region, account, password, token, uid}`。
- 凭据存储 `main.js:619`：`store.set('bambuAccount', {region, account, uid, token})`——**本就不存密码**，码登录可直接复用。
- 登录成功后的下游（listDevices / 建 MQTT / 刷新卡片）与登录方式无关，复用即可。
- UI：`src/settings/settings.js:276-298` 两阶段表单；locale `settings.verifyHint / verifyCode / submit / backLogin / errLoginFailed / errVerifyInvalid`。

---

## 三、Bambu API 端点（调研所得）

来源：pybambu `const.py` 的 `BambuUrl` 枚举 + `bambu_cloud.py`（ha-bambulab 仓库）。

| 用途 | 端点 | 说明 |
|---|---|---|
| 登录（密码或码） | `POST /v1/user-service/user/login` | host：中国区 `api.bambulab.cn`，海外 `api.bambulab.com`。支持两种 body：`{account, password}` 或 `{account, code}`（后者为推断） |
| **发短信码（中国）** | `POST https://bambulab.cn/api/v1/user-service/user/sendsmscode` | **host 是 `bambulab.cn`（无 `api.` 子域）**。body `{phone, type:"codeLogin"}`。不要密码、不要鉴权 |
| 发邮箱码（海外） | `POST https://api.bambulab.com/v1/user-service/user/sendemail/code` | 海外区用，非 SMS；本次不做 |
| TFA（少用） | `POST https://bambulab.com/api/sign-in/tfa` | 密码二次验证备用 |
| 设备列表 | `GET /v1/iot-service/api/user/bind` | Bearer token |
| 取 uid | `GET /v1/design-user-service/my/preference` | Bearer token；中国区必需 |

**关键点**：`sendsmscode` 只要 `{phone, type:"codeLogin"}` 就能触发短信，**完全不需要密码或前置登录**。这是「纯验证码登录」成立的基础。

### 推断的无密码流程（中国区）
```
1. POST https://bambulab.cn/api/v1/user-service/user/sendsmscode
   { "phone": "<手机号>", "type": "codeLogin" }
   → 服务端发短信（响应可能含 tfaKey，需实测确认）

2. 用户收到 6 位验证码

3. POST https://api.bambulab.cn/v1/user-service/user/login
   { "account": "<手机号>", "code": "<验证码>" }
   → 返回 { accessToken, uid, ... }
```

### 待实测确认的细节
- `sendsmscode` 响应体是否含 `tfaKey`？若有，`/login` 是否必须带回该 `tfaKey`？
- `account` / `phone` 字段格式：纯号码 `138xxxxxxxx`？还是带国码 `+86138xxxxxxxx` / `86138...`？
- `/login` 用 `api.bambulab.cn`（本项目中国区 host）还是 `api.bambulab.com`（pybambu 写法）？两边都试。
- `{account, code}` 是否真能在无 password 下换到 `accessToken`？（核心未知）

---

## 四、Stage A：实测脚本（必须先跑）

新建 `scripts/test-sms-login.js`，用 Node 内置 `https` + `readline`，**不引依赖**。交互式：输入手机号 → 发码 → 输入收到的码 → 尝试登录，**每步完整响应打印到控制台**用于诊断。

脚本要点：
1. 读手机号（保留原始输入字符串）。
2. `POST https://bambulab.cn/api/v1/user-service/user/sendsmscode`，body `{phone, type:"codeLogin"}`，`Content-Type: application/json`。打印状态码 + 完整 body（看有无 `tfaKey`）。
3. 读用户收到的验证码。
4. 依次尝试并都打印结果：
   - 组合 1：`POST https://api.bambulab.cn/v1/user-service/user/login`，body `{account: phone, code}`。
   - 组合 2（若 sendsmscode 返回过 tfaKey）：同端点 body `{account: phone, code, tfaKey}`。
   - Fallback：若上面在 `api.bambulab.cn` 全失败，换 `api.bambulab.com` 同路径再试组合 1/2。
5. 打印最终是否拿到 `accessToken` / `uid` 及完整 body。

运行：`node scripts/test-sms-login.js`（真实手机号）。

**判定**：
- 拿到 `accessToken` → 进入 Stage B，按实测确定的确切请求体实现。
- 必须带 tfaKey → Stage B 的 `loginWithCode` 带 tfaKey 参数。
- 全部失败 → 停止，回报。

脚本用完可删，不进正式产物。

---

## 五、Stage B：实现指南（以 Stage A 实测结果为准）

仅 `region === 'china'` 启用；海外区维持密码登录不变。

### 1. `src/core/bambu-auth.js`
- 新增 `SMS_CODE_PATH = '/v1/user-service/user/sendsmscode'`，host 用 `bambulab.cn`（注意不是 `api.bambulab.cn`）。
- 新增 `requestSmsCode(region, phone)`：POST sendsmscode `{phone, type:'codeLogin'}`，返回 `{ok, tfaKey?}`（tfaKey 视实测）。
- 新增 `loginWithCode(region, account, code, tfaKey?)`：POST `/login` `{account, code[, tfaKey]}`（无 password），复用 `decodeUidFromToken` / `getUid` 取 uid，返回 `{ok, token, uid, account}`。
- 复用现有 `httpsJson`、`humanizeError`、`getUid`、`decodeUidFromToken`。
- 失败走 `humanizeError`，与现有风格一致。

### 2. `src/main.js`
- `ipcMain.handle('bambu:requestSmsCode', (_e, region, phone) => bambuAuth.requestSmsCode(region, phone))`。
- `ipcMain.handle('bambu:loginWithCode', async (_e, region, account, code, tfaKey) => { const r = await bambuAuth.loginWithCode(region, account, code, tfaKey); if (r.ok) pendingAuth = {region, account, token:r.token, uid:r.uid}; return r; })`。
- 登录成功后的收尾（listDevices / MQTT / 刷新）复用现有 `bambu:login` 成功分支之后的逻辑。
- 凭据存储 `store.set('bambuAccount', {region, account, uid, token})` 不存密码，码登录直接复用，无需改。

### 3. `src/preload-settings.js`
```js
requestSmsCode: (region, phone) => ipcRenderer.invoke('bambu:requestSmsCode', region, phone),
loginWithCode: (region, account, code, tfaKey) => ipcRenderer.invoke('bambu:loginWithCode', region, account, code, tfaKey),
```

### 4. 登录 UI（`src/settings/index.html` + `src/settings/settings.js` + `src/config/locales.js`）
- 登录卡上新增「验证码登录 / 密码登录」切换链接，**仅 region=china 时显示**；海外区隐藏切换、维持密码登录。
- 验证码登录模式：隐藏密码框；显示「手机号」输入 +「发送验证码」按钮（60s 倒计时禁用）+「验证码」输入 + 提交。
- 流程：发送验证码 → `requestSmsCode` → 提示已发送 → 填码 → `loginWithCode` → 成功走现有登录成功收尾。
- 复用现有错误文案 `settings.errLoginFailed / errVerifyInvalid`；新增 locale（zh + en 都备齐）：
  - `settings.loginModePassword` / `settings.loginModeCode`
  - `settings.sendCode` / `settings.codeSent` / `settings.codeSentHint`
  - `settings.phonePlaceholder`

### 5. 文档
- `docs/superpowers/桌面宠物-技术实现文档.md` 鉴权小节：补充「验证码登录（中国区）」流程与端点，去掉 `bambu-auth.js:95` 的「待核实」标注（实测后落实）。

---

## 六、验证

1. Stage A：`node scripts/test-sms-login.js` 真机跑通，确认 `{account, code}` 换到 `accessToken`，记录确切请求体/端点/tfaKey。
2. Stage B：`npm start`（改了 main/preload/locales 需**完全退出再重启**，仅刷新窗口不够，主进程 require 缓存）→ 设置 → 打印机页账号卡 → 切「验证码登录」→ 输手机号 → 收码 → 登录成功，打印机列表刷新、熊猫连上 MQTT。
3. 切回「密码登录」仍正常；海外区不出现「验证码登录」切换。
4. 退出后分别用两种方式重登，确认 token 存取与 MQTT 重连正常。

---

## 七、来源

- pybambu 源码（事实来源）：
  - `custom_components/bambu_lab/pybambu/const.py` — `BambuUrl` 枚举与 `BAMBU_URL` 字典（所有端点 URL）。
  - `custom_components/bambu_lab/pybambu/bambu_cloud.py` — `_get_sms_verification_code` 发码实现：`data = {phone, type:"codeLogin"}`，POST 到 `BambuUrl.SMS_CODE`。
- 仓库地址：https://github.com/greghesp/ha-bambulab
- 本项目参考：`src/core/bambu-auth.js:1-6` 注明「以 pybambu 为事实来源」；`docs/superpowers/桌面宠物-技术实现文档.md` 鉴权小节。

## 八、关键端点速查

```
发短信码（中国，无鉴权）：
  POST https://bambulab.cn/api/v1/user-service/user/sendsmscode
  body: { "phone": "<手机号>", "type": "codeLogin" }

码登录（推断，无密码）：
  POST https://api.bambulab.cn/v1/user-service/user/login
  body: { "account": "<手机号>", "code": "<6位码>" }
  → { accessToken, uid, ... }
```
