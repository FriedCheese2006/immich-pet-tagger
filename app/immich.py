"""Immich HTTP helpers. Sync functions are used by the poller (runs in a thread).
Async functions are used by the API routes."""

import logging
import os
import json
from logging.handlers import RotatingFileHandler
from pathlib import Path

import httpx
import requests

log = logging.getLogger("immich")

IMMICH_URL = os.environ.get("IMMICH_URL", "http://localhost:2283").rstrip("/")
IMMICH_API_KEY = os.environ.get("IMMICH_API_KEY", "")

FACE_BOX_SIZE = 256

_owner_id: str | None = None
_face_audit_file_logger: logging.Logger | None = None


def _get_face_audit_file_logger() -> logging.Logger | None:
    """Return logger writing APP_FACE_ASSIGN events to a rotating file.

    File path: {DATA_DIR}/logs/face_assignment.log
    Rotation defaults can be tuned with env vars:
      - FACE_AUDIT_LOG_MAX_BYTES (default: 5 MiB)
      - FACE_AUDIT_LOG_BACKUP_COUNT (default: 5)
    """
    global _face_audit_file_logger
    if _face_audit_file_logger is not None:
        return _face_audit_file_logger

    try:
        data_dir = Path(os.environ.get("DATA_DIR", "/data"))
        logs_dir = data_dir / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        log_file = logs_dir / "face_assignment.log"

        max_bytes = int(os.environ.get("FACE_AUDIT_LOG_MAX_BYTES", str(5 * 1024 * 1024)))
        backup_count = int(os.environ.get("FACE_AUDIT_LOG_BACKUP_COUNT", "5"))

        logger = logging.getLogger("face_audit_file")
        logger.setLevel(logging.INFO)
        logger.propagate = False

        # Avoid duplicate handlers if module is re-imported.
        if not logger.handlers:
            handler = RotatingFileHandler(
                log_file,
                maxBytes=max(1024, max_bytes),
                backupCount=max(1, backup_count),
                encoding="utf-8",
            )
            handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S"))
            logger.addHandler(handler)

        _face_audit_file_logger = logger
        return logger
    except Exception as e:
        log.warning(f"face audit file logger init failed: {e}")
        return None


def _audit_face_assignment(
    phase: str,
    *,
    asset_id: str,
    person_id: str,
    source: str,
    face_id: str | None = None,
    status_code: int | None = None,
    detail: str | None = None,
    context: dict | None = None,
) -> None:
    """Structured app-side audit line for Person face assignments in Immich.

    Prefix is intentionally unique so it can be grepped from logs.
    """
    payload = {
        "event": "APP_FACE_ASSIGN",
        "phase": phase,
        "source": source,
        "asset_id": asset_id,
        "person_id": person_id,
    }
    if face_id:
        payload["face_id"] = face_id
    if status_code is not None:
        payload["status_code"] = status_code
    if detail:
        payload["detail"] = detail
    if context:
        payload["context"] = context
    log.info(payload)

    file_logger = _get_face_audit_file_logger()
    if file_logger is not None:
        # JSON line format for easy grep/parsing in /data/logs/face_assignment.log
        file_logger.info(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))


def headers() -> dict:
    return {"x-api-key": IMMICH_API_KEY, "Accept": "application/json"}


def validate_connection() -> None:
    """Fail fast if the configured Immich API URL or key does not work."""
    try:
        r = requests.get(f"{IMMICH_URL}/api/users/me", headers=headers(), timeout=10)
    except Exception as e:
        raise RuntimeError(f"Cannot reach Immich at {IMMICH_URL}: {e}") from e
    if r.status_code != 200:
        raise RuntimeError(f"Immich validation failed at {IMMICH_URL}: HTTP {r.status_code}: {r.text[:200]}")
    global _owner_id
    _owner_id = r.json().get("id")


def get_owner_id() -> str | None:
    """Return the user ID of the API key owner, cached after first call."""
    global _owner_id
    if _owner_id is None:
        try:
            r = requests.get(f"{IMMICH_URL}/api/users/me", headers=headers(), timeout=10)
            if r.status_code == 200:
                _owner_id = r.json().get("id")
        except Exception as e:
            log.warning(f"get_owner_id failed: {e}")
    return _owner_id


# ---------------------------------------------------------------------------
# Sync (poller)
# ---------------------------------------------------------------------------

