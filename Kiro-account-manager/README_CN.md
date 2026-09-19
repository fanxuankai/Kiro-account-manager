# Kiro 账户管理器

<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Kiro Logo">
</p>

<p align="center">
  <strong>一个功能强大的 Kiro IDE 多账号管理工具</strong>
</p>

<p align="center">
  支持多账号快速切换、自动 Token 刷新、分组标签管理、机器码管理等功能
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

---

## ✨ 功能特性

### 🔐 多账号管理
- 添加、编辑、删除多个 Kiro 账号
- 一键快速切换账号
- 支持 Builder ID 和社交登录（Google/GitHub）方式
- 批量导入/导出账号数据

### 🔄 自动刷新
- Token 过期前自动刷新
- 刷新后自动更新账号用量和订阅信息
- 开启自动切换后，定时检查所有账号余额

### 📁 分组与标签
- 使用分组和标签灵活组织账号
- 批量设置账号的分组/标签

### 🔑 机器码管理
- 修改设备标识符，防止账号关联封禁
- 切换账号时自动切换机器码
- 为每个账号分配唯一绑定的机器码

### 🔄 自动切换账号
- 余额不足时自动切换到可用账号
- 可配置余额阈值和检查间隔

### ⚙️ Kiro IDE 设置同步
- 同步 Kiro IDE 设置（Agent 模式、模型、MCP 服务器等）
- 编辑 MCP 服务器配置
- 管理用户规则（Steering 文件）

### 🌐 多语言支持
- 完整的中英文双语界面
- 自动检测系统语言或手动选择

### 🎨 个性化
- 21 种主题颜色可选
- 深色/浅色模式切换
- 隐私模式隐藏敏感信息

### 📝 账号注册
- 内置 Kiro Builder ID 注册功能
- 四种模式：手动、Outlook IMAP、自建域名（TempMail.Plus）、混合（加权轮询）
- 并发批量注册 + 限速 + 退避 + 风控自动暂停
- 失败重试队列（按错误类型分桶）
- 暂停/恢复 + 进度持久化
- 定时启动 + 每日配额 + 星期掩码
- 注册策略模板（保存/加载/导入/导出）
- 注册结果分析报表（圆环图、24h 曲线、7 日趋势、失败原因、CSV 导出）
- 邮箱占用黑名单 + 经验型预校验
- 完整 i18n 支持

### 🌐 代理支持
- 内置代理池（http/https/socks5/socks4），4 种调度策略 + 自动验活 + 定时刷新

### 🔔 通知与运维
- Webhook 通知（钉钉/企微/飞书/Telegram/Discord/自定义），7 种事件订阅
- 统一任务中心（全局进度面板）
- 一键诊断面板（网络/Kiro/AWS/邮箱/代理连通性）
- 账号数据导入导出（含 AES-GCM 加密选项）

---

## 📸 截图

### 主页
![主页](resources/主页.png)

### 账户管理
![账户管理](resources/账户管理.png)

### 机器码管理
![机器码管理](resources/机器码管理.png)

### 设置
![设置](resources/设置.png)

### Kiro IDE 设置
![Kiro 设置](resources/Kiro%20设置.png)

### 主题颜色
![主题颜色](resources/主题色.png)

### 关于
![关于](resources/关于.png)

---

## 🛠️ 技术栈

- **前端框架**: React 18 + TypeScript
- **桌面框架**: Electron
- **状态管理**: Zustand
- **UI 组件**: Radix UI + Tailwind CSS
- **图标库**: Lucide React
- **构建工具**: Vite

---

