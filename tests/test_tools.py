"""Tests for the tools module — protocol, registry, decorator, builtins."""

import asyncio

import pytest

from wings.tools.base import ToolContext, ToolResult
from wings.tools.registry import ToolRegistry
from wings.tools.decorator import tool
from wings.tools.builtin.read import ReadInput, read_file
from wings.tools.builtin.write import WriteInput, write_file
from wings.tools.builtin.edit import EditInput, edit_file
from wings.tools.builtin.bash import BashInput, bash
from wings.tools.builtin.glob import GlobInput, glob_files
from wings.tools.builtin.grep import GrepInput, grep


# -- ToolContext / ToolResult --------------------------------------------------

def test_tool_result_defaults():
    r = ToolResult(output="done")
    assert r.output == "done"
    assert r.error is None


def test_tool_result_with_error():
    r = ToolResult(output="", error="permission denied")
    assert r.error == "permission denied"


def test_tool_context():
    ctx = ToolContext(working_dir="/tmp", session_id="s1")
    assert ctx.working_dir == "/tmp"


# -- ToolRegistry --------------------------------------------------------------


class FakeTool:
    name = "fake"
    description = "a fake tool"
    search_hint = "fake"
    _enabled = True

    def input_schema(self):
        return {"type": "object", "properties": {"x": {"type": "string"}}}

    async def call(self, input, context):
        return ToolResult(output="ok")

    def is_enabled(self):
        return self._enabled

    def is_read_only(self, input=None):
        return True

    def is_destructive(self, input=None):
        return False

    def render_result(self, result):
        return result.output

    def activity_description(self, input=None):
        return "faking..."


def test_registry_register_and_get():
    reg = ToolRegistry()
    t = FakeTool()
    reg.register(t)
    assert reg.get("fake") is t


def test_registry_get_missing():
    assert ToolRegistry().get("nope") is None


def test_registry_list_all():
    reg = ToolRegistry()
    reg.register(FakeTool())
    assert len(reg.list_all()) == 1


def test_registry_list_enabled():
    reg = ToolRegistry()
    t1 = FakeTool()
    t2 = FakeTool()
    t2.name = "fake2"
    t2._enabled = False
    reg.register(t1)
    reg.register(t2)
    assert len(reg.list_enabled()) == 1


def test_registry_get_schemas():
    reg = ToolRegistry()
    reg.register(FakeTool())
    schemas = reg.get_schemas()
    assert len(schemas) == 1
    assert schemas[0]["name"] == "fake"
    assert "input_schema" in schemas[0]


def test_registry_filter_denied():
    reg = ToolRegistry()
    reg.register(FakeTool())
    reg.filter_denied(["fake"])
    assert reg.get("fake") is None


# -- @tool decorator -----------------------------------------------------------

def test_decorator_basic():
    from pydantic import BaseModel

    class MyInput(BaseModel):
        text: str

    @tool(name="my_tool", description="desc", search_hint="hint", read_only=True)
    async def my_tool(input: MyInput, ctx: ToolContext) -> str:
        return f"got: {input.text}"

    assert my_tool.name == "my_tool"
    assert my_tool.is_read_only(None) is True
    assert my_tool.is_enabled() is True
    assert "text" in str(my_tool.input_schema())


@pytest.mark.asyncio
async def test_decorator_call():
    from pydantic import BaseModel

    class MyInput(BaseModel):
        value: int

    @tool(name="doubler", description="", search_hint="")
    async def doubler(input: MyInput, ctx: ToolContext) -> str:
        return str(input.value * 2)

    ctx = ToolContext(working_dir="/tmp")
    result = await doubler.call(MyInput(value=5), ctx)
    assert result.output == "10"


# -- Built-in: read ------------------------------------------------------------


