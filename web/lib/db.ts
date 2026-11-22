import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
let pool: pg.Pool | undefined;
let local: Promise<PGlite> | undefined;
let migrated = false;

async function migratePglite(db: PGlite) {
  const dir = path.join(process.cwd(), "migrations");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return;
  }
  for (const file of files) {
    const sqlText = await readFile(path.join(dir, file), "utf8");
    await db.exec(sqlText);
  }
}

async function migratePostgres(client: pg.Pool) {
  const dir = path.join(process.cwd(), "migrations");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return;
  }
  for (const file of files) {
    const sqlText = await readFile(path.join(dir, file), "utf8");
    await client.query(sqlText);
  }
}

async function ensureMigrated() {
  if (migrated) return;
  if (databaseUrl) {
    if (!pool) pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    await migratePostgres(pool);
    migrated = true;
    return;
  }
  const db = await getLocal();
  await migratePglite(db);
  migrated = true;
}

function getLocal() {
  if (!local) {
    local = (async () => {
      const dataDir = path.join(process.cwd(), "data", "filmai");
      await mkdir(dataDir, { recursive: true });
      // File-backed PGlite so videos survive server restarts locally.
      return new PGlite(dataDir);
    })();
  }
  return local;
}

export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  await ensureMigrated();
  if (databaseUrl) {
    if (!pool) pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    const result = await pool.query(text, params);
    return { rows: result.rows as T[] };
  }
  const db = await getLocal();
  const result = await db.query(text, params);
  return { rows: (result.rows ?? []) as T[] };
}

export type JobRow = {
  id: string;
  owner: string;
  prompt: string;
  status: string;
  progress: number;
  message: string;
  video_url: string | null;
  prediction_id: string | null;
  aspect: string;
  has_video?: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};
