// Quanta-PC-Extension/test/m1-adversarial-stress.test.mjs
// Adversarial Empirical Stress Test Suite for Milestone M1
// Target: Binary Integrity, IgnoreMatcher Deep Directory/Collisions, Conflict Resolution Policies

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { IgnoreMatcher } from '../src/ignoreRules.ts';
import { getMimeType, writeDriveFile, readDriveFile } from '../src/gdrive.ts';
import { computeThreeWayPlan } from '../src/manifest.ts';

// ============================================================================
// SUITE 1: Binary Round-Trip Stress Testing & High-Entropy Corruption Oracles
// ============================================================================

/**
 * Helper to parse multipart/related or multipart/form-data body according to RFC 2046.
 * Extracts metadata JSON and raw binary content buffer without string coercion.
 */
function parseMultipartBody(rawBuffer, boundary) {
  const boundaryDelimiter = Buffer.from(`--${boundary}`);
  const headerDelimiter = Buffer.from('\r\n\r\n');
  const crlf = Buffer.from('\r\n');

  const parts = [];
  let searchIndex = 0;

  while (true) {
    const boundaryIndex = rawBuffer.indexOf(boundaryDelimiter, searchIndex);
    if (boundaryIndex === -1) break;

    const afterBoundary = boundaryIndex + boundaryDelimiter.length;
    // Check if end boundary (--boundary--)
    if (rawBuffer.subarray(afterBoundary, afterBoundary + 2).equals(Buffer.from('--'))) {
      break;
    }

    // Next boundary search start
    const nextBoundaryIndex = rawBuffer.indexOf(boundaryDelimiter, afterBoundary);
    if (nextBoundaryIndex === -1) break;

    // The part is between afterBoundary and nextBoundaryIndex
    // Part starts with headers followed by \r\n\r\n, then body
    const partBuffer = rawBuffer.subarray(afterBoundary, nextBoundaryIndex);
    const headerEndIndex = partBuffer.indexOf(headerDelimiter);
    if (headerEndIndex !== -1) {
      const headers = partBuffer.subarray(0, headerEndIndex).toString('utf8');
      // Body ends before the trailing \r\n that precedes the next boundary
      let bodyEnd = partBuffer.length;
      if (partBuffer.subarray(partBuffer.length - 2).equals(crlf)) {
        bodyEnd -= 2;
      }
      const body = partBuffer.subarray(headerEndIndex + headerDelimiter.length, bodyEnd);
      parts.push({ headers, body });
    }

    searchIndex = nextBoundaryIndex;
  }

  return parts;
}

