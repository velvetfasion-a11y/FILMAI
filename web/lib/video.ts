import { accessSync, constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const ROOT = process.cwd();
const JOBS = path.join(ROOT, "python", "jobs");
const SCRIPT = path.join(ROOT, "python", "generate_wan13.py");

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
};

async function readStatus(jobDir: string): Promise<StatusFile> {
  try {
    return JSON.parse(await readFile(path.join(jobDir, "status.json"), "utf8")) as StatusFile;
  } catch {
    return { status: "starting", progress: 0.02, message: "Starting Wan2.1…" };
  }
}

/** Start local Wan-AI/Wan2.1-T2V-1.3B-Diffusers generation. */
export async function startGeneration(opts: {
  prompt: string;
  aspect: Aspect;
  imageDataUrl?: string | null;
}): Promise<{ predictionId: string; mock: boolean }> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const jobDir = path.join(JOBS, id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(
    path.join(jobDir, "status.json"),
    JSON.stringify({
      status: "starting",
      progress: 0.02,
      message: "Queued Wan2.1-T2V-1.3B…",
      prompt: opts.prompt,
      model: "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
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
  ];
  const child = spawn(/*turbopackIgnore: true*/ py, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HF_HOME: process.env.HF_HOME || path.join(ROOT, "hf"),
      WAN_FRAMES: process.env.WAN_FRAMES || "17",
      WAN_STEPS: process.env.WAN_STEPS || "8",
    },
  });
  const logPath = path.join(jobDir, "worker.log");
  const logChunks: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => logChunks.push(d));
  child.stderr?.on("data", (d: Buffer) => logChunks.push(d));
  child.on("exit", async (code) => {
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
}> {
  if (!predictionId.startsWith("wan13_")) {
    return {
      status: "failed",
      progress: 0,
      message: "Unknown generation backend",
      error: "expected wan13_ job",
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
    };
  }
  if (status === "failed" || status === "canceled") {
    return {
      status,
      progress: 0,
      message: st.message || "Generation failed",
      error: st.error || st.message,
    };
  }
  return {
    status: status === "starting" ? "starting" : "processing",
    progress: st.progress ?? 0.1,
    message: st.message || "Filming with Wan2.1 1.3B…",
  };
}

export async function fileToDataUrl(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 8_000_000) throw new Error("Image too large (max 8 MB)");
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
