import { getIdentity } from "../cursor/identity";

/** Viewer id for jobs: signed-in Cursor user, or a stable anonymous guest. */
export async function viewerId(request: Request): Promise<string> {
  const identity = await getIdentity(request);
  if (identity.verified) return identity.sub;

  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)filmai_guest=([a-zA-Z0-9_-]{8,64})/);
  if (match) return `guest:${match[1]}`;

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const raw = `${ip}|${request.headers.get("user-agent") || ""}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `guest:${h.toString(16)}`;
}

const hits = new Map<string, { n: number; t: number }>();

/** Simple in-memory rate limit (best-effort on serverless). */
export function rateLimit(key: string, max = 8, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  const row = hits.get(key);
  if (!row || now - row.t > windowMs) {
    hits.set(key, { n: 1, t: now });
    return true;
  }
  if (row.n >= max) return false;
  row.n += 1;
  return true;
}

const ALLOWED = new Set([
  "https://velvetfasion-a11y.github.io",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:7860",
  "http://localhost:7860",
]);

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin") || "";
  const allow =
    ALLOWED.has(origin) ||
    origin.endsWith(".github.io") ||
    origin.endsWith(".trycloudflare.com") ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1")
      ? origin
      : "https://velvetfasion-a11y.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function withCors(request: Request, body: BodyInit | null, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  const cors = corsHeaders(request);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

export function jsonCors(request: Request, data: unknown, status = 200) {
  return withCors(request, JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
