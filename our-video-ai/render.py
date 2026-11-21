"""Renders one job: python render.py <job_dir>. Writes progress into <job_dir>/job.json."""
import os, sys, json, time, gc, re, subprocess, traceback
from pathlib import Path
os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent / "hf"))
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "taehv"))
import torch
torch.set_num_threads(int(os.environ.get("THREADS", str(os.cpu_count() or 8))))
DEVICE = os.environ.get("DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")  # a GPU makes this ~50-100x faster

WAN = "FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers"
LLM = "Qwen/Qwen2.5-3B-Instruct"
SIZES = {  # (quality, aspect) -> (H, W)   all multiples of 32
    ("hd", "16:9"): (704, 1280), ("hd", "9:16"): (1280, 704), ("hd", "1:1"): (960, 960),
    ("standard", "16:9"): (480, 832), ("standard", "9:16"): (832, 480), ("standard", "1:1"): (640, 640),
}
FRAMES = {"short": 49, "long": 81, "xlong": 121}   # 24 fps -> 2.0 s, 3.4 s, 5.0 s
# measured seconds per denoising step on this box (3 steps per scene)
SEC_PER_STEP = {("hd", 49): 82, ("hd", 81): 200, ("hd", 121): 260, ("standard", 49): 35, ("standard", 81): 60, ("standard", 121): 100}
STYLES = {
    "cinematic": "cinematic film look, dramatic natural lighting, shallow depth of field, rich color grading, 35mm film",
    "documentary": "documentary footage, natural light, handheld camera, realistic, detailed",
    "dreamy": "soft dreamy light, pastel colors, ethereal glow, gentle motion, beautiful",
    "vibrant": "vibrant saturated colors, bright sunlight, crisp high detail",
    "noir": "black and white film noir, high contrast, moody shadows",
    "anime": "anime style, beautiful hand-drawn animation, studio quality, vivid colors",
}
SHOTS = ["wide establishing shot, slow dolly in", "medium shot, smooth tracking camera", "close-up shot, shallow focus, subtle push in",
         "low angle shot, slow camera tilt", "aerial drone shot gliding forward", "over-the-shoulder shot, gentle handheld motion"]

JD = Path(sys.argv[1]); JF = JD / "job.json"
job = json.loads(JF.read_text())

def save(**kw):
    job.update(kw); tmp = JF.with_suffix(".tmp"); tmp.write_text(json.dumps(job)); tmp.replace(JF)

WORDNUM = {"one":1,"two":2,"three":3,"four":4,"five":5,"six":6,"seven":7,"eight":8,"nine":9,"ten":10,"twelve":12,"fifteen":15,"twenty":20,"thirty":30}
def _num(x):
    return float(x) if re.fullmatch(r"\d+(?:\.\d+)?", x) else WORDNUM.get(x.lower())

def explicit(prompt):
    """Settings the user stated outright; these always win over the AI director."""
    t = prompt.lower(); out = {}
    if re.search(r"\b(vertical|portrait|tiktok|tik tok|reels?|shorts|9:16|9x16|instagram stor(y|ies)|story format|phone screen)\b", t): out["aspect"] = "9:16"
    elif re.search(r"\b(square|1:1|1x1)\b", t): out["aspect"] = "1:1"
    elif re.search(r"\b(landscape|horizontal|widescreen|16:9|youtube)\b", t): out["aspect"] = "16:9"
    m = re.search(r"\b(\d+|one|two|three|four|five|six)\s*(?:-\s*)?(shots?|scenes?|clips?|cuts?|parts?)\b", t)
    if m and _num(m.group(1)): out["scenes"] = int(_num(m.group(1)))
    m = re.search(r"\b(\d+(?:\.\d+)?|five|ten|fifteen|twenty|thirty|twelve|six|eight)\s*(?:-\s*)?(seconds?|secs?|s)\b(?!\s*(?:each|per))", t)
    if m and _num(m.group(1)): out["total"] = float(_num(m.group(1)))
    m = re.search(r"\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s*(?:each|per (?:shot|scene|clip))", t)
    if m: out["per"] = float(m.group(1))
    if re.search(r"\b(hard cuts?|quick cuts?|fast[- ]paced|jump cuts?|cut between|cuts? to)\b", t): out["transition"] = "cut"
    elif re.search(r"\b(fade to black|dip to black|fades? out)\b", t): out["transition"] = "black"
    elif re.search(r"\b(crossfades?|dissolves?)\b", t): out["transition"] = "crossfade"
    if re.search(r"\b(one take|single take|one shot|oner|continuous(ly)?|unbroken|seamless)\b", t): out["continuous"] = True
    if re.search(r"\b(480p|standard quality|low res|quick draft|draft)\b", t): out["quality"] = "standard"
    return out