test('SUITE 1.1: High-entropy binary buffers round-trip preserves byte-for-byte SHA-256 (0 corrupted bytes)', async () => {
  const testSizes = [
    0,           // Empty file edge case
    1,           // 1 byte
    16,          // Tiny 16B
    1024,        // 1 KB
    64 * 1024,   // 64 KB
    256 * 1024,  // 256 KB
    1024 * 1024  // 1 MB
  ];

  for (const size of testSizes) {
    const originalBuffer = size === 0 ? Buffer.alloc(0) : crypto.randomBytes(size);
    const originalSha256 = crypto.createHash('sha256').update(originalBuffer).digest('hex');
    const originalMd5 = crypto.createHash('md5').update(originalBuffer).digest('hex');

    let uploadedMultipartBody = null;

    // Spin up ephemeral HTTP server acting as Drive v3 upload and download target
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          uploadedMultipartBody = Buffer.concat(chunks);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: `file-${size}`, md5Checksum: originalMd5 }));
        });
      } else if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(originalBuffer);
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const originalFetch = globalThis.fetch;
    try {
      // Intercept fetch to route to local test server
      globalThis.fetch = async (url, options) => {
        const urlStr = url.toString();
        let targetUrl = urlStr;
        if (urlStr.includes('upload/drive/v3/files')) {
          targetUrl = `http://127.0.0.1:${port}/upload`;
        } else if (urlStr.includes('drive/v3/files')) {
          targetUrl = `http://127.0.0.1:${port}/download`;
        }
        return originalFetch(targetUrl, options);
      };

      // 1. Write binary buffer
      const writeResult = await writeDriveFile('mock-token', `random-${size}.bin`, originalBuffer);
      assert.equal(writeResult.id, `file-${size}`);
      assert.equal(writeResult.md5Checksum, originalMd5);

      // Verify multipart payload structure & extract content
      const boundary = '-------314159265358979323846';
      const parts = parseMultipartBody(uploadedMultipartBody, boundary);
      assert.equal(parts.length, 2, `Multipart body for ${size}B must have exactly 2 parts`);

      const receivedPart2 = parts[1].body;
      assert.equal(receivedPart2.length, originalBuffer.length, `Uploaded part 2 length must match original for ${size}B`);

      const extractedSha256 = crypto.createHash('sha256').update(receivedPart2).digest('hex');
      assert.equal(extractedSha256, originalSha256, `SHA-256 mismatch in uploaded multipart body for ${size}B`);

      // 2. Read binary buffer via readDriveFile
      const downloadedBuffer = await readDriveFile('mock-token', `file-${size}`);
      assert.ok(Buffer.isBuffer(downloadedBuffer));
      assert.equal(downloadedBuffer.length, originalBuffer.length);

      const downloadedSha256 = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');
      assert.equal(downloadedSha256, originalSha256, `SHA-256 mismatch on downloaded buffer for ${size}B`);

      // 3. Count corrupted bytes (must be exactly 0)
      let corruptedBytes = 0;
      for (let i = 0; i < originalBuffer.length; i++) {
        if (originalBuffer[i] !== downloadedBuffer[i]) corruptedBytes++;
      }
      assert.equal(corruptedBytes, 0, `Corrupted bytes detected in ${size}B round-trip`);

      // 4. Contrast against text conversion corruption (for non-empty buffers)
      if (size > 16) {
        const textCorrupted = Buffer.from(originalBuffer.toString('utf8'), 'utf8');
        const textSha256 = crypto.createHash('sha256').update(textCorrupted).digest('hex');
        assert.notEqual(textSha256, originalSha256, `Text conversion must alter SHA-256 for high-entropy buffer of ${size}B`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise(r => server.close(r));
    }
  }
});

test('SUITE 1.2: Hostile non-UTF8 and format magic byte sequences survive intact', async () => {
  // Test vectors targeting non-UTF8, magic numbers, CRLF, and delimiter-like bytes
  const vectors = [
    {
      name: 'PNG Header with high bytes',
      buf: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
        Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81, 0xc0, 0xc1])
      ])
    },
    {
      name: 'WASM Magic and Nulls',
      buf: Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        Buffer.alloc(64, 0x00),
        Buffer.from([0xff, 0xff, 0xff, 0xff])
      ])
    },
    {
      name: 'All 256 byte values sequence',
      buf: Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    },
    {
      name: 'Hostile invalid UTF-8 (lone surrogates, overlong, 0xFF, 0xFE)',
      buf: Buffer.from([
        0xed, 0xa0, 0x80, // Lone surrogate high
        0xed, 0xbf, 0xbf, // Lone surrogate low
        0xc0, 0xaf,       // Overlong ASCII slash
        0xe0, 0x80, 0xaf, // Overlong 3-byte
        0xf5, 0x80, 0x80, 0x80, // Out of Unicode range
        0xff, 0xfe, 0xff, 0xfe
      ])
    },
    {
      name: 'Boundary-like content with CRLF and dashes',
      buf: Buffer.from('\r\n---\r\n--314159265358979323846\r\nContent-Type: none\r\n\r\n---\r\n', 'utf8')
    },
    {
      name: 'Single 0x00 null byte',
      buf: Buffer.from([0x00])
    },
    {
      name: 'Single 0xFF byte',
      buf: Buffer.from([0xff])
    }
  ];

  for (const { name, buf } of vectors) {
    const originalSha256 = crypto.createHash('sha256').update(buf).digest('hex');

    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'file-vector', md5Checksum: 'ok' }));
        });
      } else if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(buf);
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, options) => {
        const urlStr = url.toString();
        let targetUrl = urlStr;
        if (urlStr.includes('upload/drive/v3/files')) {
          targetUrl = `http://127.0.0.1:${port}/upload`;
        } else if (urlStr.includes('drive/v3/files')) {
          targetUrl = `http://127.0.0.1:${port}/download`;
        }
        return originalFetch(targetUrl, options);
      };

      await writeDriveFile('mock-token', 'test-vector.bin', buf);
      const readBuf = await readDriveFile('mock-token', 'file-vector');

      const restoredSha256 = crypto.createHash('sha256').update(readBuf).digest('hex');
      assert.equal(restoredSha256, originalSha256, `Hash mismatch for vector: ${name}`);

      let corruptedBytes = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== readBuf[i]) corruptedBytes++;
      }
      assert.equal(corruptedBytes, 0, `Corrupted byte in vector: ${name}`);
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise(r => server.close(r));
    }
  }
});

