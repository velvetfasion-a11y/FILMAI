import os, re, uuid, time, json, threading, subprocess, sys
from pathlib import Path
from typing import List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, HTMLResponse
from PIL import Image, ImageOps

ROOT = Path(__file__).parent
OUT = ROOT / "outputs"; OUT.mkdir(exist_ok=True)
PY = str(ROOT / ".venv" / "bin" / "python")
app = FastAPI(title="Our Video AI")
LOCK = threading.Lock()
WAKE = threading.Event()
SEC_PER_STEP = {("hd", "short"): 82, ("hd", "long"): 200, ("hd", "xlong"): 260, ("standard", "short"): 35, ("standard", "long"): 60, ("standard", "xlong"): 100}

def jpath(jid): return OUT / jid / "job.json"
def load(jid):
    try: return json.loads(jpath(jid).read_text())
    except Exception: return None
def save(j):
    p = jpath(j["id"]); tmp = p.with_suffix(".tmp"); tmp.write_text(json.dumps(j)); tmp.replace(p)

def estimate(req, n):
    return round(40 + n * (3 * SEC_PER_STEP[(req["quality"], req["length"])] + 25) + 20)

def pending():
    js = [load(d.name) for d in OUT.iterdir() if (d / "job.json").exists()]
    js = [j for j in js if j and j.get("status") in ("queued", "running") and "req" in j]
    return sorted(js, key=lambda j: j["created"])

def worker():
    # jobs interrupted by a restart are re-queued
    for j in pending():
        if j["status"] == "running":
            alive = subprocess.run(["pgrep", "-f", f"render.py {OUT / j['id']}"], capture_output=True).returncode == 0
            if alive:  # a render survived the server restart: let it finish instead of starting a second copy
                while subprocess.run(["pgrep", "-f", f"render.py {OUT / j['id']}"], capture_output=True).returncode == 0: time.sleep(5)
                j2 = load(j["id"])
                if j2 and j2.get("status") in ("done", "error"): continue
            j = load(j["id"]) or j
            j.update(status="queued", message="Waiting in queue (restarted)"); save(j)
    while True:
        q = [j for j in pending() if j["status"] == "queued"]
        if not q:
            WAKE.wait(5); WAKE.clear(); continue
        j = q[0]
        log = open(OUT / j["id"] / "render.log", "a")
        r = subprocess.run([PY, str(ROOT / "render.py"), str(OUT / j["id"])], stdout=log, stderr=subprocess.STDOUT)
        j2 = load(j["id"])
        if j2 and j2.get("status") not in ("done", "error"):
            j2.update(status="error", message=f"Renderer stopped unexpectedly (code {r.returncode})"); save(j2)

threading.Thread(target=worker, daemon=True).start()

@app.post("/api/generate")
async def generate(prompt: str = Form(...), images: List[UploadFile] = File(default=[])):
    prompt = prompt.strip()[:1500]
    if not prompt: raise HTTPException(400, "Please write a prompt")
    if len(pending()) >= 8: raise HTTPException(429, "The queue is full right now, please try again later")
    images = [f for f in images if f and f.filename][:6]
    scenes = max(3, len(images))
    jid = uuid.uuid4().hex[:10]; d = OUT / jid; d.mkdir()
    names = []
    for k, f in enumerate(images):
        data = await f.read()
        if len(data) > 20_000_000: raise HTTPException(400, "Image too large (max 20 MB)")
        try:
            im = ImageOps.exif_transpose(Image.open(__import__("io").BytesIO(data))).convert("RGB")
        except Exception: raise HTTPException(400, f"Could not read image {f.filename}")
        im.thumbnail((2048, 2048)); nm = f"ref{k+1}.jpg"; im.save(d / nm, quality=95); names.append(nm)
    req = dict(prompt=prompt, scenes=scenes, quality="hd", aspect="16:9", length="short")  # the AI director decides the rest
    j = dict(id=jid, req=req, images=names, scenes=[], scene_state=[], status="queued", progress=0.0,
             message="Waiting in queue", created=time.time(), eta=estimate(req, scenes))
    save(j); WAKE.set()
    return {"id": jid}

@app.get("/api/job/{jid}")
def job(jid: str):
    if not re.fullmatch(r"[0-9a-f]{10}", jid): raise HTTPException(404)
    j = load(jid)
    if not j: raise HTTPException(404)
    p = pending(); ids = [x["id"] for x in p]
    j["ahead"] = ids.index(jid) if jid in ids else 0
    if j["status"] == "queued":
        j["eta"] = j.get("eta", 0) + sum((x.get("eta") or 0) for x in p[: j["ahead"]])
    if j["status"] == "done": j["video"] = f"video/{jid}"
    j["prompt"] = j["req"]["prompt"]; j["imgs"] = [f"file/{jid}/{n}" for n in j.get("images", [])]
    return j

@app.get("/api/gallery")
def gallery(ids: str = ""):
    want = [i for i in ids.split(",") if re.fullmatch(r"[0-9a-f]{10}", i)]
    dirs = [OUT / i for i in want] if want else sorted([d for d in OUT.iterdir() if d.is_dir()], key=lambda p: p.stat().st_mtime, reverse=True)
    items = []
    for d in dirs:
        j = load(d.name)
        if not j or "req" not in j: continue
        if not want and j.get("status") != "done": continue
        items.append({"id": d.name, "prompt": j["req"]["prompt"], "status": j["status"], "progress": j.get("progress", 0),
                      "video": f"video/{d.name}" if j["status"] == "done" else None, "created": j["created"]})
        if len(items) >= 24: break
    return items

@app.get("/video/{jid}")
def video(jid: str, download: int = 0):
    if not re.fullmatch(r"[0-9a-f]{10}", jid): raise HTTPException(404)
    p = OUT / jid / "final.mp4"
    if not p.exists(): raise HTTPException(404)
    return FileResponse(p, media_type="video/mp4", filename=f"our-video-ai-{jid}.mp4" if download else None)

@app.get("/file/{jid}/{name}")
def file(jid: str, name: str):
    if not re.fullmatch(r"[0-9a-f]{10}", jid) or not re.fullmatch(r"(ref\d+\.jpg|scene\d+\.mp4)", name): raise HTTPException(404)
    p = OUT / jid / name
    if not p.exists(): raise HTTPException(404)
    return FileResponse(p)

@app.get("/", response_class=HTMLResponse)
def index():
    return (ROOT / "static" / "index.html").read_text()
