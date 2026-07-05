# Logging refactor

## Problem

Current logging dumps the full `self._messages` (entire conversation history) on every
cycle. This grows unboundedly — a 10-cycle conversation logs 55 messages worth of
duplicate data. Also doesn't distinguish main session vs subagent.

## Changes

### logging.py
- Add `context` field to `record_cycle()` (task_type: "main", "subagent/explore", etc.)
- Replace `messages_sent` (full list of all messages) with:
  - `message_count`: total messages in conversation (to track growth)
  - `tool_results`: list of tool results from this cycle (output text, truncated to 500 chars each)
- Keep `response`, `tool_calls`, `thinking`, `model` as-is

### loop.py
- Pass `context.task_type` to both `record_cycle()` call sites
- Collect tool results into log entries

## Verification
- `uv run pytest tests/ -q` — all 243 pass
- Manual: `wings chat --log`, check log file is cleaner
