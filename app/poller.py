"""Poller: incremental classification using a local CLIP model.
No DB access. Embeddings computed from thumbnails via the Immich HTTP API."""

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

import classifier as clf_mod
import data
import embedder as emb
import immich as imm

log = logging.getLogger("poller")

THRESHOLD = float(os.environ.get("THRESHOLD", 0.8))

_count_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Date range helpers
# ---------------------------------------------------------------------------

def parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def asset_in_range(time_str: str, since: str | None, until: str | None) -> bool:
    d = parse_date(time_str)
    if d is None:
        return True
    if since and d < date.fromisoformat(since):
        return False
    if until and d > date.fromisoformat(until):
        return False
    return True


# ---------------------------------------------------------------------------
# Ref migration
# ---------------------------------------------------------------------------

def migrate_ref_bboxes(data_dir: Path) -> None:
    """One-time migration: fill in missing bbox and face_id fields on old-format refs."""
    config = data.load_config(data_dir)
    bbox_resolved = 0
    bbox_unresolvable = 0
    face_recovered = 0
    for pet_name, cfg in config.items():
        folder_key = cfg.get("person_id") or pet_name
        person_id = cfg.get("person_id")
        refs = data.load_pet_refs(folder_key, data_dir)
        changed = False
        for ref in refs:
            if not ref.get("bbox"):
                bbox = emb.resolve_bbox(ref["asset_id"])
                if bbox:
                    ref["bbox"] = bbox
                    changed = True
                    bbox_resolved += 1
                else:
                    bbox_unresolvable += 1
            if not ref.get("face_id") and person_id:
                face_id = imm.fetch_face_id_for_person(ref["asset_id"], person_id)
                if face_id:
                    ref["face_id"] = face_id
                    changed = True
                    face_recovered += 1
        if changed:
            try:
                data.save_pet_refs(folder_key, refs, data_dir)
            except PermissionError as e:
                # Keep startup running even if legacy docker-written files are not writable
                # in local script mode. Users can fix ownership and restart to complete migration.
                log.warning(f"Skipping ref migration write for '{folder_key}': {e}")
    parts = []
    if bbox_resolved or bbox_unresolvable:
        parts.append(f"bbox: {bbox_resolved} resolved, {bbox_unresolvable} unresolvable")
    if face_recovered:
        parts.append(f"face_id: {face_recovered} recovered")
    if parts:
        log.info(f"Ref migration: {', '.join(parts)}")


# ---------------------------------------------------------------------------
# Main poll cycle
# ---------------------------------------------------------------------------

def run_poll_cycle(data_dir: str, on_date=None, cancel=None, low_conf_out=None, live_counts: dict | None = None, manual: bool = False, scan_until: str | None = None, discover_only: bool = False, pet_name: str | None = None) -> None:
    log.info(f"Poll cycle | threshold={THRESHOLD} manual={manual}")
    dd = Path(data_dir)
    now = datetime.now(timezone.utc).isoformat()
    data.write_poll_status(dd, {"status": "running", "started_at": now})

    counts = live_counts if live_counts is not None else {}
    for k in ("added", "low_confidence", "unknown", "out_of_range", "already_tagged", "failed", "no_thumb", "matched"):
        counts[k] = 0
    try:
        extra = _run_poll_cycle(dd, counts, on_date, cancel, low_conf_out, manual, scan_until, discover_only, pet_name)
    except Exception as e:
        data.write_poll_status(dd, {"status": "error", "ran_at": datetime.now(timezone.utc).isoformat(), "error": str(e), "counts": counts})
        raise
    else:
        status = {"status": "idle", "ran_at": datetime.now(timezone.utc).isoformat(), "counts": counts}
        if isinstance(extra, dict):
            status.update(extra)
        data.write_poll_status(dd, status)


