import { requireIdentity } from "../../../../cursor/identity";
import { sql, type JobRow } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  const { id } = await ctx.params;
  const { rows } = await sql<JobRow>(`select * from jobs where id = $1 limit 1`, [id]);
  const job = rows[0];
  if (!job || job.owner !== identity.sub || !job.video_url) {
    return Response.json({ detail: "Not found" }, { status: 404 });
  }

  // Redirect to the hosted MP4 (Replicate CDN or sample).
  return Response.redirect(job.video_url, 302);
}
