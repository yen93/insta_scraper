const fs = require('fs');
const { google } = require('googleapis');

// Credential source: pass "env" as the first arg to read the service account
// key JSON from GOOGLE_SERVICE_ACCOUNT_KEY_JSON (used by scheduled cloud
// routines, which have no local key file), or pass a file path to use a key
// file directly (used for local/manual runs).
const keyArg = process.argv[2];
if (!keyArg) {
  console.error('Usage: node download_from_drive.js <env|path-to-service-account-key.json> <fileId1> <outputPath1> [<fileId2> <outputPath2> ...]');
  process.exit(1);
}

const pairArgs = process.argv.slice(3);
if (pairArgs.length === 0 || pairArgs.length % 2 !== 0) {
  console.error('Provide fileId/outputPath pairs (an even number of args after the key arg).');
  process.exit(1);
}

const downloads = [];
for (let i = 0; i < pairArgs.length; i += 2) {
  downloads.push({ fileId: pairArgs[i], outputPath: pairArgs[i + 1] });
}

async function main() {
  const authOptions = { scopes: ['https://www.googleapis.com/auth/drive.readonly'] };
  if (keyArg === 'env') {
    let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
    if (!raw) {
      console.error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not set.');
      process.exit(1);
    }
    // Defensive: the env var has previously been set to "GOOGLE_SERVICE_ACCOUNT_KEY_JSON=<json>"
    // (the whole KEY=value line pasted into the value field) instead of just the bare JSON.
    const prefix = 'GOOGLE_SERVICE_ACCOUNT_KEY_JSON=';
    if (raw.startsWith(prefix)) raw = raw.slice(prefix.length);
    authOptions.credentials = JSON.parse(raw);
  } else {
    authOptions.keyFile = keyArg;
  }
  const auth = new google.auth.GoogleAuth(authOptions);
  const drive = google.drive({ version: 'v3', auth });

  for (const { fileId, outputPath } of downloads) {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(outputPath);
      res.data.on('error', reject);
      dest.on('error', reject);
      dest.on('finish', resolve);
      res.data.pipe(dest);
    });
    const { size } = fs.statSync(outputPath);
    console.log(`Downloaded ${fileId} -> ${outputPath} (${size} bytes)`);
  }
}

main().catch((err) => {
  console.error('Download failed:', err.message || err);
  process.exit(1);
});
