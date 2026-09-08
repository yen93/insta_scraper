# CLAUDE.md

## What this project is
A tool for pulling Instagram story images referenced in the Supabase table
`public.insta_stories` (project "MAGTestProject", id `aivitcomiywiysrfwqxt`),
saving them into a Google Drive folder ("Instagram Story Scraper",
id `1lYvSd_IpE_wL1T0clJpxt0AC6rbRvbiy`), and then analyzing each saved image
for booking-lead signals. The `insta_stories` table is populated by an
external n8n workflow, "Insta Outbound Sales Automations" (exported as
`n8n - Insta Outbound Sales Automations.json` in this repo — not run from
here, just kept for reference). That workflow: finds batches of speakers in
Supabase `speakers`, scrapes their current Instagram stories via an Apify
actor, inserts new rows into `insta_stories`, fires this project's uploader
routine (see below) to save them to Drive, and — on its own separate daily
schedule — fires this project's second routine to analyze them. As of
2026-09-08 the batch-discovery → scrape → insert → upload chain is fully
live (previously only the "fire the uploader" stage was scheduled; the
upstream stages have since been consolidated into one continuous enabled
chain — see the n8n workflow section below). That workflow still has a
known unresolved bug: one of its nodes ("Execute a SQL query2") hardcodes
`batch_no = 1` instead of using the current loop's batch, so every batch's
"already ran in the last 24h" check looks at batch 1's history regardless
of which batch is actually being processed — this now matters for real
since the chain went live.

## Key gotcha: can't upload images via chat-connected MCP tools
The connected Google Drive MCP tool (`create_file`) only accepts inline
base64/text content as a tool-call parameter — there is no "upload this local
file" option. For real image sizes (tens to hundreds of KB), base64-encoding
and passing the bytes through a chat turn is not feasible: even a ~60KB file's
base64 text overflows a single context read, and it can't be reliably chunked
and reassembled as a tool-call argument. **Don't try the inline-base64 route
again for anything but tiny files.**

The working approach is `upload_to_drive.js`: a standalone Node script that
authenticates as a Google Cloud service account and uploads local files
directly via the Drive v3 API (`googleapis` package), bypassing chat context
entirely.

## Related gotcha: the same problem exists on download, via a different tool
The Google Drive MCP connector's `download_file_content` tool has the mirror
problem: it returns the whole file as base64 text in the tool result (large
results get auto-saved to a local file, but smaller ones — observed at
roughly under ~50KB — come back inline instead). When that happens, there's
no local file to decode from, and the only way to get the bytes onto disk is
to have the model retype tens of thousands of base64 characters as a
`Write`/`Bash` tool argument — which is exactly as slow and unreliable as the
upload-side gotcha above. This caused multi-minute stalls in the
`scraped_insta_stories_analyzer` routine (below) on 2026-09-08. **Don't use
`download_file_content` for real image files either.**

The fix is the same shape as the upload fix: `download_from_drive.js`, a
standalone Node script that authenticates as the same Google Cloud service
account and streams a Drive file straight to a local path via
`drive.files.get({ alt: 'media', supportsAllDrives: true })` — no base64
round-trip through chat context at all. Usage:
```
node download_from_drive.js <env|path-to-service-account-key.json> <fileId1> <outputPath1> [<fileId2> <outputPath2> ...]
```
Same `env`/file-path credential convention as `upload_to_drive.js`.

## Drive API gotcha: Shared Drive requires `supportsAllDrives`
The target Drive folder lives inside a Shared Drive (confirmed via
`get_file_permissions` — its permission roles are "organizer"/"fileOrganizer",
which only exist in Shared Drives, not personal My Drive folders). Any
`drive.files.create` (or similar) call against it must include
`supportsAllDrives: true`, or the API returns a misleading "File not found"
error even when the service account genuinely has access.

