---
name: commit
description: Generate a descriptive git commit message from staged or working changes
user-invocable: true
---

# Commit Skill

Analyze staged (`git diff --cached`) and working tree (`git diff`) changes,
then propose a concise, descriptive commit message following
conventional commits format (e.g. `feat:`, `fix:`, `refactor:`, `docs:`).

## Steps
1. Run `git diff --cached` to see staged changes
2. If nothing staged, run `git diff` for working changes
3. Identify the primary change and its scope
4. Generate a single-line summary (<= 72 chars)
5. Optionally add a body paragraph explaining why
6. Display the message and offer to `git commit` with it
