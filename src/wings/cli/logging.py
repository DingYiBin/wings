"""Request/response logger — writes session transcripts to .wings/logs/."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class TurnLogger:
    """Captures each API call cycle (request + response) with tool results.

    When enabled via --log, writes one .log file per session to
    .wings/logs/ in the working directory.
    """

    def __init__(self, working_dir: Path):
        self._dir = working_dir / ".wings" / "logs"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._make_path()
        self._buffer: list[dict[str, Any]] = []
        self._cycle_count = 0
        self._session_start = time.monotonic()

    def _make_path(self) -> Path:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
        raw = f"{ts}-{id(self)}".encode()
        h = hashlib.sha256(raw).hexdigest()[:8]
        return self._dir / f"{ts}_{h}.log"

    @property
    def path(self) -> Path:
        return self._path

    def record_cycle(
        self,
        *,
        model: str,
        context: str = "main",
        message_count: int = 0,
        input_summary: str = "",
        response: dict[str, Any],
        system_prompt: str = "",
        tool_calls: list[str] | None = None,
        tool_results: list[str] | None = None,
        thinking: str | None = None,
    ) -> None:
        """Record a single API call cycle.

        Args:
            model: api_id used for this call (e.g. "anthropic/claude-opus-4-6")
            context: task_type — "main", "subagent/explore", etc.
            message_count: total messages in conversation (tracks context growth)
            input_summary: what was sent to the model this cycle (user prompt
                or tool result summary)
            response: the model's response (text blocks + tool use blocks)
            tool_calls: list of tool names called in this cycle
            tool_results: truncated tool outputs from this cycle
            thinking: thinking/reasoning text if the model produced it
        """
        self._cycle_count += 1
        provider_name, _, service_model = model.partition("/")
        entry: dict[str, Any] = {
            "cycle": self._cycle_count,
            "context": context,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "elapsed_s": round(time.monotonic() - self._session_start, 3),
            "provider": provider_name,
            "service_model": service_model or model,
            "api_id": model,
            "message_count": message_count,
            "input": input_summary,
            "response": response,
            "tool_calls": tool_calls or [],
        }
        if system_prompt:
            entry["system_prompt"] = system_prompt
        if tool_results:
            entry["tool_results"] = tool_results
        if thinking:
            entry["thinking"] = thinking
        self._buffer.append(entry)
        self._flush()

    def _flush(self) -> None:
        """Write buffer to the log file incrementally."""
        with open(self._path, "w") as f:
            for entry in self._buffer:
                f.write(json.dumps(entry, ensure_ascii=False, default=str))
                f.write("\n")