def fetch_assets_taken_after(taken_after_iso: str, taken_before_iso: str | None = None) -> list[tuple[str, str]]:
    """Return [(asset_id, fileCreatedAt_iso), ...] for manual scans.
    Uses takenAfter (EXIF date) so the date picker matches what the user sees in the Immich library."""
    query: dict = {"takenAfter": taken_after_iso}
    if taken_before_iso:
        query["takenBefore"] = taken_before_iso
    return _fetch_assets(query, ts_field="fileCreatedAt", label="fetch_assets_taken_after")


def _fetch_assets(query: dict, ts_field: str, label: str) -> list[tuple[str, str]]:
    url = f"{IMMICH_URL}/api/search/metadata"
    hdrs = {**headers(), "Content-Type": "application/json"}
    out: list[tuple[str, str]] = []
    page = 1
    size = 1000
    while True:
        r = requests.post(url, json={**query, "page": page, "size": size, "order": "asc"}, headers=hdrs, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"{label}: HTTP {r.status_code} on page {page}: {r.text[:200]}")
        data = r.json()
        block = data.get("assets") or {}
        items = (block.get("items") if isinstance(block, dict) else None) or data.get("items") or []
        owner_id = get_owner_id()
        for a in items:
            aid = a.get("id")
            ts = a.get(ts_field) or a.get("localDateTime") or ""
            if aid and ts:
                if owner_id and a.get("ownerId") != owner_id:
                    continue
                out.append((str(aid).strip("\x00"), ts))
        if len(items) < size:
            break
        page += 1
    return out


def fetch_face_id_for_person(asset_id: str, person_id: str) -> str | None:
    """Return the face_id on asset_id that belongs to person_id, or None."""
    try:
        r = requests.get(f"{IMMICH_URL}/api/faces", params={"id": asset_id}, headers=headers(), timeout=10)
        if r.status_code == 200:
            for face in r.json():
                if (face.get("person") or {}).get("id") == person_id:
                    return face.get("id")
    except Exception as e:
        log.warning(f"fetch_face_id_for_person {asset_id}: {e}")
    return None


def fetch_asset_face_person_ids(asset_id: str) -> set[str]:
    """Return set of person_ids already assigned as faces on this asset."""
    try:
        r = requests.get(f"{IMMICH_URL}/api/faces", params={"id": asset_id}, headers=headers(), timeout=10)
        if r.status_code != 200 or not isinstance(r.json(), list):
            return set()
        return {str(f["person"]["id"]) for f in r.json() if (f.get("person") or {}).get("id")}
    except Exception:
        return set()


def post_face_sync(
    asset_id: str,
    person_id: str,
    bbox_norm=None,
    img_size=None,
    *,
    source: str = "unknown",
    context: dict | None = None,
) -> str | None:
    """Create a face entry in Immich (sync, used by poller). Returns face_id on success, None on failure."""
    if bbox_norm is not None and img_size is not None:
        x1, y1, x2, y2 = bbox_norm
        iw, ih = img_size
        bx, by = int(x1 * iw), int(y1 * ih)
        bw, bh = int((x2 - x1) * iw), int((y2 - y1) * ih)
    else:
        bx, by, bw, bh = 0, 0, FACE_BOX_SIZE, FACE_BOX_SIZE
        iw, ih = FACE_BOX_SIZE, FACE_BOX_SIZE
    try:
        _audit_face_assignment("create_request", asset_id=asset_id, person_id=person_id, source=source, context=context)
        r = requests.post(
            f"{IMMICH_URL}/api/faces",
            json={"assetId": asset_id, "personId": person_id,
                  "width": bw, "height": bh,
                  "imageWidth": iw, "imageHeight": ih,
                  "x": bx, "y": by},
            headers={**headers(), "Content-Type": "application/json"},
            timeout=30,
        )
        if r.status_code not in (200, 201):
            _audit_face_assignment(
                "create_failed",
                asset_id=asset_id,
                person_id=person_id,
                source=source,
                status_code=r.status_code,
                detail=(r.text or "")[:200],
                context=context,
            )
            log.warning(f"post_face {asset_id} -> {r.status_code}: {r.text[:200]}")
            return None
        fr = requests.get(f"{IMMICH_URL}/api/faces", headers=headers(), params={"id": asset_id}, timeout=15)
        if fr.status_code == 200:
            for face in fr.json():
                if (face.get("person") or {}).get("id") == person_id:
                    face_id = face.get("id")
                    _audit_face_assignment(
                        "create_success",
                        asset_id=asset_id,
                        person_id=person_id,
                        source=source,
                        face_id=face_id,
                        status_code=r.status_code,
                        context=context,
                    )
                    return face_id
        _audit_face_assignment(
            "create_no_face_id",
            asset_id=asset_id,
            person_id=person_id,
            source=source,
            status_code=r.status_code,
            detail="created but could not retrieve face_id",
            context=context,
        )
        log.warning(f"post_face: created but could not retrieve face_id for asset {asset_id}")
        return None
    except Exception as e:
        _audit_face_assignment(
            "create_error",
            asset_id=asset_id,
            person_id=person_id,
            source=source,
            detail=str(e),
            context=context,
        )
        log.error(f"post_face error: {e}")
        return None


