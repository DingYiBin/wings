"""Layered configuration: env vars > .wings/config.json > ~/.wings/config.json > defaults.

Project-level ``.wings/config.json`` overrides global ``~/.wings/config.json``
for overlapping keys.  Both files share the same schema.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from wings.routing.types import PoolConfig

# -- Default system prompt (identity section) --------------------------------

_DEFAULT_PERSONALITY = """You are Wings, a multi-model AI agent CLI.

You are an interactive agent that helps users with software engineering tasks. \
Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with authorized security testing, defensive security, CTF \
challenges, and educational contexts. Refuse requests for destructive \
techniques, DoS attacks, mass targeting, supply chain compromise, or detection \
evasion for malicious purposes. Dual-use security tools (C2 frameworks, \
credential testing, exploit development) require clear authorization context: \
pentesting engagements, CTF competitions, security research, or defensive use \
cases.
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are \
confident that the URLs are for helping the user with programming. You may use \
URLs provided by the user in their messages or local files."""

# -- Per-provider API config --------------------------------------------------


class ProviderConfig(BaseModel):
    """Configuration for a single model provider.

    The provider name is the key in the ``providers`` dict, not a field here.
    ``protocol`` determines which adapter class is used (e.g. "anthropic"
    for Anthropic-compatible APIs, "openai" for OpenAI-compatible).
    """

    model: str = "claude-sonnet-4-6"
    protocol: str = "anthropic"  # which adapter class to use
    api_key: str = ""
    base_url: str  # required — each provider has its own endpoint
    max_tokens: int = 8_000  # output token cap (claude-code's CAPPED_DEFAULT)
    escalated_max_tokens: int = 64_000  # retry limit on max_tokens hit
    thinking: bool = True  # enable extended thinking
    thinking_budget: int | None = None  # None = auto: max_tokens - 1
    context_window: int = 200_000  # input context window (tokens)


# -- Global settings ----------------------------------------------------------


class GlobalSettings(BaseSettings):
    """Configuration loaded from ~/.wings/config.json + env vars,
    with optional per-project override from .wings/config.json.

    Environment variables use WINGS_ prefix with __ as nested separator.
    Example: WINGS_PROVIDERS__ANTHROPIC__API_KEY=sk-...
    """

    model_config = SettingsConfigDict(
        env_prefix="WINGS_",
        env_nested_delimiter="__",
    )

    # Model providers keyed by name: "anthropic", "openai", ...
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)

    # API candidate pool configuration
    routing: PoolConfig = Field(default_factory=PoolConfig)

    # UI
    theme: Literal["dark", "light"] = "dark"

    # Project-level overrides (also settable in global config)
    model: str | None = None  # default model override
    personality: str = _DEFAULT_PERSONALITY  # identity section, prepended to system prompt
    allowed_tools: list[str] = Field(default_factory=list)
    denied_tools: list[str] = Field(default_factory=list)
    hooks: dict[str, list[dict]] = Field(default_factory=dict)
    mcp_servers: dict[str, dict] = Field(default_factory=dict)

    @classmethod
    def load_global(cls, path: Path | None = None) -> GlobalSettings:
        """Load global settings from a JSON file + env var overrides.

        Default path: ~/.wings/config.json
        """
        json_path = path or Path.home() / ".wings" / "config.json"
        json_data: dict = {}
        if json_path.exists():
            with open(json_path) as f:
                json_data = json.load(f)
        return cls(**json_data)

    @classmethod
    def load(cls, working_dir: Path | None = None) -> GlobalSettings:
        """Load settings with project-level override.

        1. Load global from ~/.wings/config.json
        2. Walk up from working_dir to find .wings/config.json
        3. Merge: project values override global values

        Returns merged GlobalSettings.
        """
        cwd = working_dir or Path.cwd()
        global_settings = cls.load_global()

        # Walk up to find project config
        project_data = cls._find_project_config(cwd)
        if project_data:
            merged = global_settings.model_dump()
            _deep_merge(merged, project_data)
            return cls(**merged)

        return global_settings

    @staticmethod
    def _find_project_config(directory: Path) -> dict | None:
        """Walk up from *directory* to find .wings/config.json."""
        current = directory.resolve()
        for _ in range(20):
            json_path = current / ".wings" / "config.json"
            if json_path.exists():
                with open(json_path) as f:
                    return json.load(f)
            parent = current.parent
            if parent == current:
                break
            current = parent
        return None

    def api_key_for(self, provider: str) -> str:
        """Resolve API key for a provider: env var > config file."""
        env_key = os.environ.get(f"WINGS_PROVIDERS__{provider.upper()}__API_KEY", "")
        if env_key:
            return env_key
        cfg = self.providers.get(provider)
        if cfg is None:
            return ""
        return cfg.api_key


# -- Wiring helper ------------------------------------------------------------


class AppConfig(BaseModel):
    """Top-level application configuration — bundles everything needed
    to bootstrap a wings session."""

    global_settings: GlobalSettings = Field(default_factory=GlobalSettings)

    # Convenience aliases for the most-accessed project-level fields
    @property
    def project_settings(self) -> GlobalSettings:
        """The merged settings (global + project override)."""
        return self.global_settings

    @classmethod
    def load(cls, working_dir: Path | None = None) -> AppConfig:
        """Load the full application configuration."""
        return cls(global_settings=GlobalSettings.load(working_dir))


# -- Helpers ------------------------------------------------------------------


def _deep_merge(base: dict, override: dict) -> None:
    """Merge *override* into *base* in-place.  Nested dicts are merged
    recursively; everything else is replaced."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
