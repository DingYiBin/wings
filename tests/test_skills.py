"""Tests for the skills module — loader, injector, skill_view tool."""

from pathlib import Path

import pytest

from wings.skills.builtin_data import builtin_skills_dir
from wings.skills.injector import SkillInjector
from wings.skills.loader import SkillLoader, _parse_frontmatter, _parse_skill_file
from wings.skills.types import SkillSpec
from wings.tools.base import ToolContext
from wings.tools.builtin.skill_view import SkillViewInput, skill_view


# -- Frontmatter parsing ---------------------------------------------------

def test_parse_frontmatter_valid():
    text = "---\nname: test-skill\ndescription: A test skill\n---\n\nBody text here."
    fm, body = _parse_frontmatter(text)
    assert fm == {"name": "test-skill", "description": "A test skill"}
    assert body == "Body text here."


def test_parse_frontmatter_no_delimiter():
    text = "Just plain markdown\n\nNo frontmatter."
    fm, body = _parse_frontmatter(text)
    assert fm == {}
    assert body == text


def test_parse_frontmatter_empty():
    fm, body = _parse_frontmatter("")
    assert fm == {}
    assert body == ""


def test_parse_frontmatter_invalid_yaml():
    text = "---\n\tinvalid: yaml: indent\n---\n\nBody."
    fm, body = _parse_frontmatter(text)
    # Invalid YAML returns empty frontmatter, body unchanged
    assert body == text


# -- Parse skill file ------------------------------------------------------

def test_parse_skill_file_valid(tmp_path):
    skill_dir = tmp_path / "my-skill"
    skill_dir.mkdir()
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("---\nname: my-skill\ndescription: Does things\n---\n\n## Instructions\n\nDo the thing.")

    spec = _parse_skill_file(skill_md)
    assert spec is not None
    assert spec.name == "my-skill"
    assert spec.description == "Does things"
    assert spec.content == "## Instructions\n\nDo the thing."
    assert spec.path == skill_dir


def test_parse_skill_file_missing_name(tmp_path):
    skill_dir = tmp_path / "bad-skill"
    skill_dir.mkdir()
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("---\ndescription: No name here\n---\n\nBody.")

    assert _parse_skill_file(skill_md) is None


def test_parse_skill_file_no_frontmatter(tmp_path):
    skill_dir = tmp_path / "no-fm"
    skill_dir.mkdir()
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("Just markdown, no YAML frontmatter.")

    assert _parse_skill_file(skill_md) is None


def test_parse_skill_file_empty(tmp_path):
    skill_dir = tmp_path / "empty"
    skill_dir.mkdir()
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("")

    assert _parse_skill_file(skill_md) is None


def test_parse_skill_file_user_invocable_false(tmp_path):
    skill_dir = tmp_path / "hidden"
    skill_dir.mkdir()
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("---\nname: hidden\ndescription: hidden skill\nuser-invocable: false\n---\n\nBody.")

    spec = _parse_skill_file(skill_md)
    assert spec is not None
    assert spec.user_invocable is False


def test_parse_skill_file_disable_model_invocation(tmp_path):
    skill_dir = tmp_path / "user-only"
    skill_dir.mkdir()
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("---\nname: user-only\ndescription: User only\ndisable-model-invocation: true\n---\n\nBody.")

    spec = _parse_skill_file(skill_md)
    assert spec is not None
    assert spec.disable_model_invocation is True


# -- SkillLoader -----------------------------------------------------------

def test_loader_discovers_skills(tmp_path):
    for name in ["alpha", "beta"]:
        skill_dir = tmp_path / name
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {name} skill\n---\n\nBody for {name}."
        )

    loader = SkillLoader(project_dir=tmp_path)
    skills = loader.load_all()
    assert len(skills) == 2
    names = {s.name for s in skills}
    assert names == {"alpha", "beta"}


def test_loader_skips_dot_dirs(tmp_path):
    skill_dir = tmp_path / "valid"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: valid\ndescription: ok\n---\n\nBody.")

    hidden_dir = tmp_path / ".hidden"
    hidden_dir.mkdir()
    (hidden_dir / "SKILL.md").write_text("---\nname: hidden\ndescription: nope\n---\n\nBody.")

    loader = SkillLoader(project_dir=tmp_path)
    skills = loader.load_all()
    assert len(skills) == 1
    assert skills[0].name == "valid"


