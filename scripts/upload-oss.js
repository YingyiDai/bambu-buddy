#!/usr/bin/env node
'use strict';

// 把发版产物镜像到阿里云 OSS —— 让中国大陆用户不经 GitHub 也能下载安装包。
// 由 .github/workflows/release.yml 的「镜像到阿里云 OSS」步骤调用，详见 RELEASING.md。
//
// 依赖 ali-oss（阿里云官方 Node SDK），由工作流临时装到 $RUNNER_TEMP、经 NODE_PATH 引入，
// 故意**不**写进 package.json：它只在 release 这个 ubuntu job 用得到，进 devDependencies
// 会让 mac/win 两个构建 job 的 npm ci 白白多装一份，拖慢每次发版。
//
// 同一份产物上传到三处，各有各的用途（别合并，命名诉求是冲突的）：
//   <prefix>/<tag>/     全部产物按原名归档，可回溯任意旧版
//   <prefix>/latest/    应用内自动更新的 generic feed —— electron-updater 按
//                       latest*.yml 里记录的文件名去取包，故这里必须保留带版本号的原名
//   <prefix>/download/  对外公开的固定直链 —— 去掉版本号，地址永不变，
//                       README / 小红书等渠道贴一次就够，以后发新版无需改任何文档
//
// 环境变量：OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_ENDPOINT
//           TAG（如 v0.4.3）、ARTIFACTS_DIR（默认 artifacts）、OSS_PREFIX（默认 bambu-buddy）
// 四个 OSS 变量一个都没配 → 视为「尚未接入 OSS」，跳过并正常退出（不让发版变红）；
// 配了一部分 → 视为配错，直接报错，避免只上传半套、大陆用户拿到不完整的版本。

const fs = require('fs');
const path = require('path');

const OSS_VARS = ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_ENDPOINT'];

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
      const msg = (e && e.message) || String(e);
      if (i === attempts) throw new Error(`${label} 失败（已重试 ${attempts} 次）：${msg}`);
      const waitMs = 2000 * i;
      console.warn(`  ! ${label} 第 ${i} 次失败：${msg} —— ${waitMs / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function main() {
  const present = OSS_VARS.filter((k) => (process.env[k] || '').trim());
  if (present.length === 0) {
    console.log('未配置 OSS Secrets，跳过中国大陆镜像。');
    console.log(`（要启用请在仓库 Secrets 配置：${OSS_VARS.join(' / ')}，见 RELEASING.md）`);
    return;
  }
  if (present.length !== OSS_VARS.length) {
    const missing = OSS_VARS.filter((k) => !present.includes(k));
    throw new Error(`OSS Secrets 配置不完整，缺少：${missing.join(' / ')}`);
  }

  const tag = (process.env.TAG || '').trim();
  if (!tag) throw new Error('缺少 TAG（如 v0.4.3）');
  const version = tag.replace(/^v/i, '');

  const artifactsDir = process.env.ARTIFACTS_DIR || 'artifacts';
  if (!fs.existsSync(artifactsDir)) throw new Error(`产物目录不存在：${artifactsDir}`);

  const prefix = (process.env.OSS_PREFIX || 'bambu-buddy').replace(/^\/+|\/+$/g, '');
  const bucket = process.env.OSS_BUCKET.trim();
  // 允许 secret 里写成带或不带协议的 endpoint，统一归一化成 https。
  const rawEndpoint = process.env.OSS_ENDPOINT.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  const OSS = require('ali-oss');
  const client = new OSS({
    accessKeyId: process.env.OSS_ACCESS_KEY_ID.trim(),
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET.trim(),
    bucket,
    endpoint: `https://${rawEndpoint}`,
    secure: true,
    timeout: 10 * 60 * 1000, // 100MB+ 的包，默认超时不够
  });

  const publicBase = `https://${bucket}.${rawEndpoint}`;

  const files = walk(artifactsDir)
    .filter((f) => MIRRORED.test(f) && !DMG_BLOCKMAP.test(f));
  if (files.length === 0) throw new Error(`${artifactsDir} 下没找到可镜像的产物`);

  // 上传：小文件直传，大文件走分片（100MB+ 单次 PUT 容易断在跨境链路上）。
  async function upload(localPath, key, headers) {
    const size = fs.statSync(localPath).size;
    const mb = (size / 1024 / 1024).toFixed(1);
    await withRetry(`上传 ${key}`, async () => {
      if (size > 10 * 1024 * 1024) {
        await client.multipartUpload(key, localPath, { headers, parallel: 4, partSize: 10 * 1024 * 1024 });
      } else {
        await client.put(key, localPath, { headers });
      }
    });
    console.log(`  ✓ ${key}  (${mb} MB)`);
  }

  // 归档路径的内容永不变，可以让浏览器长期缓存；
  // latest/ 与 download/ 每次发版都被覆盖，必须每次回源校验，
  // 否则用户可能下到上一版、或自动更新读到过期的 latest*.yml。
  const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable' };
  const MUTABLE = { 'Cache-Control': 'no-cache' };

  console.log(`\n[1/3] 归档到 ${prefix}/${tag}/`);
  for (const f of files) {
    await upload(f, `${prefix}/${tag}/${path.basename(f)}`, IMMUTABLE);
  }

  // 自动更新 feed：dmg 不参与（mac 更新走 zip），其余原名上传。
  console.log(`\n[2/3] 自动更新 feed → ${prefix}/latest/`);
  for (const f of files.filter((f) => !/\.dmg$/i.test(f))) {
    await upload(f, `${prefix}/latest/${path.basename(f)}`, MUTABLE);
  }

  // 对外固定直链：把版本号从文件名里去掉，链接从此不再变化。
  // 例：Bambu.Buddy-0.4.3-macOS-arm64.dmg → Bambu.Buddy-macOS-arm64.dmg
  console.log(`\n[3/3] 固定下载直链 → ${prefix}/download/`);
  const installers = files.filter((f) => /\.dmg$/i.test(f) || /Setup\.exe$/i.test(f));
  const links = {};
  for (const f of installers) {
    const stable = path.basename(f).replace(`-${version}`, '');
    if (stable === path.basename(f)) {
      throw new Error(`文件名里找不到版本号 ${version}，无法生成固定直链：${path.basename(f)}`);
    }
    const key = `${prefix}/download/${stable}`;
    await upload(f, key, MUTABLE);
    links[/\.dmg$/i.test(f) ? 'macOS' : 'Windows'] = `${publicBase}/${key}`;
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
    'Content-Type': 'application/json; charset=utf-8',
  });

  console.log('\n=== 中国大陆下载直链（固定，发新版不变）===');
  for (const [os, url] of Object.entries(links)) console.log(`${os.padEnd(8)} ${url}`);
}

main().catch((e) => {
  console.error(`\n镜像到 OSS 失败：${(e && e.message) || e}`);
  process.exit(1);
});
