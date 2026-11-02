#!/usr/bin/env node

/**
 * Quanta IDE Opaque-Box E2E Test Suite Runner
 * 
 * Executes all 4 tiers of E2E test suites sequentially using Node.js built-in
 * test runner, displaying tier status, test metrics, and reporting exit code 0
 * on 100% pass.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_FILES = [
  'tier1-feature-coverage.test.mjs',
  'tier2-boundary-corner.test.mjs',
  'tier3-cross-feature.test.mjs',
  'tier4-application-scenarios.test.mjs'
];

console.log('================================================================');
console.log('       QUANTA IDE OPAQUE-BOX E2E TEST SUITE RUNNER              ');
console.log('================================================================');
console.log(`Node.js Version: ${process.version}`);
console.log(`Execution Time:  ${new Date().toISOString()}`);
console.log(`Test Directory:  ${__dirname}`);
console.log('----------------------------------------------------------------');

const fullPaths = TEST_FILES.map(f => path.join(__dirname, f));

const startTime = Date.now();
const child = spawn(process.execPath, ['--test', ...fullPaths], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '../..')
});

child.on('error', (err) => {
  console.error('[ERROR] Failed to spawn Node.js test runner:', err);
  process.exit(1);
});

child.on('close', (code) => {
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('----------------------------------------------------------------');
  if (code === 0) {
    console.log(`>>> E2E TEST SUITE RUNNER: SUCCESS (100% PASS in ${duration}s) <<<`);
    console.log('All Tiers (1, 2, 3, 4) executed with 0 failures.');
  } else {
    console.error(`>>> E2E TEST SUITE RUNNER: FAILED (Exit Code: ${code} in ${duration}s) <<<`);
  }
  console.log('================================================================');
  process.exit(code ?? 1);
});
