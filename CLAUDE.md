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
node upload_to_drive.js <path-to-service-account-key.json> <image1> [image2 ...]
```
- The service account's `client_email` must be shared on the target Drive
  folder with at least Editor access, or uploads fail with "File not found".
- The folder ID is hardcoded in `upload_to_drive.js` as `DRIVE_FOLDER_ID`.

## Credentials
- `service_account_json_key_claudegwscli-502400-3a7969b176ed.json.json` in the
  project root is a live Google Cloud service account key. **Never commit
  this file.** Add it (and any other `*service_account*.json` / `*.json.json`
  key files) to `.gitignore` before this project is pushed anywhere.
- No Supabase credentials exist in this project yet — table access so far has
  only gone through the Supabase MCP connection inside Claude Code sessions,
  not a standalone script.

## Not yet built
- No script reads `insta_stories` directly from Supabase and feeds URLs into
  the uploader automatically — the one run so far was manual (download each
  image, rename, then call `upload_to_drive.js`). If this needs to become a
  recurring/automated pipeline, it will need Supabase credentials wired in and
  the download+rename steps scripted too.
