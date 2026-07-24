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
6. **核对并补全发版说明（必做，非可选）**：CI 用 `--generate-notes` 自动生成的说明
   **只会列出「已合并的 PR」**。本项目日常允许直接提交到 `main`（见开头说明），这些
   直提 main、未走 PR 的改动**不会出现在自动说明里**。因此每次发版都要以本区间的完整
   提交为准，确保说明覆盖**本次全部改动**，而不是只有恰好走了 PR 的那部分。

   > **发版说明一律用英文撰写（硬规则）**：面向用户的发版描述（Release notes）**必须全部
   > 用英文**——包括你手写补全的条目。若自动生成说明里带了中文（如中文 PR 标题），补全时
   > 一并译成英文。CI 注入的「📥 Download」引导已是英文，无需处理。

   先看清本次到底改了什么：
   ```bash
   git log --oneline <上个版本 tag>..<本次 tag>   # 如 v0.1.12..v0.1.13
   ```
   逐条比对自动说明；凡是直提 main 的改动没被收录，就编辑 Release 补上：
   ```bash
   gh release edit v0.1.3 --notes-file <说明文件.md>   # 或在 Release 页面手动编辑
   ```

> **发版说明「下载」引导（CI 自动，无需手动）**：release 工作流会在说明**顶部自动注入
> 英文「📥 Download」一节**，直链本版 dmg 与 Setup.exe（资产列表里混着 yml/zip/blockmap，没有引导
> 用户不知道下哪个）。该步骤幂等——说明里已有 `## 📥 Download` 就跳过，故补建/重跑不会重复注入，
> 也不覆盖你手写说明里已放好的引导。想改引导文案见 `.github/workflows/release.yml` 的
> 「注入下载引导」步骤。
>
> **发版说明完整性规则**：一次发版通常打包多次改动（多个 PR + 若干直提 main 的提交）。
> 发版说明必须涵盖本次区间内的**所有**改动，逐一列出、不遗漏。不要直接照搬 `--generate-notes`
> 的结果——它漏掉直提 main 的部分（v0.1.13 就因此只写了一个 PR、漏了「区分用户取消与打印失败」）。
> 若想完全用手写说明，可在推 tag 前先 `gh release create v0.1.3 --notes-file ... --draft`，
> CI 只负责上传资产、不会覆盖你的说明。

## 先出测试包（草稿 Release，可选）

想在正式发版前先拿到全平台安装包自测、但**不想落到公开 Releases 页、也不想惊动老用户的
自动更新**时，用「草稿模式」跑一遍：

1. 仓库 **Actions** 页 → 选 `release` 工作流 → **Run workflow**。
2. `tag` 填测试 tag（如 `v0.4.1-test`）。
3. `ref` 填要打包的 commit/分支（如 `main`，或 `claude/xxx` 特性分支）。
4. **勾选 `draft`**（建成草稿 Release）。
5. 运行结束后，Release 以**草稿**形式存在：只有仓库协作者能在 Releases 页看到（带
   「Draft」标记），**不进公开 releases API**，所以**老版本应用的自动更新不会把它当成最新版拉走**。

命令行触发同理：
```bash
gh workflow run release.yml -f tag=v0.4.1-test -f ref=main -f draft=true
```

自测通过后：
- **要转正**：直接在草稿 Release 页面点 **Publish release** 即可——因为建草稿时用了
  `--target <本次构建的 commit>`，转正时 tag 正好落在你实测过的那份代码上，无需重打。
- **不要了**：在页面删掉这个草稿 Release（连带其关联的测试 tag）即可，不留痕迹。

> 说明：
> - 草稿模式只在 **手动 Run workflow** 时可选；**推 `v*` tag 恒为正式发布**（不经草稿）。
> - 草稿里同样会带 `latest*.yml` 等自动更新资产，但草稿不进 releases API，故对线上用户
>   自动更新无影响——这正是用草稿而非 prerelease 做测试包的原因。
> - 说明顶部「📥 下载」引导里的直链在草稿阶段还打不开（资产要 Publish 后才有公开下载地址），
>   转正后即生效；自测阶段可直接从草稿页的资产列表下载。

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

| 平台 | 产物 | 用途 / 签名 |
|---|---|---|
| macOS（Apple Silicon） | `Bambu.Buddy-<ver>-macOS-arm64.dmg` | 用户手动下载；Developer ID 正式签名 + 公证（CI 自动） |
| macOS（Apple Silicon） | `Bambu.Buddy-update-macOS-arm64-<ver>.zip` | 应用内自动更新专用（Squirrel.Mac 要求 zip）；同签名 |
| Windows（x64） | `Bambu.Buddy-<ver>-Windows-x64.Setup.exe` | 手动下载 + 自动更新共用；未签名 |

> **应用内自动更新依赖的资产（勿删）**：每个 Release 除 dmg/exe 外还带
> `latest-mac.yml` / `latest.yml`（版本清单：文件名 + sha512）、update zip、
> `*.blockmap`（增量下载索引）。老版本应用的自动更新靠读取**最新 Release** 里的
> `latest*.yml` 找到安装包并校验，手动整理资产时删了它们自动更新即失效
> （用户只能回退「查看发布页」手动下载）。
>
> **资产命名兼顾列表排序**：GitHub 资产列表按文件名字母序排、不可自定义。update zip
> 特意命名为 `Bambu.Buddy-update-...`（`u` 排在版本号 `0` 之后），让两个安装包始终
> 排在列表最前。dmg 不生成 blockmap（`dmg.writeUpdateInfo:false`，mac 更新只走 zip
> 用不上），CI 上传也排除 `*.dmg.blockmap` 兜底。发版说明顶部固定放两个安装包的
> 直链下载引导（见下方发版说明规则）。

> 文件名里带 `macOS` / `Windows`（以及 `arm64` / `x64` 架构），下载时一眼就能分清是哪个平台。

- macOS 已做 Developer ID 签名 + Apple 公证，正常下载打开**不再有开发者警告**。
- 本地 `npm run build:mac`（无证书环境）仍走 ad-hoc（`build/adhoc-sign.js`），只用于自测，别拿去分发。
- Windows 未签名，SmartScreen 可能提示「不常见」，点「更多信息 → 仍要运行」。
- 产物文件名由 `package.json` 的 `build.{mac,win}.artifactName` 控制，保持点号风格与历史一致。

## macOS 证书签名与公证（发版硬要求）

**每次 CI 发版都会自动对 macOS 包做 Developer ID 正式签名 + Apple 公证**，无需手动操作。
原理：electron-builder 读取下面的环境变量 → 用 Developer ID 证书签名（强化运行时 +
`build/entitlements.mac.plist`）→ 公证 `.app` 并 staple。**注意 electron-builder 只公证
`.app`，不公证外层 `.dmg`**；而用户下载的是 dmg，未公证的 dmg 在打开时仍会被 Gatekeeper
拦「无法检查是否含恶意软件」。所以 `build/notarize-dmg.js`（`afterAllArtifactBuild` 钩子）
会对最终 dmg 再做一次 `notarytool submit --wait` + `stapler staple`，保证「下载→开 dmg→
拖入应用→启动」全程无警告。`build/adhoc-sign.js` 检测到 `CSC_LINK` 会自动跳过，不覆盖正式签名。

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
