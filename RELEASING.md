# 发版流程

> 全平台（macOS arm64 + macOS x64 + Windows x64）打包与发版由 GitHub Actions 自动完成。
> 工作流定义：`.github/workflows/release.yml`

> 日常开发默认直接提交到 `main`，不强制走 PR。仅当明确要求 review 时才开 PR。

## 日常发版（推荐）

每次发版**必须全平台重新打包**，不要只发某一平台。流程：

1. 改完代码，确认本地测试通过：
   ```bash
   node --test 'test/**/*.test.js'
   ```
2. 升版本号：编辑 `package.json` 的 `"version"`（如 `0.1.3`）。
3. **写本版英文发版说明**：编辑仓库根目录的 `RELEASE_NOTES.md`，覆盖成**本次这一版**的
   内容。这份文件就是 Release 正文，CI 直接采用——**不再** 用 `--generate-notes` 照抄
   PR 标题（那会把中文 PR 标题带进说明）。要求见下方「发版说明规则」。
4. 提交：
   ```bash
   git commit -am "release: v0.1.3"
   ```
5. 打 tag 并推送（**推 tag 即触发 CI 全平台打包 + 自动发布**）：
   ```bash
   git tag v0.1.3
   git push origin main v0.1.3
   ```
6. CI 在 `macos-latest` 和 `windows-latest` 上各打一份安装包，上传到 Release `v0.1.3`，
   并**用 `RELEASE_NOTES.md` 作为发版说明**（顶部自动叠加英文「📥 Download」下载引导、
   自动附「Full Changelog」比较链接）。发布后无需再手动改说明。

> **发版说明「下载」引导（CI 自动，无需手动）**：release 工作流会在说明**顶部自动注入
> 英文「📥 Download」一节**，直链本版 dmg 与 Setup.exe（资产列表里混着 yml/zip/blockmap，没有引导
> 用户不知道下哪个）。该步骤幂等——说明里已有 `## 📥 Download` 就跳过，故补建/重跑不会重复注入，
> 也不覆盖你手写说明里已放好的引导。想改引导文案见 `.github/workflows/release.yml` 的
> 「注入下载引导」步骤。
>
> ## 发版说明规则（`RELEASE_NOTES.md`）
>
> 发版说明来自仓库根目录的 **`RELEASE_NOTES.md`**，发版前手写好、每版覆盖一次。它就是
> Release 正文（CI 会在其上方叠加下载引导、下方附 Full Changelog 链接）。三条硬要求，
> **由 CI 强制、不达标发版直接失败**（不再靠人事后自觉）：
>
> 1. **必须全英文（硬规则）**：面向用户的发版说明**必须全部用英文**。CI 会扫描说明，
>    含任何中日韩字符即让发版 job 变红（emoji 如 🇨🇳 不受影响）。这条从机制上杜绝了
>    「中文 PR 标题混进说明」——因为根本不再读 PR 标题。
> 2. **不得为空**：`RELEASE_NOTES.md` 缺失或为空时 CI 直接失败，绝不用自动生成的 PR
>    标题兜底。
> 3. **必须覆盖本次全部改动**：一次发版通常打包多次改动（多个 PR + 若干直提 main 的
>    提交）。逐条列全，别漏直提 main 的部分。先看清本次到底改了什么：
>    ```bash
>    git log --oneline <上个版本 tag>..HEAD   # 如 v0.4.3..HEAD
>    ```
>
> 想先出测试包又不覆盖正式说明，见下方「先出测试包（草稿 Release）」——草稿同样读
> `RELEASE_NOTES.md`、同样受上述硬闸约束。

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
| macOS（Intel） | `Bambu.Buddy-<ver>-macOS-x64.dmg` | 同上，给 Intel Mac；在 Apple Silicon runner 上交叉打包 |
| macOS（Intel） | `Bambu.Buddy-update-macOS-x64-<ver>.zip` | 同上，Intel 的自动更新包 |
| Windows（x64） | `Bambu.Buddy-<ver>-Windows-x64.Setup.exe` | 手动下载 + 自动更新共用；未签名 |

