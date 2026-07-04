"""Request/response logger — writes turn transcripts to .wings.log/."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class TurnLogger:
    """Captures outgoing messages and incoming responses for each cycle.

    When enabled via --log, writes one .log file per session to
    .wings.log/ in the working directory.
    """

    def __init__(self, working_dir: Path):
        self._dir = working_dir / ".wings.log"
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
        messages_sent: list[dict[str, Any]],
        response: dict[str, Any],
        tool_calls: list[str] | None = None,
    ) -> None:
        """Record a single API call cycle (request + response) with timestamps."""
        self._cycle_count += 1
        provider_name, _, service_model = model.partition("/")
        entry = {
            "cycle": self._cycle_count,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "elapsed_s": round(time.monotonic() - self._session_start, 3),
            "provider": provider_name,
            "service_model": service_model or model,
            "api_id": model,
            "messages_sent": messages_sent,
            "response": response,
            "tool_calls": tool_calls or [],
        }
        self._buffer.append(entry)
        self._flush()

    def _flush(self) -> None:
        """Write buffer to the log file incrementally."""
        with open(self._path, "w") as f:
            for entry in self._buffer:
                f.write(json.dumps(entry, ensure_ascii=False, default=str))
                f.write("\n")