def rule_plan(prompt, n):
    parts = [p.strip(" ,.") for p in re.split(r"(?:[.;!?\n]+|\band then\b|\bthen\b|->)", prompt, flags=re.I) if p.strip(" ,.")] or [prompt]
    if len(parts) > n: parts = parts[:n-1] + [", ".join(parts[n-1:])]
    return [(parts[i] if i < len(parts) else parts[-1]) + (f". {prompt}" if len(parts) > 1 else "") for i in range(n)]

def llm_plan(prompt, n_hint, n_imgs):
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(LLM)
    m = AutoModelForCausalLM.from_pretrained(LLM, dtype=torch.bfloat16).to(DEVICE)
    sys_msg = (
        "You are the director of a text-to-video AI. Read the user's video request and plan it. Reply with ONLY a JSON object with these keys:\n"
        '"scenes": number of shots, 1-6. Use the number the user asks for. If they give a total length, use one shot per 2-3 seconds. '
        "If the request is a single simple moment use 1-2, a small story 3, otherwise 3.\n"
        '"continuous": true if it should feel like one continuous take of the same action, false if it is separate shots/moments.\n'
        '"transition": "cut" for energetic, fast, music-video or ad-like requests, "black" for slow emotional endings, otherwise "crossfade".\n'
        '"style": the visual style ONLY if the user asked for one (for example "anime", "black and white", "watercolor", "cinematic"), otherwise "".\n'
        '"shots": array with exactly `scenes` strings. Each is one English paragraph of 35-60 words describing what is visible and how it moves in that shot: '
        "subject, action, setting, lighting, camera framing and camera movement. Follow the request faithfully: keep the user's exact subject and every detail "
        "they gave (colors, clothing, place, time of day, objects) and repeat them word for word in EVERY shot so the subject looks identical. "
        "Do not invent details the user did not give: no new colors, breeds, eye colors, ages, characters, objects, rooms, story events or styles. Every shot must name the main subject explicitly (never start with only \"In the background\"). Vary only framing and camera angle between shots, and let the "
        "action progress in the order the user described. No dialogue, no on-screen text.")
    if n_imgs:
        sys_msg += f" The user uploaded {n_imgs} photo(s); photo k is the first frame of shot k, so describe motion that naturally continues from such a photo of the described subject."
    user = f"Video request: {prompt}" + (f"\n(Use exactly {n_hint} shots.)" if n_hint else "")
    msgs = [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}]
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)["input_ids"]
    with torch.inference_mode():
        ids = ids.to(DEVICE)
        out = m.generate(ids, max_new_tokens=110 * (n_hint or 6) + 120, do_sample=False)
    txt = tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True)
    del m; gc.collect()
    print("director:", txt, flush=True)
    d = json.loads(txt[txt.index("{"): txt.rindex("}") + 1])
    shots = [str(x).strip() for x in d.get("shots", []) if str(x).strip()]
    if not shots: raise ValueError("no shots")
    return d, shots

