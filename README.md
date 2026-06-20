# Bambu 打印机桌面宠物 🐼

macOS 桌面宠物：一只透明背景的熊猫常驻桌面，根据 Bambu 打印机状态播放对应动画。
按[技术实现文档](桌面宠物-技术实现文档.md)实现。

## 功能

- 透明、置顶、可拖动、点击穿透的桌面宠物窗口（不挡操作）。
- 11 种状态动画 + 实时状态文本 pill（进度、层数、错误信息）。
- 两种数据源：
  - **Mock 模式**（默认，demo 用）：托盘菜单手动切状态，或自动轮播全部状态。
  - **Bambu Cloud 真机模式**：账号登录 + MQTT 订阅真实打印机状态。
- 托盘菜单：状态展示、数据源切换、勿扰模式、退出。
- 窗口位置记忆。

## 环境准备

> 国内网络下 Electron 二进制走 GitHub 直连常被中断，仓库内 `.npmrc` 已配置
> npmmirror 镜像（`electron_mirror`），`npm install` 会自动使用。

```bash
# 1. 依赖
npm install

# 2. 视频处理依赖（去背用）
brew install ffmpeg
python3 -m venv .venv && .venv/bin/pip install "rembg[cpu]"
```

## 资产处理

源视频（不透明 mp4）在 `assets/source/`。熊猫为黑白配色坐在近白背景上，
主体白色与背景同色，故用 **rembg AI 抠像**（逐帧）+ 转 WebM/VP9 alpha：

```bash
npm run process-videos          # 处理全部 → assets/anim/*.webm
bash scripts/process-videos.sh idle   # 只处理单个（调试用）
```

输出统一画布、居中锚点，切状态不跳动。处理完建议人工过目边缘。

## 运行

```bash
npm start          # 开发运行
npm run build:mac  # 打 macOS 包（electron-builder）
```

启动后熊猫出现在屏幕右下角，Dock 无图标，菜单栏出现托盘图标。
**Mock 模式**下点托盘图标 →「Mock · 切换状态」逐个演示，或「自动轮播」录屏。

## 测试

```bash
node --test test/state-machine.test.js   # resolveState 纯函数单测
```

## 结构

```
src/
├─ main.js              # 主进程：窗口、托盘、IPC、位置记忆、数据源装配
├─ preload.js           # contextBridge 受控 API
├─ renderer/            # index.html / pet.js（交叉淡入播放）/ style.css
├─ core/
│  ├─ state-machine.js  # resolveState() 纯函数：数据 → {stateKey, videoFile, label}
│  ├─ mock.js           # Mock 数据源
│  └─ bambu-mqtt.js     # Bambu Cloud 登录 + MQTT
└─ config/state-map.js  # stage 枚举 + 状态→视频映射
scripts/process-videos.sh # mp4 → webm(alpha) 批处理
```

## 状态映射

见技术文档 §6。核心是 `resolveState(report)` 纯函数，Mock 与真机共用：
按 `gcode_state` 定大状态，`RUNNING` 时按 `stg_cur`（换料）与 `mc_percent`（进度档）细化，
`label` 是精确的状态文本信息通道（视频是粗粒度情绪通道）。
