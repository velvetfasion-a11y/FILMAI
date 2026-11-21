import { requireIdentity } from "../../../cursor/identity";
import { sql } from "../../../lib/db";
import { detectAspect, fileToDataUrl, hasReplicate, startGeneration } from "../../../lib/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

export async function POST(request: Request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ detail: "Expected multipart form data" }, { status: 400 });
  }

  const prompt = String(form.get("prompt") ?? "").trim().slice(0, 1500);
  if (!prompt) return Response.json({ detail: "Please write a prompt" }, { status: 400 });

  const images = form.getAll("images").filter((x): x is File => x instanceof File && Boolean(x.name));
  let imageDataUrl: string | null = null;
  if (images[0]) {
    try {
      imageDataUrl = await fileToDataUrl(images[0]);
    } catch (e) {
      return Response.json({ detail: e instanceof Error ? e.message : "Bad image" }, { status: 400 });
    }
  }

  const aspect = detectAspect(prompt);
  const id = newId();
  const owner = identity.sub;

  let predictionId: string;
  let mock: boolean;
  try {
    ({ predictionId, mock } = await startGeneration({ prompt, aspect, imageDataUrl }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not start generation";
    return Response.json({ detail: msg }, { status: 502 });
  }

  const message = mock
    ? "Demo mode — sample render (add REPLICATE_API_TOKEN for real films)"
    : "Queued on Wan 2.2";

  await sql(
    `insert into jobs (id, owner, prompt, status, progress, message, prediction_id, aspect)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, owner, prompt, "running", 0.05, message, predictionId, aspect],
  );

  if (!hasReplicate()) {
    // demo still works; frontend can poll
  }

  return Response.json({ id, demo: mock });
}
