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


def create_session(
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
            adaptive_thinking=cfg.adaptive_thinking,
            thinking_budget=cfg.thinking_budget,
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
    pipeline = PermissionPipeline(rules)

    # -- Query engine --
    engine = QueryEngine(registry)

    # -- Agent tool (subagent support) --
    custom_agents = load_custom_agents(cwd)
    agent_tool = make_agent_tool(engine, registry, tools, pool_mgr, rules, custom_agents)
    tools.register(agent_tool)

    # -- Agent loop --
    loop = AgentLoop(engine, tools, pipeline, pool_mgr, registry)

    # Attach state so CLI layer can access it
    loop.skill_loader = loader  # type: ignore[attr-defined]
    loop.available_skills = available_skills  # type: ignore[attr-defined]
    loop.skills_list = skills_list  # type: ignore[attr-defined]
    loop.pool_manager = pool_mgr  # type: ignore[attr-defined]

    return loop, config


def make_agent_context(
    config: AppConfig,
    *,
    task_type: str = "main",
    model_override: str | None = None,
    working_dir: Path | None = None,
    skills: list[SkillSpec] | None = None,
    available_skills: dict[str, str] | None = None,
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
    system_prompt = config.global_settings.personality or ""

    # Inject environment information
    env_info = (
        f"Working directory: {cwd}\n"
        f"Operating system: {platform.system()}\n"
        f"Current date: {datetime.now().strftime('%Y-%m-%d')}"
    )
    if system_prompt:
        system_prompt = f"{env_info}\n\n{system_prompt}"
    else:
        system_prompt = env_info

    # Inject available skills into system prompt
    if skills:
        injector = SkillInjector()
        system_prompt = injector.inject_skills(system_prompt, skills)

    # Inject memory (MEMORY.md from .wings/memory/)
    memory_prompt = load_memory_prompt(Path(cwd))
    system_prompt = f"{system_prompt}\n\n{memory_prompt}"

    return AgentContext(
        task_type=task_type,
        model_override=model_override or config.global_settings.model,
        tool_context=ToolContext(
            working_dir=cwd,
            available_skills=available_skills or {},
        ),
        system_prompt=system_prompt,
    )
