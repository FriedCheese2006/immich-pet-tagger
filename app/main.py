"""
Main entrypoint for immich-pet-tagger.
Starts the FastAPI enrollment UI and the background polling loop.
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import torch
import uvicorn
import fastapi
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from pathlib import Path
from embedder import load_embed_cache
from poller import run_poll_cycle, migrate_ref_bboxes
from api import router as api_router
import immich as imm
import detector as det
import embedder as emb

BASE_DIR = Path(__file__).resolve().parent
import state

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("main")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
LONG_REQUEST_TIMEOUT = int(os.environ.get("LONG_REQUEST_TIMEOUT", 120))


# Automatic polling removed - app is now entirely user-driven.
# All scans are manually triggered through the UI.


async def _wait_for_models_ready(timeout_s: int = 3600):
    deadline = asyncio.get_running_loop().time() + timeout_s
    while True:
        yolo_error = det.get_yolo_error()
        clip_error = emb.get_clip_error()
        if yolo_error or clip_error:
            raise RuntimeError(f"Model initialization failed: yolo={yolo_error or 'ok'} clip={clip_error or 'ok'}")
        if det.is_yolo_ready() and emb.is_clip_ready():
            return
        if asyncio.get_running_loop().time() > deadline:
            raise RuntimeError("Model initialization timed out")
        await asyncio.sleep(0.5)


async def initialize_runtime(app: FastAPI):
    app.state.ui_ready = False
    app.state.init_error = None
    try:
        await asyncio.to_thread(migrate_ref_bboxes, Path(DATA_DIR))
        await asyncio.to_thread(imm.validate_connection)
        # Start model workers eagerly so downloads begin at boot.
        det._ensure_yolo_workers()
        emb._ensure_clip_workers()
        await _wait_for_models_ready()
        app.state.ui_ready = True
        log.info("Initialization complete. Main UI is ready.")
    except Exception as e:
        app.state.init_error = str(e)
        app.state.ui_ready = False
        log.exception(f"Startup initialization failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.init()
    load_embed_cache(Path(DATA_DIR))
    app.state.ui_ready = False
    app.state.init_error = None
    app.state.init_task = asyncio.create_task(initialize_runtime(app))
    yield
    init_task = getattr(app.state, "init_task", None)
    if init_task:
        init_task.cancel()
        try:
            await init_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Immich Pet Tagger", lifespan=lifespan)

app.include_router(api_router)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/status")
async def status(request: fastapi.Request):
    # Debug logging to identify what's spamming this endpoint
    import time
    if not hasattr(app.state, "_last_status_log_time"):
        app.state._last_status_log_time = 0
        app.state._status_request_count = 0
    
    app.state._status_request_count += 1
    current_time = time.time()
    
    # Log every 5 seconds with request details
    if current_time - app.state._last_status_log_time > 5:
        user_agent = request.headers.get("user-agent", "no-user-agent")
        referer = request.headers.get("referer", "no-referer")
        log.info(f"Status endpoint hit {app.state._status_request_count} times in last 5s. User-Agent: {user_agent[:100]}, Referer: {referer}")
        app.state._last_status_log_time = current_time
        app.state._status_request_count = 0
    
    return {
        "data_dir": DATA_DIR,
        "immich_url": os.environ.get("IMMICH_URL", "not set"),
        "ui_ready": bool(getattr(app.state, "ui_ready", False)),
        "init_error": getattr(app.state, "init_error", None),
        "yolo_model": det.get_yolo_model(),
        "yolo_ready": det.is_yolo_ready(),
        "clip_ready": emb.is_clip_ready(),
        "yolo_error": det.get_yolo_error(),
        "clip_error": emb.get_clip_error(),
    }


@app.get("/")
async def root():
    from fastapi.responses import Response
    content = (BASE_DIR / "static" / "landing.html").read_text()
    return Response(
        content=content,
        media_type="text/html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        }
    )


@app.get("/app")
async def main_ui():
    from fastapi.responses import Response
    if not bool(getattr(app.state, "ui_ready", False)):
        content = (BASE_DIR / "static" / "landing.html").read_text()
        return Response(
            content=content,
            media_type="text/html",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            }
        )
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        log_level="info",
        timeout_keep_alive=LONG_REQUEST_TIMEOUT,
    )
