"""Bing search adapter — same {title, href, body} interface as ddgs.

Uses httpx + BeautifulSoup to scrape Bing's HTML results.
"""

from __future__ import annotations

import time

import httpx
from bs4 import BeautifulSoup

_BING_URL = "https://cn.bing.com/search"
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def bing_search(query: str, max_results: int = 10) -> list[dict[str, str]]:
    """Search Bing and return {title, href, body} results.

    Same interface as ddgs.DDGS().text(query, max_results=...).
    """
    if not query.strip():
        return []

    for attempt in range(3):
        try:
            with httpx.Client(
                timeout=15,
                follow_redirects=True,
                headers={"User-Agent": _USER_AGENT},
            ) as client:
                resp = client.get(
                    _BING_URL, params={"q": query, "count": max_results},
                )
                return _parse_results(resp.text, max_results)
        except Exception:
            if attempt < 2:
                time.sleep(1.0 * (attempt + 1))

    return []


def _parse_results(html: str, max_results: int) -> list[dict[str, str]]:
    """Parse Bing HTML search results into {title, href, body} dicts."""
    soup = BeautifulSoup(html, "html.parser")
    result_elements = soup.select("li.b_algo")[:max_results]

    results: list[dict[str, str]] = []
    for li in result_elements:
        # Title link — in h2 > a, or directly a.tilk
        h2 = li.find("h2")
        a = h2.find("a") if h2 else li.find("a", class_="tilk")

        if not a:
            continue

        href = a.get("href", "")
        if not href:
            continue

        # Extract plain text title from the link element
        title = a.get_text(" ", strip=True)[:200]

        # Snippet
        p = li.find("p")
        body = p.get_text(" ", strip=True)[:500] if p else ""
        body = body.replace("&ensp;", " ").replace("&#0183;", "")

        results.append({"title": title, "href": href, "body": body})

    return results
