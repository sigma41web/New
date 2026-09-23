#!/usr/bin/env python3
"""Author the fully Korean prompt families (ADR-0055) as immutable version folders.

Each version lives in `tools/ko_prompts/v<X>_<Y>_<Z>.py` as FAMILIES = {family: (system, user[, meta])} plus a
CHANGELOG. Metadata (inputs, schema, params, failure behaviour, regression cases) is copied from the family's
SOURCE version unless the version module overrides it: the variable surface is the workflow contract and this
generator must not fork it silently. Content hashes mirror packages/prompts/src/registry.ts. Versions are
immutable: an existing folder with different content is an error, never an overwrite.

Usage: python3 tools/seed-prompt-families-ko-v3.py [3.0.0 3.1.0 ...]
"""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "packages", "prompts", "families")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SOURCE_VERSION = "2.2.5"
KNOWN = ["3.0.0", "4.0.0", "4.0.1", "4.1.0", "4.2.0", "4.3.0", "4.4.0"]


def content_hash(meta: dict, system: str, user: str) -> str:
    rest = {k: v for k, v in meta.items() if k not in ("content_hash", "id")}
    canonical = json.dumps(_normalize_numbers(rest), sort_keys=True, ensure_ascii=False,
                           separators=(",", ":"))
    h = hashlib.sha256()
    h.update(canonical.encode("utf-8"))
    h.update(b"\x00")
    h.update(system.encode("utf-8"))
    h.update(b"\x00")
    h.update(user.encode("utf-8"))
    return f"sha256:{h.hexdigest()}"


def _normalize_numbers(value):
    """JS JSON.stringify collapses integral doubles to ints; mirror it so hashes agree."""
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    if isinstance(value, list):
        return [_normalize_numbers(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalize_numbers(v) for k, v in value.items()}
    return value


def source_meta(family: str, source: str) -> dict:
    path = os.path.join(BASE, family, f"v{source}", "prompt.json")
    return json.load(open(path, encoding="utf-8"))


def write(family: str, version: str, changelog: str, system: str, user: str,
          overrides: dict | None, source: str, base: dict | None = None,
          purpose: str | None = None) -> None:
    # A new family has no source version: its module supplies the complete base metadata.
    src = base if base is not None else source_meta(family, source)
    meta = {
        "family": family,
        "version": version,
        "role": src["role"],
        "purpose": (purpose or "Korean manuscript-language prompt, fully Korean surface (ADR-0055), {version}.").format(version=version),
        "style_sensitive": src["style_sensitive"],
        "manuscript_producing": src["manuscript_producing"],
        "identity_variant": src.get("identity_variant"),
        "model_class": src["model_class"],
        "input_variables": src["input_variables"],
        "output_schema": src["output_schema"],
        "output_mode": src["output_mode"],
        "params": src["params"],
        "failure_behavior": src["failure_behavior"],
        "status": "active",
        "changelog": changelog,
        "regression_cases": src.get("regression_cases", []),
    }
    meta.update(overrides or {})
    if "{{narrative_identity_block}}" in system and not meta["style_sensitive"]:
        raise SystemExit(f"{family}: identity block in a non-style-sensitive prompt")
    meta["content_hash"] = content_hash(meta, system, user)
    out_dir = os.path.join(BASE, family, f"v{version}")
    if os.path.isdir(out_dir):
        existing = json.load(open(os.path.join(out_dir, "prompt.json"), encoding="utf-8"))
        if existing.get("content_hash") != meta["content_hash"]:
            raise SystemExit(f"{family}@{version} exists with different content; versions are immutable")
        return
    os.makedirs(out_dir)
    with open(os.path.join(out_dir, "prompt.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    open(os.path.join(out_dir, "system.md"), "w", encoding="utf-8").write(system)
    open(os.path.join(out_dir, "user.md"), "w", encoding="utf-8").write(user)
    print(f"{family}@{version} written")


def main(argv: list[str]) -> None:
    for version in argv or KNOWN:
        mod = importlib.import_module(f"ko_prompts.v{version.replace('.', '_')}")
        source = getattr(mod, "SOURCE_VERSION", SOURCE_VERSION)
        families = sorted(d for d in os.listdir(BASE) if os.path.isdir(os.path.join(BASE, d)))
        if getattr(mod, "COMPLETE", True):
            missing = [f for f in families if f not in mod.FAMILIES]
            if missing:
                raise SystemExit(f"{version} is missing families: {missing}")
        for family, spec in mod.FAMILIES.items():
            system, user = spec[0], spec[1]
            overrides = dict(spec[2]) if len(spec) > 2 else {}
            base = overrides.pop("__base", None)
            src = overrides.pop("__source", source)
            write(family, version, mod.CHANGELOG, system, user, overrides, src, base,
                  getattr(mod, "PURPOSE", None))


if __name__ == "__main__":
    main(sys.argv[1:])
