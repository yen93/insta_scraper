# CLAUDE.md

## What this project is
A tool for pulling Instagram story images referenced in the Supabase table
`public.insta_stories` (project "MAGTestProject", id `aivitcomiywiysrfwqxt`)
and saving them into a Google Drive folder ("Instagram Story Scraper",
id `1lYvSd_IpE_wL1T0clJpxt0AC6rbRvbiy`). The `insta_stories` table is populated
by an external n8n workflow, "Insta Outbound Sales Automations" (exported as
`n8n - Insta Outbound Sales Automations.json` in this repo — not run from
here, just kept for reference). That workflow: finds batches of speakers in
Supabase `speakers`, scrapes their current Instagram stories via an Apify
actor, inserts new rows into `insta_stories`, then fires this project's
scheduled routine (see below) to upload them to Drive. As of 2026-09-08 only
the "fire the routine" stage of that n8n workflow is actually scheduled — the
two upstream stages that populate new `insta_stories` rows are disabled, so
don't assume new rows will show up on their own; check n8n if none are
appearing. That workflow also has a known bug: one of its nodes hardcodes
`batch_no = 1` instead of using the current loop's batch.

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
  `{...}` JSON — no variable name, no `=`.
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
right after a fresh scrape, and again on its own schedule.

**Known unresolved issue (2026-09-08):** `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`'s
value on the cloud environment still has the literal prefix
`GOOGLE_SERVICE_ACCOUNT_KEY_JSON=` baked into it (see the credentials gotcha
above) — the routine only succeeded once by detecting this mid-run and
stripping the prefix in that session only, which is not a persisted fix. The
next run that finds real rows to upload will fail the same way the original
bug did, until the env var's value is corrected in claude.ai/code environment
settings to contain only the bare JSON.

## Second routine: "scraped_insta_stories_analyzer"
A second cloud routine (id `trig_01QdunLBvdnu7ZK5zmYb6g35`) automates the
"read the story image for booking clues" step that used to be manual (see the
Instagram Story Scraper user guide doc). It finds `insta_stories` rows with
`status = 'processed'` AND `description IS NULL` (via Supabase MCP), locates
that row's already-uploaded image in the Drive folder by matching the
`<Speaker> - story <id> - <date>.jpg` naming convention (via the Google Drive
MCP connector's `search_files`), downloads and actually views the image
(`download_file_content` + decode base64 to a local `.jpg` + `Read`), and
fills in `description`, `org`, `event_name`, `poc`, `poc_email`,
`poc_position` — leaving `description` NULL on failure so the row retries
next run, same success-gates-the-write pattern as the uploader routine.
It never touches `insta_story_image_url`/the Instagram CDN, so the egress
gotcha above doesn't apply to it.

Unlike the uploader routine, this one attaches **two** MCP connectors
(Supabase + Google Drive, both trimmed from the account's full connector
list) and allows `Bash` + `Read` (Read for viewing the decoded image).

**Created disabled, as an API-trigger-only routine — but the API token has
not been generated yet.** The `RemoteTrigger` create API has no field for
generating an API trigger token (the existing uploader routine's token was
generated by a manual step in claude.ai/code UI, per the chat history at
`chat_history/0809260959_chat_history.txt`) — it requires exactly one of
`cron_expression`/`run_once_at`, so it was created with an inert
`cron_expression` (`0 5 * * *`) and `enabled: false` so it never fires on its
own. Whoever wants to actually run this needs to either enable it and add an
API trigger via the routine's page at
`https://claude.ai/code/routines/trig_01QdunLBvdnu7ZK5zmYb6g35`, or fire it
manually from a Claude Code session via `RemoteTrigger action: "run"`. As of
creation, no run has ever been fired — all 11 existing rows are still
pending (`status='processed'` and `description IS NULL`) and will be
backfilled on its first run.
