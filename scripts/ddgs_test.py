"""Test script to see raw ddgs output format."""
import json
from ddgs import DDGS

query = "腾讯股价"
print(f"Query: {query}\n")

with DDGS() as ddgs:
    results = list(ddgs.text(query, max_results=5))

for i, r in enumerate(results, 1):
    print(f"--- Result {i} ---")
    for k, v in r.items():
        val = str(v)
        if len(val) > 200:
            val = val[:200] + "..."
        print(f"  {k}: {val}")
    print()

print(f"Total results: {len(results)}")
print(f"\nRaw JSON:\n{json.dumps(results, indent=2, ensure_ascii=False)}")