## 🚀 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 类型检查
npm run typecheck
```

---

## 📋 更新日志

### v1.7.0（当前版本）

#### 🔥 重大功能（4 期累计 19 项新功能）

##### 注册可用性
- **代理池** — 独立页面，注册时 IP 轮换，支持 4 种调度策略（轮询/随机/最少使用/最快），自动验活 + 失效自动停用，支持 http/https/socks5/socks4 + user:pass@host:port + host:port:user:pass 多种格式导入
- **失败重试队列** — 错误自动归类（网络/OTP超时/邮箱占用/限流/AWS风控/认证/未知），按桶选择性重试
- **批量任务暂停/恢复** — 一键暂停启动新任务，恢复时无缝继续
- **统一任务中心** — TitleBar 实时徽章 + 侧栏抽屉，所有批量任务（注册、订阅、超额、Token 刷新、代理验活）集中显示，支持「全部取消」

##### 运营效率
- **限速 + 退避策略** — 令牌桶限速（每分钟最大启动数）+ 连续失败指数退避（基础时长 → 上限可配）+ 风控自动暂停
- **风控信号检测** — 实时面板：吞吐率、成功率、窗口内失败数、连续失败、退避剩余，触发时 Webhook 通知 + 可选自动暂停
- **订阅升级前预检** — 自动分类账号阻塞原因（已订阅/无 Token/已封禁/不可升级/状态未知）
- **订阅取消/降级** — 新增「订阅管理」Tab：批量打开门户、批量关闭超额、卡片视图账号管理
- **指纹摘要** — 注册成功后保存 chromeVer/UA/GPU/CanvasHash/Screen + 脱敏代理 URL，注册历史显示徽章

##### 自动化
- **多邮箱服务混合并发** — 新增 Mixed 模式，Outlook + TempMail.Plus 平滑加权轮询（SWRR 算法）
- **邮箱预校验** — 经验型黑名单，注册失败为 email_used 自动加入，可视化管理面板
- **定时任务 + 每日配额** — 每日某时自动启动 + 按星期掩码过滤（周一到周日任选）+ 每日配额上限（手动重置）
- **Webhook 通知** — 独立配置页，支持钉钉/企微/飞书/Telegram/Discord/自定义 JSON 模板，7 种事件订阅（批量完成、风控触发、账号封禁、注册成功/失败、Token 过期等），自动重试 + 限流

##### 体验增强
- **注册策略模板** — 保存当前完整配置为命名模板，一键加载，支持导入/导出 JSON
- **注册结果分析报表** — 圆环图（成功率）+ 24 小时平滑曲线（Catmull-Rom 双曲线）+ 7 日趋势叠加柱状图 + 失败原因彩色卡片 + 登录方式对比 + CSV 导出
- **订阅链接有效期检测** — 15 分钟时间阈值 + HTTP HEAD 真实探测，过期链接一键重新生成
- **一键诊断面板** — 检测公网/Kiro/AWS/邮箱服务/代理池连通性，含报告导出
- **账号数据导入导出** — 支持完整账号数据备份与恢复

#### 🔌 网络层
- **SOCKS5/SOCKS4 代理支持** — 通过 socks 库 + undici Agent.connect 钩子建立隧道，HTTPS 自动 TLS 升级
- **注册响应中文乱码修复** — tls-client 的 latin1 字节流自动 UTF-8 重解码
- **AWS 风控错误识别** — `AWS-RISK-CONTROL` 自动归类，错误消息含修复建议
- **Invalid URL protocol 修复** — Windows 多协议代理字符串解析、systemProxy macOS HTTPS 检测、统一 safeCreateProxyAgent 工厂

#### ⚡ 性能优化（4 轮深度优化）
- saveToStorage 500ms 防抖（1000 账号场景：1000 次写盘 → 1 次）
- createBackup 5 分钟节流（消除双倍写盘）
- 后台刷新结果 120ms 缓冲批量化（N 次 Map 复制 → 1 次）
- ProxyLogStore 异步写盘 + 上限 5 万条（不再阻塞主进程 1-5s）
- 反代封禁回调改内存快照（消除整库 AES 加解密）
- 托盘 IPC 400ms 防抖
- getFilteredAccounts / getStats 引用缓存（O(n) → O(1) 命中）
- importAccounts/importFromExportData O(n²) → O(n) 批量化

#### 🗑️ 移除
- MoEmail 邮箱模式从 UI 彻底移除（保留底层 service 代码作为可恢复实现）

#### 🔧 边缘情况修复（22 项）
- 代理变更/删除时自动同步绑定账号到主进程账号池
- Webhook 6 个事件类型完整接入触发点
- 任务中心持久化 200 条已完成任务到 localStorage
- 配置导出支持 PBKDF2 + AES-GCM 加密
- cron 表达式支持星期掩码（工作日/每日/自定义）
- 多邮箱混合权重平滑轮询 (SWRR)
- 注册报表 SVG 圆环图 + Catmull-Rom 平滑曲线 + 7 日趋势叠加柱状图

---

### v1.6.x

#### 反代 API 增强
- **新增**: Gemini v1beta API 兼容（`/v1beta/models`、`/v1beta/models/{model}:generateContent`、`/v1beta/models/{model}:streamGenerateContent`）
- **新增**: 一键配置客户端支持 6 种：Claude Code、OpenCode、Codex CLI、Gemini CLI、Hermes、OpenClaw
- **新增**: AmazonQ CLI 端点隔离 — `amazonq-cli` 首选端点仅使用 SendMessageStreaming，失败不回退
- **新增**: 智能账号轮换 — 断路器 + 粘滞行为 + 指数退避 + 概率重试（参考 Kiro Gateway 架构）
- **新增**: 错误分类系统 — `FATAL`（请求问题，直接返回）vs `RECOVERABLE`（账号问题，切换下一个）
- **新增**: 主动配额过滤 — 已耗尽账号在选择前即被排除，不再等 429 才发现
- **新增**: `onPoolEmpty` 懒加载回调 — 代理收到首个请求时自动从 store 加载账号（修复 Mac 冷启动 503）
- **新增**: 冷启动账号池同步重试机制（5 次重试，2s/4s/6s/8s/10s 间隔）
- **新增**: 模型能力标签 — 模型列表显示 Thinking/Caching/Effort 等能力（从 ListAvailableModels 解析）
- **新增**: 隐藏模型支持 — Claude 3.7 Sonnet 等未在官方列表中但后端支持的模型
- **优化**: 请求头/UA/版本号完全匹配官方 Kiro IDE 0.12.155 抢包（SDK 1.0.34、动态 OS/Node 指纹）
- **优化**: 请求体新增 agentContinuationId/agentTaskType 字段，匹配官方协议
- **优化**: 所有出站请求统一走应用级 HTTP 代理（包括 Token 刷新、SSO 登录、图片下载等）
- **优化**: machineId 空值兆底（SHA-256 哈希）、Token 刷新随机 jitter（0-3s）、IDC UA 动态 OS
- **优化**: K-Proxy MITM 新增 body 中 machineId 替换 + telemetry 域名 kiro.dev 拦截
- **优化**: 工具调用 token 估算覆盖全部出口（工具名 + 参数 JSON）
- **优化**: 503 错误信息包含配额详情（`All accounts quota exhausted (X/Y exhausted, Z in cooldown)`）
- **优化**: 扩展配额错误检测模式（402、429、ThrottlingException、ServiceQuotaExceededException、rate limit、limit exceeded）
- **新增**: 流式日志开关 — 默认关闭，开启后显示每个流式事件的详细 JSON（assistantResponseEvent/toolUseEvent 等）
- **优化**: Thinking 模式简化 — 移除旧的 `<thinking>` 标签检测，直接透传原生 reasoningContentEvent 为 OpenAI `reasoning_content` / Claude thinking block
- **新增**: `additionalModelRequestFields` 支持 — 客户端发送 `thinking` 参数时透传给 Kiro API

#### 账号切换
- **新增**: Kiro CLI 切号支持 — 写入凭证到 `~/.local/share/kiro-cli/data.sqlite3` SQLite 数据库
- **新增**: 设置中可选择切号目标：「Kiro IDE」/「Kiro CLI」/「两者 (IDE + CLI)」（默认 IDE）
- **新增**: 手动切号和自动切号均遵循 `switchTarget` 设置
- **新增**: CLI 切号使用 Read-Merge-Write 策略，保留未知字段，清理过期优先级 key

#### 订阅与超额
- **新增**: 批量超额设置页面 —「一键超额」（仅未开启）和「全部设置」（所有已订阅）按钮
- **新增**: 账号超额状态总览表（订阅类型、超额能力、超额状态）
- **修复**: `overageStatus` 字段检测 — 正确将 REST API 的 `"ENABLED"`/`"DISABLED"` 字符串映射为布尔值
- **修复**: 批量检查和批量刷新现在会返回 `resourceDetail` 和 `overageCapability` 给前端

#### UI & 交互
- **新增**: 注册页面全面重设计 — 使用 Card/Button/Input/Label/Progress/Badge/Switch 组件库
- **新增**: 订阅页面 Header 重设计 — 渐变色横幅风格
- **新增**: 两个页面均支持主题色切换和深色模式
- **修复**: 批量注册进度/历史切页后不再丢失（模块级 React setter refs）
- **修复**: Windows 开发终端中文乱码（dev 脚本前置 `chcp 65001`）

#### 账号注册
- **新增**: 账号注册功能（手动 / MoEmail / Outlook / 自建域名 模式）
- **新增**: 自建域名模式 — 用户提供域名（配置 catch-all 转发到 TempMail.Plus），系统自动生成随机英文人名邮箱前缀注册
- **新增**: 并发批量注册 — 可配置并发数（1-10 个任务同时执行）
- **新增**: 批量注册，支持自动导入、失败重试、每项状态跟踪
- **新增**: 手动模式步骤进度指示器
- **新增**: 所有模式注册成功后自动验活并导入账号
- **新增**: 会话级注册状态持久化（日志、阶段、历史切换页面后保留）
- **新增**: 手动模式支持中途取消注册
- **新增**: 注册页面完整 i18n 支持（中/英）

#### Bug 修复
- **修复**: 模型别名映射改为精确匹配，`claude-opus-4.7` 等动态模型不再被降级
- **修复**: 代理测试页加载真实 `/v1/models` 结果，避免选择不可用的静态别名
- **修复**: 未知模型 ID 原样透传，不再重映射到静态 Claude 默认值
- **修复**: 代理默认端点顺序改为 AmazonQ 优先，CodeWhisperer 备用
- **修复**: 反代流式请求通过应用级 HTTP 代理路由
- **修复**: CodeWhisperer 请求解析短别名为 `ListAvailableModels` 官方 ID
- **修复**: CodeWhisperer 请求包含 `x-amzn-kiro-agent-mode` 头
- **修复**: 解决注册页面白屏问题（TDZ 错误）
- **修复**: 解决手动模式注册后账号被重复导入
- **修复**: TLS 指纹升级到 `chrome_144`
- **修复**: 修正 `tlsclientwrapper` API 调用方式 — body 为第2参数、options 为第3参数

查看 [根目录 README](../README_CN.md#-更新日志) 获取完整更新日志。
