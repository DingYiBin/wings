# Bundled Skills 设计

> 创建: 2026-07-11
> 参考: claude-code `src/skills/bundledSkills.ts` + `bundled/*.ts`

## 目标

将 wings 的内置 skills 从纯文件方式（SKILL.md）切换为 claude-code 的混合模式：
- **Bundled skills** — TypeScript 硬编码，编译进 CLI，支持动态 prompt、自定义工具、hooks
- **File skills** — SKILL.md 文件，用户/项目自定义（保持不变）

## claude-code 格式

```typescript
// src/skills/bundled/simplify.ts
import { registerBundledSkill } from '../bundledSkills.ts'

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    description: 'Review changed code for reuse, quality, and efficiency',
    userInvocable: true,
    async getPromptForCommand(args, context) {
      return [{ type: 'text', text: SIMPLIFY_PROMPT + args }]
    },
  })
}
```

BundledSkillDefinition 字段：
- `name` — 技能名
- `description` — 描述（显示给用户和模型）
- `aliases` — 别名（可选）
- `whenToUse` — 何时使用（可选，注入 system prompt）
- `argumentHint` — 参数提示（可选）
- `allowedTools` — 允许的工具列表（可选）
- `model` — 指定模型（可选）
- `disableModelInvocation` — 是否隐藏模型调用
- `userInvocable` — 用户可否通过 /name 调用
- `isEnabled` — 动态启用/禁用（可选函数）
- `context` — 'inline' | 'fork'（可选）
- `agent` — 指定 agent 类型（可选）
- `getPromptForCommand(args, context)` — 核心：生成 prompt（异步，可访问上下文）

## wings 适配

### 目录结构

```
src/skills/
  bundled/           # 硬编码 TS skills
    index.ts         # registerAllBundledSkills()
    simplify.ts      # registerSimplifySkill()
    commit.ts        # registerCommitSkill() — 如有需要
  bundledSkills.ts   # BundledSkillDefinition 类型 + registerBundledSkill()
  loader.ts          # 现有文件加载器（保持不变）
  injector.ts        # 现有 prompt 注入器（需更新：同时注入 bundled + file skills）
  types.ts           # 现有 SkillSpec（保持不变）
  index.ts           # 导出
```

### BundledSkillDefinition 类型

```typescript
// src/skills/bundledSkills.ts
export interface BundledSkillDefinition {
  name: string;
  description: string;
  aliases?: string[];
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  isEnabled?: () => boolean;
  getPromptForCommand: (args: string, context: ToolUseContext) => Promise<PromptBlock[]>;
}

interface PromptBlock {
  type: "text";
  text: string;
}
```

### 注册流程

1. `src/skills/bundled/index.ts` — `registerAllBundledSkills()` 调用所有 register 函数
2. `src/cli/bootstrap.ts` — 启动时调用 `registerAllBundledSkills()`
3. `SkillLoader.loadAll()` — 返回 bundled + file skills 的合并列表
4. `SkillInjector` — 注入时使用 bundled skill 的 `whenToUse` 字段

### 与现有 file skills 的关系

- Bundled skills 优先级 > project skills > user skills
- 同名时 bundled 覆盖 file
- File skills 继续从 `~/.wings/skills/` + `.wings/skills/` 加载

## 实现计划

### Step 1: 类型 + 注册系统
- `src/skills/bundledSkills.ts` — BundledSkillDefinition + registerBundledSkill()
- `src/skills/bundled/index.ts` — registerAllBundledSkills()

### Step 2: 迁移现有内置 skills
- 把现有的 SKILL.md 内容转为 bundled format
- 目前有哪些内置 skills？查看 `skills/builtin/` 或类似目录

### Step 3: 更新注入器
- `SkillInjector` 支持注入 bundled skill 的 `whenToUse` 描述
- System prompt 中同时列出 bundled + file skills

### Step 4: 更新 bootstrap
- `createSession()` 中调用 `registerAllBundledSkills()`
- `SkillLoader.loadAll()` 合并两种 skill

### Step 5: 测试
- 验证 /skill_name 命令可用
- 验证模型能识别并使用 bundled skills
