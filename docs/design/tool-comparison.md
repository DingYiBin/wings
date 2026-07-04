# Wings 内置工具对比分析

基于对 claude-code 和 opensquilla 的工具实现深入研究。

## 当前 Wings 工具

| 工具 | status |
|------|--------|
| read | ✅ 已实现 |
| write | ✅ 已实现 |
| edit | ✅ 已实现 |
| bash | ✅ 已实现 |
| glob | ✅ 已实现 |
| grep | ✅ 已实现 |
| skill_view | ✅ 已实现 |

## 与参考项目的关键差异

### read

| 维度 | wings | claude-code | opensquilla |
|------|-------|-------------|-------------|
| 输入 | file_path, offset, limit | file_path, offset, limit, pages | path, offset, limit |
| 图片 | ❌ 不支持 | ✅ base64 返回 + token 预算压缩 | ❌ |
| PDF | ❌ | ✅ poppler 页提取 | ❌ |
| Notebook | ❌ | ✅ 解析 cell | ❌ |
| 二进制检测 | ❌ | ✅ 扩展名+内容 | ✅ 扩展名+NUL字节 |
| 去重 | ❌ | ✅ readFileState 缓存 | ❌ |
| 格式 | 无行号 | cat -n 行号格式 | lineno\t 前缀 |
| 安全 | 仅相对路径 | 阻止 /dev/zero 等设备路径 | 敏感路径封锁 |

### write

| 维度 | wings | claude-code | opensquilla |
|------|-------|-------------|-------------|
| 父目录创建 | ✅ | ✅ | ✅ |
| stale 检测 | ❌ | ✅ 必须 Read 过 + mtime 检查 | ❌ |
| 行尾符 | 保留原样 | 强制 LF | UTF-8 |
| 权限 | 通过 pipeline | 集中式文件系统权限 | 工作区内外边界检查 |
| 输出 | 简要 | 含 diff hunks | bytes 计数 |

### edit

| 维度 | wings | claude-code | opensquilla |
|------|-------|-------------|-------------|
| replace_all | ✅ | ✅ | ❌ (只 replace 1 次) |
| 去重检测 | ✅ (多匹配时提示) | ✅ (含数量) | ✅ (多匹配抛异常) |
| 旧字符串查找 | 精确匹配 | 精确 + 引号规范化 + desanitize | 精确匹配 |
| stale 检测 | ❌ | ✅ | ❌ |
| OOM 防护 | ❌ | ✅ 拒绝 >1GiB | ❌ |
| 编码检测 | ❌ | ✅ UTF-16LE BOM | ❌ |
| .ipynb 处理 | ❌ | ❌ 拒绝 (导向 NotebookEdit) | ❌ |

### bash

| 维度 | wings | claude-code | opensquilla |
|------|-------|-------------|-------------|
| 超时 | ✅ | ✅ max 600000ms | ✅ max 600s |
| 后台 | ❌ | ✅ run_in_background | ✅ background_process 工具 |
| 进度 | ❌ | ✅ 正则进度更新 | ❌ |
| 输出截断 | ❌ | ✅ 30KB 后持久化到文件 | ✅ 通过 ResultBudget |
| 安全 | 通过 pipeline | 10 层防护 (AST + 分类器) | 多层防护 (denylist + sandbox) |
| 沙箱 | ❌ | ✅ SandboxManager | ✅ Bubblewrap/Seatbelt |
| description 字段 | ❌ | ✅ (给用户的说明) | ❌ |
| exit_code | ✅ (在 output 中) | ✅ 独立字段 | ✅ 独立字段 |

### glob

| 维度 | wings | claude-code | opensquilla |
|------|-------|-------------|-------------|
| 实现 | Path.glob | ripgrep --files --glob | Path.glob |
| 排序 | ❌ | ✅ 按修改时间 | ✅ 按名称 |
| 结果限制 | ❌ | ✅ 默认 100 | ❌ |
| 截断标记 | ❌ | ✅ truncated 字段 | ❌ |
| 安全 | ❌ | 权限 ignore 模式 | 工作区 strict 标记 |

### grep

| 维度 | wings | claude-code | opensquilla |
|------|-------|-------------|-------------|
| 实现 | Python re | ripgrep | Python re |
| 输出模式 | files_with_matches/content/count | 同 | 仅 content |
| head_limit | ✅ 默认 250 | ✅ 默认 250 | max_results 默认 100 |
| offset 分页 | ✅ | ✅ | ❌ |
| 行号 | ✅ (默认开) | ✅ (默认开) | ✅ (始终) |
| 上下文行 | ✅ -A/-B/-C | ✅ | ❌ |
| multiline | ✅ | ✅ | ❌ |
| type 过滤 | ✅ | ✅ (rg --type) | ❌ |
| 大小写 | ✅ -i | ✅ | ❌ |
| VCS 排除 | ❌ | ✅ .git/.svn 等 | ❌ |
| max-columns | ❌ | ✅ 500 (防 base64 膨胀) | ❌ |
| 排序 | ❌ | ✅ 按修改时间 | ❌ |

## 值得补全的功能（按优先级）

### P0 — 影响安全性
1. **Bash 安全增强**: description 字段（给用户解释命令）、阻止 `sleep N`、denylist 检查
2. **write/edit stale 检测**: 先 Read 才能 Write/Edit，防止覆盖他人修改
3. **read 二进制检测**: 拒绝非图片/非文本文件，防止 base64 垃圾污染上下文

### P1 — 影响可用性
4. **read 行号输出**: 使用 cat -n 格式，让模型能准确引用行号
5. **read 设备路径阻止**: /dev/zero, /dev/random 等
6. **grep VCS 目录排除**: .git 等目录不搜索

### P2 — 锦上添花
7. **bash 后台任务**: run_in_background 支持
8. **grep 结果排序**: 按修改时间，最新的在前
9. **glob 结果限制**: 默认 100，带截断标记
10. **write diff 输出**: 返回变更的 diff hunks

## opensquilla 有但 wings 和 claude-code 都没有的工具

| 工具 | 说明 |
|------|------|
| `read_spreadsheet` | CSV/TSV/XLSX 专用读取（带 sheet/offset/limit） |
| `list_dir` | 目录列出（区分文件和目录，大小信息） |
| `apply_patch` | 批量补丁（add/update/delete 多文件） |
| `create_csv/xlsx/pptx/pdf` | 文件创作（通过 ArtifactStore 发布，不直接写磁盘） |
| `execute_code` | 沙箱 Python 执行（代码审查/计算） |
| `background_process` | 后台进程 + process 管理工具（list/poll/wait/log/kill） |
