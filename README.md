<div align="center">

<img src="assets/icon/AppIcon.png" width="240" alt="Bambu Buddy" />

# Bambu Buddy 🐼

English | <a href="README.zh-CN.md">简体中文</a>

**A desktop pet panda that lives on your screen and reacts to your Bambu Lab 3D printer.**

<sub>Unofficial community project — not affiliated with or endorsed by Bambu Lab.</sub>

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black?logo=apple)
![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-arm64-333)
![Version](https://img.shields.io/github/v/release/YingyiDai/bambu-buddy?color=brightgreen&label=version)

### [⬇️ Download for macOS / Windows](https://github.com/YingyiDai/bambu-buddy/releases/latest)

</div>

---

## What is it?

Bambu Buddy turns your printer's status into a little animated panda that lives on your desktop. It's transparent, always-on-top, draggable, and click-through — it stays out of your way in the corner, using expressions and motion to tell you how your print is going: started, swapping filament, finished, or failed. One glance and you know — no need to open Bambu Studio or Bambu Handy.

<div align="center"><img src="assets/readme/whatsthis-en.png" width="720" alt="Bambu Buddy on the desktop" /></div>

---

## ✨ Features

- 🐼 **Reacts in real time** — the panda's animation and status text change instantly when the printer's state changes.
- 🎬 **11 hand-crafted moods** — from idle and printing to filament change, success, and failure, each with its own expression.
- 🖨️ **Cloud & LAN** — sign in with your Bambu account, including **Google / Apple / Facebook** accounts (login happens on the official Bambu page — your password never touches this app), or connect directly via IP + access code on your local network.
- 🔀 **Multi-printer** — cloud and local printers merge into one list, switch from the tray menu.

---

## 🐼 The panda's moods

<table align="center">
  <tr>
    <td align="center"><img src="assets/readme/state-idle.gif" width="130"/><br/><b>Idle</b><br/><sub>Printer is idle</sub></td>
    <td align="center"><img src="assets/readme/state-prepare.gif" width="130"/><br/><b>Preparing</b><br/><sub>Heating / leveling / calibration</sub></td>
    <td align="center"><img src="assets/readme/state-printing.gif" width="130"/><br/><b>Printing</b><br/><sub>4 stages by progress</sub></td>
    <td align="center"><img src="assets/readme/state-changing-filament.gif" width="130"/><br/><b>Changing filament</b><br/><sub>Load / unload / AMS</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/readme/state-paused.gif" width="130"/><br/><b>Paused</b><br/><sub>Manual or error pause</sub></td>
    <td align="center"><img src="assets/readme/state-finished.gif" width="130"/><br/><b>Finished 🎉</b><br/><sub>Print succeeded</sub></td>
    <td align="center"><img src="assets/readme/state-failed.gif" width="130"/><br/><b>Failed</b><br/><sub>Error / HMS code</sub></td>
    <td align="center"><img src="assets/readme/state-offline.gif" width="130"/><br/><b>Offline</b><br/><sub>Disconnected or login expired</sub></td>
  </tr>
</table>

---

## 📥 Download & Install

### macOS

1. Download the latest `.dmg` from **[Releases](https://github.com/YingyiDai/bambu-buddy/releases/latest)** (Apple Silicon / arm64).
2. Open the DMG and drag **Bambu Buddy** into Applications.
3. Launch **Bambu Buddy** — it's Apple-signed (Developer ID) and notarized, so it opens normally with no security warning.

### Windows

1. Download the latest `.exe` installer from **[Releases](https://github.com/YingyiDai/bambu-buddy/releases/latest)**.
2. Run the installer. If Windows SmartScreen warns that the publisher is unrecognized — the app isn't code-signed yet — click **More info › Run anyway**.

---

## 🔌 Connect your printer

| Mode | How |
|---|---|
| 🎮 **Playground** | No printer needed — click through every state in the Playground, or auto-cycle. |
| ☁️ **Bambu Cloud** | Sign in with your Bambu account — email/password and Google / Apple / Facebook are all supported via the official Bambu sign-in page. Cloud printers sync automatically and subscribe to live status via MQTT. |
| 🏠 **LAN** | Enter the printer's IP + access code (shown on the printer's screen) to connect directly on your local network. |

<div align="center"><img src="assets/readme/connectprinter-en.png" width="720" alt="Connect your printer" /></div>

---

## ❓ FAQ

**Does it send my data anywhere?**
No. Account credentials are encrypted locally with your OS keychain (macOS Keychain / Windows DPAPI via Electron `safeStorage`) and only used to connect to your own printer — nothing is sent to any third-party server.

**How do I update?**
Click "Check for updates" from the tray menu or Settings › About — it compares against the latest GitHub Release and offers a one-click jump to download.

**No Bambu printer?**
That's fine — Playground mode exists for exactly that, so you can enjoy the panda's animations on their own.

---

<div align="center"><sub>Made with 🐼 for the Bambu Lab community</sub></div>
