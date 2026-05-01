const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

let s3Client;

function getClient() {
  if (s3Client) return s3Client;
  const config = global.appConfig;
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.CLOUDFLARE_ACCESS_KEY_ID,
      secretAccessKey: config.CLOUDFLARE_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch metadata JSON from R2 with local file cache (24h TTL).
 * key: "metadata/products.json" or "metadata/documents.json"
 */
async function fetchMetadata(key) {
  const cacheFile = path.join(global.dataDir, key.replace(/\//g, '_'));

  // Check cache
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    if (ageHours < 24) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    }
  }

  // Fetch from R2
  const client = getClient();
  const response = await client.send(new GetObjectCommand({
    Bucket: global.appConfig.R2_BUCKET,
    Key: key,
  }));

  const body = await streamToBuffer(response.Body);
  const text = body.toString('utf-8');

  // Cache locally
  fs.writeFileSync(cacheFile, text, 'utf-8');

  return JSON.parse(text);
}

/**
 * Fetch a document (PDF) from R2 as a Buffer. No caching.
 */
async function fetchDocumentBuffer(r2Key) {
  const client = getClient();
  const response = await client.send(new GetObjectCommand({
    Bucket: global.appConfig.R2_BUCKET,
    Key: r2Key,
  }));
  return streamToBuffer(response.Body);
}

/**
 * Fetch any URL as a Buffer. Used for documents hosted outside R2 — e.g.
 * Soprema PDS files on my.assets-library.com. The fetchDocumentBuffer
 * function above only works for keys that genuinely live in R2; PDS files
 * don't, so the bundle export uses this URL-based helper.
 */
async function fetchUrlBuffer(url) {
  if (!url) throw new Error('fetchUrlBuffer: url is required');
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetchUrlBuffer: HTTP ' + res.status + ' fetching ' + url);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

module.exports = { fetchMetadata, fetchDocumentBuffer, fetchUrlBuffer };
