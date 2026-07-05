"""Tests for the config module — settings loading and layered priority."""

from pathlib import Path

import pytest

from wings.config.settings import AppConfig, GlobalSettings, ProviderConfig
from wings.routing.types import PoolConfig


# -- GlobalSettings ------------------------------------------------------------

def test_global_settings_defaults():
    settings = GlobalSettings()
    assert settings.providers == {}
    assert isinstance(settings.routing, PoolConfig)
    assert settings.theme == "dark"
    assert settings.personality is None
    assert settings.model is None
    assert settings.allowed_tools == []
    assert settings.denied_tools == []


def test_global_settings_load_global(tmp_path):
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

    settings = GlobalSettings.load_global(json_path)
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


# -- GlobalSettings.load (global + project merge) ------------------------------

def test_load_merges_project_over_global(tmp_path):
    """Project .wings/config.json overrides global values."""
    (tmp_path / ".wings").mkdir()
    (tmp_path / ".wings" / "config.json").write_text("""{
  "personality": "concise",
  "allowed_tools": ["read"],
  "model": "claude-haiku-4-5"
}""")

    settings = GlobalSettings.load(tmp_path)
    assert settings.personality == "concise"
    assert settings.allowed_tools == ["read"]
    assert settings.model == "claude-haiku-4-5"
    # Global defaults still present
    assert settings.theme == "dark"


def test_load_walks_up_for_project_config(tmp_path):
    (tmp_path / ".wings").mkdir()
    (tmp_path / ".wings" / "config.json").write_text('{"model": "claude-haiku-4-5"}')
    sub = tmp_path / "deep" / "nested"
    sub.mkdir(parents=True)

    settings = GlobalSettings.load(sub)
    assert settings.model == "claude-haiku-4-5"


def test_load_no_project_config(tmp_path):
    settings = GlobalSettings.load(tmp_path)
    assert settings.model is None
    assert settings.personality is None


def test_load_project_providers_override_global(tmp_path):
    """Project config can add providers that take precedence over global."""
    # This tests deep merge: project providers should merge, not replace
    (tmp_path / ".wings").mkdir()
    (tmp_path / ".wings" / "config.json").write_text("""{
  "providers": {
    "openai": {
      "model": "gpt-4o",
      "protocol": "openai",
      "api_key": "sk-project",
      "base_url": "https://api.openai.com"
    }
  }
}""")

    settings = GlobalSettings.load(tmp_path)
    assert "openai" in settings.providers
    assert settings.providers["openai"].model == "gpt-4o"


# -- AppConfig ----------------------------------------------------------------

def test_app_config_load(tmp_path, monkeypatch):
    monkeypatch.setenv("WINGS_PROVIDERS__ANTHROPIC__API_KEY", "sk-test-key")
    monkeypatch.setenv("WINGS_PROVIDERS__ANTHROPIC__BASE_URL", "https://api.anthropic.com")
    (tmp_path / ".wings").mkdir()
    (tmp_path / ".wings" / "config.json").write_text(
        '{"allowed_tools": ["read"], "personality": "concise"}'
    )

    app = AppConfig.load(tmp_path)
    assert app.global_settings.allowed_tools == ["read"]
    assert app.global_settings.personality == "concise"
    assert app.global_settings.api_key_for("anthropic") == "sk-test-key"


def test_app_config_defaults():
    app = AppConfig()
    assert isinstance(app.global_settings, GlobalSettings)
    assert app.global_settings.theme == "dark"