def plan(prompt, n_imgs):
    ex = explicit(prompt)
    n_hint = ex.get("scenes")
    if not n_hint and "total" in ex:
        n_hint = max(1, min(6, round(ex["total"] / (ex.get("per") or 3.4))))
    if n_imgs and (not n_hint or n_hint < n_imgs): n_hint = min(6, n_imgs)
    try:
        d, shots = llm_plan(prompt, n_hint, n_imgs); planner = "ai"
    except Exception as e:
        print("planner fallback:", repr(e), flush=True); d, shots, planner = {}, None, "rules"
    n = int(n_hint or min(int(d.get("scenes") or 3), 3)); n = max(1, min(6, n))
    if not shots: shots = rule_plan(prompt, n)
    while len(shots) < n: shots.append(shots[-1])
    shots = shots[:n]
    quality = ex.get("quality", "hd")
    per = ex.get("per") or (ex["total"] / n if "total" in ex else 2.0)
    length = "short" if per < 2.7 else ("long" if (per < 4.2 or quality == "hd") else "xlong")
    s = dict(scenes=n, aspect=ex.get("aspect", "16:9"), quality=quality, length=length,
             transition=ex.get("transition") or (d.get("transition") if d.get("transition") in ("cut", "crossfade", "black") else "crossfade"),
             continuous=bool(ex.get("continuous", d.get("continuous") is True)),
             style=str(d.get("style") or "").strip()[:80], planner=planner)
    # keep the user's own words attached to every shot so nothing they asked for gets lost
    ground = re.sub(r"\b(a |an )?(vertical|portrait|square|landscape|horizontal)\b|\b(tiktok|tik tok|reels?|shorts|youtube|instagram)\b|\b\d+(\.\d+)?\s*(seconds?|secs?|s)\b|\b(\d+|one|two|three|four|five|six)\s*(shots?|scenes?|clips?)\b|\b(hard|quick|jump) cuts?\b|\bwith crossfades?\b", "", prompt, flags=re.I)
    ground = re.sub(r"\s{2,}", " ", re.sub(r"\s+([,.])", r"\1", ground)).strip(" ,.")[:300]
    prompts = [f"{sh} {('Style: ' + s['style'] + '.') if s['style'] else ''} Request: {ground}".replace("  ", " ") for sh in shots]
    return s, prompts

def encode(prompts):
    from transformers import UMT5EncoderModel, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(WAN, subfolder="tokenizer")
    te = UMT5EncoderModel.from_pretrained(WAN, subfolder="text_encoder", torch_dtype=torch.bfloat16).to(DEVICE)
    embs = []
    with torch.inference_mode():
        for p in prompts:
            ids = tok([p], padding="max_length", max_length=512, truncation=True, return_attention_mask=True, return_tensors="pt")
            e = te(ids.input_ids.to(DEVICE), ids.attention_mask.to(DEVICE)).last_hidden_state
            n = int(ids.attention_mask.sum())
            embs.append(torch.cat([e[:, :n], e.new_zeros(1, 512 - n, e.shape[-1])], 1).clone())
    del te; gc.collect()
    return tok, embs

def fit(img, W, H):
    from PIL import ImageOps
    return ImageOps.fit(img.convert("RGB"), (W, H), method=3)

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: raise RuntimeError(r.stderr[-800:])

