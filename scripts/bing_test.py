"""Test script — call Bing backend and show raw + parsed results."""
import json
import sys

import httpx
from bs4 import BeautifulSoup

_BING_URL = "https://cn.bing.com/search"
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "腾讯控股 00700 股价"

from pathlib import Path

print(f"Query: {query}\n")

with httpx.Client(timeout=15, follow_redirects=True, headers={"User-Agent": _USER_AGENT}) as c:
    resp = c.get(_BING_URL, params={"q": query, "count": 5})

html = resp.text

# Save raw HTML
out = Path("reference/bing_search.html")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"Saved raw HTML ({len(html)} bytes) → {out}\n")

print(f"=== Raw HTML (first 3000 chars) ===")
print(html[:3000])
print("...\n")

# Parse with BeautifulSoup
soup = BeautifulSoup(html, "html.parser")
results = soup.select("li.b_algo")
print(f"=== b_algo blocks: {len(results)} ===\n")

for i, li in enumerate(results[:5]):
    print(f"--- Raw block {i+1} (first 500 chars) ---")
    print(str(li)[:500])
    print()

# Parsed output
print("=== Parsed results ===\n")
from wings.tools.builtin.bing_search import bing_search

parsed = bing_search(query, max_results=5)
for i, r in enumerate(parsed, 1):
    print(f"{i}. [{r['title']}]")
    print(f"   URL: {r['href']}")
    print(f"   Body: {r['body'][:200]}")
    print()

print(f"Total: {len(parsed)} results")
print(f"\nRaw JSON:\n{json.dumps(parsed, indent=2, ensure_ascii=False)}")
