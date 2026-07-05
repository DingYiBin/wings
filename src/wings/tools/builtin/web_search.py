"""WebSearch tool — search the web via DuckDuckGo.

Uses the ddgs (formerly duckduckgo_search) package — free, no API key required.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class WebSearchInput(BaseModel):
    """Input schema for web_search tool."""

    query: str = Field(
        min_length=2,
        description="The search query to use",
    )
    max_results: int = Field(
        default=10,
        ge=1,
        le=20,
        description="Maximum number of results to return (1-20)",
    )


@tool(
    name="web_search",
    description=(
        "Allows Claude to search the web and use the results to inform responses.\n"
        "- Provides up-to-date information for current events and recent data\n"
        "- Returns search result information formatted as search result blocks\n"
        "- Use this tool for accessing information beyond Claude's knowledge cutoff\n"
        "- Searches are performed automatically within a single API call\n"
        "\n"
        "CRITICAL REQUIREMENT - You MUST follow this:\n"
        "  - After answering the user's question, you MUST include a \"Sources:\" "
        "section at the end of your response\n"
        "  - In the Sources section, list all relevant URLs from the search results "
        "as markdown hyperlinks: [Title](URL)\n"
        "  - This is MANDATORY - never skip including sources in your response\n"
        "\n"
        "Usage notes:\n"
        "  - Domain filtering is supported to include or block specific websites\n"
        "  - Web search is only available in the US\n"
        "\n"
        "IMPORTANT - Use the correct year in search queries:\n"
        "  - The current month is July 2026. You MUST use this year when searching "
        "for recent information, documentation, or current events."
    ),
    read_only=True,
    search_hint="web_search query='python documentation' max_results=5",
)
async def web_search(input: WebSearchInput, context: ToolContext) -> str:
    """Search the web via DuckDuckGo and return formatted results."""
    query = input.query.strip()
    if len(query) < 2:
        return "Error: search query must be at least 2 characters"

    try:
        from ddgs import DDGS
    except ImportError:
        return "Error: ddgs package not installed. Run: uv add ddgs"

    import time

    results = []
    last_error = None
    for attempt in range(3):
        try:
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=input.max_results))
            break
        except Exception as e:
            last_error = e
            if attempt < 2:
                time.sleep(1.0 * (attempt + 1))

    if last_error and not results:
        return f"Error: search failed for '{query}' (retried 3x): {last_error}"

    if not results:
        return f"No results found for '{query}'."

    lines = [f'Web search results for: "{query}"\n']
    for i, r in enumerate(results, 1):
        title = r.get("title", "Untitled")
        href = r.get("href", "")
        body = r.get("body", "")
        lines.append(f"{i}. [{title}]({href})")
        if body:
            lines.append(f"   {body}")
        lines.append("")

    lines.append(
        "REMINDER: You MUST include the sources above in your response "
        "to the user using markdown hyperlinks."
    )
    return "\n".join(lines)
