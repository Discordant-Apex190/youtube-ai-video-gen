# Youtube AI Video Generator — Architecture Overview

## Vision
Deliver a Next.js (App Router) application that automates YouTube content creation. Authenticated users feed a topic and receive:

- Gemini 2.5 Flash Lite generated outlines, full scripts, titles, descriptions, tags.
- Google Cloud Text-to-Speech audio tracks built from the script.
- DeepAI-generated still images (cover art, scene thumbnails) composable into draft videos.
- Workspace tooling to edit, version, and export the assets for upload to YouTube.

Everything runs on Cloudflares free-tier friendly stack (Workers, D1, R2, KV, Access).

## Core Services
| Concern                | Choice & Reasoning                                                                                                   |
|------------------------|------------------------------------------------------------------------------------------------------------------------|
| Frontend / SSR         | Next.js 15 App Router deployed via OpenNext Cloudflare adapter. Reactive UI with Server Actions for mutations.         |
| Authentication         | Cloudflare Access protects the app. Access JWT is verified in middleware; user identities are mirrored into D1.       |
| Relational Data        | Cloudflare D1 (SQLite) for users, projects, scripts, metadata, generation jobs.                                        |
| Binary Assets          | Cloudflare R2 bucket for generated TTS audio, DeepAI images, exported video bundles.                                   |
| Caching & Ephemeral    | Workers KV for AI response cache, request dedupe, and rate limiting counters.                                          |
| AI Text Generation     | Google Gemini 2.5 Flash Lite via Google AI Studio REST API (text + JSON generation).                                  |
| Text-to-Speech         | Google Cloud Text-to-Speech (WaveNet voices preferred) for narration output.                                           |
| Image Generation       | DeepAI Image API for thumbnails and scene imagery.                                                                    |

### Optional Extensions
- Durable Objects for long-running render orchestration (if we stitch videos server-side later).
- Cloudflare Queues for fan-out processing (e.g., bulk channel templates).

## Environment & Secrets
All secrets are bound via `wrangler.toml` / dashboard environment variables and mirrored in `env.d.ts`:

- `GOOGLE_GEMINI_API_KEY`
- `GOOGLE_TTS_API_KEY` (service account or OAuth key with TTS scope)
- `DEEPAI_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `CF_ACCESS_AUD`, `CF_ACCESS_JWT_ALG` (Access validation)
- `KV_NAMESPACE_ID`
- `D1_DATABASE_ID`

Local development options:
- Bypass Access by supplying `DEV_AUTH_BYPASS_TOKEN` and using a mock header.
- Optional `.dev.vars` file for wrangler with fake keys that route to mocked services.

## Request Flow
1. **Access Gate**: Incoming request passes through Next.js middleware (`src/middleware.ts`). If running on Cloudflare, we read `CF-Access-Jwt-Assertion`, validate signature using Access public keys, and attach decoded identity (email, subject) onto the request/headers.
2. **Session Hydration**: Middleware ensures a D1 user row exists for that subject. A lightweight signed cookie (HMAC) stores the user ID for client renders.
3. **Frontend Interaction**:
   - User inputs topic and target video length/persona in the dashboard.
   - Client submits a Server Action or fetches `/api/generate/script`.
4. **Generation Worker**:
   - API handler looks up KV cache for identical prompts (topic + persona hash) to avoid duplicate billing.
   - If cache miss, call Gemini 2.5 Flash Lite with structured prompt to receive outline, script, metadata JSON.
   - Persist script + metadata into D1 (`project_versions`) and store normalized JSON in KV for quick fetch.
5. **Asset Creation**:
   - **Audio**: `/api/generate/tts` posts script segments to Google TTS. We chunk large scripts, store resulting MP3/OGG files in R2 under `audio/{projectId}/{segment}.mp3`, and record object keys in D1.
   - **Images**: `/api/generate/image` sends prompt to DeepAI (style selectable). Save resulting JPEG/PNG to R2 under `images/{projectId}/{scene}.png`.
   - Both endpoints enqueue audit logs into D1 (`generation_jobs`) with status for UI progress feedback.
6. **Management & Editing**:
   - Dashboard fetches project list via `/api/projects` (paginated query to D1) and inlines signed URLs for R2 assets (URL short expiration via KV).
   - Editing updates are Server Actions writing back to D1 (`project_revisions`, `script_sections`). Optimistic UI uses React Query or SWR.
7. **Export**:
   - `/api/export/{projectId}` bundles script JSON, SEO metadata, image URLs, and optional audio track references.
   - Optionally generates a ZIP in memory, writes to R2 `exports/{projectId}/{timestamp}.zip`, and returns a signed download URL.

## Data Model (D1)
```
users
  id TEXT PRIMARY KEY
  access_sub TEXT UNIQUE
  email TEXT
  created_at DATETIME

