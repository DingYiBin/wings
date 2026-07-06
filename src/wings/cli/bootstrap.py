"""Bootstrap wiring — create a fully configured agent session.

This is the "composition root" where all modules are wired together.
"""

from __future__ import annotations

import platform
from datetime import datetime
from pathlib import Path

from wings.agent.agent_loader import load_custom_agents
from wings.agent.loop import AgentContext, AgentLoop
from wings.config.settings import AppConfig
from wings.hooks.runner import HookRunner
from wings.hooks.types import HookConfig
from wings.mcp.loader import load_mcp_tools
from wings.memory.extractor import maybe_extract_memories
from wings.memory.loader import load_memory_prompt
from wings.models.anthropic import AnthropicProvider
from wings.models.openai import OpenAIProvider
from wings.models.protocol import ModelConfig
from wings.models.registry import ModelRegistry
from wings.permissions.pipeline import PermissionPipeline
from wings.permissions.rules import PermissionRules
from wings.query.engine import QueryEngine
from wings.routing.manager import APIPoolManager
from wings.skills.builtin_data import builtin_skills_dir
from wings.skills.injector import SkillInjector
from wings.skills.loader import SkillLoader
from wings.skills.types import SkillSpec
from wings.tools.base import ToolContext
from wings.tools.builtin import (
    bash,
    edit_file,
    glob_files,
    grep,
    make_agent_tool,
    read_file,
    skill_view,
    web_fetch,
    web_search,
    write_file,
)
from wings.tools.registry import ToolRegistry

# Canonical provider implementations for each provider name.
_PROVIDER_CLASSES = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
}


def _build_hook_runner(config: AppConfig) -> HookRunner:
    """Build a HookRunner from app config hooks."""
    hooks_cfg = config.global_settings.hooks or {}
    pre = _parse_hook_configs(hooks_cfg.get("PreToolUse", []))
    post = _parse_hook_configs(hooks_cfg.get("PostToolUse", []))
    return HookRunner(pre_tool_use=pre, post_tool_use=post)


def _parse_hook_configs(raw: list[dict]) -> list[HookConfig]:
    """Parse raw hook config dicts into HookConfig objects."""
    configs = []
    for item in raw:
        if isinstance(item, dict) and "command" in item:
            configs.append(HookConfig(
                command=item["command"],
                matcher=item.get("matcher"),
            ))
    return configs


async def create_session(
    working_dir: Path | None = None,
) -> tuple[AgentLoop, AppConfig]:
    """Create a fully wired agent session.

    Returns (agent_loop, config) ready to handle turns.
    """
    cwd = working_dir or Path.cwd()
    config = AppConfig.load(cwd)

    # -- API pool manager --
    pool_mgr = APIPoolManager(config=config.global_settings.routing)

    # -- Model registry --
    registry = ModelRegistry(pool_mgr)

    # Register all configured providers that have API keys
    for name, cfg in config.global_settings.providers.items():
        provider_cls = _PROVIDER_CLASSES.get(cfg.protocol)
        if provider_cls is None:
            continue
        api_key = config.global_settings.api_key_for(name)
        if not api_key:
            continue
        provider = provider_cls()
        api_id = f"{name}/{cfg.model}"  # internal identifier for pool/registry
        model_config = ModelConfig(
            model=cfg.model,  # API model name (e.g. "deepseek-v4-flash")
            api_key=api_key,
            base_url=cfg.base_url,
            max_tokens=cfg.max_tokens,
            escalated_max_tokens=cfg.escalated_max_tokens,
            thinking=cfg.thinking,
            thinking_budget=cfg.thinking_budget,
            context_window=cfg.context_window,
        )
        registry.register(api_id, provider, config=model_config)
        pool_mgr.register_api(api_id)

    # -- Skills --
    user_skills_dir = Path.home() / ".wings" / "skills"
    project_skills_dir = cwd / ".wings" / "skills"
    loader = SkillLoader(
        user_dir=user_skills_dir,
        project_dir=project_skills_dir,
        builtin_dir=builtin_skills_dir(),
    )
    skills_list = loader.load_all()

    # Build name -> full content dict for skill_view tool
    available_skills: dict[str, str] = {
        s.name: s.content for s in skills_list
    }

    # Fork API pool per skill so each has independent scoring
    for skill in skills_list:
        pool_mgr.fork_mask(f"skill/{skill.name}", "subagent/skill")

    # -- Tool registry --
    tools = ToolRegistry()
    for t in [read_file, write_file, edit_file, bash, glob_files, grep, skill_view, web_fetch, web_search]:
        tools.register(t)

    # Apply project-level tool filters
    if config.global_settings.denied_tools:
        tools.filter_denied(config.global_settings.denied_tools)

    # -- Permissions --
    rules = PermissionRules()
    for name in config.global_settings.allowed_tools:
        rules.add_allow(name)
    for name in config.global_settings.denied_tools:
        rules.add_deny(name)
    # -- Hooks --
    hook_runner = _build_hook_runner(config)

    pipeline = PermissionPipeline(rules, hook_runner=hook_runner if hook_runner.has_hooks() else None)

    # -- Query engine --
    engine = QueryEngine(registry)

    # -- MCP tools --
    mcp_servers = config.global_settings.mcp_servers or {}
    if mcp_servers:
        mcp_tools = await load_mcp_tools(mcp_servers)
        for t in mcp_tools:
            tools.register(t)

    # -- Agent tool (subagent support) --
    custom_agents = load_custom_agents(cwd)
    agent_tool = make_agent_tool(engine, registry, tools, pool_mgr, rules, custom_agents)
    tools.register(agent_tool)

    # -- Agent loop --
    loop = AgentLoop(engine, tools, pipeline, pool_mgr, registry)

    # Attach state so CLI layer can access it
    loop.skill_loader = loader
    loop.available_skills = available_skills
    loop.skills_list = skills_list
    loop.pool_manager = pool_mgr
    loop.custom_agents = custom_agents

    # Memory extraction callback — called from CLI after each turn
    async def _extract_after_turn(messages_text: str) -> None:
        loop._turn_count += 1
        if loop._turn_count % 5 == 0:
            await maybe_extract_memories(
                messages_text=messages_text,
                working_dir=str(cwd),
                query_engine=engine,
                model_registry=registry,
                tool_registry=tools,
                model_selector=pool_mgr,
            )

    loop.extract_memories = _extract_after_turn

    return loop, config


