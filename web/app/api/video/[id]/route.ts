import { jsonCors, viewerId, withCors } from "../../../../lib/auth";
import { sql, type JobRow } from "../../../../lib/db";

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
  if (!job || job.owner !== owner || !job.video_url) {
    return jsonCors(request, { detail: "Not found" }, 404);
  }

  return withCors(request, null, {
    status: 302,
    headers: { Location: job.video_url },
  });
}