def main():
    req = job["req"]; imgs = [JD / f for f in job.get("images", [])]
    t0 = time.time()
    save(status="running", started=t0, message="The AI director is planning your video", progress=0.01)
    settings, prompts = plan(req["prompt"], len(imgs))
    req.update(settings); n = settings["scenes"]; q = settings["quality"]
    H, W = SIZES[(q, req["aspect"])]; F = FRAMES[req["length"]]
    sps = SEC_PER_STEP[(q, F)] * (1.0 if req["aspect"] == "16:9" or q == "standard" else 1.05)
    job["req"] = req; job["scenes"] = prompts; job["planner"] = settings["planner"]
    job["plan"] = dict(scenes=n, aspect=req["aspect"], size=f"{W}x{H}", seconds_per_scene=round(F / 24, 1), transition=req["transition"],
                       continuous=req["continuous"], style=req["style"] or "as described")
    save(message="Reading the prompts", scene_state=["waiting"] * n, eta=round(20 + n * (3 * sps + 25) + 20))
    tok, embs = encode(prompts)

    from diffusers import WanPipeline, WanImageToVideoPipeline
    from diffusers.utils import export_to_video
    from dmd import DMDScheduler
    from taehv import TAEHV
    i2v = WanImageToVideoPipeline.from_pretrained(WAN, text_encoder=None, tokenizer=tok, image_encoder=None, image_processor=None,
                                                  expand_timesteps=True, torch_dtype=torch.bfloat16)
    i2v.vae.to(torch.float32)
    if DEVICE != "cpu": i2v.to(DEVICE)
    i2v.scheduler = DMDScheduler.from_config(i2v.scheduler.config)
    t2v = WanPipeline(tokenizer=tok, text_encoder=None, transformer=i2v.transformer, vae=i2v.vae, scheduler=i2v.scheduler, expand_timesteps=True)
    tae_w = ROOT / "taehv" / "taew2_2.pth"
    if not tae_w.exists():
        import urllib.request; urllib.request.urlretrieve("https://github.com/madebyollin/taehv/raw/main/taew2_2.pth", tae_w)
    tae = TAEHV(checkpoint_path=str(tae_w)).to(DEVICE, torch.bfloat16)
    from PIL import Image
    seed = req.get("seed") or int(time.time()) % 100000
    clips, prev_last = [], None
    scene_times = []
    for i in range(n):
        ts = time.time()
        st = job["scene_state"]; st[i] = "rendering"
        image = None
        if i < len(imgs): image = fit(Image.open(imgs[i]), W, H)
        elif (imgs or req.get("continuous")) and prev_last is not None: image = prev_last  # keep following the photo / story
        def cb(p, step, t, kw, i=i, ts=ts):
            done_steps = i * 3 + step + 1
            per_scene = (time.time() - t0 - 0) / max(done_steps, 1) * 3
            elapsed_scene = time.time() - ts
            rem = (n - i - 1) * (3 * sps + 25) + max(0, (2 - step) * sps) + 20
            save(progress=round(min(0.97, (i + (step + 1) / 3.4) / n), 3), message=f"Filming scene {i+1} of {n} (step {step+1}/3)",
                 eta=round(rem))
            return kw
        save(message=f"Filming scene {i+1} of {n}", scene_state=st)
        g = torch.Generator().manual_seed(seed + i)
        with torch.inference_mode():
            kw = dict(prompt_embeds=embs[i], height=H, width=W, num_frames=F, num_inference_steps=3, guidance_scale=1.0,
                      generator=g, output_type="latent", callback_on_step_end=cb)
            lat = (i2v(image=image, **kw) if image is not None else t2v(**kw)).frames
            save(message=f"Developing scene {i+1} of {n}")
            v = tae.decode_video(lat.transpose(1, 2).to(DEVICE, torch.bfloat16), parallel=True, show_progress_bar=False)[0]
            v = v.permute(0, 2, 3, 1).float().clamp(0, 1).cpu().numpy()
        p = JD / f"scene{i+1}.mp4"
        export_to_video(list(v), str(p), fps=24)
        prev_last = Image.fromarray((v[-1] * 255).round().astype("uint8"))
        clips.append(p); st[i] = "done"; scene_times.append(round(time.time() - ts, 1))
        sps = (time.time() - ts - 15) / 3  # recalibrate the estimate with the real speed
        save(scene_state=st, scene_times=scene_times, scene_videos=[f"scene{k+1}.mp4" for k in range(len(clips))])
    del i2v, t2v, tae; gc.collect()

    save(message="Editing: transitions and final encode", progress=0.98, eta=20)
    stitch(clips, JD / "final.mp4", req["transition"], W, H)
    save(status="done", progress=1.0, message="Done", eta=0, seconds=round(time.time() - t0, 1), finished=time.time(), size=f"{W}x{H}")

def stitch(clips, out, transition, W, H):
    # 720p stays native; 480p is upscaled to 720p-class with lanczos + light sharpening. Light deflicker/denoise for polish.
    up = 1.5 if max(W, H) < 1000 else 1.0
    OW, OH = int(W * up) // 2 * 2, int(H * up) // 2 * 2
    vf = f"scale={OW}:{OH}:flags=lanczos,hqdn3d=1.2:1.2:3:3,unsharp=5:5:0.5,format=yuv420p"
    prepped = []
    for c in clips:
        p = c.with_name(c.stem + "_hq.mp4")
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(c), "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-r", "24", str(p)])
        prepped.append(p)
    if len(prepped) == 1:
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(prepped[0]), "-c", "copy", "-movflags", "+faststart", str(out)]); return
    if transition == "cut":
        lst = out.with_name("concat.txt"); lst.write_text("".join(f"file '{p}'\n" for p in prepped))
        run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)])
        return
    durs = [float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True).stdout) for p in prepped]
    fd = 0.4 if transition == "crossfade" else 0.35
    kind = "fade" if transition == "crossfade" else "fadeblack"
    inputs = sum([["-i", str(p)] for p in prepped], [])
    chain, last, off = [], "[0:v]", 0.0
    for i in range(1, len(prepped)):
        off += durs[i - 1] - fd
        chain.append(f"{last}[{i}:v]xfade=transition={kind}:duration={fd}:offset={off:.3f}[v{i}]"); last = f"[v{i}]"
    run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chain), "-map", last,
         "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)])

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        save(status="error", message=f"{type(e).__name__}: {str(e)[:400]}")
        sys.exit(1)
