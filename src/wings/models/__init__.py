"""Model adapters — each provider is a wing."""

from wings.models.protocol import ModelConfig, ModelProvider, ModelResponse, TokenUsage
from wings.models.capabilities import ModelCapabilities, get_capabilities, CAPABILITY_CATALOG
from wings.models.registry import ModelRegistry
from wings.models.anthropic import AnthropicProvider
from wings.models.openai import OpenAIProvider

__all__ = [
    "ModelConfig",
    "ModelProvider",
    "ModelResponse",
    "TokenUsage",
    "ModelCapabilities",
    "get_capabilities",
    "CAPABILITY_CATALOG",
    "ModelRegistry",
    "AnthropicProvider",
    "OpenAIProvider",
]
