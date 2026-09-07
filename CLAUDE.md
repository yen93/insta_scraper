# CLAUDE.md

## What this project is
A tool for pulling Instagram story images referenced in the Supabase table
`public.insta_stories` (project "MAGTestProject", id `aivitcomiywiysrfwqxt`)
and saving them into a Google Drive folder ("Instagram Story Scraper",
id `1lYvSd_IpE_wL1T0clJpxt0AC6rbRvbiy`). The `insta_stories` table is populated
by an external scraping process not part of this directory.

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
- No Supabase API credential exists in this project — all Supabase access
  (interactive sessions and the scheduled routine) goes through the Supabase
  MCP connector, which can read and write `insta_stories` directly.

## Scheduled routine: "insta_stories Drive Uploader"
A Claude Code cloud routine (id `trig_01LH7zt2K5iXRXeyj1Dfjpb8`) automates the
whole pipeline: find `insta_stories` rows with `status IS NULL` (via the
Supabase MCP connector), download each `insta_story_image_url`, upload via
`node upload_to_drive.js env <file>`, and set `status = 'processed'` only
after a confirmed successful upload — failures leave a row's status NULL so
it's retried on the next run. Cron `0 4 * * *` UTC (12:00 PM Philippines time
daily). **Currently paused** (`enabled: false`) — do not enable it until
`GOOGLE_SERVICE_ACCOUNT_KEY_JSON` is confirmed set correctly on the cloud
environment. Cloud routines get a fresh git clone of this repo each run with
no local files or env vars from this machine — `node_modules` isn't checked
out (gitignored), so the routine's prompt runs `npm install` first.
Its `mcp_connections` were deliberately trimmed to Supabase only; routine
creation via the API defaults to attaching every connected MCP connector on
the account if not restricted, which is more access than the job needs.