> **应用内自动更新依赖的资产（勿删）**：每个 Release 除 dmg/exe 外还带
> `latest-mac.yml` / `latest.yml`（版本清单：文件名 + sha512）、update zip、
> `*.blockmap`（增量下载索引）。老版本应用的自动更新靠读取**最新 Release** 里的
> `latest*.yml` 找到安装包并校验，手动整理资产时删了它们自动更新即失效
> （用户只能回退「查看发布页」手动下载）。
>
> **资产命名兼顾列表排序**：GitHub 资产列表按文件名字母序排、不可自定义。update zip
> 特意命名为 `Bambu.Buddy-update-...`（`u` 排在版本号 `0` 之后），让三个安装包始终
> 排在列表最前。dmg 不生成 blockmap（`dmg.writeUpdateInfo:false`，mac 更新只走 zip
> 用不上），CI 上传也排除 `*.dmg.blockmap` 兜底。发版说明顶部固定放三个安装包的
> 直链下载引导（见下方发版说明规则）。

> 文件名里带 `macOS` / `Windows`（以及 `arm64` / `x64` 架构），下载时一眼就能分清是哪个平台。

- macOS 已做 Developer ID 签名 + Apple 公证，正常下载打开**不再有开发者警告**。
- 本地 `npm run build:mac`（无证书环境）仍走 ad-hoc（`build/adhoc-sign.js`），只用于自测，别拿去分发。
- Windows 未签名，SmartScreen 可能提示「不常见」，点「更多信息 → 仍要运行」。
- 产物文件名由 `package.json` 的 `build.{mac,win}.artifactName` 控制，保持点号风格与历史一致。

### macOS Intel（x64）包是怎么来的

CI 的 mac runner 是 Apple Silicon，两个架构都在这一台上打（`package.json` 的
`build.mac.target` 里给 dmg/zip 各列了 `arm64` + `x64`）。electron-builder 会自行下载 x64
版 Electron，签名与公证对架构无感，所以**不需要第二台 Intel 机器**。两个要注意的点：

1. **koffi 的原生包必须手动补装**。原生二进制按平台拆成 optionalDependencies
   （`@koromix/koffi-darwin-x64`，带 `cpu=x64/os=darwin` 门控），arm64 机器上 `npm ci`
   **只装 arm64 那份**。release.yml 里的「补装 Intel（x64）用的 koffi 原生包」这步
   （`npm i --no-save --force @koromix/koffi-darwin-x64@<koffi 版本>`）就是为此。漏掉不会崩——
   `src/core/fullscreen-watch.js` 有 try/catch 兜底——但「全屏自动隐藏」在 Intel 机上会
   **静默失灵**，这类问题最难被发现，所以 CI 里加了硬闸（下条）。
   > 本地 `npm run build:mac` 现在同样会打两份。没补装的话本地那份 x64 就缺 koffi，
   > 自测全屏隐藏时别拿它当准。
2. **CI 硬闸「校验 arm64 / x64 两份产物」**：逐个 `.app` 用 `lipo -archs` 核对主程序架构，
   并确认自身架构的 `@koromix/koffi-darwin-*` 确实打进了 `app.asar.unpacked`；再检查
   `latest-mac.yml` 同时列出两个架构的 zip（应用内更新靠它选包——electron-updater 按文件名
   里的 `arm64` 过滤，x64 机器排除 arm64 包，少一条就有一半用户更新时拿到错架构的包）。
   任一条不满足直接让 job 变红。

**没有 Intel 真机也能自测**：x64 包是纯 Intel 二进制，在 Apple Silicon 上双击即自动走
Rosetta（首次会提示安装 Rosetta），能覆盖启动、MQTT、koffi 全屏检测这几条主路径。
确认它确实以 Intel 模式在跑：活动监视器里该进程的「种类」应显示 **Intel**，或：

```bash
lipo -archs "/Applications/Bambu Buddy.app/Contents/MacOS/Bambu Buddy"
```

## 中国大陆下载镜像（腾讯云 COS）

中国大陆用户普遍访问不了 GitHub，既下不到安装包，应用内自动更新也连不上。因此每次正式
发版，CI 会把产物**自动镜像一份到腾讯云 COS**（`.github/workflows/release.yml` 的
「镜像到腾讯云 COS」步骤 → `scripts/upload-cos.js`）。**配好一次之后无需任何手动操作。**

### 一次性配置

> 📖 零基础一步步操作见本地 **`docs/腾讯云COS配置指南.md`**（`docs/` 已 gitignore，不公开）。
> 下面是速览。

1. 注册腾讯云账号并完成个人实名认证，开通**对象存储 COS**（免费开通，按量计费）。
2. 建存储桶：地域选**大陆区域**（如上海 `ap-shanghai`，大陆下载最快），访问权限选
   **公有读私有写**。
   > 用 COS **默认域名**下载**不需要 ICP 备案**；备案只在绑自定义域名做网页时才需要。
