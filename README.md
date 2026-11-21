# FILMAI

Text & image to video.

## Create films (cloud)

The working generator is the Next.js app in [`web/`](web/):

1. Publish `web/` with Cursor (Publish button).
2. Add secret **`REPLICATE_API_TOKEN`** in Cursor Secrets (from [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens)).
3. Open the hosted app (private/team sign-in) and tap **Generate video**.

It runs **Wan 2.2 Fast** on Replicate. Without the token, the app uses a sample clip in demo mode.

## GitHub Pages

https://velvetfasion-a11y.github.io/FILMAI/ is the static UI only. It cannot POST to a GPU/API on `github.io` (that caused the **405 Not Allowed** error). Use the hosted `web/` app to generate, or point `config.js` → `FILMAI_API_BASE` at your hosted app origin.

## Local open-weights pipeline

[`our-video-ai/`](our-video-ai/) is the original self-hosted FastAPI + local Wan/Qwen stack (~45 GB models, GPU recommended). See that folder’s README.
