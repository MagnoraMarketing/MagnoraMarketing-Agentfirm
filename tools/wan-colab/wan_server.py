"""Wan 2.2 video generation API for Google Colab.

Runs Wan 2.2 TI2V-5B (text-to-video, optional image-to-video) through
diffusers behind a small HTTP API with bearer-token auth and a one-at-a-time
job queue. Paperclip agents call it with the `wan-video` skill.

Endpoints (all except /health need `Authorization: Bearer <token>`):

  GET  /health                     -> {"ok": true, "model": ..., "busy": bool}
  POST /jobs                       -> {"id": ..., "status": "queued"}
       JSON: prompt (required), negative_prompt, orientation
             ("landscape" | "portrait" | "square"), seconds (1-5),
             steps (10-50), guidance (1-10), seed, image_url
  GET  /jobs/{id}                  -> job status
  GET  /jobs/{id}/video            -> the MP4 once status == "succeeded"

Environment:
  WAN_API_TOKEN   bearer token (required)
  WAN_MODEL_ID    default "Wan-AI/Wan2.2-TI2V-5B-Diffusers"
  WAN_OUTPUT_DIR  default "/content/wan_outputs"
  WAN_FAKE=1      skip the model and write a tiny placeholder file (tests)
"""

from __future__ import annotations

import hmac
import os
import queue
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
OUTPUT_DIR = Path(os.environ.get("WAN_OUTPUT_DIR", "/content/wan_outputs"))
FAKE = os.environ.get("WAN_FAKE") == "1"
FPS = 24
MAX_QUEUED = 20

# TI2V-5B is trained at 1280x704 / 704x1280. Square is a cheaper option.
SIZES = {
    "landscape": (704, 1280),  # (height, width)
    "portrait": (1280, 704),
    "square": (704, 704),
}

DEFAULT_NEGATIVE = (
    "blurry, low quality, distorted, deformed, watermark, text, subtitles, "
    "static, frozen frame, overexposed, jpeg artifacts"
)


class JobRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    negative_prompt: Optional[str] = Field(default=None, max_length=2000)
    orientation: Literal["landscape", "portrait", "square"] = "landscape"
    seconds: float = Field(default=5, ge=1, le=5)
    steps: int = Field(default=30, ge=10, le=50)
    guidance: float = Field(default=5.0, ge=1, le=10)
    seed: Optional[int] = None
    image_url: Optional[str] = Field(default=None, max_length=2000)


@dataclass
class Job:
    id: str
    request: dict
    status: str = "queued"  # queued | running | succeeded | failed
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error: Optional[str] = None
    video_path: Optional[str] = None

    def public(self) -> dict:
        data = asdict(self)
        data.pop("video_path")
        data["video_url"] = f"/jobs/{self.id}/video" if self.status == "succeeded" else None
        return data


jobs: dict[str, Job] = {}
work: "queue.Queue[str]" = queue.Queue()
_pipes: dict[str, object] = {}
_busy = threading.Event()


def _frames_for(seconds: float) -> int:
    # Wan needs num_frames = 4k + 1.
    frames = int(round(seconds * FPS))
    return max(5, (frames // 4) * 4 + 1)


def _load_pipelines():
    import torch
    from diffusers import AutoencoderKLWan, WanPipeline

    dtype = torch.bfloat16
    vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanPipeline.from_pretrained(MODEL_ID, vae=vae, torch_dtype=dtype)
    vram_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
    if vram_gb >= 38:
        # A100 40/80 GB: everything fits on the GPU, fastest path.
        pipe.to("cuda")
    else:
        # L4 / T4: keep idle models in system RAM (needs a High-RAM runtime).
        pipe.enable_model_cpu_offload()
    _pipes["t2v"] = pipe


def _image_pipe():
    if "i2v" not in _pipes:
        from diffusers import WanImageToVideoPipeline

        _pipes["i2v"] = WanImageToVideoPipeline.from_pipe(_pipes["t2v"])
    return _pipes["i2v"]


def _run(job: Job) -> Path:
    req = JobRequest(**job.request)
    out = OUTPUT_DIR / f"{job.id}.mp4"
    if FAKE:
        time.sleep(0.2)
        out.write_bytes(b"fake-mp4")
        return out

    import torch
    from diffusers.utils import export_to_video, load_image

    height, width = SIZES[req.orientation]
    generator = None
    if req.seed is not None:
        generator = torch.Generator(device="cpu").manual_seed(req.seed)
    common = dict(
        prompt=req.prompt,
        negative_prompt=req.negative_prompt or DEFAULT_NEGATIVE,
        height=height,
        width=width,
        num_frames=_frames_for(req.seconds),
        guidance_scale=req.guidance,
        num_inference_steps=req.steps,
        generator=generator,
    )
    if req.image_url:
        image = load_image(req.image_url).convert("RGB").resize((width, height))
        frames = _image_pipe()(image=image, **common).frames[0]
    else:
        frames = _pipes["t2v"](**common).frames[0]
    export_to_video(frames, str(out), fps=FPS)
    return out


def _worker():
    while True:
        job_id = work.get()
        job = jobs.get(job_id)
        if job is None:
            continue
        job.status = "running"
        job.started_at = time.time()
        _busy.set()
        try:
            job.video_path = str(_run(job))
            job.status = "succeeded"
        except Exception as exc:  # report to the caller, keep serving
            traceback.print_exc()
            job.status = "failed"
            job.error = f"{type(exc).__name__}: {exc}"[:500]
        finally:
            job.finished_at = time.time()
            _busy.clear()


def create_app() -> FastAPI:
    token = os.environ.get("WAN_API_TOKEN", "")
    if len(token) < 16:
        raise RuntimeError("WAN_API_TOKEN must be set (16+ characters)")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if not FAKE:
        _load_pipelines()
    threading.Thread(target=_worker, daemon=True).start()

    def require_token(authorization: str = Header(default="")):
        supplied = authorization.removeprefix("Bearer ").strip()
        if not hmac.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="invalid token")

    app = FastAPI(title="Wan 2.2 video API")

    @app.get("/health")
    def health():
        queued = sum(1 for j in jobs.values() if j.status == "queued")
        return {"ok": True, "model": MODEL_ID, "busy": _busy.is_set(), "queued": queued, "fake": FAKE}

    @app.post("/jobs", dependencies=[Depends(require_token)], status_code=202)
    def create_job(req: JobRequest):
        pending = sum(1 for j in jobs.values() if j.status in ("queued", "running"))
        if pending >= MAX_QUEUED:
            raise HTTPException(status_code=429, detail="queue full, try again later")
        job = Job(id=uuid.uuid4().hex[:12], request=req.model_dump())
        jobs[job.id] = job
        work.put(job.id)
        return job.public()

    @app.get("/jobs/{job_id}", dependencies=[Depends(require_token)])
    def get_job(job_id: str):
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job.public()

    @app.get("/jobs/{job_id}/video", dependencies=[Depends(require_token)])
    def get_video(job_id: str):
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        if job.status != "succeeded" or not job.video_path:
            raise HTTPException(status_code=409, detail=f"job is {job.status}")
        return FileResponse(job.video_path, media_type="video/mp4", filename=f"wan-{job.id}.mp4")

    return app
