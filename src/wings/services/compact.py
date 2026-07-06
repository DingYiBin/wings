"""Compaction service — summarize old messages to free context window.

When the token budget exceeds the threshold (80% of context window),
the agent loop calls :func:`compact_messages` to replace the oldest
messages with a single summary message.  The system prompt and the
most recent messages are preserved verbatim so the model retains
immediate context.
"""

from __future__ import annotations

from wings.messages.types import Message, Role, TextBlock, ToolResultBlock, ToolUseBlock
from wings.models.protocol import ModelConfig
from wings.query.engine import QueryEngine

# Prompt for the summarization call.  Mirrors claude-code's
# BASE_COMPACT_PROMPT structure: preserve task-relevant detail,
# drop raw file contents, keep paths and decisions.
_COMPACT_PROMPT = """\
Review the conversation history below and produce a concise summary
that preserves all information needed to continue the task:

- User's original request and goals
- Key decisions made and why
- Files read or modified (with full paths)
- Tool results that informed decisions (brief, not full output)
- Current progress and pending next steps
- Any errors or blockers encountered

Be specific about file paths, function names, and technical details.
Do NOT include full file contents — reference them by path.
Write the summary as a continuous narrative, not a bullet list of
every message.
"""

# Number of recent messages to keep verbatim (not summarized).
# Must be even to keep user/assistant pairing intact.
_KEEP_RECENT = 6


async def compact_messages(
    messages: list[Message],
    *,
    query_engine: QueryEngine,
    model: str,
    config: ModelConfig,
    keep_recent: int = _KEEP_RECENT,
) -> list[Message]:
    """Compact message history by summarizing older messages.

    Returns a new message list:
    ``[system_prompt?, summary_message, *recent_messages]``

    The system prompt (first message if role=SYSTEM) is always preserved.
    The most recent *keep_recent* messages are preserved verbatim.
    Everything in between is sent to the model for summarization.
    """
    if len(messages) <= keep_recent + 1:
        # Not enough to compact — leave as-is.
        return messages

    # 1. Separate system prompt (if present)
    system_msg: Message | None = None
    rest = messages
    if messages and messages[0].role == Role.SYSTEM:
        system_msg = messages[0]
        rest = messages[1:]

    # 2. Split into to-summarize and keep-recent
    if len(rest) <= keep_recent:
        return messages  # nothing to summarize
    to_summarize = rest[:-keep_recent]
    recent = rest[-keep_recent:]

    # 3. Build the summarization input
    conversation_text = _messages_to_text(to_summarize)
    prompt = f"{_COMPACT_PROMPT}\n\n## Conversation to summarize\n\n{conversation_text}"

    summary = await _generate_summary(query_engine, model, config, prompt)

    # 4. Reassemble: [system?, summary, *recent]
    result: list[Message] = []
    if system_msg is not None:
        result.append(system_msg)
    result.append(
        Message(
            role=Role.USER,
            content=[TextBlock(text=f"## Conversation summary\n\n{summary}")],
        )
    )
    result.extend(recent)
    return result


def _messages_to_text(messages: list[Message]) -> str:
    """Flatten messages into a readable transcript for summarization."""
    lines: list[str] = []
    for msg in messages:
        role = msg.role.value.upper()
        parts: list[str] = []
        for block in msg.content:
            if isinstance(block, TextBlock):
                parts.append(block.text)
            elif isinstance(block, ToolUseBlock):
                parts.append(f"[tool call: {block.name}({block.input})]")
            elif isinstance(block, ToolResultBlock):
                content = block.content
                if isinstance(content, str):
                    parts.append(f"[tool result: {content[:500]}]")
                else:
                    parts.append("[tool result]")
        text = "\n".join(parts)
        lines.append(f"### {role}\n{text}")
    return "\n\n".join(lines)


async def _generate_summary(
    query_engine: QueryEngine,
    model: str,
    config: ModelConfig,
    prompt: str,
) -> str:
    """Call the model to generate a summary of the conversation."""
    summary_messages = [
        Message(
            role=Role.USER,
            content=[TextBlock(text=prompt)],
        ),
    ]
    result_text = ""
    async for event in query_engine.stream(
        summary_messages,
        model,
        tools=None,  # no tools — pure text summarization
        config=config,
    ):
        if event.type == "text_delta":
            result_text += event.text
        elif event.type == "text":
            result_text += event.text
    return result_text.strip() or "(summary unavailable)"
