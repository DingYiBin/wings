---
name: check-claude
description: 在开发 Agent 时，自动检索 reference/claude-code 源码，若存在相似实现则尽力模仿其架构、接口与代码风格。
allowed-tools: Read, Write, Edit, Grep, Bash
license: MIT
---

# check-claude Skill

## 目的
本 Skill 用于在开发当前 Agent 的基础能力（如工具调用、记忆管理、规划、多轮对话等）时，主动参考官方 Claude Code 的源码实现（位于 `reference/claude-code` 目录），确保实现方式与上游设计保持一致，减少重复设计，提升代码质量。

## 适用场景
- 正在实现 Agent 核心组件（如 `ToolExecutor`, `MemoryStore`, `Planner`, `MessageHandler` 等）。
- 不确定某个功能的最佳实践或接口设计。
- 希望复用已被验证的代码逻辑或设计模式。

## 执行流程

当 Agent 接收到“实现某功能”或“添加某能力”的指令时，**必须**先执行以下步骤：

### 1. 定位参考源码
使用 `ls` 或 `find` 命令查看 `reference/claude-code` 的目录结构，了解其模块划分。  
示例命令：
```bash
ls -R reference/claude-code