## Running the uploader
```
node upload_to_drive.js <env|path-to-service-account-key.json> <image1> [image2 ...]
```
- `env` reads the key JSON from `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` (used by the
  scheduled routine — see below); a file path uses that key file directly
  (local/manual runs).
- The service account's `client_email` must be shared on the target Drive
  folder with at least Editor access, or uploads fail with "File not found".
- The folder ID is hardcoded in `upload_to_drive.js` as `DRIVE_FOLDER_ID`.

## Credentials
- `service_account_json_key_claudegwscli-502400-3a7969b176ed.json.json` in the
  project root is a live Google Cloud service account key, gitignored. **Never
  commit this file** (or any other `*service_account*.json` / `*.json.json`
  key file).
- The scheduled cloud routine (below) needs the *entire contents* of that key
  file — not just the `private_key` field — pasted as the value of a
  `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` env var on the "Default" cloud environment
  (`env_01DYHNjMesGeuq9ABo7W6m6f`), via claude.ai/code environment settings.
  `upload_to_drive.js` does `JSON.parse()` on that value, so a partial paste
  (e.g. just the private key string) fails.
- **Gotcha: the value must be ONLY the raw JSON, not `KEY=value`.** The
  claude.ai env-var UI's bulk-paste box parses input as `.env`-style
  `KEY=value` lines, so pasting a pretty-printed (multi-line) JSON blob into
  it fails with "Use KEY=value format." The fix is to minify the JSON to a
  single line first. But don't then paste `GOOGLE_SERVICE_ACCOUNT_KEY_JSON=
  {...}` as the *value* in a field where the key name is already entered
  separately — that happened once (2026-09-08) and left the stored value
  literally starting with `GOOGLE_SERVICE_ACCOUNT_KEY_JSON={...}`, which
  still fails `JSON.parse()`. The value field should contain only the bare
  `{...}` JSON — no variable name, no `=`. As of 2026-09-08, both
  `upload_to_drive.js` and `download_from_drive.js` defensively strip that
  exact `GOOGLE_SERVICE_ACCOUNT_KEY_JSON=` prefix from the env var value if
  present, before parsing — so this specific misconfiguration no longer
  breaks either script even if the env var itself is still set wrong. That's
  a code-level mitigation, not a fix to the underlying env var — if you're
  ever setting it fresh, still follow the "bare JSON only" rule above.
- No Supabase API credential exists in this project — all Supabase access
  (interactive sessions and the scheduled routine) goes through the Supabase
  MCP connector, which can read and write `insta_stories` directly.

## Cloud environment gotcha: default network egress blocks Instagram's CDN
The "Default" cloud environment's outbound network policy only allowlists a
small set of hosts (package registries, api.anthropic.com, etc.) by default.
Instagram's image CDN (`*.fbcdn.net`, `*.cdninstagram.com`) isn't on it, so
`curl` downloads of `insta_story_image_url` fail at the egress proxy with a
403 `connect_rejected` (policy denial) — confirmed via
`cat /root/.ccr/README.md` and `curl "$HTTPS_PROXY/__agentproxy/status"`
inside a routine run. This is a distinct failure from the credential gotcha
above and looks nothing like it in the error (curl exit 000 / silent
failure, not a JSON parse error). Fix is the same shape as the credential
fix: add those hosts to the environment's egress allowlist in claude.ai/code
environment settings — no tool/API exposes this from an interactive session,
it has to be done manually in the browser.

## Scheduled routine: "insta_stories Drive Uploader"
A Claude Code cloud routine (id `trig_01LH7zt2K5iXRXeyj1Dfjpb8`) automates the
whole pipeline: find `insta_stories` rows with `status IS NULL` (via the
Supabase MCP connector), download each `insta_story_image_url`, upload via
`node upload_to_drive.js env <file>`, and set `status = 'processed'` only
after a confirmed successful upload — failures leave a row's status NULL so
it's retried on the next run. Cron `0 4 * * *` UTC (12:00 PM Philippines time
daily). Cloud routines get a fresh git clone of this repo each run with
no local files or env vars from this machine — `node_modules` isn't checked
out (gitignored), so the routine's prompt runs `npm install` first.
Its `mcp_connections` were deliberately trimmed to Supabase only; routine
creation via the API defaults to attaching every connected MCP connector on
the account if not restricted, which is more access than the job needs.

As of 2026-09-08 this routine is **enabled** (no longer paused) and also
configured as an **API trigger**: it has a generated API token, and can be
fired on demand with `POST
https://api.anthropic.com/v1/claude_code/routines/trig_01LH7zt2K5iXRXeyj1Dfjpb8/fire`
(header `Authorization: Bearer <token>`, plus `anthropic-version` and
`anthropic-beta` headers — see the n8n workflow's "HTTP Request1" node for a
working example). Both the cron schedule and this direct API trigger are
active at the same time; the n8n workflow above calls it via this endpoint
chained right after a fresh scrape completes (its old separate standalone
daily-fire schedule in n8n, "Schedule Trigger2", has since been removed as
redundant — see the n8n workflow section below).

