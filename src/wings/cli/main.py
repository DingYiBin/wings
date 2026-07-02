"""Wings CLI entry point."""

import typer

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
        "--version",
        "-v",
        help="Show version and exit",
        callback=version_callback,
    ),
) -> None:
    pass


@app.command()
def chat() -> None:
    """Start an interactive chat session (coming soon)."""
    typer.echo("Chat mode not yet implemented.")


@app.command()
def agent(
    prompt: str = typer.Argument(help="The task for the agent to perform"),
) -> None:
    """Run a single-turn agent request (coming soon)."""
    typer.echo(f"Agent mode not yet implemented. Prompt: {prompt}")
