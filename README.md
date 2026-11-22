# FILMAI

Text to video with **[Wan-AI/Wan2.1-T2V-1.3B-Diffusers](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers)**.

## Use the app

```bash
cd web
# needs the Python env from our-video-ai (torch + diffusers)
npm install && npm run build && npm run start
# open http://127.0.0.1:3000
```

Generate downloads the 1.3B Wan2.1 weights on first run (HF cache under `web/hf/`). A GPU is strongly recommended; CPU works but is slow.

## Storage

Jobs + MP4 blobs live in Postgres (`video_blobs`). Cursor Publish sets `DATABASE_URL` (Neon-backed). Locally: file-backed PGlite in `web/data/`.

## Layout

| Path | Role |
|------|------|
| `web/` | Next.js FilmAI UI + local Wan2.1 worker |
| `our-video-ai/` | Alternate FastAPI pipeline (same Wan2.1 model by default) |
| `index.html` | Static GitHub Pages UI |
