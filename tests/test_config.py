"""Tests for the config module — settings loading and layered priority."""

from pathlib import Path

import pytest

from wings.config.settings import (
    AppConfig,
    GlobalSettings,
    ProjectSettings,
    ProviderConfig,
)
from wings.routing.types import PoolConfig


# -- GlobalSettings ------------------------------------------------------------


def test_global_settings_defaults():
    settings = GlobalSettings()
    assert settings.providers == {}
    assert isinstance(settings.routing, PoolConfig)
    assert settings.theme == "dark"


def test_global_settings_load_from_json(tmp_path):
    json_path = tmp_path / "config.json"
    json_path.write_text("""{
  "theme": "light",
  "providers": {
    "anthropic": {
      "model": "claude-opus-4-6",
      "protocol": "anthropic",
      "api_key": "sk-test",
      "base_url": "https://api.anthropic.com"
    }
  },
  "routing": {
    "version": 2,
    "apis": [
      {"api_id": "anthropic/claude-opus-4-6", "score": 0}
    ],
    "masks": {
      "main": {"anthropic/claude-opus-4-6": 2.0}
    }
  }
}""")

    settings = GlobalSettings.load(json_path)
    assert settings.theme == "light"
    assert settings.providers["anthropic"].api_key == "sk-test"
    assert settings.providers["anthropic"].model == "claude-opus-4-6"
    assert settings.routing.version == 2
    assert len(settings.routing.apis) == 1


def test_global_settings_providers_defaults():
    cfg = ProviderConfig(base_url="https://api.anthropic.com")
    assert cfg.model == "claude-sonnet-4-6"
    assert cfg.protocol == "anthropic"
    assert cfg.api_key == ""
    assert cfg.base_url == "https://api.anthropic.com"


def test_provider_config_requires_base_url():
    with pytest.raises(Exception):
        ProviderConfig()  # base_url is required


def test_global_settings_api_key_from_config():
    settings = GlobalSettings(
        providers={"anthropic": ProviderConfig(api_key="sk-config", base_url="https://api.anthropic.com")}
    )
    assert settings.api_key_for("anthropic") == "sk-config"


def test_global_settings_api_key_from_env(monkeypatch):
    monkeypatch.setenv("WINGS_PROVIDERS__ANTHROPIC__API_KEY", "sk-env")
    settings = GlobalSettings(
        providers={"anthropic": ProviderConfig(api_key="sk-config", base_url="https://api.anthropic.com")}
    )
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


def test_project_settings_load_from_json(tmp_path):
    json_dir = tmp_path / ".wings"
    json_dir.mkdir()
    (json_dir / "settings.json").write_text("""{
  "allowed_tools": ["read", "glob"],
  "denied_tools": ["rm"],
  "model": "claude-opus-4-6",
  "personality": "you are a pirate"
}""")

    ps = ProjectSettings.load(tmp_path)
    assert ps.allowed_tools == ["read", "glob"]
    assert ps.denied_tools == ["rm"]
    assert ps.model == "claude-opus-4-6"
    assert ps.personality == "you are a pirate"


def test_project_settings_walks_up(tmp_path):
    json_dir = tmp_path / ".wings"
    json_dir.mkdir()
    (json_dir / "settings.json").write_text('{"model": "claude-haiku-4-5"}')
    sub = tmp_path / "deep" / "nested"
    sub.mkdir(parents=True)

    ps = ProjectSettings.load(sub)
    assert ps.model == "claude-haiku-4-5"


def test_project_settings_not_found(tmp_path):
    ps = ProjectSettings.load(tmp_path)
    assert ps.model is None


# -- AppConfig -----------------------------------------------------------------


def test_app_config_load(tmp_path, monkeypatch):
    monkeypatch.setenv("WINGS_PROVIDERS__ANTHROPIC__API_KEY", "sk-test-key")
    monkeypatch.setenv("WINGS_PROVIDERS__ANTHROPIC__BASE_URL", "https://api.anthropic.com")
    json_dir = tmp_path / ".wings"
    json_dir.mkdir()
    (json_dir / "settings.json").write_text(
        '{"allowed_tools": ["read"], "personality": "concise"}'
    )

    app = AppConfig.load(tmp_path)
    assert app.project_settings.allowed_tools == ["read"]
    assert app.project_settings.personality == "concise"
    assert app.global_settings.api_key_for("anthropic") == "sk-test-key"


def test_app_config_defaults():
    app = AppConfig()
    assert isinstance(app.global_settings, GlobalSettings)
    assert isinstance(app.project_settings, ProjectSettings)
