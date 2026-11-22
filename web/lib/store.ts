import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "./db";

const MAX_BYTES = 30 * 1024 * 1024;

export async function saveVideoBytes(
  jobId: string,
  bytes: Buffer,
  contentType = "video/mp4",
): Promise<void> {
  if (bytes.length > MAX_BYTES) {
    throw new Error(`Video too large to store (${bytes.length} bytes)`);
  }
  await sql(`delete from video_blobs where job_id = $1`, [jobId]);
  await sql(
    `insert into video_blobs (job_id, content_type, bytes, byte_size) values ($1, $2, $3, $4)`,
    [jobId, contentType, bytes, bytes.length],
  );
  await sql(`update jobs set has_video = true, updated_at = now() where id = $1`, [jobId]);
}

export async function getVideoBytes(
  jobId: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const { rows } = await sql<{ bytes: Buffer | Uint8Array; content_type: string }>(
    `select bytes, content_type from video_blobs where job_id = $1 limit 1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
  return { bytes, contentType: row.content_type || "video/mp4" };
}

/** Download a remote MP4 (or use the bundled demo) and persist it in Postgres. */
export async function ingestVideo(jobId: string, sourceUrl?: string | null): Promise<boolean> {
  try {
    let bytes: Buffer;
    if (!sourceUrl || sourceUrl.startsWith("demo:")) {
      const demoPath = path.join(process.cwd(), "storage", "demo-sample.mp4");
      bytes = await readFile(demoPath);
    } else {
      const res = await fetch(sourceUrl);
      if (!res.ok) {
        // Fall back to bundled demo if remote sample is blocked (e.g. 403).
        const demoPath = path.join(process.cwd(), "storage", "demo-sample.mp4");
        bytes = await readFile(demoPath);
      } else {
        const ab = await res.arrayBuffer();
        bytes = Buffer.from(ab);
      }
    }
    await saveVideoBytes(jobId, bytes, "video/mp4");
    await sql(`update jobs set video_url = $2 where id = $1`, [jobId, `stored:${jobId}`]);
    return true;
  } catch (e) {
    console.error("ingestVideo failed", e);
    return false;
  }
}
