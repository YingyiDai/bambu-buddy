// afterSign 钩子：在 electron-builder 自带签名步骤之后，对 .app 做一次完整的
// ad-hoc 签名（codesign --force --deep --sign -）。
//
// 为什么需要它：
// 没有配置 Apple Developer ID 时，electron-builder 不做正式签名，.app 只剩下
// 链接器自动签的残缺签名（主程序已签、资源未封印）。这种损坏签名会被
// Gatekeeper 判定为「已损坏」（硬拦截，系统设置里没有「仍要打开」入口）。
// 补一个完整的 ad-hoc 签名后，资源被封印、签名有效，Gatekeeper 改判
// 「无法验证开发者」（软拦截），系统设置里就会出现「仍要打开 / Open Anyway」。
//
// 注意：ad-hoc 签名只是把「已损坏」降级为「无法验证开发者」，让用户能通过
// 「仍要打开」放行；它不能替代 Developer ID 签名 + 公证用于大规模分发。

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`\n[adhoc-sign] 重新完整 ad-hoc 签名: ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  console.log('[adhoc-sign] 完成，资源已封印，签名有效（ad-hoc）\n');
};