# ---------------------------------------------------------------------------
# Async (API routes)
# ---------------------------------------------------------------------------

async def post_face(
    client: httpx.AsyncClient,
    asset_id: str,
    person_id: str,
    bbox_norm: list[float] | None = None,
    *,
    source: str = "unknown",
    context: dict | None = None,
) -> str | None:
    """Create a face entry in Immich. Returns face_id on success, None on failure.
    Immich returns 201 with empty body, so face_id is fetched via GET after creation."""
    try:
        if bbox_norm is not None and len(bbox_norm) == 4:
            x1, y1, x2, y2 = [max(0.0, min(1.0, float(v))) for v in bbox_norm]
            bx, by = int(x1 * FACE_BOX_SIZE), int(y1 * FACE_BOX_SIZE)
            bw, bh = int(max(0.0, x2 - x1) * FACE_BOX_SIZE), int(max(0.0, y2 - y1) * FACE_BOX_SIZE)
        else:
            bx, by, bw, bh = 0, 0, FACE_BOX_SIZE, FACE_BOX_SIZE

        _audit_face_assignment("create_request", asset_id=asset_id, person_id=person_id, source=source, context=context)
        resp = await client.post(
            f"{IMMICH_URL}/api/faces",
            headers={**headers(), "Content-Type": "application/json"},
            json={"assetId": asset_id, "personId": person_id,
                  "width": bw, "height": bh,
                  "imageWidth": FACE_BOX_SIZE, "imageHeight": FACE_BOX_SIZE,
                  "x": bx, "y": by},
            timeout=30,
        )
        if resp.status_code not in (200, 201):
            _audit_face_assignment(
                "create_failed",
                asset_id=asset_id,
                person_id=person_id,
                source=source,
                status_code=resp.status_code,
                detail=(resp.text or "")[:200],
                context=context,
            )
            log.warning(f"post_face failed {resp.status_code}: {resp.text[:200]}")
            return None
        faces_resp = await client.get(f"{IMMICH_URL}/api/faces", headers=headers(), params={"id": asset_id})
        if faces_resp.status_code == 200:
            for face in faces_resp.json():
                if (face.get("person") or {}).get("id") == person_id:
                    face_id = face.get("id")
                    _audit_face_assignment(
                        "create_success",
                        asset_id=asset_id,
                        person_id=person_id,
                        source=source,
                        face_id=face_id,
                        status_code=resp.status_code,
                        context=context,
                    )
                    return face_id
        _audit_face_assignment(
            "create_no_face_id",
            asset_id=asset_id,
            person_id=person_id,
            source=source,
            status_code=resp.status_code,
            detail="created but could not retrieve face_id",
            context=context,
        )
        log.warning(f"post_face: created but could not retrieve face_id for asset {asset_id}")
        return None
    except Exception as e:
        _audit_face_assignment(
            "create_error",
            asset_id=asset_id,
            person_id=person_id,
            source=source,
            detail=str(e),
            context=context,
        )
        log.error(f"post_face error: {e}")
        return None


async def get_existing_face_person_ids(client: httpx.AsyncClient, asset_id: str) -> set[str]:
    """Return set of person_ids already assigned as faces on this asset (async)."""
    try:
        resp = await client.get(f"{IMMICH_URL}/api/faces", headers=headers(), params={"id": asset_id}, timeout=15)
        if resp.status_code == 200:
            return {f.get("person", {}).get("id") for f in resp.json() if f.get("person")}
    except Exception as e:
        log.warning(f"get_existing_face_person_ids error: {e}")
    return set()
