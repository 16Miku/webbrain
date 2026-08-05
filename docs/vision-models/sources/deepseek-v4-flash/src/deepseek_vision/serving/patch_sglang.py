from __future__ import annotations

from pathlib import Path

OLD = "hidden_states = self.embed_tokens(input_ids)"
NEW = "hidden_states = input_embeds if input_embeds is not None else self.embed_tokens(input_ids)"


def patch_deepseek_v4_source(path: str | Path) -> bool:
    """Patch SGLang so custom embeddings do not discard the routing token IDs."""
    source = Path(path)
    text = source.read_text(encoding="utf-8")
    if NEW in text:
        return False
    count = text.count(OLD)
    if count != 1:
        raise RuntimeError(f"expected exactly one SGLang embedding site, found {count}")
    source.write_text(text.replace(OLD, NEW), encoding="utf-8")
    return True