def make_agent_context(
    config: AppConfig,
    *,
    task_type: str = "main",
    model_override: str | None = None,
    working_dir: Path | None = None,
    skills: list[SkillSpec] | None = None,
    available_skills: dict[str, str] | None = None,
    custom_agents: dict | None = None,
) -> AgentContext:
    """Build an AgentContext from app config.

    Args:
        config: Application configuration.
        task_type: Task type for model routing (main, skill/<name>, etc.).
        model_override: Optional session-level model lock.
        working_dir: Working directory for tool execution.
        skills: Loaded skills for system prompt injection.
        available_skills: Name -> content mapping for skill_view tool.
    """
    cwd = str(working_dir or Path.cwd())
    system_prompt = config.global_settings.personality

    # Core behavioral guidelines (injected first, before skills/memory)
    system_prompt = (
        system_prompt
        + "\n\n## Guidelines\n"
        "- Work autonomously — use tools to gather information, then answer.\n"
        "- For time-sensitive queries (stock prices, news, weather): 2-3 search "
        "attempts are enough. Answer with what you have and acknowledge "
        "uncertainty rather than searching indefinitely.\n"
        "- If web_fetch returns 403 or timeout twice from the same domain, stop "
        "trying that domain. Work with the information you already have.\n"
        "- When you have enough information to give a useful answer, answer "
        "directly rather than seeking perfection."
    )

    # Inject available skills into system prompt
    if skills:
        injector = SkillInjector()
        system_prompt = injector.inject_skills(system_prompt, skills)

    # Inject available agents into system prompt
    from wings.agent.subagent import get_agent_types

    all_agents = get_agent_types(custom_agents or {})
    agent_lines = ["\n## Available Agents\n"]
    for name, spec in sorted(all_agents.items()):
        tools_desc = ", ".join(spec.tools) if spec.tools else "all"
        ro = " [read-only]" if spec.read_only else ""
        agent_lines.append(
            f"- **{name}**: {spec.description} (Tools: {tools_desc}){ro}"
        )
    agent_lines.append(
        "\nUse agent(subagent_type=\"<name>\", description=\"...\", prompt=\"...\") "
        "to spawn one."
    )
    system_prompt = system_prompt + "\n".join(agent_lines)

    # Inject memory (MEMORY.md from .wings/memory/)
    memory_prompt = load_memory_prompt(Path(cwd))
    system_prompt = f"{system_prompt}\n\n{memory_prompt}"

    # Environment information — placed at the END of system prompt, mirroring
    # claude-code's getSystemPrompt() order where computeEnvInfo() comes after
    # the dynamic sections (memory, MCP, scratchpad) and before the trailing
    # mode sections.
    env_info = (
        "# Environment\n"
        f"Working directory: {cwd}\n"
        f"Operating system: {platform.system()}\n"
        f"Current date: {datetime.now().strftime('%Y-%m-%d')}"
    )
    system_prompt = f"{system_prompt}\n\n{env_info}"

    return AgentContext(
        task_type=task_type,
        model_override=model_override or config.global_settings.model,
        tool_context=ToolContext(
            working_dir=cwd,
            available_skills=available_skills or {},
        ),
        system_prompt=system_prompt,
    )
