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

## 本地安装

```bash
cd Kiro-account-manager
npm run build:win     # Windows: dist/ 下 NSIS 安装器,双击安装
npm run build:mac     # macOS:  dist/ 下 dmg,按本机架构选(arm64/x64)
npm run build:linux   # Linux:  dist/ 下 AppImage / deb
```

mac 命令行覆盖安装——用未打包产物直拷(比挂载 dmg 简单,不用拼版本号/卷名;应用开着会覆盖失败,先退出):

```bash
cd Kiro-account-manager && npm run build:mac   # 双架构构建,产物在 dist/mac-arm64(Apple Silicon) 与 dist/mac(Intel)
# 按本机架构选未打包产物目录
SRC="dist/mac-arm64/Kiro Account Manager.app"
[ "$(uname -m)" = "x86_64" ] && SRC="dist/mac/Kiro Account Manager.app"
osascript -e 'tell application "Kiro Account Manager" to quit' 2>/dev/null; sleep 2
pkill -f "Kiro Account Manager" 2>/dev/null; sleep 1
rm -rf "/Applications/Kiro Account Manager.app"
cp -R "$SRC" "/Applications/Kiro Account Manager.app"
xattr -cr "/Applications/Kiro Account Manager.app"  # 清除 quarantine 隔离属性(未签名应用必需,否则 Gatekeeper 拦截)
open "/Applications/Kiro Account Manager.app"
```

不要从 GitHub Release 下载安装——本地安装一律用本地构建产物。Windows/Linux 用各自 build:win / build:linux 的安装器双击安装。

- 用户数据不受覆盖安装影响(mac 在 `~/Library/Application Support/kiro-account-manager`);本地验证可不 bump 版本,正式发布前再 bump。

## 打包发布

```bash
# 1. bump Kiro-account-manager/package.json 的 version,commit + push(commit message 用中文)
# 2. 触发构建发布:
gh workflow run build-release.yml -R fanxuankai/Kiro-account-manager
```

约 6 分钟跑完,自动发布 `v{版本}` 正式 Release 并设为 latest,在线更新立即可见。

## 约束

- `build-release.yml` 是唯一发布 workflow。不要恢复已删除的 `build.yml`,不要改 workflow 显示名(曾因撞名出现两个 "Build & Release")。
- 发布直接上线无草稿环节:触发前确认版本号和改动内容无误。
- 同版本重跑构建:release job 会因 Release 已存在而失败,先 `gh release delete v{版本} -R fanxuankai/Kiro-account-manager --yes` 再触发。
- macOS 构建 job 固定 `macos-15`:macos-14 的 ARM runner 打 x64 dmg 稳定报 `hdiutil: Device not configured`。
- 构建 run 失败时用 `gh run view <id> -R … --log-failed` 看原始错误行;python 堆栈(plistlib/core.py)是噪音。
