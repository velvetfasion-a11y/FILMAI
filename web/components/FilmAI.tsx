"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Job = {
  id: string;
  prompt: string;
  status: string;
  progress: number;
  message?: string;
  video?: string | null;
  video_url?: string | null;
  plan?: {
    scenes: number;
    seconds_per_scene: number;
    aspect: string;
    size: string;
    continuous: boolean;
    transition: string;
    style: string;
  };
  scene_state?: string[];
  scenes?: string[];
  seconds?: number;
  size?: string;
  ahead?: number;
  eta?: number;
};

type GalleryItem = {
  id: string;
  prompt: string;
  status: string;
  progress: number;
  video: string | null;
};

const fmt = (s: number) => {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

function mine(): string[] {
  try {
    return JSON.parse(localStorage.getItem("ova_jobs") || "[]");
  } catch {
    return [];
  }
}

function addMine(id: string) {
  const m = mine().filter((x) => x !== id);
  m.unshift(id);
  localStorage.setItem("ova_jobs", JSON.stringify(m.slice(0, 40)));
}

export default function FilmAI() {
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [mineItems, setMineItems] = useState<GalleryItem[]>([]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setThumbs(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const refreshLists = useCallback(async () => {
    try {
      const m = mine();
      if (m.length) {
        const r = await fetch(`api/gallery?ids=${m.join(",")}`);
        if (r.ok) setMineItems(await r.json());
      } else setMineItems([]);
      const g = await fetch("api/gallery");
      if (g.ok) setGallery(await g.json());
      setBanner(null);
    } catch {
      setBanner("Could not reach the FILMAI server.");
    }
  }, []);

  const poll = useCallback(
    async (id: string) => {
      if (timer.current) clearTimeout(timer.current);
      try {
        const r = await fetch(`api/job/${id}`);
        if (!r.ok) throw new Error("job");
        const j: Job = await r.json();
        setJob(j);
        if (j.status === "done" || j.status === "error") {
          refreshLists();
          return;
        }
        timer.current = setTimeout(() => poll(id), 3000);
      } catch {
        timer.current = setTimeout(() => poll(id), 5000);
      }
    },
    [refreshLists],
  );

  const track = useCallback(
    (id: string) => {
      setCurrent(id);
      poll(id);
    },
    [poll],
  );

  useEffect(() => {
    refreshLists().then(() => {
      const m = mine();
      if (m.length) track(m[0]);
    });
    const t = setInterval(refreshLists, 30000);
    return () => {
      clearInterval(t);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refreshLists, track]);

  function addFiles(list: FileList | File[]) {
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.type.startsWith("image/") && next.length < 6) next.push(f);
    }
    setFiles(next);
  }

  async function onGenerate() {
    const p = prompt.trim();
    if (!p) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("prompt", p);
    files.forEach((f) => fd.append("images", f));
    try {
      const r = await fetch("api/generate", { method: "POST", body: fd });
      const raw = await r.text();
      let detail = raw;
      try {
        detail = JSON.parse(raw).detail || raw;
      } catch {
        /* keep */
      }
      if (!r.ok) {
        if (r.status === 401) {
          alert("Sign in is required to generate films on the hosted FILMAI app.");
        } else {
          alert(typeof detail === "string" ? detail.slice(0, 300) : "Could not start generation");
        }
        return;
      }
      const { id, demo } = JSON.parse(raw) as { id: string; demo?: boolean };
      if (demo) setBanner("Demo mode: showing a sample clip. Add a Replicate API token in Cursor Secrets for real Wan 2.2 films.");
      addMine(id);
      refreshLists();
      track(id);
    } catch {
      alert("Could not reach the FILMAI generation server.");
    } finally {
      setBusy(false);
    }
  }

  const resolvedVideo =
    job?.status === "done"
      ? job.video_url || (job.video?.startsWith("http") ? job.video : `/api/video/${job.id}`)
      : null;

  const aspect =
    job?.plan?.aspect === "9:16" ? "9/16" : job?.plan?.aspect === "1:1" ? "1/1" : "16/9";

  return (
    <>
      <header className="hdr">
        <div className="logo">
          Film<span>AI</span>
        </div>
        <div className="tag">Text & image to video · Wan 2.2</div>
      </header>
      {banner && <div className="banner">{banner}</div>}
      <main className="main">
        <section className="card">
          <h1>Describe your film.</h1>
          <p className="sub">
            Describe what you want to see — just write it like you would to a filmmaker. Mention things like
            “vertical for TikTok”, “10 seconds”, “3 shots” or “black and white” and the AI director takes care of
            it. Add photos and the video starts from them.
          </p>
          <label>Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A woman in a long red wool coat walks through snowy Gamla Stan at dusk, stops at a glowing café window and smiles."
          />
          <label>
            Reference images{" "}
            <span className="opt">(optional · first image becomes the opening frame)</span>
          </label>
          <div
            className={`drop${dropOver ? " over" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDropOver(true);
            }}
            onDragLeave={() => setDropOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDropOver(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            Drop photos here or <u>browse</u>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <div className="thumbs">
            {thumbs.map((src, i) => (
              <div className="th" key={src}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" />
                <b>Scene {i + 1}</b>
                <i
                  onClick={(e) => {
                    e.stopPropagation();
                    setFiles((f) => f.filter((_, j) => j !== i));
                  }}
                >
                  ×
                </i>
              </div>
            ))}
          </div>
          <button className="go" disabled={busy} onClick={onGenerate}>
            {busy ? "Starting…" : "Generate video"}
          </button>
          <div className="note">Finished videos appear under “My videos”. Real films need a Replicate API token in Cursor Secrets.</div>
        </section>

        <section className="stage">
          <div className="screen" style={{ aspectRatio: aspect }}>
            {resolvedVideo ? (
              <video src={resolvedVideo} controls autoPlay loop playsInline />
            ) : job?.status === "running" ? (
              <div className="empty">
                <b>Filming…</b>
                {job.message || "Wan 2.2 is rendering your clip."}
              </div>
            ) : (
              <div className="empty">
                <b>Your video appears here</b>
                Each render takes about half a minute on Wan 2.2 Fast.
              </div>
            )}
          </div>

          {job && current && (
            <div className="card">
              <div className="status">
                <div>
                  {job.status === "done"
                    ? "Finished"
                    : job.status === "error"
                      ? `Something went wrong: ${job.message}`
                      : job.message || "Working…"}
                </div>
                <small>
                  {job.status === "done"
                    ? job.size || ""
                    : job.eta
                      ? `≈ ${fmt(job.eta)} left`
                      : ""}
                </small>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
              </div>
              {job.plan && (
                <div className="plan">
                  {job.plan.scenes} scene · {job.plan.seconds_per_scene}s ·{" "}
                  {job.plan.aspect === "9:16"
                    ? "vertical"
                    : job.plan.aspect === "1:1"
                      ? "square"
                      : "landscape"}{" "}
                  {job.plan.size}
                </div>
              )}
              {job.status === "done" && resolvedVideo && (
                <div className="actions">
                  <a className="btn2" href={resolvedVideo} download>
                    Download MP4
                  </a>
                  <a className="btn2" href={resolvedVideo} target="_blank" rel="noreferrer">
                    Open in new tab
                  </a>
                  <button className="btn2" onClick={() => setPrompt(job.prompt)}>
                    Use this prompt again
                  </button>
                </div>
              )}
            </div>
          )}

          <div>
            <h3>My videos</h3>
            <div className="grid">
              {mineItems.length === 0 ? (
                <div className="empty-grid">Videos you make show up here.</div>
              ) : (
                mineItems.map((i) => (
                  <button key={i.id} className="tile" type="button" onClick={() => track(i.id)}>
                    {i.video ? (
                      <video src={`/api/video/${i.id}`} muted preload="metadata" />
                    ) : (
                      <div className="ph">
                        {i.status === "error"
                          ? "Failed"
                          : i.status === "queued"
                            ? "In queue"
                            : `Rendering · ${Math.round((i.progress || 0) * 100)}%`}
                      </div>
                    )}
                    <div className="c" title={i.prompt}>
                      {i.prompt}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div>
            <h3>Recent creations</h3>
            <div className="grid">
              {gallery.length === 0 ? (
                <div className="empty-grid">Nothing yet — be the first.</div>
              ) : (
                gallery.map((i) => (
                  <button key={i.id} className="tile" type="button" onClick={() => track(i.id)}>
                    {i.video ? (
                      <video src={`/api/video/${i.id}`} muted preload="metadata" />
                    ) : (
                      <div className="ph">Rendering</div>
                    )}
                    <div className="c" title={i.prompt}>
                      {i.prompt}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
      <footer>
        Video model: Wan 2.2 Fast via Replicate · hosted FILMAI app. Local open-weights pipeline remains in{" "}
        <code>our-video-ai/</code>.
      </footer>
      <style jsx>{`
        .hdr {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 22px 40px;
          border-bottom: 1px solid var(--line);
        }
        .logo {
          font-family: "Cormorant Garamond", serif;
          font-size: 28px;
          font-weight: 600;
          letter-spacing: 0.5px;
        }
        .logo span {
          color: var(--wine);
        }
        .tag {
          font-size: 13px;
          color: var(--muted);
        }
        .banner {
          background: #f8e8ea;
          color: var(--wine2);
          text-align: center;
          padding: 10px 16px;
          font-size: 13px;
        }
        .main {
          max-width: 1220px;
          margin: 0 auto;
          padding: 36px 24px 80px;
          display: grid;
          grid-template-columns: 440px 1fr;
          gap: 32px;
          align-items: start;
        }
        @media (max-width: 940px) {
          .main {
            grid-template-columns: 1fr;
          }
          .hdr {
            padding: 18px 20px;
          }
          .tag {
            display: none;
          }
        }
        .card {
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 26px;
          box-shadow: 0 10px 30px -18px rgba(90, 40, 40, 0.25);
        }
        h1 {
          font-family: "Cormorant Garamond", serif;
          font-weight: 500;
          font-size: 38px;
          line-height: 1.1;
          margin: 0 0 6px;
        }
        .sub {
          color: var(--muted);
          margin: 0 0 18px;
          font-size: 14px;
          line-height: 1.5;
        }
        label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
          margin: 18px 0 8px;
        }
        .opt {
          text-transform: none;
          letter-spacing: 0;
          font-weight: 400;
        }
        textarea {
          width: 100%;
          min-height: 120px;
          resize: vertical;
          border: 1px solid var(--line);
          border-radius: 12px;
          padding: 14px;
          font: 15px/1.5 Inter, system-ui, sans-serif;
          background: #fff;
          color: var(--ink);
          outline: none;
        }
        .drop {
          border: 1.5px dashed #d9c9b8;
          border-radius: 12px;
          padding: 16px;
          text-align: center;
          color: var(--muted);
          font-size: 13px;
          cursor: pointer;
          background: #fff;
        }
        .drop.over,
        .drop:hover {
          border-color: var(--wine);
          color: var(--wine);
        }
        .thumbs {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }
        .th {
          position: relative;
          width: 74px;
          height: 74px;
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid var(--line);
        }
        .th img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .th b {
          position: absolute;
          left: 4px;
          bottom: 4px;
          background: rgba(0, 0, 0, 0.55);
          color: #fff;
          font-size: 10px;
          padding: 1px 5px;
          border-radius: 6px;
        }
        .th i {
          position: absolute;
          right: 3px;
          top: 3px;
          background: #fff;
          color: var(--wine);
          border-radius: 50%;
          width: 18px;
          height: 18px;
          font: 600 12px/18px Inter, system-ui, sans-serif;
          text-align: center;
          cursor: pointer;
          font-style: normal;
        }
        .go {
          margin-top: 14px;
          width: 100%;
          padding: 15px;
          border: 0;
          border-radius: 12px;
          background: var(--wine);
          color: #fff;
          font: 600 15px Inter, system-ui, sans-serif;
          cursor: pointer;
        }
        .go:disabled {
          opacity: 0.55;
          cursor: wait;
        }
        .note {
          font-size: 12px;
          color: var(--muted);
          margin-top: 8px;
        }
        .stage {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .screen {
          max-height: 78vh;
          margin: 0 auto;
          width: 100%;
          border-radius: 18px;
          background: #efe7dd;
          border: 1px solid var(--line);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .screen video {
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: #1b1617;
        }
        .empty {
          text-align: center;
          color: var(--muted);
          font-size: 14px;
          padding: 20px;
        }
        .empty b {
          display: block;
          font-family: "Cormorant Garamond", serif;
          font-size: 26px;
          color: var(--ink);
          font-weight: 500;
          margin-bottom: 6px;
        }
        .bar {
          height: 6px;
          background: #eadfd3;
          border-radius: 6px;
          overflow: hidden;
          margin-top: 12px;
        }
        .bar i {
          display: block;
          height: 100%;
          background: var(--wine);
          transition: width 0.8s;
        }
        .status {
          font-size: 15px;
          display: flex;
          justify-content: space-between;
          gap: 10px;
        }
        .status small {
          color: var(--muted);
          font-size: 13px;
        }
        .plan {
          font-size: 13px;
          color: var(--wine);
          margin-top: 10px;
        }
        .actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 14px;
        }
        .btn2 {
          padding: 10px 16px;
          border: 1px solid var(--wine);
          color: var(--wine);
          border-radius: 10px;
          text-decoration: none;
          font: 600 13px Inter, system-ui, sans-serif;
          background: #fff;
          cursor: pointer;
        }
        h3 {
          font-family: "Cormorant Garamond", serif;
          font-weight: 500;
          font-size: 24px;
          margin: 10px 0 12px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
          gap: 14px;
        }
        .tile {
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 14px;
          overflow: hidden;
          cursor: pointer;
          padding: 0;
          text-align: left;
          font: inherit;
          color: inherit;
        }
        .tile video {
          width: 100%;
          display: block;
          aspect-ratio: 16/9;
          object-fit: cover;
          background: #1b1617;
        }
        .ph {
          aspect-ratio: 16/9;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--soft);
          color: var(--wine);
          font-size: 13px;
          font-weight: 600;
        }
        .c {
          padding: 10px 12px;
          font-size: 12px;
          color: var(--muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .empty-grid {
          grid-column: 1 / -1;
          color: #8a7f7a;
          font-size: 13px;
        }
        footer {
          text-align: center;
          color: var(--muted);
          font-size: 12px;
          padding: 0 20px 30px;
          line-height: 1.6;
        }
      `}</style>
    </>
  );
}
