"""Permission system — multi-stage pipeline for tool execution control."""

from wings.permissions.rules import PermissionResult, PermissionRules
from wings.permissions.pipeline import HookRunner, PermissionPipeline

__all__ = [
    "PermissionResult",
    "PermissionRules",
    "HookRunner",
    "PermissionPipeline",
]
