# FILMAI

Text & image to video (Wan 2.2).

## Use the app

1. **Hosted app (recommended):** confirm **Publish** for the `web/` folder in Cursor, then open that app.
2. **Local:** `cd web && npm install && npm run dev` → http://127.0.0.1:3000
3. **GitHub Pages** (UI only): https://velvetfasion-a11y.github.io/FILMAI/ — cannot generate alone; needs the hosted API.

### Real films (not demo)

Add secret **`REPLICATE_API_TOKEN`** in Cursor Secrets: https://replicate.com/account/api-tokens  
Without it the app runs in **demo mode** (sample clip).

## Repo layout

| Path | Role |
|------|------|
| `web/` | Working FilmAI app (Next.js + Replicate) |
| `our-video-ai/` | Self-hosted open-weights pipeline (GPU, ~45 GB) |
| `index.html` | Static GitHub Pages UI |

## Local open-weights

See `our-video-ai/README.md`.
