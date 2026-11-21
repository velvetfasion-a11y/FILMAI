import { requireIdentity } from "../../../cursor/identity";
import { sql, type JobRow } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-z]{10}$/i.test(s))
    .slice(0, 40);

  let rows: JobRow[];
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
    const { rows: found } = await sql<JobRow>(
      `select * from jobs where owner = $1 and id in (${placeholders}) order by created_at desc limit 24`,
      [identity.sub, ...ids],
    );
    rows = found;
  } else {
    const { rows: found } = await sql<JobRow>(
      `select * from jobs where owner = $1 and status = 'done' order by created_at desc limit 24`,
      [identity.sub],
    );
    rows = found;
  }

  return Response.json(
    rows.map((j) => ({
      id: j.id,
      prompt: j.prompt,
      status: j.status,
      progress: j.progress,
      video: j.status === "done" ? `video/${j.id}` : null,
      created: j.created_at,
    })),
  );
}
