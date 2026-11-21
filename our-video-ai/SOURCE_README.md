# Our Video AI: source code

A self-hosted, OpenArt-style video generator. You type a prompt and can add reference photos. An "AI director" plans the shots, an
open-source video model films each one, and the app edits them into a single MP4 with cuts or crossfades.
Everything runs on your own machine using open models from Hugging Face. No API keys or accounts are needed.

## What's inside
| File | What it does |
|---|---|
| `app.py` | FastAPI web server: the page, upload handling, a job queue on disk (`outputs/<id>/job.json`), the video and gallery endpoints, and this source-code download |
| `render.py` | Renders one video in a separate process: plans the shots, encodes the prompts, generates the scenes, decodes them and stitches them with ffmpeg |
| `dmd.py` | Small 3-step sampler for the distilled Wan model (predict x0, then re-noise) |
| `taehv/taehv.py` | Tiny video decoder (TAEHV by madebyollin), ~30x faster than the full Wan VAE on CPU |
| `static/index.html` | The whole frontend (one file: HTML, CSS and JS) |
| `start.sh`, `run_loop.sh` | Start, stop and auto-restart the server and the optional public tunnel |
| `requirements.txt` | Pinned Python packages |

## Models (downloaded automatically from Hugging Face on first run, ~45 GB)
- **Video:** FastWan2.2-TI2V-5B, a 3-step distilled Wan 2.2 that does text-to-video and image-to-video. https://huggingface.co/FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers (base: https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers)
- **AI director:** Qwen2.5-3B-Instruct. https://huggingface.co/Qwen/Qwen2.5-3B-Instruct
- **Decoder weights:** `taew2_2.pth` from https://github.com/madebyollin/taehv, downloaded automatically into `taehv/`.

## How it works
1. **Plan:** words in the prompt like "vertical/TikTok/Reels", "square", "3 shots", "10 seconds", "hard cuts" or "one take" set the format, scene count, length and editing directly.
   Qwen then writes one detailed shot per scene and repeats the user's subject and details in every shot. Defaults: 720p, up to 3 scenes, 2 s each, crossfades.
2. **Encode** the shot prompts with umT5 (then the encoder is freed to save memory).
3. **Film** each scene with Wan 2.2 in 3 steps at 24 fps. Uploaded photo *k* becomes the first frame of scene *k*. Later scenes can continue from the previous scene's last frame.
4. **Decode** with TAEHV, then **edit** with ffmpeg: upscale 480p to 720p, light denoise and sharpening, and join the scenes with crossfades, cuts or a dip to black.

## Run it locally
Requirements: Python 3.11, ffmpeg, about 50 GB of disk and 16 GB+ of RAM.
**A GPU is strongly recommended.** An NVIDIA card with 24 GB+ (or 16 GB with some swapping) renders a scene in seconds to about a minute.
On CPU only it still works (about 1.5 min per 480p scene and about 4-5 min per 720p scene on 8 fast cores). The code picks CUDA automatically when it is available (`DEVICE=cpu` forces CPU).

```bash
cd our-video-ai
python3.11 -m venv .venv && source .venv/bin/activate
# pick ONE torch build:
pip install torch --index-url https://download.pytorch.org/whl/cu128   # NVIDIA GPU
# pip install torch --index-url https://download.pytorch.org/whl/cpu   # CPU only
pip install -r requirements.txt
HF_HOME=$PWD/hf uvicorn app:app --host 127.0.0.1 --port 7860
```
Then open http://127.0.0.1:7860. The first video downloads the models, which takes a while. Finished videos are saved in `outputs/<id>/final.mp4`.
On macOS, CUDA isn't available. Use `DEVICE=mps` (experimental, needs a lot of unified memory) or CPU.

Optional: `./start.sh` runs the server and a public tunnel (liveapps.dev, which needs Node.js: `npm i --prefix ./tunnel liveapps`) and restarts them if they crash.
`./start.sh stop` stops everything.

## Open it in Cursor
1. Unzip this folder and open it in Cursor (**File → Open Folder…**).
2. Open the terminal (**Ctrl/Cmd + `**) and run the install commands above.
3. Select the interpreter: Cmd/Ctrl+Shift+P → "Python: Select Interpreter" → `.venv`.
4. Start the server with the uvicorn command and open http://127.0.0.1:7860.
5. Ask Cursor's agent for changes, for example "add a 'make it longer' button" or "use a GPU-only bigger model".
   Good places to start: the page is `static/index.html`, scene planning is `plan()` in `render.py`, and editing and transitions are `stitch()` in `render.py`.

## Not included
Model weights, the Python environment, generated videos and logs are left out on purpose. They are downloaded or created when you run it.
There are no secrets or API keys anywhere in this code.
