import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspacePath } from '../src/safePath.ts';

test('Drive sync paths cannot leave workspace through traversal, Windows paths or junctions', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-sync-path-'));
    try {
        const root = path.join(temp, 'workspace');
        const outside = path.join(temp, 'outside');
        fs.mkdirSync(root); fs.mkdirSync(outside);
        for (const name of ['../outside/secret', '/tmp/secret', 'C:/secret', 'a/../../secret', 'a\\..\\secret', 'file:stream']) {
            assert.throws(() => resolveWorkspacePath(root, name), /Unsafe|leaves/);
        }
        assert.equal(resolveWorkspacePath(root, 'src/new-file.ts'), path.join(root, 'src/new-file.ts'));
        fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => resolveWorkspacePath(root, 'link/new-file.ts'), /Symlink/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
