import Replicate from "replicate";

export type Aspect = "16:9" | "9:16" | "1:1";

export function detectAspect(prompt: string): Aspect {
  const t = prompt.toLowerCase();
  if (/\b(vertical|portrait|tiktok|tik tok|reels?|shorts|9:16|9x16|instagram stor(y|ies)|story format|phone screen)\b/.test(t)) {
    return "9:16";
  }
  if (/\b(square|1:1|1x1)\b/.test(t)) return "1:1";
  return "16:9";
}

/** Sample clip used when REPLICATE_API_TOKEN is not set (local / preview). */
export const SAMPLE_VIDEO =
  "https://replicate.delivery/xezq/placeholder-filmai-sample.mp4";

const SAMPLE_FALLBACK =
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4";

function client() {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (!token) return null;
  return new Replicate({ auth: token });
}

export function hasReplicate() {
  return Boolean(process.env.REPLICATE_API_TOKEN?.trim());
}

export async function startGeneration(opts: {
  prompt: string;
  aspect: Aspect;
  imageDataUrl?: string | null;
}): Promise<{ predictionId: string; mock: boolean }> {
  const rep = client();
  if (!rep) {
    return { predictionId: `mock_${Date.now()}`, mock: true };
  }

  const model = opts.imageDataUrl
    ? "wan-video/wan-2.2-i2v-fast"
    : "wan-video/wan-2.2-t2v-fast";

  const input: Record<string, unknown> = {
    prompt: opts.prompt.slice(0, 1500),
    aspect_ratio: opts.aspect === "1:1" ? "16:9" : opts.aspect,
    resolution: "720p",
    go_fast: true,
  };
  if (opts.imageDataUrl) input.image = opts.imageDataUrl;

  const prediction = await rep.predictions.create({
    model,
    input,
  });
  return { predictionId: prediction.id, mock: false };
}

export async function pollGeneration(predictionId: string): Promise<{
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  progress: number;
  message: string;
  videoUrl?: string;
  error?: string;
}> {
  if (predictionId.startsWith("mock_")) {
    const started = Number(predictionId.slice(5));
    const elapsed = Date.now() - started;
    if (elapsed < 2500) {
      return { status: "processing", progress: 0.35, message: "Sample render: planning shots…" };
    }
    if (elapsed < 5000) {
      return { status: "processing", progress: 0.7, message: "Sample render: filming (demo mode)…" };
    }
    return {
      status: "succeeded",
      progress: 1,
      message: "Done (sample video — add REPLICATE_API_TOKEN for real Wan 2.2 films)",
      videoUrl: SAMPLE_FALLBACK,
    };
  }

  const rep = client();
  if (!rep) {
    return { status: "failed", progress: 0, message: "Missing API token", error: "REPLICATE_API_TOKEN not set" };
  }

  const prediction = await rep.predictions.get(predictionId);
  const status = prediction.status as "starting" | "processing" | "succeeded" | "failed" | "canceled";

  if (status === "succeeded") {
    const out = prediction.output;
    const videoUrl = Array.isArray(out) ? String(out[0]) : String(out ?? "");
    return { status, progress: 1, message: "Done", videoUrl };
  }
  if (status === "failed" || status === "canceled") {
    return {
      status,
      progress: 0,
      message: prediction.error ? String(prediction.error) : "Generation failed",
      error: prediction.error ? String(prediction.error) : status,
    };
  }

  const progress = status === "starting" ? 0.08 : 0.45;
  return {
    status,
    progress,
    message: status === "starting" ? "Starting Wan 2.2…" : "Filming your video…",
  };
}

export async function fileToDataUrl(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 8_000_000) throw new Error("Image too large (max 8 MB for cloud generate)");
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
