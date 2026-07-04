"""Wings CLI entry point."""

import asyncio
from pathlib import Path

import typer

from wings.cli.bootstrap import create_session, make_agent_context
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
) -> None:
    """Run a single-turn agent request."""
    asyncio.run(_run_single(prompt, working_dir, model))


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
) -> None:
    """Start an interactive chat session."""
    asyncio.run(_run_chat(working_dir, model))


# -- Implementation -----------------------------------------------------------


async def _run_single(prompt: str, working_dir: Path, model: str | None) -> None:
    """Execute a single-turn agent request."""
    try:
        loop, config = create_session(working_dir)
        ctx = make_agent_context(config, working_dir=working_dir, model_override=model)
    except Exception as e:
        typer.echo(f"Error: failed to initialize session: {e}", err=True)
        raise typer.Exit(code=1)

    typer.echo(f"  Model: {loop._turn_history[-1].model_id if loop._turn_history else 'pool'}")

    try:
        async for event in loop.run(prompt, ctx):
            if isinstance(event, TextDelta):
                typer.echo(event.text, nl=False)
        typer.echo()  # trailing newline
    except Exception as e:
        typer.echo(f"\nError: {e}", err=True)
        raise typer.Exit(code=1)


async def _run_chat(working_dir: Path, model: str | None) -> None:
    """Interactive chat loop."""
    try:
        loop, config = create_session(working_dir)
    except Exception as e:
        typer.echo(f"Error: failed to initialize session: {e}", err=True)
        raise typer.Exit(code=1)

    typer.echo("Wings chat — type /help for commands, /exit to quit.")

    while True:
        try:
            user_input = typer.prompt(">")
        except (EOFError, KeyboardInterrupt):
            typer.echo()
            break

        if user_input.strip() == "/exit":
            break
        if user_input.strip() == "":
            continue

        ctx = make_agent_context(config, working_dir=working_dir, model_override=model)

        try:
            async for event in loop.run(user_input, ctx):
                if isinstance(event, TextDelta):
                    typer.echo(event.text, nl=False)
            typer.echo()
        except Exception as e:
            typer.echo(f"\nError: {e}", err=True)
