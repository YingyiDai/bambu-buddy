// 检查更新模块：GitHub Releases API + semver 比较。
// 纯逻辑，无 Electron 依赖 —— 可在 Node.js 环境独立测试。
// 参照 bambu-auth.js 的 httpsJson 风格（内置 https、归一化返回）。

const https = require('https');

// ---- semver 比较 ----
function compareSemver(a, b) {
  // 去 v 前缀
  const strip = (s) => String(s).replace(/^v/i, '');
  const aa = strip(a).split('.').map(Number);
  const bb = strip(b).split('.').map(Number);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const na = aa[i] || 0;
    const nb = bb[i] || 0;
    if (na < nb) return -1;  // a < b
    if (na > nb) return 1;   // a > b
  }
  return 0; // equal
}

function isValidSemverLike(v) {
  return /^\d+\.\d+\.\d+/.test(String(v).replace(/^v/i, ''));
}

// ---- HTTPS 请求 ----
// 底层 GET：只负责发请求、收 body，返回 { statusCode, headers, body }。
// 抽成这个形状是为了让 main.js 能注入一个走 Electron net（尊重系统代理）的实现，
// 而默认实现仍用 Node 原生 https，保证本模块无 Electron 依赖、可独立单测。
function httpsGetRaw(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host,
        path,
        headers: {
          'User-Agent': 'bambu-buddy/0.1',
          Accept: 'application/vnd.github.v3+json',
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: chunks });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

// 取某个 header 值：Node https 返回 string，Electron net 返回 string[]，统一成 string。
function headerValue(headers, name) {
  const v = headers && (headers[name] || headers[name.toLowerCase()]);
  return Array.isArray(v) ? v[0] : v;
}

// 用给定的底层 GET 拿 JSON，并处理限流 / 错误码 / 解析。
async function fetchGithubJson(getRaw, host, path) {
  const { statusCode, headers, body } = await getRaw(host, path);
  // 限流检测
  if (statusCode === 403 && headerValue(headers, 'x-ratelimit-remaining') === '0') {
    throw new Error('GitHub API 限流，请稍后再试');
  }
  if (statusCode >= 400) {
    throw new Error(`HTTP ${statusCode}: ${String(body).slice(0, 200)}`);
  }
  return body ? JSON.parse(body) : {};
}

// ---- 入口 ----
/**
 * 检查 GitHub Releases 是否有更新。
 * repoUrl 来自 package.json 的 repository.url（如 https://github.com/owner/repo）。
 * 返回归一化结果，不抛异常。
 *
 * @param {string} currentVersion - 当前版本号，如 "0.1.0"
 * @param {string} [repoUrl] - GitHub 仓库 URL；未提供则尝试从 package.json 读取
 * @param {(host:string, path:string)=>Promise<{statusCode:number, headers:object, body:string}>} [getRaw]
 *        底层 GET 实现；默认走 Node https。main.js 会注入走 Electron net（尊重系统代理）的实现，
 *        以便在需要代理的网络环境（如中国大陆经代理访问 GitHub）下也能连上 api.github.com。
 * @returns {Promise<{hasUpdate:boolean, currentVersion:string, latestVersion:string|null, releaseUrl:string|null, releaseName:string|null, error:string|null}>}
 */
async function checkForUpdates(currentVersion, repoUrl, getRaw = httpsGetRaw) {
  // 1. 取 repo 地址
  if (!repoUrl) {
    try {
      const pkg = require('../../package.json');
      repoUrl = (pkg.repository && pkg.repository.url) || '';
    } catch { /* ignore */ }
  }
  if (!repoUrl) {
    return { hasUpdate: false, currentVersion, latestVersion: null, releaseUrl: null, releaseName: null, error: '未配置仓库地址' };
  }

  // 2. 从 URL 提取 owner/repo
  const m = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  if (!m) {
    return { hasUpdate: false, currentVersion, latestVersion: null, releaseUrl: null, releaseName: null, error: '无法解析仓库地址' };
  }
  const owner = m[1];
  const repo = m[2];

  // 3. 请求最新 release
  let latest;
  try {
    latest = await fetchGithubJson(getRaw, 'api.github.com', `/repos/${owner}/${repo}/releases/latest`);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { hasUpdate: false, currentVersion, latestVersion: null, releaseUrl: null, releaseName: null, error: humanizeError(msg) };
  }

  // 4. 提取版本号
  const tag = (latest && latest.tag_name) || '';
  if (!tag || !isValidSemverLike(tag)) {
    return { hasUpdate: false, currentVersion, latestVersion: tag || null, releaseUrl: latest && latest.html_url || null, releaseName: latest && latest.name || null, error: tag ? '发布 tag 格式不支持' : '未找到发布版本' };
  }

  const latestVer = String(tag).replace(/^v/i, '');
  const hasUpdate = compareSemver(currentVersion, latestVer) < 0;

  return {
    hasUpdate,
    currentVersion,
    latestVersion: latestVer,
    releaseUrl: latest.html_url || `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
    releaseName: latest.name || tag,
    error: null,
  };
}

function humanizeError(msg) {
  // 覆盖 Node（ECONNRESET / socket disconnected / secure TLS）与 Electron net（net::ERR_*）两类网络错误。
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|getaddrinfo|socket disconnected|secure TLS|TLS connection|net::ERR|超时/i.test(msg)) {
    return '网络连接失败，请检查网络或代理';
  }
  return msg;
}

module.exports = { checkForUpdates, compareSemver };
