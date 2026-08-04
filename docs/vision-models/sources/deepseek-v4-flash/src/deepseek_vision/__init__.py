"""Routing-aware vision adapters for DeepSeek V4 Flash."""

from .config import ProjectConfig, load_project_config
from .projector import projector_parameter_count
from .routing import build_routing_ids, greedy_routing_palette

__all__ = [
    "ProjectConfig",
    "build_routing_ids",
    "greedy_routing_palette",
    "load_project_config",
    "projector_parameter_count",
]

__version__ = "0.1.0"
