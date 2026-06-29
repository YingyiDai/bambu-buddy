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
| macOS（Apple Silicon） | `Bambu.Buddy-<ver>-arm64.dmg` | ad-hoc（`build/adhoc-sign.js`） |
| Windows（x64） | `Bambu.Buddy.Setup.<ver>.exe` | 未签名 |

- macOS 首次打开若被拦：**系统设置 → 隐私与安全性 → 仍要打开**。
- Windows 未签名，SmartScreen 可能提示「不常见」，点「更多信息 → 仍要运行」。
- 产物文件名由 `package.json` 的 `build.{mac,win}.artifactName` 控制，保持点号风格与历史一致。

## 为什么用 CI 而非本地打包

本地无 Apple Developer 证书、且本机为 Apple Silicon 无 wine，跨平台打 Windows `.exe` 不可靠。
用 GitHub Actions 在各自原生 runner 上构建，既不依赖本地环境，也保证每次都全平台、不会漏。
