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
from wings.messages.types import TextDelta

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
            if isinstance(event, TextDelta) and spinner is not None:
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


async def _run_single(prompt: str, working_dir: Path, model: str | None, log: bool) -> None:
    """Execute a single-turn agent request."""
    try:
        loop, config = create_session(working_dir)
        if log:
            logger = TurnLogger(working_dir)
            loop.set_logger(logger)
            typer.echo(f"  Logging to {logger.path}")
        ctx = make_agent_context(config, working_dir=working_dir, model_override=model)
    except Exception as e:
        typer.echo(f"Error: failed to initialize session: {e}", err=True)
        raise typer.Exit(code=1)

    try:
        async for event in _wrap_stream(loop.run(prompt, ctx)):
            if isinstance(event, TextDelta):
                typer.echo(event.text, nl=False)
                sys.stdout.flush()
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

        if user_input.strip() == "/exit":
            break
        if user_input.strip() == "":
            continue

        ctx = make_agent_context(config, working_dir=working_dir, model_override=model)

        try:
            async for event in _wrap_stream(loop.run(user_input, ctx)):
                if isinstance(event, TextDelta):
                    typer.echo(event.text, nl=False)
                    sys.stdout.flush()
            nickname = loop.last_model.split("/")[0] if loop.last_model else ""
            typer.echo(f"\n  [{nickname}]")
        except Exception as e:
            typer.echo(f"\nError: {e}", err=True)