def test_loader_skips_no_skill_md(tmp_path):
    skill_dir = tmp_path / "s1"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: s1\ndescription: ok\n---\n\nBody.")

    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    # no SKILL.md

    loader = SkillLoader(project_dir=tmp_path)
    skills = loader.load_all()
    assert len(skills) == 1


def test_loader_get_by_name(tmp_path):
    skill_dir = tmp_path / "test"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: test\ndescription: test skill\n---\n\nInstructions.")

    loader = SkillLoader(project_dir=tmp_path)
    assert loader.get_by_name("test") is not None
    assert loader.get_by_name("nonexistent") is None


def test_loader_list_model_visible(tmp_path):
    skill_dir = tmp_path / "visible"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: visible\ndescription: ok\n---\n\nBody.")

    hidden_dir = tmp_path / "hidden"
    hidden_dir.mkdir()
    (hidden_dir / "SKILL.md").write_text(
        "---\nname: hidden\ndescription: hidden from model\ndisable-model-invocation: true\n---\n\nBody."
    )

    loader = SkillLoader(project_dir=tmp_path)
    visible = loader.list_model_visible()
    assert len(visible) == 1
    assert visible[0].name == "visible"


def test_loader_list_user_invocable(tmp_path):
    skill_dir = tmp_path / "s1"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: s1\ndescription: ok\n---\n\nBody.")

    hidden_dir = tmp_path / "s2"
    hidden_dir.mkdir()
    (hidden_dir / "SKILL.md").write_text(
        "---\nname: s2\ndescription: hidden from user\nuser-invocable: false\n---\n\nBody."
    )

    loader = SkillLoader(project_dir=tmp_path)
    invocable = loader.list_user_invocable()
    assert len(invocable) == 1
    assert invocable[0].name == "s1"


def test_loader_builtin_lowest_precedence(tmp_path):
    """User/project skills override builtin skills of same name."""
    builtin_dir = tmp_path / "builtin"
    (builtin_dir / "test").mkdir(parents=True)
    (builtin_dir / "test" / "SKILL.md").write_text(
        "---\nname: test\ndescription: builtin version\n---\n\nBuiltin body."
    )
    project_dir = tmp_path / "project"

    loader = SkillLoader(project_dir=project_dir, builtin_dir=builtin_dir)
    skills = loader.load_all()
    spec = loader.get_by_name("test")
    assert spec is not None
    assert spec.source == "builtin"
    assert spec.content == "Builtin body."

    # Add project skill — overrides builtin
    (project_dir / "test").mkdir(parents=True)
    (project_dir / "test" / "SKILL.md").write_text(
        "---\nname: test\ndescription: project version\n---\n\nProject body."
    )

    loader2 = SkillLoader(project_dir=project_dir, builtin_dir=builtin_dir)
    spec2 = loader2.get_by_name("test")
    assert spec2 is not None
    assert spec2.source == "project"
    assert spec2.content == "Project body."


def test_loader_project_overrides_user(tmp_path):
    user_dir = tmp_path / "user"
    (user_dir / "test").mkdir(parents=True)
    (user_dir / "test" / "SKILL.md").write_text("---\nname: test\ndescription: user version\n---\n\nUser body.")

    project_dir = tmp_path / "project"
    (project_dir / "test").mkdir(parents=True)
    (project_dir / "test" / "SKILL.md").write_text("---\nname: test\ndescription: project version\n---\n\nProject body.")

    loader = SkillLoader(user_dir=user_dir, project_dir=project_dir)
    spec = loader.get_by_name("test")
    assert spec is not None
    assert spec.source == "project"
    assert spec.content == "Project body."


