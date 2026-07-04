---
name: review-pr
description: Review code changes for correctness, safety, style, and test coverage
user-invocable: true
---

# PR Review Skill

Review code changes systematically. Check for:
1. **Correctness**: Does the code do what it claims?
2. **Safety**: SQL injection, shell injection, hardcoded secrets
3. **Style**: Project conventions, naming, unnecessary complexity
4. **Tests**: Are new functions/behaviors tested?
5. **Edge cases**: Error handling, null checks, boundary conditions

Provide a structured review with BLOCK / WARN / PASS per category,
then an overall recommendation.
