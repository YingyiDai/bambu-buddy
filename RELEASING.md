# 发版流程

> 全平台（macOS arm64 + Windows x64）打包与发版由 GitHub Actions 自动完成。
> 工作流定义：`.github/workflows/release.yml`

> 日常开发默认直接提交到 `main`，不强制走 PR。仅当明确要求 review 时才开 PR。

## 日常发版（推荐）

每次发版**必须全平台重新打包**，不要只发某一平台。流程：

1. 改完代码，确认本地测试通过：
   ```bash
   node --test 'test/**/*.test.js'
   ```
2. 升版本号：编辑 `package.json` 的 `"version"`（如 `0.1.3`）。
3. 提交：
   ```bash
   git commit -am "release: v0.1.3"
   ```
4. 打 tag 并推送（**推 tag 即触发 CI 全平台打包 + 自动发布**）：
   ```bash
   git tag v0.1.3
   git push origin main v0.1.3
   ```
5. CI 在 `macos-latest` 和 `windows-latest` 上各打一份安装包，上传到 Release `v0.1.3`。
6.（可选）补充发版说明：在 Release 页面编辑，或
   ```bash
   gh release edit v0.1.3 --notes-file <说明文件.md>
   ```

> CI 会在 Release 不存在时自动创建一份（带自动生成的说明）；如想用手写说明，
> 可在推 tag 前先 `gh release create v0.1.3 --notes-file ... --draft`，CI 只负责上传资产。

## 补建 / 重跑某个版本

若某个版本的安装包缺失或需重打（例如本次 v0.1.2 漏了 Windows）：

1. 仓库 **Actions** 页 → 选 `release` 工作流 → **Run workflow**。
2. `tag` 填目标版本（如 `v0.1.2`，必填）。
3. `ref` 留空则从该 tag 构建；若构建配置在该 tag 之后才合入，填 `main` 从最新代码构建（应用代码一致即可）。
4. 运行结束，资产以 `--clobber` 覆盖上传到对应 Release。

也可命令行触发：
```bash
gh workflow run release.yml -f tag=v0.1.2 -f ref=main
```

## 产物

| 平台 | 产物 | 签名 |
|---|---|---|
| macOS（Apple Silicon） | `Bambu.Buddy-<ver>-arm64.dmg` | Developer ID 正式签名 + 公证（CI 自动） |
| Windows（x64） | `Bambu.Buddy.Setup.<ver>.exe` | 未签名 |

- macOS 已做 Developer ID 签名 + Apple 公证，正常下载打开**不再有开发者警告**。
- 本地 `npm run build:mac`（无证书环境）仍走 ad-hoc（`build/adhoc-sign.js`），只用于自测，别拿去分发。
- Windows 未签名，SmartScreen 可能提示「不常见」，点「更多信息 → 仍要运行」。
- 产物文件名由 `package.json` 的 `build.{mac,win}.artifactName` 控制，保持点号风格与历史一致。

## macOS 证书签名与公证（发版硬要求）

**每次 CI 发版都会自动对 macOS 包做 Developer ID 正式签名 + Apple 公证**，无需手动操作。
原理：electron-builder 读取下面的环境变量 → 用 Developer ID 证书签名（强化运行时 +
`build/entitlements.mac.plist`）→ 上传 Apple 公证服务 → staple 票据到 `.dmg`。
`build/adhoc-sign.js` 检测到 `CSC_LINK` 会自动跳过，不会覆盖正式签名。

配置全部来自 GitHub Actions Secrets（一次性配好，长期自动生效）：

| Secret | 含义 | 来源 |
|---|---|---|
| `CSC_LINK` | Developer ID Application 证书 + 私钥打包成的 `.p12`，再 base64 | developer.apple.com 用 CSR 签发 `.cer`，与私钥合成 `.p12` |
| `CSC_KEY_PASSWORD` | 上面 `.p12` 的密码 | 生成 `.p12` 时自定 |
| `APPLE_API_KEY_P8` | App Store Connect API Key（`.p8` 文件）的 base64，公证用 | appstoreconnect.apple.com → Users and Access → Integrations → 生成 Team Key |
| `APPLE_API_KEY_ID` | 上面 API Key 的 Key ID（10 位） | 同上（也是 `.p8` 文件名里的那串） |
| `APPLE_API_ISSUER` | API Key 的 Issuer ID（UUID） | Keys 页面顶部 |

> 注意事项：
> - Developer ID 证书有效期 5 年；到期需重新签发并更新 `CSC_LINK`。
> - App Store Connect API Key 的 `.p8` **只能下载一次**，务必保存好；丢了就作废重建。
> - 私钥（生成 CSR 时的 `devid.key`）不要提交进仓库、不要外发；`.p12` 已含私钥。
> - 需要有效的付费 Apple Developer Program 会员（$99/年），否则证书与公证都不可用。

## 为什么用 CI 而非本地打包

本机为 Apple Silicon 无 wine，跨平台打 Windows `.exe` 不可靠；且 macOS 签名/公证证书统一
放在 CI 的 Secrets 里（本机 keychain 不装证书）。用 GitHub Actions 在各自原生 runner 上构建，
既不依赖本地环境，也保证每次都全平台、正式签名、不会漏。
