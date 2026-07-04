# opensquilla 内置 Skills 参考

> 来源: `reference/opensquilla/src/opensquilla/skills/bundled/`
> 约 70 个 skill，全部以 SKILL.md 文件定义

## 核心开发工具类

### code-task
- **说明**: 编码模式专用任务执行
- **特点**: 只在 coding mode 激活时可用

### web-search
- **说明**: 使用 DuckDuckGo 进行网页搜索
- **特点**: 通过 entrypoint CLI 执行，非 LLM 调用

### http-fetch
- **说明**: HTTP 请求抓取网页内容

### filesystem
- **说明**: 文件系统操作（读写、目录遍历）

### github
- **说明**: GitHub 交互（PR、issue、repo 管理）

### git-diff
- **说明**: 分析 git diff 变更

### text-file-read
- **说明**: 文本文件读取（支持多编码）

### sub-agent
- **说明**: 生成子 agent 执行隔离任务

### memory
- **说明**: 持久化记忆管理
- **特点**: `always: true`，始终注入 system prompt

### cron
- **说明**: 定时任务调度

### summarize
- **说明**: 对话/文档摘要生成

### tmux
- **说明**: Tmux 会话管理

### history-explorer
- **说明**: 对话历史搜索与探索

### weather
- **说明**: 天气查询

## Office 文档类

### docx
- **说明**: Word (.docx) 文档生成与编辑

### pptx
- **说明**: PowerPoint (.pptx) 演示文稿生成

### xlsx
- **说明**: Excel (.xlsx) 电子表格生成

### pdf-toolkit
- **说明**: PDF 工具集（合并、拆分、提取）

### html-to-pdf
- **说明**: HTML 转 PDF

### latex-compile
- **说明**: LaTeX 文档编译

### html-coder
- **说明**: HTML 页面编码，带参考文档（global-attributes, glossary, essentials 等）

## 科研/论文类 (paper-* 系列)

### paper-abstract-author
- **说明**: 论文摘要撰写

### paper-section-author
- **说明**: 论文章节撰写

### paper-outline-author
- **说明**: 论文大纲撰写

### paper-revision-author
- **说明**: 论文修订

### paper-citation-planner
- **说明**: 引用策略规划

### paper-source-curator
- **说明**: 文献来源管理

### paper-experiment-stub
- **说明**: 实验代码桩生成

### paper-plot-stub
- **说明**: 图表代码桩生成

### paper-refbib-stub
- **说明**: 参考文献 bib 生成

### paper-preference-planner
- **说明**: 投稿偏好规划（选期刊/会议）

## 媒体/创作类

### ai-video-script
- **说明**: AI 视频脚本生成

### advanced-dubbing-studio
- **说明**: 高级配音工作室

### voiceover-studio
- **说明**: 旁白/配音制作

### voice-clone-lab
- **说明**: 声音克隆实验室

### voice-conversion-studio
- **说明**: 声音转换工作室

### music-and-singing-studio
- **说明**: 音乐与歌唱生成

### seedance-2-prompt
- **说明**: SeaDance 视频生成提示词

### video-merger
- **说明**: 视频合并

### video-still-animator
- **说明**: 视频静态帧动画化

### subtitle-burner
- **说明**: 字幕烧录到视频

### srt-from-script
- **说明**: 从脚本生成 SRT 字幕

### title-card-image
- **说明**: 标题卡图片生成

### awesome-webpage-image-download
- **说明**: 网页图片批量下载

### awesome-webpage-research
- **说明**: 网页内容深度研究

### multi-search-engine
- **说明**: 多搜索引擎聚合

### openrouter-video-generator
- **说明**: 通过 OpenRouter 调用视频生成模型

## 图像/AI 模型类

### nano-banana-pro
- **说明**: 图像生成（Nano Banana Pro 模型）

### nano-banana-pro-openrouter
- **说明**: 通过 OpenRouter 的图像生成

### nano-pdf
- **说明**: PDF 内容提取与分析

## Meta-skills（编排/DAG类）

### meta-skill-creator
- **类型**: meta
- **说明**: 创建新的 meta-skill（DAG 工作流编排）
- **特点**: 四阶段 pipeline — clarify_intent → pick_pattern → assemble → smoke_test

### meta-paper-write
- **类型**: meta
- **说明**: 完整论文写作编排（大纲→章节→摘要→修订→投稿）

### meta-short-drama
- **类型**: meta
- **说明**: 短剧制作编排（剧本→配音→字幕→视频→标题卡）

### meta-kid-project-planner
- **类型**: meta
- **说明**: 儿童项目规划编排

### AwesomeWebpageMetaSkill
- **类型**: meta
- **说明**: 完整网页制作 meta skill

### skill-creator
- **说明**: 创建普通 skill

### skill-creator-linter
- **说明**: Skill 格式检查（lint）

### skill-creator-smoke-test
- **说明**: Skill 冒烟测试验证

### skill-creator-proposals
- **说明**: Skill 改进提案生成

## 调试/诊断类

### stack-trace-generic-probe
- **说明**: 通用堆栈跟踪分析

### stack-trace-go-probe
- **说明**: Go 堆栈跟踪分析

### stack-trace-js-probe
- **说明**: JavaScript 堆栈跟踪分析

### stack-trace-python-probe
- **说明**: Python 堆栈跟踪分析

### stack-trace-rust-probe
- **说明**: Rust 堆栈跟踪分析

### deep-research
- **说明**: 深度研究，多轮搜索+分析

## 其他

### audio-cog
- **说明**: 音频处理工具

### swe-bench
- **说明**: SWE-bench 评测相关

### AwesomeWebpageMetaSkill
- **说明**: 网页制作综合 skill
