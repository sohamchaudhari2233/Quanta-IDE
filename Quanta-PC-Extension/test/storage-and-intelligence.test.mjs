import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MockStorageProvider } from '../src/storage/mockStorageProvider.ts';
import { SnapshotManager } from '../src/storage/snapshots.ts';
import { SelectiveSyncManager } from '../src/storage/selectiveSync.ts';
import { ChatSearchIndex } from '../src/intelligence/chatSearch.ts';
import { PromptLibrary, BUILTIN_PROMPTS } from '../src/intelligence/promptLibrary.ts';

test('StorageProvider & MockStorageProvider: basic CRUD operations', async () => {
    const provider = new MockStorageProvider();

    const putRes = await provider.put('config/settings.json', '{"theme":"dark"}');
    assert.equal(putRes.name, 'config/settings.json');
    assert.ok(putRes.md5Checksum);

    const content = await provider.get('config/settings.json');
    assert.equal(content, '{"theme":"dark"}');

    const list = await provider.list('config');
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'config/settings.json');

    await provider.trash('config/settings.json');
    const afterTrash = await provider.list('config');
    assert.equal(afterTrash.length, 0);
});

test('SnapshotManager: stores content-addressed blobs and tracks metadata', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-snap-test-'));
    try {
        const manager = new SnapshotManager();

        const fileMap = new Map([
            ['src/index.ts', 'console.log("v1");'],
            ['README.md', '# My Project']
        ]);

        const snap = manager.createSnapshot(tempDir, fileMap, 'Initial Commit');
        assert.ok(snap.id);
        assert.equal(snap.label, 'Initial Commit');
        assert.ok(snap.files['src/index.ts']);
        assert.ok(snap.files['README.md']);

        const list = manager.listSnapshots(tempDir);
        assert.equal(list.length, 1);
        assert.equal(list[0].id, snap.id);

        // Retrieve stored blob
        const blobHash = snap.files['src/index.ts'].hash;
        const retrievedBlob = manager.getBlob(tempDir, blobHash);
        assert.equal(retrievedBlob.toString('utf8'), 'console.log("v1");');

        // Prune retention policy & GC
        const gcResult = manager.gcSnapshots(tempDir, 1);
        assert.equal(gcResult.deletedSnapshots, 0); // Kept 1
        assert.equal(gcResult.deletedBlobs, 0); // Active blobs preserved
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('SelectiveSyncManager: evaluates excluded paths', () => {
    const manager = new SelectiveSyncManager();
    const config = {
        version: 1,
        excludedPaths: ['assets/raw-video', 'datasets', 'temp']
    };

    assert.equal(manager.isPathExcluded('assets/raw-video/clip1.mp4', config), true);
    assert.equal(manager.isPathExcluded('datasets/train.csv', config), true);
    assert.equal(manager.isPathExcluded('src/auth.ts', config), false);
    assert.equal(manager.isPathExcluded('README.md', config), false);
});

test('ChatSearchIndex: indexes sessions and scores keyword queries with snippets', () => {
    const index = new ChatSearchIndex();

    index.indexSessions([
        {
            sessionId: 'sess-1',
            title: 'Refactor Auth',
            messages: [
                { role: 'user', content: 'We need to implement PKCE challenge with SHA256' },
                { role: 'assistant', content: 'Here is the S256 code verifier implementation using crypto.' }
            ]
        },
        {
            sessionId: 'sess-2',
            title: 'Fix Docker',
            messages: [
                { role: 'user', content: 'How do we run the container without root permissions?' },
                { role: 'assistant', content: 'Set USER node in the Dockerfile.' }
            ]
        }
    ]);

    // Query matching session 1
    const pkceResults = index.search('PKCE challenge');
    assert.ok(pkceResults.length >= 1);
    assert.equal(pkceResults[0].sessionId, 'sess-1');
    assert.ok(pkceResults[0].snippet.includes('PKCE'));

    // Query matching session 2
    const dockerResults = index.search('root permissions Dockerfile');
    assert.ok(dockerResults.length >= 1);
    assert.equal(dockerResults[0].sessionId, 'sess-2');

    // Empty query returns empty array
    assert.equal(index.search('').length, 0);
});

test('PromptLibrary: extracts variables and renders templates', () => {
    const lib = new PromptLibrary();

    assert.ok(lib.listTemplates().length >= BUILTIN_PROMPTS.length);

    const rendered = lib.render('explain-error', {
        file: 'server.js',
        error: 'EADDRINUSE 3000'
    });

    assert.ok(rendered.includes('server.js'));
    assert.ok(rendered.includes('EADDRINUSE 3000'));
    assert.ok(!rendered.includes('{{file}}'));

    // Custom template registration
    lib.registerTemplate({
        id: 'custom-greeting',
        title: 'Greeting',
        category: 'code',
        description: 'Greet someone',
        template: 'Hello {{name}} from {{company}}!',
        variables: ['name', 'company']
    });

    const vars = lib.extractVariables('Hello {{name}} from {{company}}!');
    assert.deepEqual(vars.sort(), ['company', 'name']);

    const customRendered = lib.render('custom-greeting', { name: 'Akira', company: 'Quanta' });
    assert.equal(customRendered, 'Hello Akira from Quanta!');
});
