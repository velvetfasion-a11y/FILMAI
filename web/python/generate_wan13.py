#!/usr/bin/env python3
"""Generate a short MP4 with Wan-AI/Wan2.1-T2V-1.3B-Diffusers.

Usage:
  python generate_wan13.py --job-dir <dir> --prompt "..." [--aspect 16:9]

Writes status.json and output.mp4 into --job-dir.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
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


def write_status(job_dir: Path, **kw):
    p = job_dir / "status.json"
    cur = {}
    if p.exists():
        try:
            cur = json.loads(p.read_text())
        except Exception:
            cur = {}
    cur.update(kw)
    cur["updated"] = time.time()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(cur))
    tmp.replace(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--aspect", default="16:9", choices=list(ASPECT))
    ap.add_argument("--frames", type=int, default=int(os.environ.get("WAN_FRAMES", "33")))
    ap.add_argument("--steps", type=int, default=int(os.environ.get("WAN_STEPS", "20")))
    args = ap.parse_args()

    job_dir = Path(args.job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    out_mp4 = job_dir / "output.mp4"
    prompt = args.prompt.strip()[:1500]
    height, width = ASPECT[args.aspect]
    # Wan frames should be 4k+1
    frames = max(17, ((args.frames - 1) // 4) * 4 + 1)

    write_status(
        job_dir,
        status="starting",
        progress=0.05,
        message=f"Loading {MODEL_ID}…",
        prompt=prompt,
        model=MODEL_ID,
    )

    try:
        import torch
        from diffusers import AutoencoderKLWan, WanPipeline
        from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler
        from diffusers.utils import export_to_video

        device = os.environ.get("DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        dtype = torch.bfloat16 if device == "cuda" else torch.float32
        write_status(job_dir, status="processing", progress=0.12, message=f"Loading model on {device}…")

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
            # Keep CPU threads reasonable
            torch.set_num_threads(int(os.environ.get("THREADS", str(max(1, (os.cpu_count() or 4) // 2)))))

        write_status(
            job_dir,
            status="processing",
            progress=0.25,
            message=f"Filming with Wan2.1 1.3B ({width}x{height}, {frames} frames, {args.steps} steps)…",
        )

        def on_step(pipe_, step, timestep, callback_kwargs):
            # step is 0-indexed
            frac = 0.25 + 0.7 * ((step + 1) / max(args.steps, 1))
            write_status(
                job_dir,
                status="processing",
                progress=round(min(0.95, frac), 3),
                message=f"Filming Wan2.1 1.3B — step {step + 1}/{args.steps}",
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
                num_inference_steps=args.steps,
                callback_on_step_end=on_step,
            )
        frames_out = result.frames[0]
        write_status(job_dir, status="processing", progress=0.96, message="Encoding MP4…")
        export_to_video(frames_out, str(out_mp4), fps=16)
        write_status(
            job_dir,
            status="succeeded",
            progress=1.0,
            message="Done — Wan2.1-T2V-1.3B",
            video=str(out_mp4),
            size=f"{width}x{height}",
        )
        return 0
    except Exception as e:
        traceback.print_exc()
        write_status(
            job_dir,
            status="failed",
            progress=0,
            message=f"{type(e).__name__}: {str(e)[:400]}",
            error=str(e)[:800],
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
