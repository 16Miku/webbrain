from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TowerConfig:
    kind: str
    model_id: str
    revision: str
    weight_prefix: str
    hidden_size: int = 1152
    merge_size: int = 2
    component_path: str | None = None


@dataclass(frozen=True)
class ProjectorConfig:
    vision_hidden_size: int = 1152
    text_hidden_size: int = 4096
    merge_size: int = 2
    layer_norm_eps: float = 1e-5


@dataclass(frozen=True)
class TextConfig:
    model_id: str
    revision: str
    hidden_size: int = 4096
    vocab_size: int = 129_280


@dataclass(frozen=True)
class RoutingConfig:
    policy: str
    palette_path: str
    palette_size: int = 64


@dataclass(frozen=True)
class ProjectConfig:
    name: str
    seed: int
    tower: TowerConfig
    projector: ProjectorConfig
    text: TextConfig
    routing: RoutingConfig


def _require(mapping: dict[str, Any], key: str, section: str) -> Any:
    if key not in mapping:
        raise ValueError(f"Missing required key {section}.{key}")
    return mapping[key]


def load_project_config(path: str | Path) -> ProjectConfig:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    tower = _require(raw, "tower", "root")
    projector = _require(raw, "projector", "root")
    text = _require(raw, "text", "root")
    routing = _require(raw, "routing", "root")
    config = ProjectConfig(
        name=_require(raw, "name", "root"),
        seed=int(raw.get("seed", 20260802)),
        tower=TowerConfig(
            kind=_require(tower, "kind", "tower"),
            model_id=_require(tower, "model_id", "tower"),
            revision=_require(tower, "revision", "tower"),
            weight_prefix=_require(tower, "weight_prefix", "tower"),
            hidden_size=int(tower.get("hidden_size", 1152)),
            merge_size=int(tower.get("merge_size", 2)),
            component_path=tower.get("component_path"),
        ),
        projector=ProjectorConfig(**projector),
        text=TextConfig(**text),
        routing=RoutingConfig(**routing),
    )
    validate_project_config(config)
    return config


def validate_project_config(config: ProjectConfig) -> None:
    if config.tower.kind not in {"moonvit", "qwen36"}:
        raise ValueError("tower.kind must be moonvit or qwen36")
    if config.tower.hidden_size != config.projector.vision_hidden_size:
        raise ValueError("tower and projector hidden sizes differ")
    if config.tower.merge_size != config.projector.merge_size:
        raise ValueError("tower and projector merge sizes differ")
    if config.text.hidden_size != config.projector.text_hidden_size:
        raise ValueError("text and projector hidden sizes differ")
    if config.routing.policy != "palette_cycle":
        raise ValueError("only routing policy palette_cycle is implemented")
    if config.routing.palette_size < 1:
        raise ValueError("routing.palette_size must be positive")