def test_loader_user_overrides_builtin(tmp_path):
    builtin_dir = tmp_path / "builtin"
    (builtin_dir / "test").mkdir(parents=True)
    (builtin_dir / "test" / "SKILL.md").write_text(
        "---\nname: test\ndescription: builtin version\n---\n\nBuiltin body."
    )

    user_dir = tmp_path / "user"
    (user_dir / "test").mkdir(parents=True)
    (user_dir / "test" / "SKILL.md").write_text(
        "---\nname: test\ndescription: user version\n---\n\nUser body."
    )

    loader = SkillLoader(user_dir=user_dir, builtin_dir=builtin_dir)
    spec = loader.get_by_name("test")
    assert spec is not None
    assert spec.source == "user"
    assert spec.content == "User body."


def test_loader_missing_dir_graceful():
    loader = SkillLoader(
        user_dir=Path("/nonexistent/path"),
        project_dir=Path("/another/nonexistent"),
    )
    skills = loader.load_all()
    assert skills == []


def test_loader_cached_load():
    loader = SkillLoader()
    skills1 = loader.load_all()
    skills2 = loader.load_all()
    assert skills1 is not skills2  # different list objects
    assert skills1 == skills2


# -- SkillInjector ---------------------------------------------------------

def test_inject_adds_skills_block():
    injector = SkillInjector()
    skills = [
        SkillSpec(name="commit", description="Generate commit messages", content="..."),
        SkillSpec(name="review-pr", description="Review pull requests", content="..."),
    ]
    result = injector.inject_skills("You are helpful.", skills)
    assert "You are helpful." in result
    assert "<available_skills>" in result
    assert "<name>commit</name>" in result
    assert "<name>review-pr</name>" in result
    assert "Generate commit messages" in result


def test_inject_empty_skills():
    injector = SkillInjector()
    result = injector.inject_skills("Base prompt", [])
    assert result == "Base prompt"


def test_inject_excludes_disable_model_invocation():
    injector = SkillInjector()
    skills = [
        SkillSpec(name="visible", description="Visible skill", content="..."),
        SkillSpec(name="hidden", description="Hidden skill", content="...",
                   disable_model_invocation=True),
    ]
    result = injector.inject_skills("Prompt", skills)
    assert "visible" in result
    assert "hidden" not in result


def test_inject_escapes_xml():
    injector = SkillInjector()
    skills = [
        SkillSpec(name="test", description="Use <code> & \"quotes\"", content="..."),
    ]
    result = injector.inject_skills("Prompt", skills)
    # XML-escaped: < → &lt;
    assert "&lt;code&gt;" in result
    # xml.escape only escapes < > &, not quotes (only in attribute context)
    assert "&amp;" in result  # & → &amp;


# -- skill_view tool -------------------------------------------------------

@pytest.mark.asyncio
async def test_skill_view_returns_content():
    ctx = ToolContext(
        working_dir=".",
        available_skills={"commit": "## Instructions\n\nGenerate a commit message."},
    )
    result = await skill_view.call(SkillViewInput(name="commit"), ctx)
    assert result.output == "## Instructions\n\nGenerate a commit message."
    assert result.error is None


@pytest.mark.asyncio
async def test_skill_view_not_found():
    ctx = ToolContext(
        working_dir=".",
        available_skills={"commit": "..."},
    )
    result = await skill_view.call(SkillViewInput(name="nonexistent"), ctx)
    assert result.error is None
    assert "not found" in result.output
    assert "commit" in result.output


@pytest.mark.asyncio
async def test_skill_view_empty_skills():
    ctx = ToolContext(working_dir=".")
    result = await skill_view.call(SkillViewInput(name="test"), ctx)
    assert "not found" in result.output
    assert "(none)" in result.output


# -- Builtin skills --------------------------------------------------------

def test_builtin_skills_loadable():
    loader = SkillLoader(builtin_dir=builtin_skills_dir())
    skills = loader.load_all()
    assert len(skills) == 3
    names = {s.name for s in skills}
    assert names == {"commit", "review-pr", "simplify"}


def test_builtin_skills_have_content():
    loader = SkillLoader(builtin_dir=builtin_skills_dir())
    for skill in loader.load_all():
        assert skill.name
        assert skill.description
        assert skill.content
        assert skill.source == "builtin"


def test_builtin_skills_model_visible():
    loader = SkillLoader(builtin_dir=builtin_skills_dir())
    for skill in loader.load_all():
        assert skill.disable_model_invocation is False
        assert skill.user_invocable is True