3. **开启该桶的「全球加速」**（存储桶 → 域名与传输管理 → 全球加速 → 启用）。
   > 为什么必须开：GitHub runner 在境外，直连大陆 COS 上传实测仅 ~0.3MB/s，350MB
   > 要跑 20 分钟必然超时。CI 上传走全球加速域名后大幅提速；**用户下载仍走普通大陆
   > 域名、不受影响、也不产生加速费**。加速流量只发生在 CI 上传（每次约 350MB，
   > 服务端复制不占跨境流量），成本可忽略。
4. 建 **CAM 子账号**，授予 COS 写权限（最小权限见配置指南文末的自定义策略），生成
   API 密钥（SecretId/SecretKey）。不要用主账号密钥。
5. 在仓库 Settings → Secrets and variables → Actions 配置 4 个 Secret：

   | Secret | 含义 | 示例 |
   |---|---|---|
   | `COS_SECRET_ID` | CAM 子账号 SecretId | `AKIDxxxx` |
   | `COS_SECRET_KEY` | CAM 子账号 SecretKey | |
   | `COS_BUCKET` | 存储桶名（**带 APPID 的完整名**） | `bambu-buddy-dl-1250000000` |
   | `COS_REGION` | 存储桶所在地域代号 | `ap-shanghai` |

5. 建议在腾讯云费用中心设**费用预警**（如 50 元/月），防止被刷流量产生意外账单。

> 应用内自动更新的**大陆回退地址**硬编码在 `src/core/updater.js` 的 `CN_UPDATE_FEED`
> （指向本桶的 `bambu-buddy/latest/`）。**若将来更换存储桶/地域，记得同步改这个常量**，
> 否则大陆用户的应用内自动更新会回退失败（初次下载走的是 `download/` 直链，不受影响）。

### 每次发版 CI 自动做什么

产物会上传到三处，各有各的用途（命名诉求冲突，故不能合并）：

| 路径 | 内容 | 用途 |
|---|---|---|
| `bambu-buddy/<tag>/` | 全部产物，**原名** | 归档，可回溯任意旧版 |
| `bambu-buddy/latest/` | yml + zip + exe + blockmap，**原名** | 应用内自动更新的 generic feed；文件名必须与 `latest*.yml` 里记录的一致 |
| `bambu-buddy/download/` | 三个安装包，**去掉版本号** | 对外公开的固定直链 + `latest.json`（版本信息） |

### 👉 给大陆用户的下载链接（就发这三条）

```
https://<bucket>.cos.<region>.myqcloud.com/bambu-buddy/download/Bambu.Buddy-macOS-arm64.dmg
https://<bucket>.cos.<region>.myqcloud.com/bambu-buddy/download/Bambu.Buddy-macOS-x64.dmg
https://<bucket>.cos.<region>.myqcloud.com/bambu-buddy/download/Bambu.Buddy-Windows-x64.Setup.exe
```

macOS 两条按芯片分：`arm64` 给 Apple 芯片（M1/M2/M3…），`x64` 给 Intel Mac。发给用户时
顺手带一句「不确定就点左上角苹果菜单 → 关于本机」，能省掉大部分「下错了打不开」的私信。

这三条地址**永不变**：CI 每次发版都把最新安装包用这个去掉版本号的固定名覆盖上去。
所以贴到小红书 / QQ 群 / 贴吧等渠道**一次就够**，以后发新版无需重贴、无需改任何文档。

> 忘了链接也不要紧：每次发版的 Actions 日志末尾，「镜像到腾讯云 COS」这步会把三条
> 完整地址打印出来（见 `scripts/upload-cos.js` 结尾的「中国大陆下载直链」）。

> 说明：
> - **草稿模式（`draft=true`）跳过镜像**：草稿是自测包，覆盖 `latest/` 会让线上用户
>   自动更新到测试版，覆盖 `download/` 会让公开直链指向测试版。
> - **未配置上述 4 个 Secret 时该步骤自行跳过**并正常退出，不会让发版流程变红。
> - `latest/` 与 `download/` 每次发版被覆盖，故设 `Cache-Control: no-cache`（每次回源
>   校验），避免用户下到上一版、或自动更新读到过期的 `latest*.yml`；`<tag>/` 内容不变，
>   设长期缓存。
> - 镜像失败会让 release job 变红（GitHub Release 本身已发布成功）。重跑方式同
>   「补建 / 重跑某个版本」，资产覆盖上传，可安全重复执行。

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
