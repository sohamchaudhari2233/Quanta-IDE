import test from 'node:test';
import assert from 'node:assert/strict';
import { IgnoreMatcher } from '../src/ignoreRules.ts';
import { computeThreeWayPlan } from '../src/manifest.ts';
import { redactSensitiveText } from '../src/redaction.ts';
import { encryptTranscript, decryptTranscript } from '../src/encryption.ts';

test('IgnoreMatcher: blocks default sensitive files and directories', () => {
  const matcher = new IgnoreMatcher();

  assert.equal(matcher.isIgnored('.env'), true);
  assert.equal(matcher.isIgnored('.env.local'), true);
  assert.equal(matcher.isIgnored('.env.example'), false, '.env.example must be allowed');
  assert.equal(matcher.isIgnored('client_secret.json'), true);
  assert.equal(matcher.isIgnored('client_secret.example.json'), false);
  assert.equal(matcher.isIgnored('node_modules/express/index.js'), true);
  assert.equal(matcher.isIgnored('.git/config'), true);
  assert.equal(matcher.isIgnored('server.key'), true);
  assert.equal(matcher.isIgnored('cert.pem'), true);
  assert.equal(matcher.isIgnored('antigravity_chats.json'), true);

  // Normal project source files must NOT be ignored
  assert.equal(matcher.isIgnored('src/index.ts'), false);
  assert.equal(matcher.isIgnored('package.json'), false);
  assert.equal(matcher.isIgnored('README.md'), false);
});

test('Three-Way Sync Plan: detects uploads, downloads, conflicts, and deletes', () => {
  const localFiles = new Map([
    ['unchanged.txt', 'hash-1'],
    ['local-modified.txt', 'hash-2-new'],
    ['remote-modified.txt', 'hash-5-base'],
    ['conflict.txt', 'hash-3-local'],
    ['new-local.txt', 'hash-4']
  ]);

  const remoteFiles = new Map([
    ['unchanged.txt', { id: 'r1', md5: 'hash-1' }],
    ['local-modified.txt', { id: 'r2', md5: 'hash-2-base' }],
    ['conflict.txt', { id: 'r3', md5: 'hash-3-remote' }],
    ['remote-modified.txt', { id: 'r4', md5: 'hash-5-new' }],
    ['new-remote.txt', { id: 'r5', md5: 'hash-6' }]
  ]);

  const manifest = {
    version: 1,
    workspaceName: 'test',
    lastSyncTimestamp: 1000,
    files: {
      'unchanged.txt': { path: 'unchanged.txt', localMd5: 'hash-1', remoteMd5: 'hash-1', remoteId: 'r1', lastSyncedAt: 1000 },
      'local-modified.txt': { path: 'local-modified.txt', localMd5: 'hash-2-base', remoteMd5: 'hash-2-base', remoteId: 'r2', lastSyncedAt: 1000 },
      'conflict.txt': { path: 'conflict.txt', localMd5: 'hash-3-base', remoteMd5: 'hash-3-base', remoteId: 'r3', lastSyncedAt: 1000 },
      'remote-modified.txt': { path: 'remote-modified.txt', localMd5: 'hash-5-base', remoteMd5: 'hash-5-base', remoteId: 'r4', lastSyncedAt: 1000 },
      'deleted-locally.txt': { path: 'deleted-locally.txt', localMd5: 'hash-7', remoteMd5: 'hash-7', remoteId: 'r7', lastSyncedAt: 1000 }
    }
  };

  remoteFiles.set('deleted-locally.txt', { id: 'r7', md5: 'hash-7' });

  const plan = computeThreeWayPlan(localFiles, remoteFiles, manifest);
  const planMap = new Map(plan.map(p => [p.path, p.type]));

  assert.equal(planMap.get('unchanged.txt'), 'noChange');
  assert.equal(planMap.get('local-modified.txt'), 'upload');
  assert.equal(planMap.get('remote-modified.txt'), 'download');
  assert.equal(planMap.get('conflict.txt'), 'conflict');
  assert.equal(planMap.get('new-local.txt'), 'upload');
  assert.equal(planMap.get('new-remote.txt'), 'download');
  assert.equal(planMap.get('deleted-locally.txt'), 'deleteRemote');
});

test('Redaction: sanitizes real keys and tokens while avoiding false positives', () => {
  const sensitiveInput = `
Here is my Google key: AIzaSyD3x9qY4LzP1mK8jR2wN7vT5bX0aC9eF1g
Here is GitHub token: ghp_111122223333444455566667777888899990
Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jV
password="SuperSecretPassword123"
API_KEY=my_secret_token_value_9988
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y7u...
-----END RSA PRIVATE KEY-----
`;

  const redacted = redactSensitiveText(sensitiveInput);

  assert.ok(!redacted.includes('AIzaSyD3x9qY4LzP1mK8jR2wN7vT5bX0aC9eF1g'));
  assert.ok(redacted.includes('[REDACTED_GOOGLE_API_KEY]'));

  assert.ok(!redacted.includes('ghp_111122223333444455566667777888899990'));
  assert.ok(redacted.includes('[REDACTED_GITHUB_TOKEN]'));

  assert.ok(!redacted.includes('SuperSecretPassword123'));
  assert.ok(!redacted.includes('MIIEowIBAAKCAQEA0Y7u'));
  assert.ok(redacted.includes('[REDACTED_PRIVATE_KEY]'));

  // Negative test / False-positive check: normal code is untouched
  const normalCode = `const greeting = "Hello World"; console.log(greeting);`;
  assert.equal(redactSensitiveText(normalCode), normalCode);
});

test('Encryption: round-trip encrypts and decrypts with AES-256-GCM', () => {
  const original = JSON.stringify([{ role: 'user', text: 'Sensitive message' }]);
  const passphrase = 'quanta-strong-user-passphrase-8899';

  const encrypted = encryptTranscript(original, passphrase);
  assert.notEqual(encrypted, original);
  assert.ok(encrypted.includes('aes-256-gcm'));

  const decrypted = decryptTranscript(encrypted, passphrase);
  assert.equal(decrypted, original);
});
