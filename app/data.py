"""File I/O helpers. All functions take an explicit data_dir Path."""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("data")


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config(data_dir: Path) -> dict:
    f = data_dir / "config.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Corrupted {f}, returning empty config: {e}")
        return {}


def save_config(config: dict, data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write(data_dir / "config.json", json.dumps(config, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Pet refs
# ---------------------------------------------------------------------------

def load_pet_refs(pet_name: str, data_dir: Path) -> list[dict]:
    """Return list of {asset_id, face_id}. Handles legacy list-of-strings format."""
    ref_file = data_dir / "pets" / pet_name / "refs.json"
    if not ref_file.exists():
        return []
    try:
        data = json.loads(ref_file.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Corrupted {ref_file}, returning empty refs: {e}")
        return []
    if not data:
        return []
    if isinstance(data[0], str):
        return [{"asset_id": aid, "face_id": None} for aid in data]
    return data


def load_pet_asset_ids(pet_name: str, data_dir: Path) -> list[str]:
    seen: set[str] = set()
    result = []
    for r in load_pet_refs(pet_name, data_dir):
        aid = r["asset_id"]
        if aid not in seen:
            seen.add(aid)
            result.append(aid)
    return result


def save_pet_refs(pet_name: str, refs: list[dict], data_dir: Path) -> None:
    pet_dir = data_dir / "pets" / pet_name
    pet_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write(pet_dir / "refs.json", json.dumps(refs, indent=2))


# ---------------------------------------------------------------------------
# Negatives
# ---------------------------------------------------------------------------

def load_negative_ids(data_dir: Path) -> list[str]:
    path = data_dir / "negatives.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Corrupted {path}, returning empty negatives: {e}")
        return []


def save_negative_ids(ids: list[str], data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write(data_dir / "negatives.json", json.dumps(ids, indent=2))


# ---------------------------------------------------------------------------
# Skipped
# ---------------------------------------------------------------------------

def _load_skipped_map(data_dir: Path) -> dict[str, list[str]]:
    """Return pet_name -> skipped asset IDs.

    Backwards compatibility:
    - legacy list format becomes {"__legacy_global__": [...]}.
    - malformed payloads return {}.
    """
    path = data_dir / "skipped.json"
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Corrupted {path}, returning empty skipped list: {e}")
        return {}

    if isinstance(raw, list):
        return {"__legacy_global__": [str(x) for x in raw if isinstance(x, str)]}
    if isinstance(raw, dict):
        out: dict[str, list[str]] = {}
        for k, v in raw.items():
            if not isinstance(k, str) or not isinstance(v, list):
                continue
            out[k] = [str(x) for x in v if isinstance(x, str)]
        return out
    return {}


def load_skipped_ids(data_dir: Path, pet_name: str | None = None) -> list[str]:
    skipped_map = _load_skipped_map(data_dir)

    # Legacy global entries are applied to all pets until they are manually cleaned up.
    legacy_global = skipped_map.get("__legacy_global__", [])
    if pet_name is not None:
        combined = legacy_global + skipped_map.get(pet_name, [])
    else:
        combined = []
        for ids in skipped_map.values():
            combined.extend(ids)

    seen: set[str] = set()
    result: list[str] = []
    for aid in combined:
        if aid in seen:
            continue
        seen.add(aid)
        result.append(aid)
    return result


def save_skipped_ids(ids: list[str], data_dir: Path, pet_name: str | None = None) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    if pet_name is None:
        _atomic_write(data_dir / "skipped.json", json.dumps(ids, indent=2))
        return

    skipped_map = _load_skipped_map(data_dir)
    seen: set[str] = set()
    deduped: list[str] = []
    for aid in ids:
        if aid in seen:
            continue
        seen.add(aid)
        deduped.append(aid)

    skipped_map[pet_name] = deduped
    _atomic_write(data_dir / "skipped.json", json.dumps(skipped_map, indent=2))


# ---------------------------------------------------------------------------
# Skip-as-reference
# ---------------------------------------------------------------------------

def _load_skip_as_ref_map(data_dir: Path) -> dict[str, list[str]]:
    """Return pet_name -> skip-as-reference asset IDs.

    Backwards compatibility:
    - legacy list format becomes {"__legacy_global__": [...]}.
    - malformed payloads return {}.
    """
    path = data_dir / "skip_as_ref.json"
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Corrupted {path}, returning empty skip-as-reference list: {e}")
        return {}

    if isinstance(raw, list):
        return {"__legacy_global__": [str(x) for x in raw if isinstance(x, str)]}
    if isinstance(raw, dict):
        out: dict[str, list[str]] = {}
        for k, v in raw.items():
            if not isinstance(k, str) or not isinstance(v, list):
                continue
            out[k] = [str(x) for x in v if isinstance(x, str)]
        return out
    return {}


def load_skip_as_ref_ids(data_dir: Path, pet_name: str | None = None) -> list[str]:
    skip_map = _load_skip_as_ref_map(data_dir)

    # Legacy global entries are applied to all pets until they are manually cleaned up.
    legacy_global = skip_map.get("__legacy_global__", [])
    if pet_name is not None:
        combined = legacy_global + skip_map.get(pet_name, [])
    else:
        combined = []
        for ids in skip_map.values():
            combined.extend(ids)

    seen: set[str] = set()
    result: list[str] = []
    for aid in combined:
        if aid in seen:
            continue
        seen.add(aid)
        result.append(aid)
    return result


def save_skip_as_ref_ids(ids: list[str], data_dir: Path, pet_name: str | None = None) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    if pet_name is None:
        _atomic_write(data_dir / "skip_as_ref.json", json.dumps(ids, indent=2))
        return

    skip_map = _load_skip_as_ref_map(data_dir)
    seen: set[str] = set()
    deduped: list[str] = []
    for aid in ids:
        if aid in seen:
            continue
        seen.add(aid)
        deduped.append(aid)

    skip_map[pet_name] = deduped
    _atomic_write(data_dir / "skip_as_ref.json", json.dumps(skip_map, indent=2))


# ---------------------------------------------------------------------------
# Scan timestamp
# ---------------------------------------------------------------------------

def load_last_timestamp(data_dir: Path) -> str:
    path = data_dir / "last_scan_timestamp.txt"
    default = datetime.now(timezone.utc).date().isoformat() + "T00:00:00.000Z"
    if not path.exists():
        path.write_text(default + "\n", encoding="utf-8")
        return default
    val = path.read_text(encoding="utf-8").strip()
    return val if val else default


def save_last_timestamp(ts: str, data_dir: Path) -> None:
    _atomic_write(data_dir / "last_scan_timestamp.txt", ts.strip() + "\n")


# ---------------------------------------------------------------------------
# Poll status
# ---------------------------------------------------------------------------

def load_poll_status(data_dir: Path) -> dict:
    path = data_dir / "last_poll_status.json"
    if not path.exists():
        return {"status": "never"}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Corrupted {path}, returning default status: {e}")
        return {"status": "never"}


def write_poll_status(data_dir: Path, payload: dict) -> None:
    try:
        _atomic_write(data_dir / "last_poll_status.json", json.dumps(payload))
    except Exception:
        pass
