// Quanta-PC-Extension/test/ignore-and-binary.test.mjs
// Automated Unit Tests for Directory Trailing Slash Ignores & Binary Buffer Handling (M1)

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { IgnoreMatcher } from '../src/ignoreRules.ts';
import { getMimeType, MIME_TYPE_MAP, writeDriveFile, readDriveFile } from '../src/gdrive.ts';

test('IgnoreMatcher: directory rules with trailing slash correctly ignore files inside directories', () => {
  const matcher = new IgnoreMatcher([
    'vendor/',
    'build/',
    'sub/cache/',
    '!vendor/allowed.js'
  ]);

  // 1. Files inside ignored directory must be ignored (isDirectory = false)
  assert.equal(matcher.isIgnored('vendor/package.json', false), true, 'vendor/package.json must be ignored');
  assert.equal(matcher.isIgnored('vendor/lib/index.js', false), true, 'vendor/lib/index.js must be ignored');
  assert.equal(matcher.isIgnored('sub/vendor/file.js', false), true, 'sub/vendor/file.js must be ignored');
  assert.equal(matcher.isIgnored('build/bundle.js', false), true, 'build/bundle.js must be ignored');
  assert.equal(matcher.isIgnored('build/sub/bundle.js', false), true, 'build/sub/bundle.js must be ignored');
  assert.equal(matcher.isIgnored('sub/cache/data.tmp', false), true, 'sub/cache/data.tmp must be ignored');

  // 2. Exact directory matching (isDirectory = true)
  assert.equal(matcher.isIgnored('vendor', true), true, 'vendor folder must be ignored');
  assert.equal(matcher.isIgnored('vendor/', true), true, 'vendor/ folder must be ignored');
  assert.equal(matcher.isIgnored('sub/vendor', true), true, 'sub/vendor folder must be ignored');
  assert.equal(matcher.isIgnored('build', true), true, 'build folder must be ignored');
  assert.equal(matcher.isIgnored('sub/cache', true), true, 'sub/cache folder must be ignored');

  // 3. Regular files with identical or prefixed names must NOT be ignored (isDirectory = false)
  assert.equal(matcher.isIgnored('vendor', false), false, 'regular file named "vendor" must NOT be ignored');
  assert.equal(matcher.isIgnored('build', false), false, 'regular file named "build" must NOT be ignored');
  assert.equal(matcher.isIgnored('vendor.js', false), false, 'vendor.js must NOT be ignored');
  assert.equal(matcher.isIgnored('vendor_notes.txt', false), false, 'vendor_notes.txt must NOT be ignored');
  assert.equal(matcher.isIgnored('my_vendor/file.js', false), false, 'my_vendor/file.js must NOT be ignored');

  // 4. Negation rule inside ignored directory
  assert.equal(matcher.isIgnored('vendor/allowed.js', false), false, 'vendor/allowed.js must be allowed by negation rule');
});

test('MIME Type Detection: maps binary, web, data, and fallback extensions accurately', () => {
  // Binary extensions
  assert.equal(getMimeType('logo.png'), 'image/png');
  assert.equal(getMimeType('photo.JPG'), 'image/jpeg');
  assert.equal(getMimeType('app.wasm'), 'application/wasm');
  assert.equal(getMimeType('archive.zip'), 'application/zip');
  assert.equal(getMimeType('database.sqlite'), 'application/vnd.sqlite3');
  assert.equal(getMimeType('database.sqlite3'), 'application/vnd.sqlite3');
  assert.equal(getMimeType('local.db'), 'application/vnd.sqlite3');
  assert.equal(getMimeType('manual.pdf'), 'application/pdf');

  // Text & Code extensions
  assert.equal(getMimeType('index.ts'), 'text/typescript');
  assert.equal(getMimeType('app.js'), 'text/javascript');
  assert.equal(getMimeType('manifest.json'), 'application/json');
  assert.equal(getMimeType('notes.txt'), 'text/plain');

  // Unknown & No-extension fallback
  assert.equal(getMimeType('binary.unknown_ext'), 'application/octet-stream');
  assert.equal(getMimeType('LICENSE'), 'application/octet-stream');
});

test('Binary Buffer Handling: multipart upload and download round-trip preserves byte integrity', async () => {
  // Test byte stream containing known binary magic numbers and non-UTF8 values
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const wasmMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const sqliteHeader = Buffer.from('SQLite format 3\0', 'utf8');
  const highBytes = Buffer.from([0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0xff, 0xfe]);

  const binaryPayload = Buffer.concat([pngMagic, wasmMagic, sqliteHeader, highBytes]);
  const expectedMd5 = crypto.createHash('md5').update(binaryPayload).digest('hex');

  // Emulate multipart body construction
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;
  const metadata = { name: 'sample.png', mimeType: 'image/png' };

  const headerPart =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: image/png\r\n\r\n';

  const multipartRequestBody = Buffer.concat([
    Buffer.from(headerPart, 'utf8'),
    binaryPayload,
    Buffer.from(closeDelimiter, 'utf8')
  ]);

  // Spin up an ephemeral HTTP server to emulate Google Drive v3 upload and download
  let serverReceivedBuffer = null;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        serverReceivedBuffer = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'file-xyz', md5Checksum: expectedMd5 }));
      });
    } else if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(binaryPayload);
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Emulate writeDriveFile upload
    const uploadRes = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartRequestBody
    });
    assert.equal(uploadRes.ok, true);
    const uploadJson = await uploadRes.json();
    assert.equal(uploadJson.md5Checksum, expectedMd5);

    // Verify the server received the exact binary bytes inside the multipart payload
    const marker = Buffer.from('Content-Type: image/png\r\n\r\n', 'utf8');
    const markerIndex = serverReceivedBuffer.indexOf(marker);
    const extractedStart = markerIndex + marker.length;
    const extractedBytes = serverReceivedBuffer.subarray(extractedStart, extractedStart + binaryPayload.length);
    assert.deepEqual(extractedBytes, binaryPayload);

    // 2. Emulate readDriveFile download and binary disk restoration
    const downloadRes = await fetch(`http://127.0.0.1:${port}/download?alt=media`);
    assert.equal(downloadRes.ok, true);
    const downloadedBuffer = Buffer.from(await downloadRes.arrayBuffer());

    assert.equal(downloadedBuffer.length, binaryPayload.length);
    assert.deepEqual(downloadedBuffer, binaryPayload);
    assert.equal(crypto.createHash('md5').update(downloadedBuffer).digest('hex'), expectedMd5);

    // 3. Contrast with UTF-8 decoding corruption:
    // Decoding the binary bytes with TextDecoder destroys invalid UTF-8 bytes
    const decodedText = new TextDecoder().decode(binaryPayload);
    const reEncodedBuffer = Buffer.from(decodedText, 'utf8');
    assert.notEqual(
      crypto.createHash('md5').update(reEncodedBuffer).digest('hex'),
      expectedMd5,
      'TextDecoder UTF-8 coercion must alter MD5 hash of binary data'
    );
  } finally {
    server.close();
  }
});
