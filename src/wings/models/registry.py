"""Model registry — holds all registered providers and delegates selection."""

from __future__ import annotations

from typing import Any

from wings.models.protocol import ModelConfig, ModelProvider
from wings.routing.protocol import ModelSelector


class ModelRegistry:
    """Registry of all available model providers.

    Delegates model selection to a ModelSelector (e.g. APIPoolManager)
    so the registry itself is selection-strategy agnostic.
    """

    def __init__(self, selector: ModelSelector):
        self._providers: dict[str, ModelProvider] = {}
        self._aliases: dict[str, str] = {}  # alias -> canonical name
        self._selector = selector

    # -- Provider management --

    def register(self, name: str, provider: ModelProvider) -> None:
        """Register a model provider under its canonical name."""
        self._providers[name] = provider

    def alias(self, alias: str, target: str) -> None:
        """Create a short alias for a model name (e.g. 'opus' -> 'claude-opus-4-6')."""
        if target not in self._providers:
            raise KeyError(f"cannot alias to unknown provider: {target!r}")
        self._aliases[alias] = target

    def get(self, name: str) -> ModelProvider:
        """Look up a provider by name or alias. Raises KeyError if not found."""
        resolved = self._aliases.get(name, name)
        if resolved not in self._providers:
            raise KeyError(f"unknown model: {name!r}")
        return self._providers[resolved]

    def list(self) -> list[str]:
        """Return all registered canonical names."""
        return sorted(self._providers.keys())

    # -- Selection --

    def select(self, task_type: str, override: str | None = None) -> str:
        """Select a model for the given task_type via the configured selector."""
        return self._selector.select(task_type, override)

    # -- Convenience --

    def build_config(self, api_id: str, **overrides: Any) -> ModelConfig:
        """Build a ModelConfig for the given api_id with optional overrides."""
        provider = self.get(api_id)
        return ModelConfig(
            model=api_id,
            api_key="",  # caller should set this from settings
            **overrides,
        )