projects
  id TEXT PRIMARY KEY
  user_id TEXT REFERENCES users(id)
  title TEXT
  topic TEXT
  target_length INTEGER
  status TEXT CHECK status IN ('draft','generating','ready','archived')
  created_at DATETIME
  updated_at DATETIME

project_versions
  id TEXT PRIMARY KEY
  project_id TEXT REFERENCES projects(id)
  version INTEGER
  script TEXT
  outline JSON
  seo JSON -- {title, description, tags}
  generated_with TEXT -- prompt metadata and model snapshot
  created_at DATETIME

assets
  id TEXT PRIMARY KEY
  project_id TEXT REFERENCES projects(id)
  type TEXT CHECK type IN ('audio','image','export')
  label TEXT
  r2_key TEXT
  mime_type TEXT
  size_bytes INTEGER
  created_at DATETIME

generation_jobs
  id TEXT PRIMARY KEY
  project_id TEXT REFERENCES projects(id)
  job_type TEXT CHECK job_type IN ('script','tts','image')
  status TEXT CHECK status IN ('queued','running','succeeded','failed')
  payload JSON
  error TEXT
  created_at DATETIME
  updated_at DATETIME
```

Indices are added on `projects.user_id`, `assets.project_id`, and `generation_jobs.project_id` for quick dashboard retrieval.

## Cloudflare Bindings
`wrangler.jsonc` additions:
```jsonc
{
  "vars": {
    // Gemini prompt defaults, etc.
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_id": "${D1_DATABASE_ID}",
      "database_name": "youtube_ai_video_gen"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "CACHE",
      "id": "${KV_NAMESPACE_ID}"
    }
  ],
  "r2_buckets": [
    {
      "binding": "MEDIA_BUCKET",
      "bucket_name": "${R2_BUCKET}"
    }
  ]
}
```
Bindings are exposed to the Next.js runtime via OpenNext configuration (`open-next.config.ts`) so that server components, routes, and actions can access them.

## API & Server Actions
| Route / Action                 | Purpose                                                                 | Notes |
|--------------------------------|-------------------------------------------------------------------------|-------|
| `POST /api/generate/script`    | Calls Gemini, stores script & metadata, returns project snapshot       | Idempotent on topic hash using KV cache |
| `POST /api/generate/tts`       | Converts script sections to audio files and stores them in R2          | Progress tracked via `generation_jobs` |
| `POST /api/generate/image`     | Generates one/many images from prompts, stores them in R2              | Supports style presets |
| `GET /api/projects`            | Returns paginated list of user projects                                | Filter by status |
| `PATCH /api/projects/:id`      | Update project metadata, script edits, SEO tweaks                      | Server Action or REST |
| `POST /api/projects/:id/export`| Builds export bundle, writes ZIP to R2, returns signed download         | Triggers analytics event |
| `GET /api/assets/:id/signed`   | Issues short-lived signed URL for R2 asset                             | Signed URL stored briefly in KV |

Server Actions wrap these routes for forms in React components wherever convenient.

## Frontend Modules
- **Dashboard Layout**: Shell with navigation, user info, and progress indicators (React Server Component).
- **Project Workspace** (Client Components):
  - Topic input + persona sliders (e.g., tone, video length, target audience).
  - Tabs: Outline, Script Editor, SEO panel, Assets.
  - Live preview sections (script segments, audio waveform, thumbnail gallery).
- **Generation Timeline**: Polls `generation_jobs` for status updates (SWR with revalidation).
- **Export Drawer**: Lets user pick which assets to include, triggers export route.
- **Settings**: Manage Access identity info, API usage tips, quota display.

Styling: Tailwind CSS (already included). Consider adding shadcn/ui or Radix primitives for modern UX (cards, tabs, dialogs).

## Error Handling & Observability
- Centralized error utility wraps API calls, maps provider errors to friendly messages.
- `generation_jobs.error` captures provider responses.
- Cloudflare Workers logs piping via `wrangler tail`.
- Optional: integrate Sentry or Logflare if quota allows.

## Rate Limits & Cost Guardrails
- KV-backed counters limit script/image/audio generations per hour per user.
- Cache successful generation payloads to allow instant re-download without re-calling paid APIs.
- Provide UI warnings when nearing quotas (tracked in D1 `usage_stats` table if needed).

## Export Formats
- JSON bundle: `project.json` with script, outline, SEO metadata.
- CSV: optional `metadata.csv` for batch upload tools.
- ZIP: Contains JSON/CSV plus audio (if selected) and image assets.
- Future: Basic MP4 slideshow assembly (requires video rendering pipeline, potentially with WebCodecs or ffmpeg Worker).

## Next Steps
1. Scaffold env bindings (`env.d.ts`, `open-next.config.ts`, `wrangler.jsonc`).
2. Implement Access-aware middleware + D1 migrations.
3. Build generation routes and tie into providers.
4. Ship frontend dashboard with editing UX.
5. Layer on exports, tests, and documentation.
