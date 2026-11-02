// Quanta-PC-Extension/test/gdrive.test.mjs
// Automated Unit Tests for Google Drive API v3 Hardening (M1)

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import {
  escapeDriveQueryTerm,
  findOrCreateFolder,
  listDriveFiles,
  listDriveFilesRecursive,
  readDriveFile,
  writeDriveFile,
  getMimeType,
  MIME_TYPE_MAP
} from '../src/gdrive.ts';

test('escapeDriveQueryTerm: correctly escapes single quotes and backslashes', () => {
  assert.equal(escapeDriveQueryTerm("John's Project"), "John\\'s Project");
  assert.equal(escapeDriveQueryTerm("C:\\Workspace\\Quanta"), "C:\\\\Workspace\\\\Quanta");
  assert.equal(escapeDriveQueryTerm("It's C:\\Path"), "It\\'s C:\\\\Path");
  assert.equal(escapeDriveQueryTerm("NormalName"), "NormalName");
  assert.equal(escapeDriveQueryTerm(""), "");
  // Injection attempt
  assert.equal(escapeDriveQueryTerm("' or '1'='1"), "\\' or \\'1\\'=\\'1");
});

test('findOrCreateFolder: applies query escaping and discovers existing folder', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedUrl = '';

  globalThis.fetch = async (url, options) => {
    interceptedUrl = url.toString();
    return new Response(JSON.stringify({
      files: [{ id: 'found-folder-id-123', name: "Developer's Space" }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const id = await findOrCreateFolder('mock-token', "Developer's Space", "parent's-id");
    assert.equal(id, 'found-folder-id-123');
    assert.ok(interceptedUrl.includes(encodeURIComponent("name = 'Developer\\'s Space' and 'parent\\'s-id' in parents")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findOrCreateFolder: creates new folder when not found', async () => {
  const originalFetch = globalThis.fetch;
  let postBody = null;

  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      postBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 'new-created-folder-id' }), { status: 200 });
    }
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  };

  try {
    const id = await findOrCreateFolder('mock-token', "New Project", "root");
    assert.equal(id, 'new-created-folder-id');
    assert.equal(postBody?.name, 'New Project');
    assert.deepEqual(postBody?.parents, ['root']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listDriveFiles: applies query escaping on folderId and handles pagination', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    calls.push(urlStr);

    if (!urlStr.includes('pageToken')) {
      return new Response(JSON.stringify({
        nextPageToken: 'token_page_2',
        files: [{ id: 'f1', name: 'file1.txt', mimeType: 'text/plain' }]
      }), { status: 200 });
    } else {
      return new Response(JSON.stringify({
        files: [{ id: 'f2', name: 'file2.txt', mimeType: 'text/plain' }]
      }), { status: 200 });
    }
  };

  try {
    const files = await listDriveFiles('mock-token', "user's-root");
    assert.equal(files.length, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes(encodeURIComponent("'user\\'s-root' in parents")));
    assert.ok(calls[1].includes('pageToken=token_page_2'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listDriveFilesRecursive: paginates through multiple pages via nextPageToken', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    calls.push(urlStr);

    if (!urlStr.includes('pageToken')) {
      // First page
      return new Response(JSON.stringify({
        nextPageToken: 'token_page_2',
        files: [
          { id: 'f1', name: 'page1_file.txt', mimeType: 'text/plain' }
        ]
      }), { status: 200 });
    } else {
      // Second page
      return new Response(JSON.stringify({
        files: [
          { id: 'f2', name: 'page2_file.txt', mimeType: 'text/plain' }
        ]
      }), { status: 200 });
    }
  };

  try {
    const files = await listDriveFilesRecursive('mock-token', 'root-id');
    assert.equal(calls.length, 2, 'Should have made 2 paginated requests');
    assert.ok(calls[1].includes('pageToken=token_page_2'), 'Second request must contain pageToken');
    assert.equal(files.length, 2, 'Should aggregate files from all pages');
    assert.equal(files[0].name, 'page1_file.txt');
    assert.equal(files[1].name, 'page2_file.txt');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listDriveFilesRecursive: recursively lists subfolders across pages', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    if (urlStr.includes("'subfolder-1'")) {
      return new Response(JSON.stringify({
        files: [{ id: 'f-nested', name: 'nested.txt', mimeType: 'text/plain' }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      files: [
        { id: 'subfolder-1', name: 'subfolder', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'f-root', name: 'root.txt', mimeType: 'text/plain' }
      ]
    }), { status: 200 });
  };

  try {
    const files = await listDriveFilesRecursive('mock-token', 'root-id');
    const names = files.map(f => f.name);
    assert.ok(names.includes('subfolder/'));
    assert.ok(names.includes('root.txt'));
    assert.ok(names.includes('subfolder/nested.txt'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('writeDriveFile and readDriveFile: preserves raw binary buffer payloads', async () => {
  // Test byte stream containing arbitrary binary bytes outside UTF-8 range
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const highBytes = Buffer.from([0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0xff, 0xfe]);
  const binaryPayload = Buffer.concat([pngHeader, highBytes]);
  const expectedMd5 = crypto.createHash('md5').update(binaryPayload).digest('hex');

  let uploadedBody = null;
  let uploadedHeaders = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const urlStr = url.toString();
    if (options?.method === 'POST') {
      uploadedBody = options.body;
      uploadedHeaders = options.headers;
      return new Response(JSON.stringify({ id: 'new-file-id', md5Checksum: expectedMd5 }), { status: 200 });
    }
    if (urlStr.includes('alt=media')) {
      return new Response(binaryPayload, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    // 1. Test binary write
    const writeResult = await writeDriveFile('mock-token', 'screenshot.png', binaryPayload, null, 'root');
    assert.equal(writeResult.id, 'new-file-id');
    assert.equal(writeResult.md5Checksum, expectedMd5);
    assert.ok(uploadedHeaders['Content-Type'].includes('multipart/related'));
    assert.ok(Buffer.isBuffer(uploadedBody));
    // Verify the multipart body contains the binary payload and correct Content-Type header
    assert.ok(uploadedBody.includes(Buffer.from('Content-Type: image/png\r\n\r\n')));
    assert.ok(uploadedBody.includes(binaryPayload));

    // 2. Test binary read
    const readBuffer = await readDriveFile('mock-token', 'new-file-id');
    assert.ok(Buffer.isBuffer(readBuffer));
    assert.equal(readBuffer.length, binaryPayload.length);
    assert.deepEqual(readBuffer, binaryPayload);
    assert.equal(crypto.createHash('md5').update(readBuffer).digest('hex'), expectedMd5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
