"""Static model capability metadata.

Each model entry describes what the model can and cannot do, enabling
capability-aware selection and validation.  Values are sourced from
official provider documentation.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

SpeedTier = Literal["fast", "normal", "slow"]


class ModelCapabilities(BaseModel):
    """Static capability profile for a model."""

    context_window: int  # Maximum context size in tokens
    max_output_tokens: int  # Maximum output tokens per call
    supports_vision: bool  # Image understanding
    supports_thinking: bool  # Extended thinking / reasoning
    supports_tools: bool  # Function calling / tool use
    supports_streaming: bool  # Streaming output
    supports_parallel_tools: bool  # Multiple tool calls in one turn
    speed_tier: SpeedTier
    cost_per_m_input: float  # $ per million input tokens
    cost_per_m_output: float  # $ per million output tokens


# -- Built-in capability catalog -----------------------------------------------

# Anthropic models (pricing as of 2026-07)
CLAUDE_OPUS_4_6 = ModelCapabilities(
    context_window=200_000,
    max_output_tokens=32_768,
    supports_vision=True,
    supports_thinking=True,
    supports_tools=True,
    supports_streaming=True,
    supports_parallel_tools=True,
    speed_tier="slow",
    cost_per_m_input=15.0,
    cost_per_m_output=75.0,
)

CLAUDE_SONNET_4_6 = ModelCapabilities(
    context_window=200_000,
    max_output_tokens=16_384,
    supports_vision=True,
    supports_thinking=True,
    supports_tools=True,
    supports_streaming=True,
    supports_parallel_tools=True,
    speed_tier="normal",
    cost_per_m_input=3.0,
    cost_per_m_output=15.0,
)

CLAUDE_HAIKU_4_5 = ModelCapabilities(
    context_window=200_000,
    max_output_tokens=8_192,
    supports_vision=True,
    supports_thinking=False,
    supports_tools=True,
    supports_streaming=True,
    supports_parallel_tools=True,
    speed_tier="fast",
    cost_per_m_input=0.80,
    cost_per_m_output=4.0,
)

# OpenAI models
GPT_4O = ModelCapabilities(
    context_window=128_000,
    max_output_tokens=16_384,
    supports_vision=True,
    supports_thinking=False,
    supports_tools=True,
    supports_streaming=True,
    supports_parallel_tools=True,
    speed_tier="normal",
    cost_per_m_input=2.50,
    cost_per_m_output=10.0,
)

GPT_O4_MINI = ModelCapabilities(
    context_window=200_000,
    max_output_tokens=100_000,
    supports_vision=True,
    supports_thinking=True,
    supports_tools=True,
    supports_streaming=True,
    supports_parallel_tools=False,
    speed_tier="normal",
    cost_per_m_input=1.10,
    cost_per_m_output=4.40,
)

# Google Gemini models
GEMINI_2_5_PRO = ModelCapabilities(
    context_window=1_048_576,
    max_output_tokens=65_536,
    supports_vision=True,
    supports_thinking=True,
    supports_tools=True,
    supports_streaming=True,
    supports_parallel_tools=True,
    speed_tier="normal",
    cost_per_m_input=1.25,
    cost_per_m_output=10.0,
)

GEMINI_2_5_FLASH = ModelCapabilities(
    context_window=1_048_576,
    max_output_tokens=65_536,
    supports_vision=True,
    supports_thinking=True,
    supports_tools=True,
    supports_streaming=True,
    supports_parallel_tools=True,
    speed_tier="fast",
    cost_per_m_input=0.15,
    cost_per_m_output=0.60,
)

# Lookup table keyed by the canonical model name used in the pool system.
CAPABILITY_CATALOG: dict[str, ModelCapabilities] = {
    "anthropic/claude-opus-4-6": CLAUDE_OPUS_4_6,
    "anthropic/claude-sonnet-4-6": CLAUDE_SONNET_4_6,
    "anthropic/claude-haiku-4-5": CLAUDE_HAIKU_4_5,
    "openai/gpt-4o": GPT_4O,
    "openai/o4-mini": GPT_O4_MINI,
    "google/gemini-2.5-pro": GEMINI_2_5_PRO,
    "google/gemini-2.5-flash": GEMINI_2_5_FLASH,
}


def get_capabilities(api_id: str) -> ModelCapabilities | None:
    """Look up capabilities for an api_id. Returns None if unknown."""
    return CAPABILITY_CATALOG.get(api_id)
