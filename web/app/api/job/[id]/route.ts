import { jsonCors, viewerId, withCors } from "../../../../lib/auth";
import { sql, type JobRow } from "../../../../lib/db";
import { ingestVideo } from "../../../../lib/store";
import { pollGeneration, wanSize, type Aspect } from "../../../../lib/video";

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

  let eta = 0;
  let renderSize = wanSize((job.aspect as Aspect) || "16:9");

  if (job.status === "running" && job.prediction_id) {
    try {
      const polled = await pollGeneration(job.prediction_id);
      if (polled.size) renderSize = polled.size;
      if (typeof polled.etaSeconds === "number") eta = polled.etaSeconds;

      if (polled.status === "succeeded" && polled.videoUrl) {
        const ok = await ingestVideo(id, polled.videoUrl);
        await sql(
          `update jobs set status = $2, progress = 1, message = $3, video_url = $4, updated_at = now() where id = $1`,
          [
            id,
            ok ? "done" : "error",
            ok ? polled.message : "Finished but could not save video to storage",
            ok ? `stored:${id}` : null,
          ],
        );
        job.status = ok ? "done" : "error";
        job.progress = ok ? 1 : 0;
        job.message = ok ? polled.message : "Finished but could not save video to storage";
        job.video_url = ok ? `stored:${id}` : null;
        job.has_video = ok;
        eta = 0;
      } else if (polled.status === "failed" || polled.status === "canceled") {
        await sql(
          `update jobs set status = 'error', progress = 0, message = $2, updated_at = now() where id = $1`,
          [id, polled.message],
        );
        job.status = "error";
        job.progress = 0;
        job.message = polled.message;
        eta = 0;
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

  // Backfill: done job without blob yet (legacy rows).
  if (job.status === "done" && !job.has_video) {
    const ok = await ingestVideo(id, job.video_url);
    if (ok) job.has_video = true;
  }

  return jsonCors(request, {
    id: job.id,
    prompt: job.prompt,
    status: job.status,
    progress: job.progress,
    message: job.message,
    demo: false,
    model: "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
    video: job.status === "done" ? `api/video/${job.id}` : null,
    video_url: job.status === "done" ? `/api/video/${job.id}` : null,
    has_video: Boolean(job.has_video),
    plan: {
      scenes: 1,
      seconds_per_scene: 1,
      aspect: job.aspect,
      size: renderSize,
      continuous: true,
      transition: "crossfade",
      style: "as described",
    },
    scene_state: job.status === "done" ? ["done"] : job.status === "running" ? ["rendering"] : ["waiting"],
    scenes: [job.prompt],
    created: job.created_at,
    size: renderSize,
    ahead: 0,
    eta: job.status === "running" ? eta : 0,
  });
}
