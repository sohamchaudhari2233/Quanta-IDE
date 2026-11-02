import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Tests must never clear the user's task queue or append to their audit log.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-tests-'));
const child = spawn(process.execPath, ['--test', 'test/*.test.js'], {
    cwd: new URL('.', import.meta.url), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, QUANTA_DATA_DIR: path.join(temporary, 'data'), QUANTA_LOG_DIR: path.join(temporary, 'logs') }
});
function cleanup() { fs.rmSync(temporary, { recursive: true, force: true }); }
child.on('error', error => { console.error(error.message); cleanup(); process.exitCode = 1; });
child.on('exit', code => { cleanup(); process.exitCode = code ?? 1; });
