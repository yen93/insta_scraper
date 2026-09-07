const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DRIVE_FOLDER_ID = '1lYvSd_IpE_wL1T0clJpxt0AC6rbRvbiy';

const keyFile = process.argv[2];
if (!keyFile) {
  console.error('Usage: node upload_to_drive.js <path-to-service-account-key.json> <image1> [image2 ...]');
  process.exit(1);
}

const files = process.argv.slice(3);
if (files.length === 0) {
  console.error('No image files given to upload.');
  process.exit(1);
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
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
