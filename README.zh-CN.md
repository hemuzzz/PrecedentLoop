# Precedent Loop

**让经验成为先例。**

为 Codex 与 Claude Code 提供本地、人工确认的工程知识库。

[![Release](https://img.shields.io/github/v/release/hemuzzz/PrecedentLoop)](https://github.com/hemuzzz/PrecedentLoop/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey.svg)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

[English](README.md) · 简体中文

https://github.com/user-attachments/assets/b9700805-b317-4676-b0c6-9cdd093ea33e

<sub>83 秒产品介绍，中文旁白，中英双语字幕。</sub>

## 为什么需要它

Coding Agent 每次打开都从零开始。上周查清楚的根因、和你一起定下的取舍、已经踩过的坑，下次还得再解释一遍。

客户端自带的记忆有帮助，但它是自动写的，你很难看全，也说不清它什么时候生效。

Precedent Loop 把这些经验保存为**先例**：经你审阅确认的简短笔记。Agent 在任务真正需要时，按项目按需召回。

## 工作方式

```text
  和 Agent 一起工作 ──▶ Agent 提出候选 ──▶ 你在 Hub 中审阅、修改、确认
          ▲                                              │
          │                                              ▼
          └──── 下一次任务：Agent 召回并标记实际用到的 ◀── 先例
```

1. **沉淀**：决定已定、根因已确认时，Agent 准备一条结构化候选。任何内容都不会自行入库。
2. **审阅**：桌面 App 打开候选，你可以修改、让 AI 改稿、接受、暂存或拒绝。接受绑定你看到的确切内容。
3. **召回**：之后的会话里，Agent 在与请求相关的项目中检索，只读取需要的正文。
4. **结算**：Agent 标记哪些先例真正影响了结论，你能看出哪些有用、哪些可以清理。
5. **修订**：Agent 使用时发现先例过时或有误，会提出修订候选，同样经你审阅。

## 特性

- **人工把关**：Agent 只能提出候选，每条先例都由你逐字确认。
- **限定范围、控制预算的召回**：每次最多 8 条、5000 字符，只在 Agent 选定的项目里检索，不挤占上下文。
- **Codex 与 Claude Code 共用一个知识库**：通过 MCP 和 Hook 接入，初始化向导会同时配置两者。
- **导入已有资料**：用本机的 Codex 或 Claude Code CLI 把现有 Markdown（`.md`、`.markdown`、`.mdx`）整理成候选，App 不保存任何模型 API 密钥。
- **使用统计**：看到哪些先例真正被用到，清理其余的。
- **本地 SQLite 存储**：一个数据库保存知识及其 Markdown 正文、每条知识的上一版、候选、检索索引和使用记录。备份数据目录即可完整保留。

## 与其他方式的区别

|  | `AGENTS.md` / `CLAUDE.md` | 客户端自带记忆 | Precedent Loop |
|---|---|---|---|
| 适合 | 始终适用的规则 | 轻量的个人背景 | 决策、根因、经验教训 |
| 谁来写 | 你 | Agent 自动生成 | Agent 提出，你确认 |
| 何时加载 | 每次会话全文加载 | 由客户端决定 | 按需、按项目、受预算限制 |
| 共享范围 | 单个仓库 | 单个客户端 | Codex 与 Claude Code，所有已登记项目 |
| 存储 | 仓库里的文件 | 客户端内部存储 | 本地 SQLite，正文为 Markdown |

它不取代前两者：始终适用的规则继续放在 `AGENTS.md`，来之不易、只在特定情境下有用的知识放在这里。

## 环境要求

- Apple Silicon 的 macOS。可以从源码构建 Intel 版本，但未经测试。
- 已安装并登录 [Codex CLI](https://github.com/openai/codex) 或 [Claude Code](https://claude.com/claude-code)（至少一个）。

## 安装

有两种方式：下载打包好的 App，或者自己从源码打包。

### 方式一：下载安装包

1. 打开[最新版本](https://github.com/hemuzzz/PrecedentLoop/releases/latest)，下载 **`PrecedentLoop-<版本>-arm64-local-install.dmg`**。`-update.dmg` 和 `.json` 供 App 内更新使用，不用下载。
2. 打开 DMG，把 **PrecedentLoop** 拖入「应用程序」。请放在这里：App 内更新会替换 `/Applications/PrecedentLoop.app`，Agent 的 Hook 也指向 App 所在位置。
3. 允许打开。App **没有 Apple 开发者签名，也未经公证**，第一次打开会被 macOS 拦截：
   1. 打开 PrecedentLoop，macOS 提示无法验证该 App。点 **完成**（不要点「移到废纸篓」）。
   2. 打开 **系统设置 → 隐私与安全性**，滚动到「安全性」，会看到 PrecedentLoop 已被阻止的提示，点 **仍要打开**。
   3. 输入密码或用触控 ID 确认，在随后的对话框里再点一次 **仍要打开**。

   macOS 会记住这次选择，之后不用再操作。也可以在终端里去掉下载隔离标记：

   ```bash
   xattr -dr com.apple.quarantine /Applications/PrecedentLoop.app
   ```

   只对从本仓库 Releases 下载的 App 这样做。

### 方式二：从源码打包

自己打包的 App 没有下载隔离标记，macOS 会直接打开，不需要上面的确认步骤。

1. 准备构建工具。版本已锁定并强制检查（`engine-strict`），其他版本会被拒绝：
   - Node.js **24.21.0**，例如用 [nvm](https://github.com/nvm-sh/nvm)：`nvm install 24.21.0`
   - pnpm **11.1.3**，例如运行 `corepack enable`（版本从 `package.json` 读取）
   - Git 和网络：第一次安装依赖时会下载 Electron。
2. 打包：

   ```bash
   git clone https://github.com/hemuzzz/PrecedentLoop.git
   cd PrecedentLoop
   pnpm install --frozen-lockfile
   cp apps/desktop/build-config.example.json .desktop-local.json
   pnpm build
   pnpm --filter @precedent-loop/desktop package:mac
   ```

   最后一条命令会输出 App 的位置 `dist/desktop/<构建编号>/PrecedentLoop.app`，每次打包都放在新目录里。
3. 复制到「应用程序」，然后正常打开：

   ```bash
   ditto "dist/desktop/<构建编号>/PrecedentLoop.app" /Applications/PrecedentLoop.app
   ```

完成初始化后，更新源码版本时拉取最新代码再原地重建即可。`update:mac` 会重新打包、退出正在运行的 App、替换 `/Applications/PrecedentLoop.app` 并重新启动：

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @precedent-loop/desktop update:mac
```

开发模式、测试和发布构建见[开发文档](docs/development.md)。

## 快速开始

1. **完成初始化向导**：首次启动时选择数据目录（避免 iCloud 和网络盘，它们可能损坏数据库），让 App 检测 Codex 和 Claude Code 并完成接入。App 会自动注册 MCP 服务并安装 Hook。
2. **登记项目**：从 Codex 和 Claude Code 最近使用的项目中选择。每个项目有自己的知识范围，全局知识所有项目共用。
3. **照常工作**：任务以已定的决策或已验证的修复结束时，Agent 会准备候选，App 自动打开审阅页。
4. **确认入库**：之后 Agent 就能召回它；项目知识在该项目中可用，全局知识在所有项目中可用。

已经有笔记？在候选页使用 **导入**，把 Markdown 文件整理成候选。

关闭窗口后本地服务仍在运行，Agent 照常可以访问知识库；按 **Cmd+Q** 退出才会停止服务。

## 更新

在菜单栏选择 **PrecedentLoop → 检查更新…**。只有点击时才会访问 GitHub。有新版本时，App 先校验安装包的大小和 SHA-256，再安装并重启。数据目录和设置保持不变。

## 数据与隐私

- 所有知识都在你选择的数据目录里：SQLite 数据库在 `runtime/`，已登记的项目在 `config/`，日志在 `logs/`。App 偏好设置保存在 `~/Library/Application Support/PrecedentLoop/`。
- 本地服务只监听 `127.0.0.1`，拒绝来自其他主机和来源的请求。
- 没有遥测、没有账号，App 本身不调用任何模型 API。
- **导入和 AI 改稿**会调用你本机的 Codex 或 Claude Code CLI：导入的文档，以及用于比对的少量已有先例，会由该 CLI 所配置的模型处理。
- 在 Hub 中删除先例只是标记为已删除，召回和使用记录会保留。目前没有恢复入口。

## 卸载

1. 在 **设置 → Agent 接入** 中移除 Codex 和 Claude Code 的接入，这会注销 MCP 服务并移除 Hook。
2. 退出 App，删除 `/Applications/PrecedentLoop.app`。
3. 删除 `~/Library/Application Support/PrecedentLoop/`；如果不再需要知识，也删除数据目录。

## 当前状态与限制

Precedent Loop 是一个早期阶段的个人项目。

- 仅支持 Apple Silicon 的 macOS；App 未签名、未公证。
- 界面目前只有中文。
- 通过 Claude Code 进行 AI 导入和改稿时，仅支持无管理策略的个人 Pro/Max 登录（claude.ai）。
- 存储和接入格式在版本之间仍可能变化。

## 文档

文档目前为英文：

- [桌面 App](docs/desktop-app.md)：初始化向导、设置、更新
- [Agent 接入](docs/agent-integration.md)：Codex 与 Claude Code 的 MCP 工具和 Hook
- [知识格式](docs/knowledge-format.md)：类型、范围、字段、版本与写法
- [知识内容模型](apps/server/resources/knowledge-content-model.md)：Agent 遵循的内容规则（中文）
- [审阅流程](docs/review-workflow.md)：候选、审阅、导入与 AI 改稿
- [配置](docs/configuration.md)：环境变量、配置文件与数据目录识别
- [排错](docs/troubleshooting.md)
- [开发](docs/development.md)：仓库结构、开发模式、测试、打包

## 参与贡献

欢迎提交 Issue 和 Pull Request。请先阅读[开发文档](docs/development.md)；较大的改动请先开 Issue 讨论方案。

## 许可证

[Apache License 2.0](LICENSE)
