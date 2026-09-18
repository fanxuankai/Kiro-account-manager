# AGENTS.md — GitHub Actions 事项

本仓库(外层)的 CI/发布约定。应用代码在 `Kiro-account-manager/` 子目录。

## 发布链(唯一)

- **唯一发布 workflow:`.github/workflows/build-release.yml`**(workflow_dispatch 手动触发)。
  - `build.yml` 是历史遗留、与它撞名,已于 2026-09-18 删除——**不要恢复**;
  - `build-app.yml` 是它的前身,更名而来——**不要改回 Build App 等名字**,避免 Actions 列表再出现同名混淆。
- 触发:`gh workflow run build-release.yml -R fanxuankai/Kiro-account-manager`
  - **必须带 `-R fanxuankai/Kiro-account-manager`**:本仓库是 `chaogei/Kiro-account-manager` 的 fork,`gh` 不带 `-R` 会默认指向上游而 404。
- 结构:Windows(NSIS x64)+ macOS(dmg/zip 双架构)→ release job 汇总建**草稿** `v{version}`(版本取 `Kiro-account-manager/package.json`)。

## 发布流程

1. 发版前 bump `Kiro-account-manager/package.json` 版本号,提交(习惯:`chore(release): 版本 x.y.z——汇总…`)并 push。
2. 触发 workflow,等约 6 分钟。
3. **CI 只建草稿,不算发布**。草稿资产应共 12 个(win setup+blockmap+latest.yml + mac dmg/zip×双架构+blockmap)。确认后:
   `gh release edit v{version} -R fanxuankai/Kiro-account-manager --draft=false --latest`
4. 在线更新(generic 静态源 `releases/latest/download`)**只认已发布的 Latest**——不 Publish 则所有用户检查更新无反应,这是"发布后仍查不到新版本"的头号原因。

## 已钉死的坑

- **同版本重发会失败**:release job 用 `gh release create v{version}`,同 tag 草稿已存在即报 already_exists。改完代码要重发同一版本时,先 `gh release delete v{版本} --yes` 删旧草稿再触发。
- **mac 构建机必须 `macos-15`**:macos-14 的 ARM runner 打 x64 dmg 时 `hdiutil: create failed - Device not configured` 稳定复现(2026-09-18 起连续两次,同配置本地与 macos-15 均正常;runner 镜像 tag 未变 = 底层宿主问题)。勿退回 macos-14。
- **run 失败排查**:`gh run view <id> -R … --log-failed`;先看失败 step 的原始错误行(如 `hdiutil:`、`Exit code`),python 堆栈(plistlib/core.py)通常是噪音。
- **gh run watch / 长等待命令会占住会话**,用户不要盯进度时直接查一次状态即可。
- **sing-box 内核(hy2 支持依赖)**:两平台 build job 各自 `node scripts/fetch-singbox.mjs` 下载进 `resources/bin/`(extraResources 随包);mac 默认双架构各一份,`afterPack-trim-singbox.cjs` 裁掉异架构那份。内核不入 git(.gitignore)。
