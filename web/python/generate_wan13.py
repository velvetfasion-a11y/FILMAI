#!/usr/bin/env python3
"""Generate a short MP4 with Wan-AI/Wan2.1-T2V-1.3B-Diffusers."""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

MODEL_ID = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
NEG = (
    "Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, "
    "static, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, "
    "extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, "
    "fused fingers, still picture, messy background, three legs, many people in the background, walking backwards"
)

ASPECT = {
    "16:9": (480, 832),
    "9:16": (832, 480),
    "1:1": (480, 480),
}


_STATUS_LOCK = threading.Lock()


def write_status(job_dir: Path, **kw):
    p = job_dir / "status.json"
    with _STATUS_LOCK:
        cur = {}
        if p.exists():
            try:
                cur = json.loads(p.read_text())
            except Exception:
                cur = {}
        cur.update(kw)
        cur["updated"] = time.time()
        # Unique tmp avoids races between heartbeat + main thread.
        tmp = job_dir / f"status.{os.getpid()}.{threading.get_ident()}.tmp"
        tmp.write_text(json.dumps(cur))
        tmp.replace(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--aspect", default="16:9", choices=list(ASPECT))
    ap.add_argument("--frames", type=int, default=int(os.environ.get("WAN_FRAMES", "17")))
    ap.add_argument("--steps", type=int, default=int(os.environ.get("WAN_STEPS", "8")))
    args = ap.parse_args()

    job_dir = Path(args.job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    out_mp4 = job_dir / "output.mp4"
    prompt = args.prompt.strip()[:1500]
    height, width = ASPECT[args.aspect]
    frames = max(17, ((args.frames - 1) // 4) * 4 + 1)
    steps = max(4, args.steps)
    t0 = time.time()
    step_times: list[float] = []
    state = {"step": 0, "phase": "load"}

    def _cpu() -> bool:
        try:
            import torch

            if os.environ.get("DEVICE") == "cuda":
                return False
            return not torch.cuda.is_available()
        except Exception:
            return True

    def eta_seconds() -> int:
        elapsed = time.time() - t0
        if state["phase"] == "load":
            return max(20, int(120 - elapsed))
        if state["phase"] == "encode":
            return 15
        done = state["step"]
        if done <= 0:
            per = 200.0 if _cpu() else 20.0
            return max(30, int(per * steps - elapsed))
        avg = sum(step_times) / len(step_times)
        remaining_steps = max(0, steps - done)
        return max(5, int(avg * remaining_steps + 20))

    def heartbeat():
        while state["phase"] not in ("done", "failed"):
            write_status(
                job_dir,
                status="processing",
                progress=round(
                    0.08
                    if state["phase"] == "load"
                    else (0.25 + 0.7 * (state["step"] / max(steps, 1)))
                    if state["phase"] == "denoise"
                    else 0.96,
                    3,
                ),
                message=(
                    f"Loading Wan2.1 1.3B… ({int(time.time() - t0)}s)"
                    if state["phase"] == "load"
                    else (
                        f"Encoding MP4…"
                        if state["phase"] == "encode"
                        else f"Filming Wan2.1 1.3B — step {state['step']}/{steps} ({width}x{height}, {frames} frames)"
                    )
                ),
                eta_seconds=eta_seconds(),
                elapsed_seconds=int(time.time() - t0),
                step=state["step"],
                steps=steps,
                size=f"{width}x{height}",
            )
            time.sleep(3)

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()
    write_status(
        job_dir,
        status="starting",
        progress=0.05,
        message=f"Loading {MODEL_ID}…",
        prompt=prompt,
        model=MODEL_ID,
        eta_seconds=eta_seconds(),
        started=t0,
        size=f"{width}x{height}",
        steps=steps,
        frames=frames,
    )

    try:
        import torch
        from diffusers import AutoencoderKLWan, WanPipeline
        from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler
        from diffusers.utils import export_to_video

        device = os.environ.get("DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        dtype = torch.bfloat16 if device == "cuda" else torch.float32
        os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parents[1] / "hf"))

        vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)
        pipe = WanPipeline.from_pretrained(MODEL_ID, vae=vae, torch_dtype=dtype)
        pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=3.0)
        if device == "cuda":
            try:
                pipe.enable_model_cpu_offload()
            except Exception:
                pipe.to(device)
        else:
            pipe.to("cpu")
            torch.set_num_threads(int(os.environ.get("THREADS", str(max(1, (os.cpu_count() or 4) // 2)))))

        state["phase"] = "denoise"
        step_t0 = time.time()

        def on_step(pipe_, step, timestep, callback_kwargs):
            nonlocal step_t0
            now = time.time()
            step_times.append(now - step_t0)
            step_t0 = now
            state["step"] = step + 1
            write_status(
                job_dir,
                status="processing",
                progress=round(min(0.95, 0.25 + 0.7 * ((step + 1) / max(steps, 1))), 3),
                message=f"Filming Wan2.1 1.3B — step {step + 1}/{steps} ({width}x{height}, {frames} frames)",
                eta_seconds=eta_seconds(),
                elapsed_seconds=int(now - t0),
                step=step + 1,
                steps=steps,
                sec_per_step=round(sum(step_times) / len(step_times), 1),
                size=f"{width}x{height}",
            )
            return callback_kwargs

        with torch.inference_mode():
            result = pipe(
                prompt=prompt,
                negative_prompt=NEG,
                height=height,
                width=width,
                num_frames=frames,
                guidance_scale=5.0,
                num_inference_steps=steps,
                callback_on_step_end=on_step,
            )
        frames_out = result.frames[0]
        state["phase"] = "encode"
        write_status(job_dir, status="processing", progress=0.96, message="Encoding MP4…", eta_seconds=10)
        export_to_video(frames_out, str(out_mp4), fps=16)
        state["phase"] = "done"
        write_status(
            job_dir,
            status="succeeded",
            progress=1.0,
            message="Done — Wan2.1-T2V-1.3B",
            video=str(out_mp4),
            size=f"{width}x{height}",
            eta_seconds=0,
            elapsed_seconds=int(time.time() - t0),
        )
        return 0
    except Exception as e:
        state["phase"] = "failed"
        traceback.print_exc()
        write_status(
            job_dir,
            status="failed",
            progress=0,
            message=f"{type(e).__name__}: {str(e)[:400]}",
            error=str(e)[:800],
            eta_seconds=0,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
