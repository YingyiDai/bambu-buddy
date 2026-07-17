#!/bin/bash
# SessionStart 钩子：Claude Code on the web 会话启动时装好依赖，
# 让测试（node --test）开箱即跑，无需每次手动 npm install。
# 仅在远程（云端）会话运行；本地会话用你已有的 node_modules，不打扰。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --registry + --no-package-lock：仓库的 package-lock.json 里 resolved URL 指向
#   registry.npmmirror.com（作者本机的国内镜像），而云端 agent 代理只放行
#   registry.npmjs.org，走镜像会被 403 挡住、整个 install 卡死十几分钟。故强制
#   从 npmjs.org 重新解析（--no-package-lock 让 npm 忽略锁文件里的镜像地址）。
# --ignore-scripts：跳过 electron 二进制下载（GUI 无法在无显示的云端容器里跑，
#   且该下载又大又易在容器网络里卡住/装残）。测试是纯 Node，只需 JS 依赖 + koffi 预编译件。
npm install --ignore-scripts --no-package-lock --registry=https://registry.npmjs.org/ --no-audit --no-fund
