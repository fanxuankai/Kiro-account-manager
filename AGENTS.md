# AGENTS.md

## 项目结构

- 仓库根:CI(workflow)、LICENSE、README。
- 应用代码在 `Kiro-account-manager/` 子目录(Electron + React)。所有 npm 命令在该目录下执行。
- gh 命令必须带 `-R fanxuankai/Kiro-account-manager`:本仓库是 fork,不带 `-R` 会默认指向上游 `chaogei` 而报 404。

## 常用命令

```bash
cd Kiro-account-manager
npm run typecheck        # 类型检查(node + web)
npm run lint             # eslint(存量告警多,只关注新改动的 error)
npm run build            # electron-vite 构建(含 typecheck)
npm run build:mac        # 本地打 mac 安装包(dist/)
npm run fetch:singbox    # 开发模式下载 sing-box 内核到 resources/bin/(hy2 功能前置)
node test/hy2-e2e.mjs    # hy2 桥端到端测试
```

## 打包发布

1. bump `Kiro-account-manager/package.json` 的 version,commit + push(commit message 用中文)。
2. 触发构建:
   ```bash
   gh workflow run build-release.yml -R fanxuankai/Kiro-account-manager
   ```
   约 6 分钟,自动创建 `v{版本}` **草稿** Release(12 个资产)。
3. 发布草稿(不发布则在线更新不可见):
   ```bash
   gh release edit v{版本} -R fanxuankai/Kiro-account-manager --draft=false --latest
   ```

## 约束

- `build-release.yml` 是唯一发布 workflow。不要恢复已删除的 `build.yml`,不要改 workflow 显示名(曾因撞名出现两个 "Build & Release")。
- 同版本重跑构建:release job 会因草稿已存在而失败,先 `gh release delete v{版本} -R fanxuankai/Kiro-account-manager --yes` 再触发。
- macOS 构建 job 固定 `macos-15`:macos-14 的 ARM runner 打 x64 dmg 稳定报 `hdiutil: Device not configured`。
- 构建 run 失败时用 `gh run view <id> -R … --log-failed` 看原始错误行;python 堆栈(plistlib/core.py)是噪音。
