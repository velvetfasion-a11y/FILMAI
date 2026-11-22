import { jsonCors, viewerId, withCors } from "../../../../lib/auth";
import { sql, type JobRow } from "../../../../lib/db";
import { getVideoBytes, ingestVideo } from "../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return withCors(request, null, { status: 204 });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const owner = await viewerId(request);
  const { id } = await ctx.params;
  const { rows } = await sql<JobRow>(`select * from jobs where id = $1 limit 1`, [id]);
  const job = rows[0];
  if (!job || job.owner !== owner) {
    return jsonCors(request, { detail: "Not found" }, 404);
  }

  let blob = await getVideoBytes(id);
  if (!blob && job.video_url) {
    await ingestVideo(id, job.video_url);
    blob = await getVideoBytes(id);
  }
  if (!blob) {
    return jsonCors(request, { detail: "Video not in storage yet" }, 404);
  }

  const headers = new Headers({
    "Content-Type": blob.contentType,
    "Content-Length": String(blob.bytes.length),
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  });
  const cors = (await import("../../../../lib/auth")).corsHeaders(request);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);

  const body = new Uint8Array(blob.bytes);

  // Support Range requests for mobile Safari scrubbing.
  const range = request.headers.get("range");
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;
      const slice = body.subarray(start, end + 1);
      headers.set("Content-Range", `bytes ${start}-${end}/${body.length}`);
      headers.set("Content-Length", String(slice.length));
      return new Response(slice, { status: 206, headers });
    }
  }

  return new Response(body, { status: 200, headers });
}
