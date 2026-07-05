"""Tests for the memory module."""

import tempfile
from pathlib import Path

from wings.memory.loader import load_memory_prompt


def test_creates_memory_dir(tmp_path):
    """load_memory_prompt creates .wings/memory/ if it doesn't exist."""
    memory_dir = tmp_path / ".wings" / "memory"
    assert not memory_dir.exists()
    load_memory_prompt(tmp_path)
    assert memory_dir.exists()
    assert memory_dir.is_dir()


def test_returns_guidance_when_no_memory_file(tmp_path):
    """When MEMORY.md doesn't exist, return guidance only."""
    result = load_memory_prompt(tmp_path)
    assert "Auto Memory" in result
    assert "MEMORY.md" in result
    assert "user" in result
    assert "feedback" in result


def test_loads_existing_memory_md(tmp_path):
    """When MEMORY.md exists, include its content."""
    memory_dir = tmp_path / ".wings" / "memory"
    memory_dir.mkdir(parents=True)
    memory_md = memory_dir / "MEMORY.md"
    memory_md.write_text("- [User role](user_role.md) — Hugo is a Go developer")

    result = load_memory_prompt(tmp_path)
    assert "Hugo is a Go developer" in result
    assert "Auto Memory" in result


def test_empty_memory_md_returns_guidance(tmp_path):
    """Empty MEMORY.md still returns guidance."""
    memory_dir = tmp_path / ".wings" / "memory"
    memory_dir.mkdir(parents=True)
    memory_md = memory_dir / "MEMORY.md"
    memory_md.write_text("")

    result = load_memory_prompt(tmp_path)
    assert "Auto Memory" in result


def test_memory_guidance_includes_all_types(tmp_path):
    """Guidance covers all 4 memory types."""
    result = load_memory_prompt(tmp_path)
    assert "type>\n    <name>user</name>" in result
    assert "type>\n    <name>feedback</name>" in result
    assert "type>\n    <name>project</name>" in result
    assert "type>\n    <name>reference</name>" in result


def test_memory_guidance_includes_what_not_to_save(tmp_path):
    """Guidance tells model what NOT to save."""
    result = load_memory_prompt(tmp_path)
    assert "What NOT to save in memory" in result
    assert "git log" in result


def test_memory_guidance_includes_how_to_save(tmp_path):
    """Guidance explains the 2-step save process."""
    result = load_memory_prompt(tmp_path)
    assert "How to save memories" in result
    assert "two-step process" in result
    assert "frontmatter" in result


def test_memory_guidance_includes_before_recommending(tmp_path):
    """Guidance includes verification before recommending."""
    result = load_memory_prompt(tmp_path)
    assert "Before recommending from memory" in result
    assert "The memory says X exists" in result
