"""Wings CLI entry point."""

import asyncio
import contextlib
import sys
import time
from pathlib import Path

import typer

from prompt_toolkit import PromptSession

from wings.cli.bootstrap import create_session, make_agent_context
from wings.cli.logging import TurnLogger
from wings.messages.types import TextDelta, ToolResultBlock, ToolUseBlock

app = typer.Typer(
    name="wings",
    help="Multi-model AI agent system — each model is a wing.",
    no_args_is_help=True,
)


def version_callback(value: bool) -> None:
    if value:
        typer.echo("wings 0.1.0")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False,
        "--version", "-v",
        help="Show version and exit",
        callback=version_callback,
    ),
    working_dir: Path = typer.Option(
        Path.cwd(), "--dir", "-d",
        help="Working directory",
    ),
    model: str | None = typer.Option(
        None, "--model", "-m",
        help="Model to use (overrides pool selection)",
    ),
) -> None:
    """Wings — each model is a wing."""
    # Store in context for subcommands
    pass


@app.command()
def run(
    prompt: str = typer.Argument(help="The task for the agent to perform"),
    working_dir: Path = typer.Option(
        Path.cwd(), "--dir", "-d",
        help="Working directory",
    ),
    model: str | None = typer.Option(
        None, "--model", "-m",
        help="Model override",
    ),
    log: bool = typer.Option(
        False, "--log",
        help="Log request/response to .wings.log/",
    ),
) -> None:
    """Run a single-turn agent request."""
    asyncio.run(_run_single(prompt, working_dir, model, log))


@app.command()
def chat(
    working_dir: Path = typer.Option(
        Path.cwd(), "--dir", "-d",
        help="Working directory",
    ),
    model: str | None = typer.Option(
        None, "--model", "-m",
        help="Model override",
    ),
    log: bool = typer.Option(
        False, "--log",
        help="Log request/response to .wings.log/",
    ),
) -> None:
    """Start an interactive chat session."""
    asyncio.run(_run_chat(working_dir, model, log))


# -- Implementation -----------------------------------------------------------

# ANSI escape sequences
_CLEAR_LINE = "\033[2K\r"


async def _spinner_task(start: float) -> None:
    """Update the spinner line every second until cancelled."""
    try:
        while True:
            elapsed = int(time.monotonic() - start)
            sys.stderr.write(f"{_CLEAR_LINE}Working... ({elapsed}s)")
            sys.stderr.flush()
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        pass


async def _wrap_stream(stream):
    """Wrap an async iterator with a spinner. Yields events, clears spinner on first text."""
    started = False
    spinner = None
    try:
        async for event in stream:
            if not started:
                spinner = asyncio.create_task(_spinner_task(time.monotonic()))
                started = True
                # Yield control so the spinner task can start running
                await asyncio.sleep(0)
            if isinstance(event, (TextDelta, ToolUseBlock)) and spinner is not None:
                spinner.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await spinner
                spinner = None
                sys.stderr.write(_CLEAR_LINE)
                # Move to a clean line so stdout text starts fresh
                sys.stderr.write("\n")
                sys.stderr.flush()
            yield event
    finally:
        if spinner is not None:
            spinner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await spinner
            sys.stderr.write(f"{_CLEAR_LINE}\n")
            sys.stderr.flush()


def _ctx_kwargs(config, working_dir, model, loop):
    """Build kwargs for make_agent_context from session state."""
    return dict(
        config=config,
        working_dir=working_dir,
        model_override=model,
        skills=getattr(loop, "skills_list", None),
        available_skills=getattr(loop, "available_skills", None),
    )


def _display_tool_event(event) -> None:
    """Format a tool call or result for terminal display."""
    if isinstance(event, ToolUseBlock):
        # Show a clean one-liner for the tool call
        label = _tool_label(event.name, event.input)
        typer.echo(f"  ● {label}")
    elif isinstance(event, ToolResultBlock):
        # Show the result indented
        lines = event.content.strip().split("\n")
        for line in lines[:30]:  # cap at 30 lines
            typer.echo(f"    ⎿ {line}")
        if len(lines) > 30:
            typer.echo(f"    ... ({len(lines) - 30} more lines)")


