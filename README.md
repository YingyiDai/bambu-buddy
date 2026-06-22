<div align="center">

<img src="assets/readme/hero.gif" width="240" alt="Bambu Buddy" />

# Bambu Buddy 🐼

**A desktop pet panda that lives on your screen and reacts to your Bambu Lab 3D printer.**

**一只住在 macOS 桌面上的熊猫，会实时跟着你的拓竹（Bambu Lab）打印机状态做出反应。**

![Platform](https://img.shields.io/badge/platform-macOS-black?logo=apple)
![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-arm64-333)
![Version](https://img.shields.io/badge/version-0.1.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT%20(code)-blue)

### [⬇️ Download for macOS / 下载](https://github.com/YingyiDai/bambu-buddy/releases/latest)

</div>

---

## What is it? · 这是什么

Bambu Buddy 把你打印机的状态变成桌面上一只会动的熊猫。它透明、置顶、可拖动、点击穿透——
不挡你干活，只是安静地待在角落，用表情和动作告诉你打印进行得怎么样：开始打印了、换料了、
打完了、还是出错了。瞄一眼就知道，不用再切到手机 App 或网页。

> Glance at the corner of your screen and you instantly know how your print is going —
> no need to open the app or a browser. The panda reacts in real time.

---

## ✨ Features · 功能亮点

- 🐼 **Reacts in real time · 实时反应** —— 打印机状态一变，熊猫的动画和状态文字立刻跟着变。
- 🎬 **11 hand-crafted moods · 11 种精心制作的状态动画** —— 从空闲、打印、换料到成功、失败，每种都有专属表情。
- 🎮 **Try it without a printer · 没有打印机也能玩** —— 内置「把玩模式」，一键演示全部状态，或自动轮播。
- 🖨️ **Cloud & LAN · 云端与局域网** —— 支持 Bambu 账号登录（MQTT 实时状态）或填 IP + access code 直连本地打印机。
- 🔀 **Multi-printer · 多打印机** —— 云端 + 本地打印机合并成一个列表，托盘菜单一键切换。
- 🪶 **Stays out of your way · 不打扰** —— 透明置顶、点击穿透、菜单栏常驻、Dock 无图标，可调大小、记忆位置。
- 🔒 **Private by design · 隐私优先** —— 账号 token / access code 用系统级 `safeStorage` 本地加密存储，绝不上传。
- 🆙 **Auto update check · 自动检查更新** —— 通过 GitHub Releases 比对版本，有新版一键跳转下载。
- 🌐 **Bilingual · 中英双语** —— 界面支持简体中文 / English。

---

## 🐼 The panda's moods · 熊猫的心情

<table align="center">
  <tr>
    <td align="center"><img src="assets/readme/state-idle.gif" width="130"/><br/><b>Idle · 空闲</b><br/><sub>打印机待机</sub></td>
    <td align="center"><img src="assets/readme/state-prepare.gif" width="130"/><br/><b>Preparing · 准备中</b><br/><sub>预热 / 调平 / 校准</sub></td>
    <td align="center"><img src="assets/readme/state-printing.gif" width="130"/><br/><b>Printing · 打印中</b><br/><sub>按进度分 4 档</sub></td>
    <td align="center"><img src="assets/readme/state-changing-filament.gif" width="130"/><br/><b>Changing filament · 换料</b><br/><sub>进退料 / AMS</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/readme/state-paused.gif" width="130"/><br/><b>Paused · 已暂停</b><br/><sub>手动或异常暂停</sub></td>
    <td align="center"><img src="assets/readme/state-finished.gif" width="130"/><br/><b>Finished · 完成 🎉</b><br/><sub>打印成功</sub></td>
    <td align="center"><img src="assets/readme/state-failed.gif" width="130"/><br/><b>Failed · 失败</b><br/><sub>报错 / HMS 码</sub></td>
    <td align="center"><img src="assets/readme/state-offline.gif" width="130"/><br/><b>Offline · 未连接</b><br/><sub>离线或登录失效</sub></td>
  </tr>
</table>

<div align="center"><sub>状态文字 pill 会显示精确信息（进度、层数、换料、错误码）；动画是情绪，文字是细节。</sub></div>

---

## 📥 Download & Install · 下载与安装

1. 到 **[Releases](https://github.com/YingyiDai/bambu-buddy/releases/latest)** 下载最新的 `.dmg`（Apple Silicon / arm64）。
2. 打开 DMG，把 **Bambu Buddy** 拖进「应用程序」。
3. 首次打开若提示「无法验证开发者」——app 暂未做 Apple 签名，到
   **系统设置 › 隐私与安全性** 点「仍要打开」即可。

启动后熊猫出现在屏幕右下角，菜单栏出现托盘图标，Dock 里没有图标。

> 🖼️ _桌面实拍录屏（占位，待补）：`<在此放一段熊猫贴在桌面的录屏 GIF>`_

---

## 🔌 Connect your printer · 连接打印机

打开托盘菜单 →「设置…」，在「打印机」里选一种方式：

| 方式 / Mode | 怎么用 / How |
|---|---|
| 🎮 **Playground · 把玩模式**（默认） | 不用打印机，在「把玩探索」里点一下就能看任意状态，或自动轮播。 |
| ☁️ **Bambu Cloud · 云端** | 登录 Bambu 账号，自动同步云端打印机，MQTT 订阅实时状态。 |
| 🏠 **LAN · 局域网** | 填打印机 IP + access code（在打印机屏幕上查），直连本地打印机。 |

> 🖼️ _设置页截图（占位，待补）：`<在此放设置页/打印机管理截图>`_

---

## ❓ FAQ

**它会上传我的数据吗？ · Does it phone home?**
不会。账号凭据用 macOS `safeStorage` 本地加密，只用于连接你自己的打印机；不向任何第三方服务器发送数据。

**怎么更新？ · How do I update?**
托盘菜单或「设置 › 关于」点「检查更新」，会比对 GitHub 最新 Release，有新版一键跳转下载。

**没有拓竹打印机能用吗？ · No Bambu printer?**
能。「把玩模式」就是为此准备的——纯欣赏熊猫的各种状态动画。

**支持 Intel Mac 吗？ · Intel Macs?**
当前发布的是 Apple Silicon（arm64）版本。

---

## 📄 License · 许可

源代码以 **[MIT](LICENSE)** 许可发布。
`assets/` 下的美术、动画与视频素材版权由作者保留，**不在 MIT 范围内**，未经授权不得单独复用或再分发。

The source code is released under the **[MIT](LICENSE)** license.
Artwork, animations, and video assets under `assets/` are **not** covered by MIT — all rights reserved by the author.

---

<div align="center"><sub>Made with 🐼 for the Bambu Lab community · 为拓竹玩家而做</sub></div>
