"""Tests for the web_fetch tool."""

import pytest

from wings.tools.builtin.web_fetch import (
    WebFetchInput,
    _is_blocked_host,
    _html_to_markdown,
    _check_cache,
    _set_cache,
    _cache,
    web_fetch,
)
from wings.tools.base import ToolContext


def test_blocked_localhost():
    assert _is_blocked_host("localhost")
    assert _is_blocked_host("127.0.0.1")
    assert _is_blocked_host("0.0.0.0")


def test_blocked_private_ips():
    assert _is_blocked_host("10.0.0.1")
    assert _is_blocked_host("192.168.1.1")
    assert _is_blocked_host("172.16.0.1")
    assert _is_blocked_host("169.254.1.1")


def test_allows_public_hosts():
    assert not _is_blocked_host("example.com")
    assert not _is_blocked_host("docs.python.org")
    assert not _is_blocked_host("github.com")
    assert not _is_blocked_host("1.2.3.4")


def test_html_to_markdown_basic():
    md = _html_to_markdown("<h1>Title</h1><p>Hello <strong>world</strong></p>", "http://example.com")
    assert "Title" in md
    assert "world" in md
    assert "**" in md


def test_html_to_markdown_links():
    md = _html_to_markdown('<a href="/docs">docs</a>', "http://example.com")
    assert "docs" in md
    assert "example.com" in md or "/docs" in md


def test_cache_set_and_get():
    _cache.clear()
    _set_cache("http://x.com/test", "cached content")
    assert _check_cache("http://x.com/test") == "cached content"


def test_cache_miss():
    _cache.clear()
    assert _check_cache("http://never-seen.com") is None


def test_input_schema():
    schema = WebFetchInput.model_json_schema()
    props = schema["properties"]
    assert "url" in props
    assert "prompt" in props


@pytest.mark.asyncio
async def test_rejects_empty_url():
    ctx = ToolContext(working_dir="/tmp")
    inp = WebFetchInput(url="")
    result = await web_fetch.call(inp, ctx)
    assert "Error" in result.output


@pytest.mark.asyncio
async def test_rejects_blocked_host():
    ctx = ToolContext(working_dir="/tmp")
    inp = WebFetchInput(url="http://localhost:8080/docs")
    result = await web_fetch.call(inp, ctx)
    assert "blocked" in result.output.lower()


@pytest.mark.asyncio
async def test_upgrades_http_to_https():
    """HTTP URLs are auto-upgraded to HTTPS."""
    ctx = ToolContext(working_dir="/tmp")
    # This will fail to connect (no server), but won't be blocked
    inp = WebFetchInput(url="http://httpbin.org/get")
    result = await web_fetch.call(inp, ctx)
    # Should either succeed or fail with connection error, not "blocked"
    assert "blocked" not in result.output.lower()
