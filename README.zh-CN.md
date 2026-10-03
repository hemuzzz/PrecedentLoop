# Precedent Loop

**让经验成为先例。**

为 Codex 与 Claude Code 提供本地、人工确认的工程知识库。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

[English](README.md) · 简体中文

https://github.com/user-attachments/assets/b9700805-b317-4676-b0c6-9cdd093ea33e

<sub>83 秒产品介绍，中文旁白，中英双语字幕。</sub>

## 为什么需要它

Coding Agent 每次打开都从零开始。上周查清楚的根因、和你一起定下的取舍、已经踩过的坑，下次还得再解释一遍。

客户端自带的记忆有帮助，但它是自动写的，你很难看全，也说不清它什么时候生效。

Precedent Loop 把这些经验保存为**先例**：经你审阅确认的简短 Markdown。Agent 在任务真正需要时，按项目按需召回。

## 工作方式

```text
  和 Agent 一起工作 ──▶ Agent 提出候选 ──▶ 你在 Hub 中审阅、修改、确认
          ▲                                              │
          │                                              ▼
          └──── 下一次任务：Agent 召回并标记实际用到的 ◀── 先例
```

1. **沉淀**：决定已定、根因已确认时，Agent 准备一条结构化候选。任何内容都不会自行入库。
2. **审阅**：桌面 App 打开候选，你可以修改、接受、暂存或拒绝。接受绑定你看到的确切内容。
3. **召回**：之后的会话里，Agent 在与请求相关的项目中检索，只读取需要的正文。
4. **结算**：Agent 标记哪些先例真正影响了结论，你能看出哪些有用、哪些可以清理。

## 特性

- **人工把关**：Agent 只能提出候选，每条先例都由你逐字确认。
- **限定范围、控制预算的召回**：每次最多 8 条、5000 字符，只在 Agent 选定的项目里检索，不挤占上下文。
- **Codex 与 Claude Code 共用一个知识库**：通过 MCP 和 Hook 接入，初始化向导会同时配置两者。
- **导入已有资料**：用本机的 Codex 或 Claude Code CLI 把现有 Markdown 整理成候选，App 不保存任何模型 API 密钥。
- **使用统计**：看到哪些先例真正被用到，清理其余的。
- **纯文本**：先例是你选定目录里的普通 Markdown，可以自己用 git 管理；SQLite 索引随时可以重建。

## 与其他方式的区别

|  | `AGENTS.md` / `CLAUDE.md` | 客户端自带记忆 | Precedent Loop |
|---|---|---|---|
| 适合 | 始终适用的规则 | 轻量的个人背景 | 决策、根因、经验教训 |
| 谁来写 | 你 | Agent 自动生成 | Agent 提出，你确认 |
| 何时加载 | 每次会话全文加载 | 由客户端决定 | 按需、按项目、受预算限制 |
| 共享范围 | 单个仓库 | 单个客户端 | Codex 与 Claude Code，所有已登记项目 |
| 存储 | 仓库里的文件 | 客户端内部存储 | 你目录中的 Markdown + 本地 SQLite |

它不取代前两者：始终适用的规则继续放在 `AGENTS.md`，来之不易、只在特定情境下有用的知识放在这里。

## 安装

### 下载

从 [Releases](https://github.com/hemuzzz/PrecedentLoop/releases) 下载最新的 `.dmg`，把 **PrecedentLoop** 拖入「应用程序」。

App 没有 Apple 开发者签名，首次打开会被 macOS 拦截：打开 **系统设置 → 隐私与安全性**，点击 **仍要打开**。

要求：

- Apple Silicon 的 macOS（可以构建 Intel 版本，但未经测试）
- 已安装并登录 [Codex CLI](https://github.com/openai/codex) 或 [Claude Code](https://claude.com/claude-code)（至少一个）

### 从源码构建

需要 Node.js `24.21.0` 和 pnpm `11.1.3`。

```bash
pnpm install --frozen-lockfile
cp apps/desktop/build-config.example.json .desktop-local.json
pnpm build
pnpm --filter @precedent-loop/desktop package:mac
```

App 输出到 `dist/desktop/`。开发模式、测试和发布构建见[开发文档](docs/development.md)。

## 快速开始

1. **完成初始化向导**：首次启动时选择数据目录，让 App 检测 Codex 和 Claude Code 并完成接入。App 会自动注册 MCP 服务并安装 Hook。
2. **登记项目**：从 Codex 和 Claude Code 最近使用的项目中选择。每个项目有自己的知识范围，全局知识所有项目共用。
3. **照常工作**：任务以已定的决策或已验证的修复结束时，Agent 会准备候选，App 自动打开审阅页。
4. **确认入库**：从下一次会话开始，Agent 就能召回它；项目知识在该项目中可用，全局知识在所有项目中可用。

已经有笔记？在 Hub 中使用 **导入**，把 Markdown 文件整理成候选。

## 数据与隐私

- 所有数据都在你选择的目录里。本地服务只监听 `127.0.0.1`，拒绝来自其他主机和来源的请求。
- 没有遥测、没有账号，App 本身不调用任何模型 API。
- **导入和 AI 改稿**会调用你本机的 Codex 或 Claude Code CLI：导入的文档，以及用于比对的少量已有先例，会由该 CLI 所配置的模型处理。
- **检查更新**只在你点击时访问 GitHub。

## 当前状态与限制

Precedent Loop 是一个早期阶段的个人项目。

- 仅支持 macOS；App 未签名、未公证。
- 界面目前只有中文。
- 通过 Claude Code 进行 AI 导入时，仅支持无管理策略的个人 Pro/Max 登录。
- 存储和接入格式在版本之间仍可能变化。

## 文档

文档目前为英文：

- [桌面 App](docs/desktop-app.md)：数据目录、设置、更新
- [Agent 接入](docs/agent-integration.md)：Codex 与 Claude Code 的 MCP 工具和 Hook
- [知识格式](docs/knowledge-format.md)：目录结构与 Markdown Front Matter
- [审阅流程](docs/review-workflow.md)：候选、审阅、导入与 AI 改稿
- [配置](docs/configuration.md)：环境变量与配置文件
- [排错](docs/troubleshooting.md)
- [开发](docs/development.md)：仓库结构、开发模式、测试、打包

## 参与贡献

欢迎提交 Issue 和 Pull Request。请先阅读[开发文档](docs/development.md)；较大的改动请先开 Issue 讨论方案。

## 许可证

[Apache License 2.0](LICENSE)