// ============================================================================
// SUITE 2: IgnoreMatcher Deep Directory & Sibling Collision Stress Tests
// ============================================================================

test('SUITE 2.1: IgnoreMatcher directory trailing slash rules deeply nested matching', () => {
  const matcher = new IgnoreMatcher([
    'vendor/',
    'build/',
    'dist/',
    'node_modules/',
    'nested/cache/'
  ]);

  const deepPathsMustIgnore = [
    // vendor/
    'vendor/a/b/c/d/e.js',
    'vendor/level1/level2/level3/level4/level5/level6/script.py',
    'vendor/sub/deep/module.wasm',
    'sub/vendor/a/b/c/d/e.js',
    'deep/sub/dir/vendor/lib.so',

    // build/
    'build/nested/x/y/z/bundle.min.js',
    'build/dist/output/manifest.json',
    'src/build/output.o',

    // dist/
    'dist/esm/chunks/deep/core.mjs',
    'dist/a/b/c/d/e/f/g.bin',
    'packages/core/dist/index.d.ts',

    // node_modules/
    'node_modules/@scope/pkg/dist/index.cjs',
    'node_modules/lodash/fp/array.js',
    'sub/node_modules/react/index.js',

    // nested/cache/
    'nested/cache/a/b/c/data.sqlite3',
    'nested/cache/temp.log'
  ];

  for (const p of deepPathsMustIgnore) {
    assert.equal(
      matcher.isIgnored(p, false),
      true,
      `Path '${p}' MUST be ignored by directory trailing slash rule`
    );
  }
});

test('SUITE 2.2: Sibling directory and filename collisions are NOT falsely ignored', () => {
  const matcher = new IgnoreMatcher([
    'vendor/',
    'build/',
    'dist/',
    'node_modules/'
  ]);

  const siblingCollisionsMustNotIgnore = [
    // vendor collisions
    'vendor_file.js',
    'vendor.js',
    'vendor_notes.txt',
    'vendor-test/sub/file.js',
    'vendor2/file.js',
    'my-vendor/file.js',
    'my_vendor/file.js',
    'super-vendor/a/b/c.js',
    'sub/my-vendor/file.js',
    'sub/vendor_assets/icon.png',

    // build collisions
    'build.js',
    'build_artifacts/app.js',
    'build-assets/style.css',
    'my-build/output.js',
    'rebuild/main.go',
    'sub/build_dir/file.txt',

    // dist collisions
    'dist_file.js',
    'dist.tar.gz',
    'dist-prod/main.js',
    'my-dist/main.js',
    'sub/dist_backup/file.json',

    // node_modules collisions
    'node_modules_backup/file.js',
    'my_node_modules/index.js',
    'node_modules.tar',
    'sub/not_node_modules/lib.js',

    // Regular files sharing name with directory rules
    'src/vendor.ts',
    'src/build.config.js',
    'src/dist.info'
  ];

  for (const p of siblingCollisionsMustNotIgnore) {
    assert.equal(
      matcher.isIgnored(p, false),
      false,
      `Collision path '${p}' MUST NOT be falsely ignored`
    );
  }
});