**Known issue, now mitigated at the code level (2026-09-08):**
`GOOGLE_SERVICE_ACCOUNT_KEY_JSON`'s value on the cloud environment has
previously had the literal prefix `GOOGLE_SERVICE_ACCOUNT_KEY_JSON=` baked
into it (see the credentials gotcha above). `upload_to_drive.js` now strips
that prefix defensively before parsing, so this no longer breaks uploads
even if the env var itself is still set wrong — but the env var's actual
value in claude.ai/code environment settings hasn't been independently
re-verified since.

## Second routine: "scraped_insta_stories_analyzer"
A second cloud routine (id `trig_01QdunLBvdnu7ZK5zmYb6g35`) automates the
"read the story image for booking clues" step that used to be manual (see the
Instagram Story Scraper user guide doc). It finds `insta_stories` rows with
`status = 'processed'` AND `description IS NULL` (via Supabase MCP), locates
that row's already-uploaded image in the Drive folder by matching the
`<Speaker> - story <id> - <date>.jpg` naming convention (via the Google Drive
MCP connector's `search_files`, which also supplies `contentSnippet` — Drive's
own OCR text + Vision-API labels — and each file's `viewUrl`), downloads it
with `download_from_drive.js` (see the download gotcha above — **not** the
Drive MCP connector's `download_file_content`, which caused multi-minute
stalls), views it with `Read`, and fills in `description`, `org`,
`event_name`, `poc`, `poc_email`, `poc_position`, and `saved_img_link`
(the file's `viewUrl`) — leaving `description` NULL on failure so the row
retries next run, same success-gates-the-write pattern as the uploader
routine. `saved_img_link` is set whenever a Drive file is found for the row,
regardless of whether the image could be viewed directly or only analyzed
via text. It never touches `insta_story_image_url`/the Instagram CDN, so the
egress gotcha above doesn't apply to it.

Unlike the uploader routine, this one attaches **two** MCP connectors
(Supabase + Google Drive, both trimmed from the account's full connector
list) and allows `Bash` + `Read` (Read for viewing the downloaded image).

As of 2026-09-08 this routine is **enabled** as a **pure API trigger** (no
`cron_expression` at all — the `RemoteTrigger` create API has no field for
generating an API trigger token or for omitting a schedule entirely, so it
was first created with an inert placeholder cron and `enabled: false`, then
switched to this via a manual step in claude.ai/code UI, same as the
uploader routine's token). It has a generated API token and can be fired
with `POST
https://api.anthropic.com/v1/claude_code/routines/trig_01QdunLBvdnu7ZK5zmYb6g35/fire`
(same Bearer-auth pattern as the uploader). The n8n workflow below calls it
on its own daily schedule ("Schedule Trigger3", 20:00 — 30 minutes after the
scrape-and-upload chain, to give uploads time to land in Drive first).
Verified working end-to-end via manual test runs on 2026-09-08.