def test_read_file_content(tmp_path):
    f = tmp_path / "test.txt"
    f.write_text("line one\nline two\nline three\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(read_file.call(ReadInput(file_path=str(f)), ctx))
    assert "line one" in result.output
    assert "line two" in result.output


def test_read_with_offset(tmp_path):
    f = tmp_path / "test.txt"
    f.write_text("line one\nline two\nline three\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(read_file.call(ReadInput(file_path=str(f), offset=2), ctx))
    assert "line one" not in result.output
    assert "line two" in result.output


def test_read_not_found(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(read_file.call(
        ReadInput(file_path=str(tmp_path / "nope.txt")), ctx
    ))
    assert "Error: file not found" in result.output


def test_read_is_directory(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(read_file.call(ReadInput(file_path=str(tmp_path)), ctx))
    assert "Error: path is a directory" in result.output


# -- Built-in: write -----------------------------------------------------------


def test_write_file(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    f = tmp_path / "out.txt"
    result = asyncio.run(write_file.call(
        WriteInput(file_path=str(f), content="hello world"), ctx
    ))
    assert "Wrote" in result.output
    assert f.read_text() == "hello world"


def test_write_creates_parent_dirs(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    f = tmp_path / "deep" / "nested" / "file.txt"
    asyncio.run(write_file.call(
        WriteInput(file_path=str(f), content="deep"), ctx
    ))
    assert f.read_text() == "deep"


# -- Built-in: edit ------------------------------------------------------------


def test_edit_file(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("hello world\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(edit_file.call(
        EditInput(file_path=str(f), old_string="hello", new_string="goodbye"), ctx
    ))
    assert "Edit applied" in result.output
    assert f.read_text() == "goodbye world\n"


def test_edit_same_string(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("hello\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(edit_file.call(
        EditInput(file_path=str(f), old_string="hello", new_string="hello"), ctx
    ))
    assert "Error" in result.output


def test_edit_duplicate_no_replace_all(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("hello world hello\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(edit_file.call(
        EditInput(file_path=str(f), old_string="hello", new_string="bye"), ctx
    ))
    assert "appears 2 times" in result.output


def test_edit_replace_all(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("hello world hello\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(edit_file.call(
        EditInput(
            file_path=str(f), old_string="hello", new_string="bye", replace_all=True
        ), ctx
    ))
    assert "2 occurrence" in result.output
    assert f.read_text() == "bye world bye\n"


# -- Built-in: bash ------------------------------------------------------------


def test_bash_echo(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(bash.call(BashInput(command="echo hello"), ctx))
    assert "hello" in result.output


def test_bash_nonzero_exit(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(bash.call(BashInput(command="exit 1"), ctx))
    assert "exit code: 1" in result.output


# -- Built-in: glob ------------------------------------------------------------


def test_glob_finds_files(tmp_path):
    (tmp_path / "a.py").write_text("")
    (tmp_path / "b.py").write_text("")
    (tmp_path / "c.txt").write_text("")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(glob_files.call(GlobInput(pattern="*.py"), ctx))
    assert "a.py" in result.output
    assert "b.py" in result.output
    assert "c.txt" not in result.output


def test_glob_no_matches(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(glob_files.call(GlobInput(pattern="*.rs"), ctx))
    assert "(no matches)" in result.output


# -- Built-in: grep ------------------------------------------------------------


def test_grep_finds_pattern(tmp_path):
    (tmp_path / "test.py").write_text("def foo():\n    pass\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(grep.call(
        GrepInput(pattern="def foo", path=str(tmp_path)), ctx
    ))
    assert "def foo" in result.output


def test_grep_files_with_matches(tmp_path):
    (tmp_path / "a.py").write_text("def foo():\n    pass\n")
    (tmp_path / "b.py").write_text("def bar():\n    pass\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(grep.call(
        GrepInput(pattern="def foo", path=str(tmp_path), output_mode="files_with_matches"), ctx
    ))
    assert "a.py" in result.output
    assert "b.py" not in result.output


def test_grep_count(tmp_path):
    (tmp_path / "a.py").write_text("foo foo foo\n")

    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(grep.call(
        GrepInput(pattern="foo", path=str(tmp_path), output_mode="count"), ctx
    ))
    assert ":3" in result.output


def test_grep_no_matches(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(grep.call(
        GrepInput(pattern="xyzzy_nonexistent", path=str(tmp_path)), ctx
    ))
    assert "(no matches)" in result.output


def test_grep_invalid_regex(tmp_path):
    ctx = ToolContext(working_dir=str(tmp_path))
    result = asyncio.run(grep.call(
        GrepInput(pattern="[invalid", path=str(tmp_path)), ctx
    ))
    assert "Error: invalid regex" in result.output


# -- Tool attribute checks -----------------------------------------------------


def test_read_tool_attrs():
    assert read_file.name == "read"
    assert read_file.is_read_only(None) is True
    assert read_file.is_enabled() is True


def test_write_tool_attrs():
    assert write_file.name == "write"
    assert write_file.is_destructive(None) is True


def test_bash_tool_attrs():
    assert bash.name == "bash"
    assert bash.is_destructive(None) is True


def test_glob_tool_attrs():
    assert glob_files.name == "glob"
    assert glob_files.is_read_only(None) is True


def test_edit_tool_attrs():
    assert edit_file.name == "edit"
    assert edit_file.is_read_only(None) is False
    assert edit_file.is_destructive(None) is True
