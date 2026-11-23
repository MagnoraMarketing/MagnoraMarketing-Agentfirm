---
name: wan-video
description: Generate short marketing videos (up to 5 seconds, text-to-video or image-to-video) with a self-hosted Wan 2.2 engine running in Google Colab, then attach the MP4 to the issue.
key: paperclipai/optional/content/wan-video
recommendedForRoles:
  - designer
  - marketer
  - writer
tags:
  - video
  - wan
  - generation
  - marketing
---

# Wan 2.2 Video

Generate a short video clip with the company's Wan 2.2 engine. The engine runs
in a Google Colab notebook (`tools/wan-colab/wan22_colab.ipynb` in the
Agentfirm repository) and is reachable only while that notebook is running.

## When to use

- An issue asks for a short video clip, b-roll, a product shot in motion, or a
  social video loop.
- You have a still image (product photo, ad visual) that should come alive.

## When not to use

- The video needs readable text, logos, voice-over, or exact brand typography.
  Wan does not render text reliably. Generate the clip without text and say
  that text must be added in editing.
- The clip must be longer than 5 seconds. Generate several 5-second shots and
  list them as a shot list for editing.

## Requirements

Two environment variables, bound to your agent from company secrets:

- `WAN_API_URL`: the `https://...trycloudflare.com` address the notebook printed
- `WAN_API_TOKEN`: the bearer token the notebook printed

If either is missing, stop and comment on the issue: "Wan video engine is not
configured. Bind WAN_API_URL and WAN_API_TOKEN to this agent." Do not invent
another video tool.

## Workflow

### 1. Check that the engine is online

```sh
curl -fsS --max-time 30 "$WAN_API_URL/health"
```

If this fails (connection error, 404, 502, 530), the Colab notebook is not
running or its address changed. Comment on the issue that the video engine is
offline and ask the board to start the notebook and update `WAN_API_URL`.
Set the issue to `blocked`. Do not retry in a loop.

### 2. Write the prompt

Write one concrete English prompt, 1–3 sentences. Describe in this order:
subject, action, setting, camera movement, light, style. Example:

> A ceramic coffee cup on a wooden table, steam rising slowly, morning light
> through a window, slow push-in camera, shallow depth of field, cinematic.

Pick `orientation`: `portrait` for Reels/TikTok/Stories, `landscape` for web
and YouTube, `square` for feeds.

### 3. Submit the job

```sh
curl -fsS -X POST "$WAN_API_URL/jobs" \
  -H "Authorization: Bearer $WAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "<prompt>", "orientation": "portrait", "seconds": 5, "steps": 30}'
```

Optional fields:

- `image_url`: a public `https://` image to animate (image-to-video)
- `negative_prompt`: things to avoid
- `seed`: an integer, to reproduce a result
- `steps`: 10–50 (default 30; lower is faster and rougher)
- `guidance`: 1–10 (default 5)

The response has an `id`. A `429` means the queue is full: wait 5 minutes and
try once more.

### 4. Wait for the result

One clip takes about 3–10 minutes on an A100 and longer on smaller GPUs.
Poll every 30 seconds, for at most 30 minutes:

```sh
curl -fsS "$WAN_API_URL/jobs/<id>" -H "Authorization: Bearer $WAN_API_TOKEN"
```

Stop when `status` is `succeeded` or `failed`. On `failed`, report `error` in
the issue comment.

### 5. Download and attach

```sh
curl -fsS -o wan-<id>.mp4 "$WAN_API_URL/jobs/<id>/video" \
  -H "Authorization: Bearer $WAN_API_TOKEN"
```

Attach the MP4 to the issue with the Paperclip skill's "Generated Artifacts
and Work Products" workflow (`paperclip-upload-artifact.sh`). Videos are kept
in Colab only until the session ends, so always attach them.

In the final comment, link the artifact and list the prompt, orientation,
seed, and steps, so the board can ask for a variation.

## Quality bar

- One idea per clip. Simple motion beats complex choreography.
- Generate at most 3 variations per request unless the issue asks for more.
- Never put personal data, customer names, or secrets in a prompt.
