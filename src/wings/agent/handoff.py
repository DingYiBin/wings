"""Model handoff detection — when a model returns after other models.

In a main conversation, the candidate pool may select different models
for different turns. When model A is used, then model B, then model A
again, the system injects a handoff prompt so model A knows what
happened in between and can review for needed corrections.
"""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field


class TurnRecord(BaseModel):
    """Record of a single model call within a conversation."""

    turn_id: int
    model_id: str  # API id used, e.g. "anthropic/claude-opus-4-6"
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    user_input_summary: str = ""  # One-line summary of user input
    tool_calls: list[str] = Field(default_factory=list)  # Tool names called
    summary: str = ""  # One-line summary of what the turn accomplished


class HandoffDetector:
    """Detect model handoff and generate context prompts.

    Maintained by AgentLoop. Checks whether the same model is being
    called again after other models intervened.
    """

    def detect(
        self,
        current_model: str,
        turn_history: list[TurnRecord],
    ) -> str | None:
        """Detect if a handoff prompt is needed.

        Returns a handoff prompt string, or None if not needed.

        Trigger: model A was used → other models were used in between
        → model A is being used again.
        """
        if len(turn_history) < 2:
            return None

        # Find the last turn where the current model was used
        previous_turn: TurnRecord | None = None
        for turn in reversed(turn_history):
            if turn.model_id == current_model:
                previous_turn = turn
                break

        if previous_turn is None:
            return None  # This model's first appearance — no handoff needed

        # Find intervening turns by other models.
        # Walk backwards from the end. Turns between now and the previous
        # self-turn are "intervening" if they used a different model.
        intermediate: list[TurnRecord] = []
        for turn in reversed(turn_history):
            if turn is previous_turn:
                break  # reached the last self-turn, stop
            if turn.model_id != current_model:
                intermediate.append(turn)

        if not intermediate:
            return None  # No other models in between

        return self._build_prompt(current_model, previous_turn, intermediate)

    def _build_prompt(
        self,
        current_model: str,
        previous_turn: TurnRecord,
        intermediate_turns: list[TurnRecord],
    ) -> str:
        other_models = sorted({t.model_id for t in intermediate_turns})
        turns_desc = "\n".join(
            f"  - [{t.model_id}] {t.summary or t.user_input_summary}"
            for t in reversed(intermediate_turns)
        )

        return (
            f"[System notice] Since your last turn in this conversation "
            f"(turn #{previous_turn.turn_id}), "
            f"{len(intermediate_turns)} turn(s) were handled by other "
            f"models: {', '.join(other_models)}.\n\n"
            f"Work done in between:\n{turns_desc}\n\n"
            f"Before addressing the current task, please:\n"
            f"1. Review these intermediate turns for issues that need "
            f"correction but haven't been addressed (e.g. inconsistent "
            f"code style, conflicting decisions, missed edge cases)\n"
            f"2. If issues are found, correct them before proceeding\n"
            f"3. If no corrections are needed, proceed with the current task"
        )
