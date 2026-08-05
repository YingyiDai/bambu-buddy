#!/usr/bin/env node
'use strict';

// 把发版产物镜像到腾讯云 COS —— 让中国大陆用户不经 GitHub 也能下载安装包。
// 由 .github/workflows/release.yml 的「镜像到腾讯云 COS」步骤调用，详见 RELEASING.md。
//
// 依赖 cos-nodejs-sdk-v5（腾讯云官方 Node SDK），由工作流临时装到 $RUNNER_TEMP、经
// NODE_PATH 引入，故意**不**写进 package.json：它只在 release 这个 ubuntu job 用得到，
// 进 devDependencies 会让 mac/win 两个构建 job 的 npm ci 白白多装一份，拖慢每次发版。
//
// 同一份产物上传到三处，各有各的用途（别合并，命名诉求是冲突的）：
//   <prefix>/<tag>/     全部产物按原名归档，可回溯任意旧版
//   <prefix>/latest/    应用内自动更新的 generic feed —— electron-updater 按
//                       latest*.yml 里记录的文件名去取包，故这里必须保留带版本号的原名
//   <prefix>/download/  对外公开的固定直链 —— 去掉版本号，地址永不变，
//                       README / 小红书等渠道贴一次就够，以后发新版无需改任何文档
//
// 环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET（带 appid，如 xxx-1250000000）/
//           COS_REGION（如 ap-shanghai）、TAG（如 v0.4.3）、
//           ARTIFACTS_DIR（默认 artifacts）、COS_PREFIX（默认 bambu-buddy）
// 四个 COS 变量一个都没配 → 视为「尚未接入 COS」，跳过并正常退出（不让发版变红）；
// 配了一部分 → 视为配错，直接报错，避免只上传半套、大陆用户拿到不完整的版本。

const fs = require('fs');
const path = require('path');

const COS_VARS = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION'];