def _tool_label(name: str, input: dict) -> str:
    """Build a human-readable label for a tool call."""
    path = input.get("file_path", "")
    if path:
        return f"{name}({path})"
    command = input.get("command", "")
    if command:
        # Truncate long commands
        if len(command) > 120:
            command = command[:120] + "..."
        return f"{name}({command})"
    pattern = input.get("pattern", "")
    if pattern:
        return f"{name}({pattern})"
    # Fallback: show first key-value pair
    if input:
        key, val = next(iter(input.items()))
        val_str = str(val)
        if len(val_str) > 80:
            val_str = val_str[:80] + "..."
        return f"{name}({key}={val_str})"
    return f"{name}()"


async def _run_single(prompt: str, working_dir: Path, model: str | None, log: bool) -> None:
    """Execute a single-turn agent request."""
    try:
        loop, config = create_session(working_dir)
        if log:
            logger = TurnLogger(working_dir)
            loop.set_logger(logger)
            typer.echo(f"  Logging to {logger.path}")
        ctx = make_agent_context(**_ctx_kwargs(config, working_dir, model, loop))
    except Exception as e:
        typer.echo(f"Error: failed to initialize session: {e}", err=True)
        raise typer.Exit(code=1)

    try:
        async for event in _wrap_stream(loop.run(prompt, ctx)):
            if isinstance(event, TextDelta):
                typer.echo(event.text, nl=False)
                sys.stdout.flush()
            else:
                _display_tool_event(event)
        nickname = loop.last_model.split("/")[0] if loop.last_model else ""
        typer.echo(f"\n  [{nickname}]")
    except Exception as e:
        typer.echo(f"\nError: {e}", err=True)
        raise typer.Exit(code=1)


async def _run_chat(working_dir: Path, model: str | None, log: bool) -> None:
    """Interactive chat loop."""
    try:
        loop, config = create_session(working_dir)
        if log:
            logger = TurnLogger(working_dir)
            loop.set_logger(logger)
            typer.echo(f"  Logging to {logger.path}")
    except Exception as e:
        typer.echo(f"Error: failed to initialize session: {e}", err=True)
        raise typer.Exit(code=1)

    typer.echo("Wings chat — type /help for commands, /exit to quit.")
    session = PromptSession("> ", enable_history_search=False)

    while True:
        try:
            user_input = (await session.prompt_async()).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if user_input.strip() == "":
            continue

        # -- Slash commands --
        if user_input.startswith("/"):
            parts = user_input[1:].split(maxsplit=1)
            cmd = parts[0].strip()
            args = parts[1].strip() if len(parts) > 1 else ""

            if cmd == "exit":
                break

            if cmd == "help":
                _show_help(loop)
                continue

            # Look up skill
            loader = getattr(loop, "skill_loader", None)
            skill = loader.get_by_name(cmd) if loader else None
            if skill is not None:
                skill_prompt = (
                    f"[Skill: {skill.name}]\n\n{skill.content}\n\n"
                    f"---\n\nUser request: {args or 'Run this skill'}"
                )
                ctx = make_agent_context(
                    **_ctx_kwargs(config, working_dir, model, loop),
                    task_type=f"skill/{skill.name}",
                )
                user_input = skill_prompt
            else:
                typer.echo(f"Unknown command or skill: /{cmd}")
                continue
        else:
            ctx = make_agent_context(**_ctx_kwargs(config, working_dir, model, loop))

        try:
            async for event in _wrap_stream(loop.run(user_input, ctx)):
                if isinstance(event, TextDelta):
                    typer.echo(event.text, nl=False)
                    sys.stdout.flush()
                else:
                    _display_tool_event(event)
            nickname = loop.last_model.split("/")[0] if loop.last_model else ""
            typer.echo(f"\n  [{nickname}]")
        except Exception as e:
            typer.echo(f"\nError: {e}", err=True)


def _show_help(loop) -> None:
    """Display available slash commands and skills."""
    typer.echo("\nCommands:")
    typer.echo("  /exit          Quit the chat session")
    typer.echo("  /help          Show this help")

    loader = getattr(loop, "skill_loader", None)
    if loader is not None:
        skills = loader.list_user_invocable()
        if skills:
            typer.echo("\nSkills:")
            for s in skills:
                typer.echo(f"  /{s.name:<15} {s.description}")
    typer.echo()
