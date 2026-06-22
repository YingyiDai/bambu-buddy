<div align="center">

<img src="assets/icon/AppIcon.png" width="240" alt="Bambu Buddy" />

# Bambu Buddy 🐼

<a href="README.md">English</a> | 简体中文

**一只住在桌面上的熊猫，会实时跟着你的拓竹（Bambu Lab）打印机状态做出反应。**

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black?logo=apple)
![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-arm64-333)
![Version](https://img.shields.io/badge/version-0.1.0-brightgreen)

### [⬇️ 下载 macOS / Windows 版本](https://github.com/YingyiDai/bambu-buddy/releases/latest)

</div>

---

## 这是什么

Bambu Buddy 把你打印机的状态变成桌面上一只会动的熊猫。它透明、置顶、可拖动、点击穿透——
不挡你干活，只是安静地待在角落，用表情和动作告诉你打印进行得怎么样：开始打印了、换料了、
打完了、还是出错了。瞄一眼就知道，不用再切到手机 App 或网页。

---

## ✨ 功能亮点

- 🐼 **实时反应** —— 打印机状态一变，熊猫的动画和状态文字立刻跟着变。
- 🎬 **11 种精心制作的状态动画** —— 从空闲、打印、换料到成功、失败，每种都有专属表情。
- 🖨️ **云端与局域网** —— 支持 Bambu 账号登录（MQTT 实时状态）或填 IP + access code 直连本地打印机。
- 🔀 **多打印机** —— 云端 + 本地打印机合并成一个列表，托盘菜单一键切换。

---

## 🐼 熊猫的心情

<table align="center">
  <tr>
    <td align="center"><img src="assets/readme/state-idle.gif" width="130"/><br/><b>空闲</b><br/><sub>打印机待机</sub></td>
    <td align="center"><img src="assets/readme/state-prepare.gif" width="130"/><br/><b>准备中</b><br/><sub>预热 / 调平 / 校准</sub></td>
    <td align="center"><img src="assets/readme/state-printing.gif" width="130"/><br/><b>打印中</b><br/><sub>按进度分 4 档</sub></td>
    <td align="center"><img src="assets/readme/state-changing-filament.gif" width="130"/><br/><b>换料</b><br/><sub>进退料 / AMS</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/readme/state-paused.gif" width="130"/><br/><b>已暂停</b><br/><sub>手动或异常暂停</sub></td>
    <td align="center"><img src="assets/readme/state-finished.gif" width="130"/><br/><b>完成 🎉</b><br/><sub>打印成功</sub></td>
    <td align="center"><img src="assets/readme/state-failed.gif" width="130"/><br/><b>失败</b><br/><sub>报错 / HMS 码</sub></td>
    <td align="center"><img src="assets/readme/state-offline.gif" width="130"/><br/><b>未连接</b><br/><sub>离线或登录失效</sub></td>
  </tr>
</table>

<div align="center"><sub>状态文字 pill 会显示精确信息（进度、层数、换料、错误码）；动画是情绪，文字是细节。</sub></div>

---

## 📥 下载与安装

### macOS

1. 到 **[Releases](https://github.com/YingyiDai/bambu-buddy/releases/latest)** 下载最新的 `.dmg`（Apple Silicon / arm64）。
2. 打开 DMG，把 **Bambu Buddy** 拖进「应用程序」。
3. 首次打开若提示「无法验证开发者」——app 暂未做 Apple 签名，到
   **系统设置 › 隐私与安全性** 点「仍要打开」即可。

启动后熊猫出现在屏幕右下角，菜单栏出现托盘图标，Dock 里没有图标。

### Windows

1. 到 **[Releases](https://github.com/YingyiDai/bambu-buddy/releases/latest)** 下载最新的 `.exe` 安装程序。
2. 运行安装程序。若 Windows SmartScreen 提示「无法识别的发布者」——app 暂未做代码签名——点「更多信息 › 仍要运行」即可。

启动后熊猫出现在桌面上，通知区域出现托盘图标。

> 🖼️ _桌面实拍录屏（占位，待补）：`<在此放一段熊猫贴在桌面的录屏 GIF>`_

---

## 🔌 连接打印机

打开托盘菜单 →「设置…」，在「打印机」里选一种方式：

| 方式 | 怎么用 |
|---|---|
| 🎮 **把玩模式**（默认） | 不用打印机，在「把玩探索」里点一下就能看任意状态，或自动轮播。 |
| ☁️ **云端** | 登录 Bambu 账号，自动同步云端打印机，MQTT 订阅实时状态。 |
| 🏠 **局域网** | 填打印机 IP + access code（在打印机屏幕上查），直连本地打印机。 |

> 🖼️ _设置页截图（占位，待补）：`<在此放设置页/打印机管理截图>`_

---

## ❓ 常见问题

**它会上传我的数据吗？**
不会。账号凭据用 macOS `safeStorage` 本地加密，只用于连接你自己的打印机；不向任何第三方服务器发送数据。

**怎么更新？**
托盘菜单或「设置 › 关于」点「检查更新」，会比对 GitHub 最新 Release，有新版一键跳转下载。

**没有拓竹打印机能用吗？**
能。「把玩模式」就是为此准备的——纯欣赏熊猫的各种状态动画。

---

<div align="center"><sub>为拓竹玩家而做 🐼</sub></div>
