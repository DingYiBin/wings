"""Bootstrap wiring — create a fully configured agent session.

This is the "composition root" where all modules are wired together.
"""

from __future__ import annotations

from pathlib import Path

from wings.agent.loop import AgentContext, AgentLoop
from wings.config.settings import AppConfig
from wings.models.anthropic import AnthropicProvider
from wings.models.openai import OpenAIProvider
from wings.models.registry import ModelRegistry
from wings.permissions.pipeline import PermissionPipeline
from wings.permissions.rules import PermissionRules
from wings.query.engine import QueryEngine
from wings.routing.manager import APIPoolManager
from wings.tools.base import ToolContext
from wings.tools.builtin import (
    bash,
    edit_file,
    glob_files,
    grep,
    read_file,
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
        provider_cls = _PROVIDER_CLASSES.get(name)
        if provider_cls is None:
            continue
        api_key = config.global_settings.api_key_for(name)
        if not api_key:
            continue
        # Register the provider under its canonical id
        provider = provider_cls()
        api_id = f"{name}/{cfg.model}"
        registry.register(api_id, provider)
        # Also add to pool
        pool_mgr.register_api(api_id)

    # -- Tool registry --
    tools = ToolRegistry()
    for t in [read_file, write_file, edit_file, bash, glob_files, grep]:
        tools.register(t)

    # Apply project-level tool filters
    if config.project_settings.denied_tools:
        tools.filter_denied(config.project_settings.denied_tools)

    # -- Permissions --
    rules = PermissionRules()
    for name in config.project_settings.allowed_tools:
        rules.add_allow(name)
    for name in config.project_settings.denied_tools:
        rules.add_deny(name)
    pipeline = PermissionPipeline(rules)

    # -- Query engine --
    engine = QueryEngine(registry)

    # -- Agent loop --
    loop = AgentLoop(engine, tools, pipeline, pool_mgr)

    return loop, config


def make_agent_context(
    config: AppConfig,
    *,
    task_type: str = "main",
    model_override: str | None = None,
    working_dir: Path | None = None,
) -> AgentContext:
    """Build an AgentContext from app config."""
    cwd = str(working_dir or Path.cwd())
    return AgentContext(
        task_type=task_type,
        model_override=model_override or config.project_settings.model,
        tool_context=ToolContext(working_dir=cwd),
        system_prompt=config.project_settings.personality or "",
    )
