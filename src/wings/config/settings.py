"""Layered configuration: env vars > project toml > global toml > defaults."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from wings.routing.types import PoolConfig


# -- Per-provider API config --------------------------------------------------


class LLMConfig(BaseModel):
    """Configuration for a single model provider."""

    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    api_key: str = ""
    base_url: str | None = None


# -- Global settings ----------------------------------------------------------


class GlobalSettings(BaseSettings):
    """Global configuration loaded from ~/.wings/config.toml and env vars.

    Environment variables use WINGS_ prefix with __ as nested separator.
    Example: WINGS_LLM__ANTHROPIC__API_KEY=sk-...
    """

    model_config = SettingsConfigDict(
        env_prefix="WINGS_",
        env_nested_delimiter="__",
        toml_file=None,  # set at load time
    )

    # Model providers (keyed by provider name: "anthropic", "openai", ...)
    llm: dict[str, LLMConfig] = Field(default_factory=dict)

    # API candidate pool configuration
    routing: PoolConfig = Field(default_factory=PoolConfig)

    # UI
    theme: Literal["dark", "light"] = "dark"

    @classmethod
    def load(cls, path: Path | None = None) -> GlobalSettings:
        """Load global settings from a TOML file + env var overrides.

        Default path: ~/.wings/config.toml
        """
        toml_path = path or Path.home() / ".wings" / "config.toml"
        toml_data: dict = {}
        if toml_path.exists():
            with open(toml_path, "rb") as f:
                toml_data = tomllib.load(f)

        # Merge TOML data with env vars (env vars win)
        return cls(**toml_data)

    def api_key_for(self, provider: str) -> str:
        """Resolve API key for a provider: env var > config file."""
        env_key = os.environ.get(f"WINGS_LLM__{provider.upper()}__API_KEY", "")
        if env_key:
            return env_key
        return self.llm.get(provider, LLMConfig()).api_key


# -- Project settings ---------------------------------------------------------


class ProjectSettings(BaseModel):
    """Per-project configuration loaded from wings.toml in the project root."""

    allowed_tools: list[str] = Field(default_factory=list)
    denied_tools: list[str] = Field(default_factory=list)
    model: str | None = None  # project-level model override
    personality: str | None = None  # appended to system prompt

    @classmethod
    def load(cls, directory: Path) -> ProjectSettings:
        """Load project settings from wings.toml in the given directory.

        Walks up from *directory* to find the nearest wings.toml.
        """
        current = directory.resolve()
        for _ in range(20):  # prevent infinite walk
            toml_path = current / "wings.toml"
            if toml_path.exists():
                with open(toml_path, "rb") as f:
                    data = tomllib.load(f)
                return cls(**data)
            parent = current.parent
            if parent == current:
                break
            current = parent
        return cls()


# -- Wiring helper ------------------------------------------------------------


class AppConfig(BaseModel):
    """Top-level application configuration — bundles everything needed
    to bootstrap a wings session."""

    global_settings: GlobalSettings = Field(default_factory=GlobalSettings)
    project_settings: ProjectSettings = Field(default_factory=ProjectSettings)

    @classmethod
    def load(cls, working_dir: Path | None = None) -> AppConfig:
        """Load the full application configuration."""
        cwd = working_dir or Path.cwd()
        return cls(
            global_settings=GlobalSettings.load(),
            project_settings=ProjectSettings.load(cwd),
        )
