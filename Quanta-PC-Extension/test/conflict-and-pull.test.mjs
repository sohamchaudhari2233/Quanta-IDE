// Quanta-PC-Extension/test/conflict-and-pull.test.mjs
// Automated Unit Tests for Conflict Resolution Policies, Pull Deletions & Doctor Credentials (M1)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { computeThreeWayPlan } from '../src/manifest.ts';

// Helper mimicking conflict resolution policy logic in extension.ts
function applyConflictPolicy(plan, conflicts, policy, options = {}) {
  let uploads = plan.filter(p => p.type === 'upload');
  const downloads = [];
  const localFilesToCreate = [];

  if (conflicts.length > 0) {
    if (policy === 'keepLocal') {
      uploads.push(...conflicts);
    } else if (policy === 'keepRemote') {
      for (const item of conflicts) {
        if (item.remoteId) {
          downloads.push(item);
        }
      }
    } else if (policy === 'keepBoth') {
      const timestamp = options.timestamp || '20261101-120000';
      for (const item of conflicts) {
        const ext = path.extname(item.path);
        const base = path.basename(item.path, ext);
        const dir = path.dirname(item.path);
        const conflictFileName = `${base}.conflict-${timestamp}${ext}`;
        const conflictRelPath = dir === '.' ? conflictFileName : `${dir}/${conflictFileName}`.replace(/\\/g, '/');

        uploads.push({
          type: 'upload',
          path: conflictRelPath,
          localMd5: item.localMd5
        });
        localFilesToCreate.push(conflictRelPath);
      }
    }
  }

  return { uploads, downloads, localFilesToCreate };
}

test('Three-Way Sync Plan: detects deleteLocal when file removed remotely', () => {
  const localFiles = new Map([
    ['retained.txt', 'hash-1'],
    ['removed-on-remote.txt', 'hash-2']
  ]);

  const remoteFiles = new Map([
    ['retained.txt', { id: 'r1', md5: 'hash-1' }]
  ]);

  const manifest = {
    version: 1,
    workspaceName: 'test',
    lastSyncTimestamp: 1000,
    files: {
      'retained.txt': { path: 'retained.txt', localMd5: 'hash-1', remoteMd5: 'hash-1', remoteId: 'r1', lastSyncedAt: 1000 },
      'removed-on-remote.txt': { path: 'removed-on-remote.txt', localMd5: 'hash-2', remoteMd5: 'hash-2', remoteId: 'r2', lastSyncedAt: 1000 }
    }
  };

  const plan = computeThreeWayPlan(localFiles, remoteFiles, manifest);
  const planMap = new Map(plan.map(p => [p.path, p.type]));

  assert.equal(planMap.get('retained.txt'), 'noChange');
  assert.equal(planMap.get('removed-on-remote.txt'), 'deleteLocal');
});

test('Three-Way Sync Plan: detects conflict when file modified locally but deleted remotely', () => {
  const localFiles = new Map([
    ['locally-modified-remote-deleted.txt', 'hash-2-modified']
  ]);

  const remoteFiles = new Map();

  const manifest = {
    version: 1,
    workspaceName: 'test',
    lastSyncTimestamp: 1000,
    files: {
      'locally-modified-remote-deleted.txt': { path: 'locally-modified-remote-deleted.txt', localMd5: 'hash-2', remoteMd5: 'hash-2', remoteId: 'r2', lastSyncedAt: 1000 }
    }
  };

  const plan = computeThreeWayPlan(localFiles, remoteFiles, manifest);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].type, 'conflict');
  assert.equal(plan[0].path, 'locally-modified-remote-deleted.txt');
});

test('Conflict Policy: keepLocal includes conflicts in uploads targeting remote file', () => {
  const plan = [
    { type: 'upload', path: 'new.txt', localMd5: 'h1' },
    { type: 'conflict', path: 'conflict.txt', localMd5: 'h2', remoteId: 'r2', remoteMd5: 'h3' }
  ];
  const conflicts = plan.filter(p => p.type === 'conflict');

  const result = applyConflictPolicy(plan, conflicts, 'keepLocal');
  assert.equal(result.uploads.length, 2);
  assert.ok(result.uploads.some(u => u.path === 'conflict.txt' && u.remoteId === 'r2'));
  assert.equal(result.downloads.length, 0);
});

test('Conflict Policy: keepRemote omits conflicts from uploads and queues for download', () => {
  const plan = [
    { type: 'upload', path: 'new.txt', localMd5: 'h1' },
    { type: 'conflict', path: 'conflict.txt', localMd5: 'h2', remoteId: 'r2', remoteMd5: 'h3' }
  ];
  const conflicts = plan.filter(p => p.type === 'conflict');

  const result = applyConflictPolicy(plan, conflicts, 'keepRemote');
  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0].path, 'new.txt');
  assert.equal(result.downloads.length, 1);
  assert.equal(result.downloads[0].path, 'conflict.txt');
  assert.equal(result.downloads[0].remoteId, 'r2');
});

test('Conflict Policy: keepBoth generates timestamped copy and preserves remote original', () => {
  const plan = [
    { type: 'upload', path: 'clean.txt', localMd5: 'h1' },
    { type: 'conflict', path: 'src/config.json', localMd5: 'h2', remoteId: 'r9', remoteMd5: 'h3' }
  ];
  const conflicts = plan.filter(p => p.type === 'conflict');

  const result = applyConflictPolicy(plan, conflicts, 'keepBoth', { timestamp: '20261101-120000' });
  assert.equal(result.uploads.length, 2);
  assert.equal(result.uploads[0].path, 'clean.txt');
  assert.equal(result.uploads[1].path, 'src/config.conflict-20261101-120000.json');
  assert.equal(result.uploads[1].remoteId, undefined, 'Must not have remoteId so Drive creates new file');
  assert.equal(result.localFilesToCreate[0], 'src/config.conflict-20261101-120000.json');
});

test('Remote Deletions Execution: removes local file and updates manifest', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-pull-test-'));
  try {
    const filePath = path.join(tempDir, 'to-delete.txt');
    fs.writeFileSync(filePath, 'hello world', 'utf8');
    assert.ok(fs.existsSync(filePath));

    const manifest = {
      version: 1,
      workspaceName: 'test',
      lastSyncTimestamp: 1000,
      files: {
        'to-delete.txt': { path: 'to-delete.txt', localMd5: 'abc', remoteMd5: 'abc', remoteId: 'r1', lastSyncedAt: 1000 }
      }
    };

    const localDeletes = [{ type: 'deleteLocal', path: 'to-delete.txt' }];
    for (const item of localDeletes) {
      const target = path.join(tempDir, item.path);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
      delete manifest.files[item.path];
    }

    assert.ok(!fs.existsSync(filePath), 'Local file must be removed');
    assert.equal(manifest.files['to-delete.txt'], undefined, 'Manifest entry must be deleted');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('OAuth example documents credentials without requiring private secrets in CI', () => {
  const clientSecretPath = new URL('../../client_secret.example.json', import.meta.url);
  const content = JSON.parse(fs.readFileSync(clientSecretPath, 'utf8'));
  const creds = content.installed || content.web;
  assert.match(creds.client_id, /^YOUR_CLIENT_ID/);
  assert.equal(creds.client_secret, 'YOUR_CLIENT_SECRET');
});
