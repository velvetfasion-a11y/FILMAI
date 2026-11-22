import { jsonCors, viewerId, withCors } from "../../../../lib/auth";
import { sql, type JobRow } from "../../../../lib/db";
import { pollGeneration } from "../../../../lib/video";

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
  if (!/^[0-9a-z]{10}$/i.test(id)) {
    return jsonCors(request, { detail: "Not found" }, 404);
  }

  const { rows } = await sql<JobRow>(`select * from jobs where id = $1 limit 1`, [id]);
  const job = rows[0];
  if (!job || job.owner !== owner) {
    return jsonCors(request, { detail: "Not found" }, 404);
  }

  if (job.status === "running" && job.prediction_id) {
    try {
      const polled = await pollGeneration(job.prediction_id);
      if (polled.status === "succeeded" && polled.videoUrl) {
        await sql(
          `update jobs set status = 'done', progress = 1, message = $2, video_url = $3, updated_at = now() where id = $1`,
          [id, polled.message, polled.videoUrl],
        );
        job.status = "done";
        job.progress = 1;
        job.message = polled.message;
        job.video_url = polled.videoUrl;
      } else if (polled.status === "failed" || polled.status === "canceled") {
        await sql(
          `update jobs set status = 'error', progress = 0, message = $2, updated_at = now() where id = $1`,
          [id, polled.message],
        );
        job.status = "error";
        job.progress = 0;
        job.message = polled.message;
      } else {
        await sql(
          `update jobs set progress = $2, message = $3, updated_at = now() where id = $1`,
          [id, polled.progress, polled.message],
        );
        job.progress = polled.progress;
        job.message = polled.message;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Poll failed";
      await sql(`update jobs set message = $2, updated_at = now() where id = $1`, [id, msg]);
      job.message = msg;
    }
  }

  return jsonCors(request, {
    id: job.id,
    prompt: job.prompt,
    status: job.status,
    progress: job.progress,
    message: job.message,
    video: job.video_url ? `video/${job.id}` : null,
    video_url: job.video_url,
    plan: {
      scenes: 1,
      seconds_per_scene: 5,
      aspect: job.aspect,
      size: job.aspect === "9:16" ? "720x1280" : "1280x720",
      continuous: true,
      transition: "crossfade",
      style: "as described",
    },
    scene_state: job.status === "done" ? ["done"] : job.status === "running" ? ["rendering"] : ["waiting"],
    scenes: [job.prompt],
    created: job.created_at,
    size: job.aspect === "9:16" ? "720x1280" : "1280x720",
    ahead: 0,
    eta: job.status === "running" ? 45 : 0,
  });
}
