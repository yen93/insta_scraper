const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DRIVE_FOLDER_ID = '1lYvSd_IpE_wL1T0clJpxt0AC6rbRvbiy';

// Credential source: pass "env" as the first arg to read the service account
// key JSON from GOOGLE_SERVICE_ACCOUNT_KEY_JSON (used by the scheduled cloud
// routine, which has no local key file), or pass a file path to use a key
// file directly (used for local/manual runs).
const keyArg = process.argv[2];
if (!keyArg) {
  console.error('Usage: node upload_to_drive.js <env|path-to-service-account-key.json> <image1> [image2 ...]');
  process.exit(1);
}

const files = process.argv.slice(3);
if (files.length === 0) {
  console.error('No image files given to upload.');
  process.exit(1);
}

async function main() {
  const authOptions = { scopes: ['https://www.googleapis.com/auth/drive'] };
  if (keyArg === 'env') {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
    if (!raw) {
      console.error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not set.');
      process.exit(1);
    }
    authOptions.credentials = JSON.parse(raw);
  } else {
    authOptions.keyFile = keyArg;
  }
  const auth = new google.auth.GoogleAuth(authOptions);
  const drive = google.drive({ version: 'v3', auth });

  for (const filePath of files) {
    const name = path.basename(filePath);
    const res = await drive.files.create({
      requestBody: {
        name,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: 'image/jpeg',
        body: fs.createReadStream(filePath),
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });
    console.log(`Uploaded ${name} -> ${res.data.webViewLink}`);
  }
}

main().catch((err) => {
  console.error('Upload failed:', err.message || err);
  process.exit(1);
});
