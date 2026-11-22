import { jsonCors, rateLimit, viewerId, withCors } from "../../../lib/auth";
import { sql } from "../../../lib/db";
import { detectAspect, fileToDataUrl, startGeneration } from "../../../lib/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

export async function OPTIONS(request: Request) {
  return withCors(request, null, { status: 204 });
}

export async function POST(request: Request) {
  const owner = await viewerId(request);
  if (!rateLimit(`gen:${owner}`, 10, 60 * 60 * 1000)) {
    return jsonCors(request, { detail: "Too many videos this hour — try again later" }, 429);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonCors(request, { detail: "Expected multipart form data" }, 400);
  }

  const prompt = String(form.get("prompt") ?? "").trim().slice(0, 1500);
  if (!prompt) return jsonCors(request, { detail: "Please write a prompt" }, 400);

  const images = form.getAll("images").filter((x): x is File => x instanceof File && Boolean(x.name));
  let imageDataUrl: string | null = null;
  if (images[0]) {
    try {
      imageDataUrl = await fileToDataUrl(images[0]);
    } catch (e) {
      return jsonCors(request, { detail: e instanceof Error ? e.message : "Bad image" }, 400);
    }
  }

  const aspect = detectAspect(prompt);
  const id = newId();

  let predictionId: string;
  let mock: boolean;
  try {
    ({ predictionId, mock } = await startGeneration({ prompt, aspect, imageDataUrl }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not start generation";
    return jsonCors(request, { detail: msg }, 502);
  }

  const message = mock
    ? "Demo mode — sample render (add REPLICATE_API_TOKEN for real films)"
    : "Queued on Wan 2.2";

  await sql(
    `insert into jobs (id, owner, prompt, status, progress, message, prediction_id, aspect)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, owner, prompt, "running", 0.05, message, predictionId, aspect],
  );

  const res = jsonCors(request, { id, demo: mock });
  if (!request.headers.get("cookie")?.includes("filmai_guest=") && owner.startsWith("guest:")) {
    const headers = new Headers(res.headers);
    const secure = request.url.startsWith("https:");
    headers.append(
      "Set-Cookie",
      `filmai_guest=${owner.slice(6)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`,
    );
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}
