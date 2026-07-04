"""Tests for the config module — settings loading and layered priority."""

import os
import tempfile
from pathlib import Path

import pytest

from wings.config.settings import (
    AppConfig,
    GlobalSettings,
    LLMConfig,
    ProjectSettings,
)
from wings.routing.types import PoolConfig


# -- GlobalSettings ------------------------------------------------------------


def test_global_settings_defaults():
    settings = GlobalSettings()
    assert settings.llm == {}
    assert isinstance(settings.routing, PoolConfig)
    assert settings.theme == "dark"


def test_global_settings_load_from_toml(tmp_path):
    toml_path = tmp_path / "config.toml"
    toml_path.write_text("""
theme = "light"

[llm.anthropic]
provider = "anthropic"
model = "claude-opus-4-6"
api_key = "sk-test"

[routing]
default_weight = 2.0
""")

    settings = GlobalSettings.load(toml_path)
    assert settings.theme == "light"
    assert settings.llm["anthropic"].api_key == "sk-test"
    assert settings.routing.default_weight == 2.0


def test_global_settings_api_key_from_config():
    settings = GlobalSettings(
        llm={"anthropic": LLMConfig(api_key="sk-config")}
    )
    assert settings.api_key_for("anthropic") == "sk-config"


def test_global_settings_api_key_from_env(monkeypatch):
    monkeypatch.setenv("WINGS_LLM__ANTHROPIC__API_KEY", "sk-env")
    settings = GlobalSettings(
        llm={"anthropic": LLMConfig(api_key="sk-config")}
    )
    # Env var should win over config
    assert settings.api_key_for("anthropic") == "sk-env"


def test_global_settings_api_key_missing():
    settings = GlobalSettings()
    assert settings.api_key_for("nonexistent") == ""


# -- ProjectSettings -----------------------------------------------------------


def test_project_settings_defaults():
    ps = ProjectSettings()
    assert ps.allowed_tools == []
    assert ps.denied_tools == []
    assert ps.model is None


def test_project_settings_load_from_toml(tmp_path):
    toml_path = tmp_path / "wings.toml"
    toml_path.write_text("""
allowed_tools = ["read", "glob"]
denied_tools = ["rm"]
model = "claude-opus-4-6"
personality = "you are a pirate"
""")

    ps = ProjectSettings.load(tmp_path)
    assert ps.allowed_tools == ["read", "glob"]
    assert ps.denied_tools == ["rm"]
    assert ps.model == "claude-opus-4-6"
    assert ps.personality == "you are a pirate"


def test_project_settings_walks_up(tmp_path):
    """Project settings found by walking up from a subdirectory."""
    (tmp_path / "wings.toml").write_text('model = "claude-haiku-4-5"\n')
    sub = tmp_path / "deep" / "nested"
    sub.mkdir(parents=True)

    ps = ProjectSettings.load(sub)
    assert ps.model == "claude-haiku-4-5"


def test_project_settings_not_found(tmp_path):
    ps = ProjectSettings.load(tmp_path)
    assert ps.model is None


# -- AppConfig -----------------------------------------------------------------


def test_app_config_load(tmp_path, monkeypatch):
    """AppConfig bundles global + project settings."""
    monkeypatch.setenv("WINGS_LLM__ANTHROPIC__API_KEY", "sk-test-key")

    (tmp_path / "wings.toml").write_text(
        'allowed_tools = ["read"]\npersonality = "concise"\n'
    )

    app = AppConfig.load(tmp_path)
    assert app.project_settings.allowed_tools == ["read"]
    assert app.project_settings.personality == "concise"
    assert app.global_settings.api_key_for("anthropic") == "sk-test-key"


def test_app_config_defaults():
    app = AppConfig()
    assert isinstance(app.global_settings, GlobalSettings)
    assert isinstance(app.project_settings, ProjectSettings)