def _run_poll_cycle(dd: Path, counts: dict, on_date=None, cancel=None, low_conf_out=None, manual: bool = False, scan_until: str | None = None, discover_only: bool = False, pet_name: str | None = None) -> dict:
    config = data.load_config(dd)
    if not config:
        log.warning("config.json empty or missing, no pets configured yet.")
        return {}

    if pet_name and pet_name not in config:
        log.warning(f"Requested scan pet '{pet_name}' not found in config.")
        return {}

    all_pet_names = list(config.keys())

    all_refs = {name: data.load_pet_refs(config[name].get("person_id") or name, dd) for name in all_pet_names}
    ref_asset_ids_by_pet = {
        name: {str(r.get("asset_id")) for r in refs if r.get("asset_id")}
        for name, refs in all_refs.items()
    }

    pet_names = [n for n in all_pet_names if all_refs.get(n)]
    refs_per_pet = {n: all_refs[n] for n in pet_names}
    skipped = [n for n in all_pet_names if n not in pet_names]

    if skipped:
        log.warning(f"Skipping pets with no refs: {skipped}")
    if not pet_names:
        log.warning("No pets with reference assets, enroll pets via the UI first.")
        return {}

    log.info(f"Pets: {', '.join(f'{n}({len(refs_per_pet[n])} refs)' for n in pet_names)}")

    negative_ids = data.load_negative_ids(dd)
    if negative_ids:
        log.info(f"Loaded {len(negative_ids)} negative samples")

    result = clf_mod.build_classifier(pet_names, refs_per_pet, negative_ids)
    if result is None:
        return {}
    names, clf, scaler = result

    last_ts = data.load_last_timestamp(dd)
    log.info(f"Fetching assets by taken date (fileCreatedAt/localDateTime) after: {last_ts}")

    t0 = time.time()
    taken_before = (scan_until + "T23:59:59.999Z") if manual and scan_until else None
    assets = imm.fetch_assets_taken_after(last_ts, taken_before)
    log.info(f"Fetched {len(assets)} assets in {time.time()-t0:.1f}s")

    if not assets:
        log.info("No new assets.")
        if not manual:
            data.save_last_timestamp(datetime.now(timezone.utc).isoformat(), dd)
        return {}

    latest_ts = max((ts for _, ts in assets), default=last_ts)
    matched_assets: list[dict] = []
    low_conf_assets: list[dict] = []
    matched_lock = threading.Lock()

    def process_asset(aid: str, time_str: str) -> None:
        if cancel and cancel.is_set():
            return

        if on_date:
            on_date(time_str[:10])

        img = emb.fetch_thumbnail(aid)
        if img is None:
            with _count_lock:
                counts["no_thumb"] += 1
            return
        detected = emb.crop_animals(img)
        if not detected:
            crops = [(None, img)]
        else:
            crops = detected
            if len(detected) > 1:
                log.info(f"YOLO detected {len(detected)} animals in {aid} ({time_str[:10]})")
        vecs = [(bbox_norm, emb.embed_image(crop)) for bbox_norm, crop in crops]

        # Populate the crop cache so borderline and suggestions can reuse this
        # work without re-fetching and re-embedding. Only real animal crops are
        # stored; an empty list marks "no animal detected".
        emb.store_crops(aid, [(b, v) for b, v in vecs if b is not None and v is not None])

        if discover_only:
            best_match_by_pet: dict[str, dict] = {}
            best_low_by_pet: dict[str, dict] = {}
            for bbox_norm, vec in vecs:
                if vec is None:
                    continue

                predicted_pet, prob = clf_mod.classify(vec, names, clf, scaler)

                if predicted_pet == "unknown":
                    with _count_lock:
                        counts["unknown"] += 1
                    continue

                if pet_name and predicted_pet != pet_name:
                    continue

                cfg = config.get(predicted_pet, {})
                if not asset_in_range(time_str, cfg.get("since"), cfg.get("until")):
                    with _count_lock:
                        counts["out_of_range"] += 1
                    continue

                if prob < THRESHOLD:
                    prev_low = best_low_by_pet.get(predicted_pet)
                    if prev_low is None or prob > prev_low["prob"]:
                        best_low_by_pet[predicted_pet] = {
                            "asset_id": aid,
                            "date": time_str[:10],
                            "pet_name": predicted_pet,
                            "prob": round(float(prob), 4),
                            "bbox": list(bbox_norm) if bbox_norm is not None else None,
                        }
                    continue

                prev_match = best_match_by_pet.get(predicted_pet)
                if prev_match is None or prob > prev_match["prob"]:
                    best_match_by_pet[predicted_pet] = {
                        "asset_id": aid,
                        "date": time_str[:10],
                        "pet_name": predicted_pet,
                        "prob": round(float(prob), 4),
                        "bbox": list(bbox_norm) if bbox_norm is not None else None,
                    }

            if best_match_by_pet or best_low_by_pet:
                existing_face_person_ids = imm.fetch_asset_face_person_ids(aid)
            else:
                existing_face_person_ids = set()

            all_pets = set(best_match_by_pet.keys()) | set(best_low_by_pet.keys())
            for pet in all_pets:
                chosen = best_match_by_pet.get(pet) or best_low_by_pet.get(pet)
                if not chosen:
                    continue

                chosen_cfg = config.get(pet, {})
                chosen_person_id = chosen_cfg.get("person_id")
                chosen["is_reference"] = aid in ref_asset_ids_by_pet.get(pet, set())
                if chosen_person_id:
                    chosen["already_tagged"] = chosen_person_id in existing_face_person_ids
                else:
                    chosen["already_tagged"] = False

                if pet in best_match_by_pet:
                    with matched_lock:
                        matched_assets.append(chosen)
                    with _count_lock:
                        counts["matched"] += 1
                else:
                    with matched_lock:
                        low_conf_assets.append(chosen)
                    with _count_lock:
                        counts["low_confidence"] += 1
            return

        for bbox_norm, vec in vecs:
            if vec is None:
                continue

            predicted_pet, prob = clf_mod.classify(vec, names, clf, scaler)

            if predicted_pet == "unknown":
                with _count_lock:
                    counts["unknown"] += 1
                continue

            if pet_name and predicted_pet != pet_name:
                continue

            if prob < THRESHOLD:
                with _count_lock:
                    counts["low_confidence"] += 1
                if low_conf_out is not None:
                        low_conf_out.append({
                            "asset_id": aid,
                            "pet_name": predicted_pet,
                            "prob": prob,
                            "date": time_str[:10],
                            "bbox": list(bbox_norm) if bbox_norm is not None else None,
                        })
                continue

            cfg = config.get(predicted_pet, {})
            if not asset_in_range(time_str, cfg.get("since"), cfg.get("until")):
                with _count_lock:
                    counts["out_of_range"] += 1
                continue

            person_id = cfg.get("person_id")
            if not person_id:
                log.warning(f"Pet '{predicted_pet}' has no person_id in config.")
                continue

            # Auto poll/scan cycles are discovery only. Face assignment to
            # Immich is user-initiated via explicit tag actions in the UI.
            log.info(f"Discover match {aid} -> {predicted_pet} ({prob:.3f}) | {time_str[:10]}")
            with matched_lock:
                matched_assets.append({
                    "asset_id": aid,
                    "date": time_str[:10],
                    "pet_name": predicted_pet,
                    "prob": round(float(prob), 4),
                    "bbox": list(bbox_norm) if bbox_norm is not None else None,
                })
            with _count_lock:
                counts["matched"] += 1

    import detector as _det
    emb.reset_batch_stats()
    with _det._yolo_stats_lock:
        _det.yolo_batch_total = _det.yolo_batch_count = 0

    log.info(f"Processing {len(assets)} assets with {emb.SCAN_WORKERS} workers")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=emb.SCAN_WORKERS) as executor:
        futures = {executor.submit(process_asset, aid, ts): aid for aid, ts in assets}
        for future in as_completed(futures):
            if cancel and cancel.is_set():
                executor.shutdown(wait=False, cancel_futures=True)
                log.info("Scan cancelled.")
                return {}
            try:
                future.result()
            except Exception as e:
                log.warning(f"Asset {futures[future]} failed: {e}")

    elapsed = time.time() - t0
    clip_avg = emb.get_avg_batch_size()
    with _det._yolo_stats_lock:
        yolo_avg = _det.yolo_batch_total / _det.yolo_batch_count if _det.yolo_batch_count else 0
    log.info(
        f"STATS | assets={len(assets)} elapsed={elapsed:.1f}s "
        f"throughput={len(assets)/elapsed:.1f}/s "
        f"yolo_batch={yolo_avg:.1f} clip_batch={clip_avg:.1f} "
        f"counts={counts}"
    )

    emb.save_embed_cache()

    if discover_only:
        matched_assets.sort(key=lambda a: (a["date"], -a["prob"], a["asset_id"]))
        low_conf_assets.sort(key=lambda a: (a["date"], -a["prob"], a["asset_id"]))
        log.info(
            f"Discover-only scan complete. matched={len(matched_assets)} low_conf={len(low_conf_assets)} in_scope={len(assets)}"
        )
        return {
            "discover_only": True,
            "in_scope_total": len(assets),
            "matched_total": len(matched_assets),
            "matched_assets": matched_assets,
            "low_conf_total": len(low_conf_assets),
            "low_conf_assets": low_conf_assets,
            "threshold": THRESHOLD,
        }

    if not manual:
        data.save_last_timestamp(latest_ts, dd)
        log.info(f"Saved timestamp: {latest_ts}")
    if manual:
        matched_assets.sort(key=lambda a: (a["date"], -a["prob"], a["asset_id"]))
        return {
            "discover_only": False,
            "matched_total": len(matched_assets),
            "matched_assets": matched_assets,
            "low_conf_total": len(low_conf_assets),
            "low_conf_assets": low_conf_assets,
            "threshold": THRESHOLD,
        }
    return {}