// 只镜像这几类：两个安装包 + 自动更新所需的 yml / zip / blockmap。
// 与 release.yml 上传 GitHub Release 的过滤规则保持一致（含排除 *.dmg.blockmap：
// mac 更新只走 zip，dmg 的增量索引用不上）。
const MIRRORED = /\.(dmg|exe|zip|yml|blockmap)$/i;
const DMG_BLOCKMAP = /\.dmg\.blockmap$/i;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// 网络抖动重试：CI 跨境传 100MB+ 的包偶发失败，重试一次通常就过了。
async function withRetry(label, fn, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e && (e.message || e.error || JSON.stringify(e))) || String(e);
      if (i === attempts) throw new Error(`${label} 失败（已重试 ${attempts} 次）：${msg}`);
      const waitMs = 2000 * i;
      console.warn(`  ! ${label} 第 ${i} 次失败：${msg} —— ${waitMs / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function main() {
  const present = COS_VARS.filter((k) => (process.env[k] || '').trim());
  if (present.length === 0) {
    console.log('未配置 COS Secrets，跳过中国大陆镜像。');
    console.log(`（要启用请在仓库 Secrets 配置：${COS_VARS.join(' / ')}，见 RELEASING.md）`);
    return;
  }
  if (present.length !== COS_VARS.length) {
    const missing = COS_VARS.filter((k) => !present.includes(k));
    throw new Error(`COS Secrets 配置不完整，缺少：${missing.join(' / ')}`);
  }

  const tag = (process.env.TAG || '').trim();
  if (!tag) throw new Error('缺少 TAG（如 v0.4.3）');
  const version = tag.replace(/^v/i, '');

  const artifactsDir = process.env.ARTIFACTS_DIR || 'artifacts';
  if (!fs.existsSync(artifactsDir)) throw new Error(`产物目录不存在：${artifactsDir}`);

  const prefix = (process.env.COS_PREFIX || 'bambu-buddy').replace(/^\/+|\/+$/g, '');
  const bucket = process.env.COS_BUCKET.trim();   // 带 appid 的完整桶名，如 bambu-buddy-1250000000
  const region = process.env.COS_REGION.trim();   // 如 ap-shanghai

  const COS = require('cos-nodejs-sdk-v5');
  const creds = {
    SecretId: process.env.COS_SECRET_ID.trim(),
    SecretKey: process.env.COS_SECRET_KEY.trim(),
  };
  // 关键：GitHub runner 在境外，直连大陆 COS 上传被限速到 ~0.3MB/s（实测），大文件会超时。
  // 上传客户端走「全球加速」域名（就近接入 + 腾讯骨干网回源），跨境上传快很多。
  // 需在 COS 控制台为该桶开启「全球加速」（域名与传输管理 → 全球加速）。默认开启，
  // 想关掉走普通域名可设 COS_USE_ACCELERATE=false（会慢）。
  const useAccelerate = (process.env.COS_USE_ACCELERATE || 'true').toLowerCase() !== 'false';
  const cosUp = new COS({ ...creds, UseAccelerate: useAccelerate, Timeout: 10 * 60 * 1000 });
  // 复制客户端走普通（地域）域名：putObjectCopy 不支持全球加速端点，且复制在 COS 内部完成、
  // 本就不跨境，无需加速。
  const cosCopy = new COS({ ...creds, Timeout: 10 * 60 * 1000 });

  const publicBase = `https://${bucket}.cos.${region}.myqcloud.com`;
  // CopySource 里对象键按段做 URLEncode（保留 /）。
  const copySource = (key) => `${bucket}.cos.${region}.myqcloud.com/`
    + key.split('/').map(encodeURIComponent).join('/');

  const files = walk(artifactsDir)
    .filter((f) => MIRRORED.test(f) && !DMG_BLOCKMAP.test(f));
  if (files.length === 0) throw new Error(`${artifactsDir} 下没找到可镜像的产物`);

  // uploadFile 会按 SliceSize 自动选择简单上传 / 分块上传（100MB+ 的包走分块更稳）。
  async function upload(localPath, key, extra) {
    const size = fs.statSync(localPath).size;
    const mb = (size / 1024 / 1024).toFixed(1);
    await withRetry(`上传 ${key}`, () => cosUp.uploadFile({
      Bucket: bucket,
      Region: region,
      Key: key,
      FilePath: localPath,
      SliceSize: 10 * 1024 * 1024, // >10MB 走分块
      ...extra,
    }));
    console.log(`  ✓ 传 ${key}  (${mb} MB)`);
  }

  // 服务端复制：源和目标都在 COS 内部，不跨境、秒级完成。MetadataDirective:'Replaced'
  // 让副本用新的 Cache-Control（latest//download/ 要 no-cache，与归档区的长缓存不同）。
  async function copy(srcKey, dstKey, extra) {
    await withRetry(`复制 ${dstKey}`, () => cosCopy.putObjectCopy({
      Bucket: bucket,
      Region: region,
      Key: dstKey,
      CopySource: copySource(srcKey),
      MetadataDirective: 'Replaced',
      ...extra,
    }));
    console.log(`  ✓ 复制 ${dstKey}`);
  }

  // 归档路径的内容永不变，可让浏览器长期缓存；
  // latest/ 与 download/ 每次发版被覆盖，必须每次回源校验，
  // 否则用户可能下到上一版、或自动更新读到过期的 latest*.yml。
  const IMMUTABLE = { CacheControl: 'public, max-age=31536000, immutable' };
  const MUTABLE = { CacheControl: 'no-cache' };

  // [1/3] 只在这里真正「跨境上传」——每个文件传一次到归档区，其余两处都从这里服务端复制。
  console.log(`\n[1/3] 跨境上传到归档区 ${prefix}/${tag}/（加速=${useAccelerate}）`);
  const archiveKey = {}; // basename → 归档区 key，供后续复制引用
  for (const f of files) {
    const key = `${prefix}/${tag}/${path.basename(f)}`;
    await upload(f, key, IMMUTABLE);
    archiveKey[path.basename(f)] = key;
  }

  // [2/3] 自动更新 feed：从归档区服务端复制（dmg 不参与，mac 更新走 zip）。
  console.log(`\n[2/3] 服务端复制 → 自动更新 feed ${prefix}/latest/`);
  for (const f of files.filter((f) => !/\.dmg$/i.test(f))) {
    const name = path.basename(f);
    await copy(archiveKey[name], `${prefix}/latest/${name}`, MUTABLE);
  }

  // [3/3] 对外固定直链：从归档区服务端复制，并把版本号从文件名里去掉，链接从此不再变化。
  // 例：Bambu.Buddy-0.4.3-macOS-arm64.dmg → Bambu.Buddy-macOS-arm64.dmg
  // 但同时用 Content-Disposition 指定「另存为」文件名带上版本号：链接固定、下载下来
  // 的文件名却带版本，用户一眼能分清下的是哪一版（每次发版这个头会更新到当前版本）。
  console.log(`\n[3/3] 服务端复制 → 固定下载直链 ${prefix}/download/`);
  const installers = files.filter((f) => /\.dmg$/i.test(f) || /Setup\.exe$/i.test(f));
  const links = {};
  for (const f of installers) {
    const name = path.basename(f); // 带版本号的原名，如 Bambu.Buddy-0.4.2-Windows-x64.Setup.exe
    const stable = name.replace(`-${version}`, '');
    if (stable === name) {
      throw new Error(`文件名里找不到版本号 ${version}，无法生成固定直链：${name}`);
    }
    const key = `${prefix}/download/${stable}`;
    await copy(archiveKey[name], key, {
      ...MUTABLE,
      ContentDisposition: `attachment; filename="${name}"`, // 另存为带版本号的文件名
    });
    // 按「平台-架构」做 key（如 macOS-arm64 / macOS-x64 / Windows-x64）——macOS 有
    // Apple Silicon 与 Intel 两份包，只按平台归会互相覆盖，漏掉一条直链。
    const m = stable.match(/-(macOS|Windows)-(arm64|x64)/);
    if (!m) throw new Error(`文件名里认不出平台/架构，无法生成固定直链：${name}`);
    links[`${m[1]}-${m[2]}`] = `${publicBase}/${key}`;
  }

  // 给 Phase 2 的官网页面留的版本信息：页面读它就能显示最新版本号，
  // 无需再改 CI（纯静态页面没有后端，只能靠这种预生成的 JSON）。
  const manifest = {
    version,
    tag,
    releasedAt: new Date().toISOString(),
    downloads: links,
    releaseNotes: `https://github.com/${process.env.GITHUB_REPOSITORY || 'YingyiDai/bambu-buddy'}/releases/tag/${tag}`,
  };
  const manifestPath = path.join(require('os').tmpdir(), 'latest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await upload(manifestPath, `${prefix}/download/latest.json`, {
    ...MUTABLE,
    ContentType: 'application/json; charset=utf-8',
  });

  console.log('\n=== 中国大陆下载直链（固定，发新版不变）===');
  for (const [target, url] of Object.entries(links)) console.log(`${target.padEnd(14)} ${url}`);
}

main().catch((e) => {
  console.error(`\n镜像到 COS 失败：${(e && (e.message || JSON.stringify(e))) || e}`);
  process.exit(1);
});