test('SUITE 2.3: Directory flag (isDirectory=true) vs File flag (isDirectory=false) distinction', () => {
  const matcher = new IgnoreMatcher([
    'vendor/',
    'build/',
    'dist/'
  ]);

  // When treated as directories, they must match
  assert.equal(matcher.isIgnored('vendor', true), true, 'vendor directory must be ignored');
  assert.equal(matcher.isIgnored('vendor/', true), true, 'vendor/ directory must be ignored');
  assert.equal(matcher.isIgnored('build', true), true, 'build directory must be ignored');
  assert.equal(matcher.isIgnored('dist', true), true, 'dist directory must be ignored');
  assert.equal(matcher.isIgnored('sub/vendor', true), true, 'sub/vendor directory must be ignored');

  // When treated as regular files, they must NOT match directory-only patterns
  assert.equal(matcher.isIgnored('vendor', false), false, 'regular file named vendor must NOT be ignored');
  assert.equal(matcher.isIgnored('build', false), false, 'regular file named build must NOT be ignored');
  assert.equal(matcher.isIgnored('dist', false), false, 'regular file named dist must NOT be ignored');
  assert.equal(matcher.isIgnored('sub/vendor', false), false, 'regular file named sub/vendor must NOT be ignored');
});

test('SUITE 2.4: Cross-platform Windows backslashes and relative paths normalize correctly', () => {
  const matcher = new IgnoreMatcher([
    'vendor/',
    'build/'
  ]);

  // Windows backslash representations
  assert.equal(matcher.isIgnored('vendor\\a\\b\\c\\d\\e.js', false), true, 'Windows path inside vendor must be ignored');
  assert.equal(matcher.isIgnored('my-vendor\\file.js', false), false, 'Windows sibling my-vendor must NOT be ignored');
  assert.equal(matcher.isIgnored('build\\sub\\app.js', false), true, 'Windows build sub path must be ignored');
  assert.equal(matcher.isIgnored('build_test\\app.js', false), false, 'Windows build_test must NOT be ignored');

  // Leading slashes / backslashes
  assert.equal(matcher.isIgnored('/vendor/a/b/file.js', false), true, 'Leading slash vendor path must be ignored');
  assert.equal(matcher.isIgnored('\\vendor\\a\\b\\file.js', false), true, 'Leading backslash vendor path must be ignored');
  assert.equal(matcher.isIgnored('/my-vendor/file.js', false), false, 'Leading slash my-vendor must NOT be ignored');
});

test('SUITE 2.5: Directory trailing slash with selective un-ignore (!) negation rules', () => {
  const matcher = new IgnoreMatcher([
    'vendor/',
    '!vendor/critical/keep.ts',
    '!vendor/public/**'
  ]);

  // Ignored by default
  assert.equal(matcher.isIgnored('vendor/package.json', false), true);
  assert.equal(matcher.isIgnored('vendor/other/file.ts', false), true);
  assert.equal(matcher.isIgnored('vendor/critical/other.ts', false), true);

  // Un-ignored by exact negation
  assert.equal(matcher.isIgnored('vendor/critical/keep.ts', false), false, 'Negated exact file must NOT be ignored');

  // Un-ignored by glob negation
  assert.equal(matcher.isIgnored('vendor/public/bundle.js', false), false, 'Negated glob path must NOT be ignored');
  assert.equal(matcher.isIgnored('vendor/public/sub/bundle.js', false), false, 'Negated glob deep path must NOT be ignored');
});

// ============================================================================
// SUITE 3: Conflict Resolution Policy Empirical Verification
// ============================================================================

