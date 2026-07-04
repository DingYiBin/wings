"""@tool decorator — register async functions as Tool instances.

Inspired by OpenSquilla's decorator pattern.
"""

from __future__ import annotations

import functools
from typing import Any, get_type_hints

from pydantic import BaseModel

from wings.tools.base import ToolContext, ToolResult


def tool(
    *,
    name: str,
    description: str,
    search_hint: str,
    read_only: bool = False,
    destructive: bool = False,
):
    """Decorate an async function to produce a Tool instance.

    The decorated function must accept a Pydantic model input and a
    ToolContext, and return something convertible to str.

    Example::

        class ReadInput(BaseModel):
            file_path: str

        @tool(name="read", description="Read a file", search_hint="read /path/to/file")
        async def read_file(input: ReadInput, context: ToolContext) -> str:
            return Path(input.file_path).read_text()
    """

    def decorator(fn):
        hints = get_type_hints(fn)
        # Find the first Pydantic model in the parameter types (excluding return)
        input_type = next(
            (
                t
                for n, t in hints.items()
                if n != "return" and isinstance(t, type) and issubclass(t, BaseModel)
            ),
            None,
        )

        class _ToolAdapter:
            """Tool instance created by @tool decorator."""

            def input_schema(self) -> dict[str, Any]:
                if _input_type is None:
                    return {"type": "object", "properties": {}}
                return _input_type.model_json_schema()

            async def call(self, input: Any, context: ToolContext) -> ToolResult:
                if _input_type is not None and isinstance(input, dict):
                    input = _input_type(**input)
                result = await _fn(input, context)
                return ToolResult(output=str(result))

            def is_enabled(self) -> bool:
                return True

            def is_read_only(self, input: Any = None) -> bool:
                return _read_only

            def is_destructive(self, input: Any = None) -> bool:
                return _destructive

            def render_result(self, result: ToolResult) -> str:
                return result.output

            def activity_description(self, input: Any = None) -> str:
                return f"{_name}..."

        # Attach captured values to the class (class body scope can't see
        # enclosing function variables).
        _fn = fn
        _input_type = input_type
        _name = name
        _read_only = read_only
        _destructive = destructive
        _ToolAdapter.name = _name
        _ToolAdapter.description = description
        _ToolAdapter.search_hint = search_hint

        return _ToolAdapter()

    return decorator
