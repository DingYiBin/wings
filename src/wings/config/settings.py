"""Layered configuration: env vars > project json > global json > defaults."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from wings.routing.types import PoolConfig


# -- Per-provider API config --------------------------------------------------


class ProviderConfig(BaseModel):
    """Configuration for a single model provider.

    The provider name is the key in the ``providers`` dict, not a field here.
    """

    model: str = "claude-sonnet-4-6"
    api_key: str = ""
    base_url: str | None = None


# -- Global settings ----------------------------------------------------------


class GlobalSettings(BaseSettings):
    """Global configuration loaded from ~/.wings/config.json and env vars.

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

    @classmethod
    def load(cls, path: Path | None = None) -> GlobalSettings:
        """Load global settings from a JSON file + env var overrides.

        Default path: ~/.wings/config.json
        """
        json_path = path or Path.home() / ".wings" / "config.json"
        json_data: dict = {}
        if json_path.exists():
            with open(json_path) as f:
                json_data = json.load(f)

        return cls(**json_data)

    def api_key_for(self, provider: str) -> str:
        """Resolve API key for a provider: env var > config file."""
        env_key = os.environ.get(f"WINGS_PROVIDERS__{provider.upper()}__API_KEY", "")
        if env_key:
            return env_key
        return self.providers.get(provider, ProviderConfig()).api_key


# -- Project settings ---------------------------------------------------------


class ProjectSettings(BaseModel):
    """Per-project configuration loaded from wings.json in the project root."""

    allowed_tools: list[str] = Field(default_factory=list)
    denied_tools: list[str] = Field(default_factory=list)
    model: str | None = None  # project-level model override
    personality: str | None = None  # appended to system prompt

    @classmethod
    def load(cls, directory: Path) -> ProjectSettings:
        """Load project settings from wings.json in the given directory.

        Walks up from *directory* to find the nearest wings.json.
        """
        current = directory.resolve()
        for _ in range(20):  # prevent infinite walk
            json_path = current / "wings.json"
            if json_path.exists():
                with open(json_path) as f:
                    data = json.load(f)
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
