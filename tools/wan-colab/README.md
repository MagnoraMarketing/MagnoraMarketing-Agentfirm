# Wan 2.2 video engine on Google Colab

Runs Wan 2.2 TI2V-5B on a Colab GPU behind a token-protected HTTP API and a
Cloudflare quick tunnel. Paperclip agents use it through the optional
`wan-video` catalog skill (`packages/skills-catalog/catalog/optional/content/wan-video`).

- `wan22_colab.ipynb`: the notebook to run in Colab
- `wan_server.py`: the FastAPI job server the notebook downloads

## Run it

1. Open the notebook in Colab:
   `https://colab.research.google.com/github/MagnoraMarketing/MagnoraMarketing-Agentfirm/blob/HEAD/tools/wan-colab/wan22_colab.ipynb`
2. Runtime → Change runtime type → **A100 GPU** (or **L4 GPU** with
   **High-RAM**). The free T4 runtime has too little system RAM for the model.
3. Runtime → Run all. The first start downloads about 30 GB and takes
   10–20 minutes.
4. Copy the printed `WAN_API_URL` and `WAN_API_TOKEN`.

## Connect Paperclip agents

1. Company Settings → Secrets: create `WAN_API_URL` and `WAN_API_TOKEN`.
2. On each video agent: Environment variables → add `WAN_API_URL` and
   `WAN_API_TOKEN` with source **Secret**.
3. Install the `wan-video` skill on those agents from the skills catalog.

The tunnel address changes on every notebook start. Update the
`WAN_API_URL` secret each time. Store a fixed token as the Colab secret
`WAN_API_TOKEN` so the token stays the same.

## Limits

- The engine is reachable only while the notebook runs. Colab ends idle
  sessions and caps session length.
- Clips are up to 5 seconds at 24 fps (1280×704, 704×1280, or 704×704).
- Generated files live in the Colab session only. Agents attach every clip to
  its issue.

## API

All endpoints except `/health` need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, busy flag, queue length |
| POST | `/jobs` | Queue a clip: `prompt`, `orientation`, `seconds`, `steps`, `guidance`, `seed`, `negative_prompt`, `image_url` |
| GET | `/jobs/{id}` | Job status |
| GET | `/jobs/{id}/video` | The MP4 when the job succeeded |

Local check without a GPU: `WAN_FAKE=1 WAN_API_TOKEN=<16+ chars>` makes the
server write a placeholder file instead of loading the model.
