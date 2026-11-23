import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type Aspect = "16:9" | "9:16" | "1:1";

export function detectAspect(prompt: string): Aspect {
  const t = prompt.toLowerCase();
  if (/\b(vertical|portrait|tiktok|tik tok|reels?|shorts|9:16|9x16|instagram stor(y|ies)|story format|phone screen)\b/.test(t)) {
    return "9:16";
  }
  if (/\b(square|1:1|1x1)\b/.test(t)) return "1:1";
  return "16:9";
}

/** Native Wan render size for a given aspect (matches generate_wan13.py). */
export function wanSize(aspect: Aspect): string {
  if (aspect === "9:16") return "480x832";
  if (aspect === "1:1") return "480x480";
  return "832x480";
}

const ROOT = process.cwd();
const JOBS = path.join(ROOT, "python", "jobs");
const SCRIPT = path.join(ROOT, "python", "generate_wan13.py");
const LOCK = path.join(JOBS, ".worker.lock");

function pythonBin() {
  const candidates = [
    process.env.WAN_PYTHON,
    path.join(ROOT, "..", "our-video-ai", ".venv", "bin", "python"),
    path.join(ROOT, ".venv", "bin", "python"),
    "python3",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (c === "python3") return c;
      accessSync(c, fsConstants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return "python3";
}

type StatusFile = {
  status?: string;
  progress?: number;
  message?: string;
  video?: string;
  error?: string;
  size?: string;
  eta_seconds?: number;
  elapsed_seconds?: number;
  step?: number;
  steps?: number;
  updated?: number;
};

async function readStatus(jobDir: string): Promise<StatusFile> {
  try {
    return JSON.parse(await readFile(path.join(jobDir, "status.json"), "utf8")) as StatusFile;
  } catch {
    return { status: "starting", progress: 0.02, message: "Starting Wan2.1…", eta_seconds: 180 };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireWorkerLock(): Promise<void> {
  await mkdir(JOBS, { recursive: true });
  if (existsSync(LOCK)) {
    try {
      const raw = JSON.parse(await readFile(LOCK, "utf8")) as { pid?: number; job?: string };
      if (raw.pid && pidAlive(raw.pid)) {
        throw new Error(
          "Another film is already rendering on this machine. Wait for it to finish, then try again.",
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("already rendering")) throw e;
    }
    try {
      await unlink(LOCK);
    } catch {
      /* ignore */
    }
  }
}

async function releaseWorkerLock(pid: number) {
  try {
    const raw = JSON.parse(await readFile(LOCK, "utf8")) as { pid?: number };
    if (raw.pid === pid) await unlink(LOCK);
  } catch {
    /* ignore */
  }
}

/** Mark orphan processing jobs (no live worker) as failed so the UI unsticks. */
export async function sweepStaleJobs(): Promise<void> {
  try {
    const dirs = await readdir(JOBS);
    const now = Date.now() / 1000;
    for (const id of dirs) {
      if (id.startsWith(".")) continue;
      const jobDir = path.join(JOBS, id);
      const st = await readStatus(jobDir);
      if (st.status !== "processing" && st.status !== "starting") continue;
      const updated = st.updated || 0;
      // Heartbeat every 3s — if silent > 90s and no output, mark failed.
      if (updated && now - updated < 90) continue;
      if (existsSync(path.join(jobDir, "output.mp4"))) continue;
      await writeFile(
        path.join(jobDir, "status.json"),
        JSON.stringify({
          ...st,
          status: "failed",
          progress: 0,
          message: "Render stalled (worker stopped). Start a new generate.",
          eta_seconds: 0,
          updated: now,
        }),
      );
    }
  } catch {
    /* ignore */
  }
}

/** Start local Wan-AI/Wan2.1-T2V-1.3B-Diffusers generation. */
export async function startGeneration(opts: {
  prompt: string;
  aspect: Aspect;
  imageDataUrl?: string | null;
}): Promise<{ predictionId: string; mock: boolean }> {
  await sweepStaleJobs();
  await acquireWorkerLock();

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const jobDir = path.join(JOBS, id);
  await mkdir(jobDir, { recursive: true });
  const size = wanSize(opts.aspect);
  const frames = Number(process.env.WAN_FRAMES || "17");
  const steps = Number(process.env.WAN_STEPS || "8");
  // CPU first-step ~3 min; GPU much faster — seed ETA before worker heartbeats.
  const seedEta = Math.round(steps * (process.env.DEVICE === "cuda" ? 20 : 200) + 90);

  await writeFile(
    path.join(jobDir, "status.json"),
    JSON.stringify({
      status: "starting",
      progress: 0.02,
      message: `Queued Wan2.1-T2V-1.3B (${size}, ${frames} frames, ${steps} steps)…`,
      prompt: opts.prompt,
      model: "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
      eta_seconds: seedEta,
      size,
      frames,
      steps,
      updated: Date.now() / 1000,
    }),
  );

  const py = pythonBin();
  const args = [
    SCRIPT,
    "--job-dir",
    jobDir,
    "--prompt",
    opts.prompt.slice(0, 1500),
    "--aspect",
    opts.aspect,
    "--frames",
    String(frames),
    "--steps",
    String(steps),
  ];
  const child = spawn(/*turbopackIgnore: true*/ py, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HF_HOME: process.env.HF_HOME || path.join(ROOT, "hf"),
      WAN_FRAMES: String(frames),
      WAN_STEPS: String(steps),
    },
  });

  await writeFile(
    LOCK,
    JSON.stringify({ pid: child.pid, job: id, started: Date.now() / 1000 }),
  );

  const logPath = path.join(jobDir, "worker.log");
  const logChunks: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => logChunks.push(d));
  child.stderr?.on("data", (d: Buffer) => logChunks.push(d));
  child.on("exit", async (code) => {
    await releaseWorkerLock(child.pid || 0);
    try {
      await writeFile(logPath, Buffer.concat(logChunks));
      if (code && code !== 0) {
        const st = await readStatus(jobDir);
        if (st.status !== "succeeded" && st.status !== "failed") {
          await writeFile(
            path.join(jobDir, "status.json"),
            JSON.stringify({
              ...st,
              status: "failed",
              progress: 0,
              message: `Worker exited with code ${code}`,
              eta_seconds: 0,
              updated: Date.now() / 1000,
            }),
          );
        }
      }
    } catch {
      /* ignore */
    }
  });
  child.unref();

  return { predictionId: `wan13_${id}`, mock: false };
}

export async function pollGeneration(predictionId: string): Promise<{
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  progress: number;
  message: string;
  videoUrl?: string;
  error?: string;
  size?: string;
  etaSeconds?: number;
}> {
  if (!predictionId.startsWith("wan13_")) {
    return {
      status: "failed",
      progress: 0,
      message: "Unknown generation backend",
      error: "expected wan13_ job",
      etaSeconds: 0,
    };
  }
  const id = predictionId.slice("wan13_".length);
  const jobDir = path.join(JOBS, id);
  const st = await readStatus(jobDir);
  const status = (st.status || "starting") as
    | "starting"
    | "processing"
    | "succeeded"
    | "failed"
    | "canceled";
  const out = path.join(jobDir, "output.mp4");
  if (status === "succeeded") {
    return {
      status,
      progress: 1,
      message: st.message || "Done — Wan2.1-T2V-1.3B",
      videoUrl: `file:${out}`,
      size: st.size,
      etaSeconds: 0,
    };
  }
  if (status === "failed" || status === "canceled") {
    return {
      status,
      progress: 0,
      message: st.message || "Generation failed",
      error: st.error || st.message,
      etaSeconds: 0,
    };
  }
  // Stale heartbeat → treat as failed so UI recovers.
  const age = st.updated ? Date.now() / 1000 - st.updated : 0;
  if (age > 120 && !existsSync(out)) {
    return {
      status: "failed",
      progress: 0,
      message: "Render stalled (no progress updates). Start a new generate.",
      etaSeconds: 0,
    };
  }
  return {
    status: status === "starting" ? "starting" : "processing",
    progress: st.progress ?? 0.1,
    message: st.message || "Filming with Wan2.1 1.3B…",
    size: st.size,
    etaSeconds: typeof st.eta_seconds === "number" ? Math.max(0, Math.round(st.eta_seconds)) : undefined,
  };
}

export async function fileToDataUrl(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 8_000_000) throw new Error("Image too large (max 8 MB)");
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