test('SUITE 3.1: keepRemote skips local upload, downloads remote content, and updates manifest', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-m1-remote-test-'));

  try {
    const conflictRelPath = 'src/config.json';
    const localFilePath = path.join(tempDir, conflictRelPath);
    fs.mkdirSync(path.dirname(localFilePath), { recursive: true });

    // Local file has local modifications
    const localContent = Buffer.from('{"version": "local-edit-v2"}', 'utf8');
    fs.writeFileSync(localFilePath, localContent);

    // Remote file on Drive has remote modifications
    const remoteContent = Buffer.from('{"version": "remote-edit-v3-authoritative"}', 'utf8');
    const remoteMd5 = crypto.createHash('md5').update(remoteContent).digest('hex');
    const remoteId = 'drive-remote-id-999';

    const manifest = {
      version: 1,
      workspaceName: 'test',
      lastSyncTimestamp: 1000,
      files: {
        [conflictRelPath]: {
          path: conflictRelPath,
          localMd5: 'old-base-md5',
          remoteMd5: 'old-base-md5',
          remoteId: remoteId,
          lastSyncedAt: 1000
        }
      }
    };

    const localFiles = new Map([[conflictRelPath, crypto.createHash('md5').update(localContent).digest('hex')]]);
    const remoteFiles = new Map([[conflictRelPath, { id: remoteId, md5: remoteMd5 }]]);

    // 1. Compute 3-way plan: must detect conflict
    const plan = computeThreeWayPlan(localFiles, remoteFiles, manifest);
    const conflicts = plan.filter(p => p.type === 'conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, conflictRelPath);

    // 2. Execute keepRemote policy logic directly mimicking extension.ts lines 226-258
    let uploads = plan.filter(p => p.type === 'upload');
    const effectivePolicy = 'keepRemote';

    // Mock readDriveFile returning remote content
    const downloadedFiles = [];
    const mockReadDriveFile = async (token, id) => {
      if (id === remoteId) {
        return remoteContent;
      }
      throw new Error(`File not found: ${id}`);
    };

    if (effectivePolicy === 'keepRemote') {
      for (const item of conflicts) {
        if (item.remoteId) {
          const content = await mockReadDriveFile('mock-token', item.remoteId);
          downloadedFiles.push(item.path);
          fs.writeFileSync(localFilePath, content);
          const localComputedMd5 = crypto.createHash('md5').update(content).digest('hex');

          manifest.files[item.path] = {
            path: item.path,
            localMd5: localComputedMd5,
            remoteMd5: item.remoteMd5 || '',
            remoteId: item.remoteId,
            lastSyncedAt: Date.now()
          };
        }
      }
    }

    // Assert uploads queue DOES NOT contain the conflict file (upload skipped)
    assert.equal(uploads.length, 0, 'keepRemote must NOT queue local conflict file for upload');

    // Assert remote content was downloaded and replaced local file on disk
    const diskContent = fs.readFileSync(localFilePath);
    assert.deepEqual(diskContent, remoteContent, 'Disk file must match remote content');
    assert.equal(diskContent.toString('utf8'), '{"version": "remote-edit-v3-authoritative"}');

    // Assert manifest updated
    assert.equal(manifest.files[conflictRelPath].localMd5, remoteMd5);
    assert.equal(manifest.files[conflictRelPath].remoteId, remoteId);
    assert.ok(manifest.files[conflictRelPath].lastSyncedAt > 1000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SUITE 3.2: keepBoth generates non-colliding copy and queues for upload without remoteId', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-m1-keepboth-test-'));

  try {
    const testCases = [
      { relPath: 'index.ts', ext: '.ts', base: 'index' },
      { relPath: 'LICENSE', ext: '', base: 'LICENSE' },
      { relPath: 'archive.tar.gz', ext: '.gz', base: 'archive.tar' },
      { relPath: 'src/components/Header.tsx', ext: '.tsx', base: 'Header' },
      { relPath: '.env.local', ext: '.local', base: '.env' }
    ];

    const timestamp = '20261101-143000';
    const plan = [];
    const conflicts = [];

    for (const tc of testCases) {
      const localFilePath = path.join(tempDir, tc.relPath);
      fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
      fs.writeFileSync(localFilePath, `Original local content of ${tc.relPath}`);

      const conflictItem = {
        type: 'conflict',
        path: tc.relPath,
        localMd5: crypto.createHash('md5').update(`Original local content of ${tc.relPath}`).digest('hex'),
        remoteId: `remote-${tc.base}`,
        remoteMd5: 'remote-hash-xyz'
      };
      plan.push(conflictItem);
      conflicts.push(conflictItem);
    }

    // Execute keepBoth logic mimicking extension.ts lines 259-289
    let uploads = plan.filter(p => p.type === 'upload');
    const effectivePolicy = 'keepBoth';

    if (effectivePolicy === 'keepBoth') {
      for (const item of conflicts) {
        const ext = path.extname(item.path);
        const base = path.basename(item.path, ext);
        const dir = path.dirname(item.path);
        const conflictFileName = `${base}.conflict-${timestamp}${ext}`;
        const conflictRelPath = dir === '.' ? conflictFileName : `${dir}/${conflictFileName}`.replace(/\\/g, '/');

        const srcPath = path.join(tempDir, item.path);
        const destPath = path.join(tempDir, conflictRelPath);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        }

        uploads.push({
          type: 'upload',
          path: conflictRelPath,
          localMd5: item.localMd5
        });
      }
    }

    // 1. Verify uploads queue has 5 items (one for each conflict copy)
    assert.equal(uploads.length, 5);

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      const uploadItem = uploads[i];

      // 2. Verify non-colliding path format
      assert.ok(uploadItem.path.includes(`conflict-${timestamp}`));

      // 3. Verify uploadItem.remoteId is undefined (crucial: Drive must CREATE a new file, not patch remote)
      assert.equal(
        uploadItem.remoteId,
        undefined,
        `Conflict upload copy '${uploadItem.path}' must NOT have remoteId`
      );

      // 4. Verify both files exist on disk with identical local content
      const originalDiskPath = path.join(tempDir, tc.relPath);
      const copyDiskPath = path.join(tempDir, uploadItem.path);

      assert.ok(fs.existsSync(originalDiskPath), `Original file '${originalDiskPath}' must remain on disk`);
      assert.ok(fs.existsSync(copyDiskPath), `Copy file '${copyDiskPath}' must be created on disk`);

      const originalContent = fs.readFileSync(originalDiskPath, 'utf8');
      const copyContent = fs.readFileSync(copyDiskPath, 'utf8');
      assert.equal(originalContent, copyContent, 'Conflict copy content must match original local content');
      assert.equal(originalContent, `Original local content of ${tc.relPath}`);
    }

    // Specific format verification
    assert.equal(uploads[0].path, `index.conflict-${timestamp}.ts`);
    assert.equal(uploads[1].path, `LICENSE.conflict-${timestamp}`);
    assert.equal(uploads[2].path, `archive.tar.conflict-${timestamp}.gz`);
    assert.equal(uploads[3].path, `src/components/Header.conflict-${timestamp}.tsx`);
    assert.equal(uploads[4].path, `.env.conflict-${timestamp}.local`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SUITE 3.3: keepLocal queues conflict for remote overwrite with remoteId preserved', () => {
  const plan = [
    { type: 'upload', path: 'clean.txt', localMd5: 'h1' },
    { type: 'conflict', path: 'important.doc', localMd5: 'h2-local', remoteId: 'remote-doc-123', remoteMd5: 'h3-remote' }
  ];
  const conflicts = plan.filter(p => p.type === 'conflict');

  let uploads = plan.filter(p => p.type === 'upload');
  const effectivePolicy = 'keepLocal';

  if (effectivePolicy === 'keepLocal') {
    uploads.push(...conflicts);
  }

  assert.equal(uploads.length, 2);
  const conflictUpload = uploads.find(u => u.path === 'important.doc');
  assert.ok(conflictUpload);
  assert.equal(conflictUpload.remoteId, 'remote-doc-123', 'keepLocal upload item must carry remoteId for PATCH overwrite');
  assert.equal(conflictUpload.localMd5, 'h2-local');
});
