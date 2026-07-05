// afterAllArtifactBuild 钩子：对最终的 .dmg 再做一次公证 + staple。
//
// 为什么需要它：
// electron-builder 的 notarize 只公证 .app（并把票据 staple 到 .app 里），但它是
// 「先公证 app，再把 app 打进 dmg」，所以 dmg 外壳本身没有被公证、没有票据。
// 用户下载分发的是 dmg，而现代 macOS 在打开「已隔离（quarantine）的未公证 dmg」时，
// 会先弹「'X.dmg' 无法打开，因为 Apple 无法检查其中是否包含恶意软件」——这一步发生在
// 用户碰到里面的 app 之前。所以必须把最终 dmg 也公证并 staple，才能做到全程无警告。
//
// 仅在 CI 有正式签名（CSC_LINK）时执行；本地无证书的 ad-hoc 构建直接跳过。
// 公证凭据复用 release.yml 注入的环境变量：APPLE_API_KEY(.p8 路径) / APPLE_API_KEY_ID / APPLE_API_ISSUER。

const { execFileSync } = require('child_process');

exports.default = async function (buildResult) {
  if (process.platform !== 'darwin') return;
  if (!process.env.CSC_LINK) {
    console.log('[notarize-dmg] 无 CSC_LINK（非正式签名），跳过 dmg 公证');
    return;
  }
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.warn('[notarize-dmg] 缺少公证 API Key 环境变量（APPLE_API_KEY / _ID / _ISSUER），跳过 dmg 公证');
    return;
  }

  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) {
    console.log('[notarize-dmg] 没有 dmg 产物，跳过');
    return;
  }

  for (const dmg of dmgs) {
    console.log(`\n[notarize-dmg] 提交 dmg 公证（--wait，可能要一两分钟）: ${dmg}`);
    execFileSync(
      'xcrun',
      ['notarytool', 'submit', dmg,
        '--key', APPLE_API_KEY,
        '--key-id', APPLE_API_KEY_ID,
        '--issuer', APPLE_API_ISSUER,
        '--wait'],
      { stdio: 'inherit' }
    );
    console.log(`[notarize-dmg] staple 票据到 dmg: ${dmg}`);
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    console.log('[notarize-dmg] 完成，dmg 已公证并 staple\n');
  }
};
