#!/usr/bin/env node
/**
 * Quanta IDE Interactive Setup Wizard
 * Guides developers through initial environment provisioning, secrets generation,
 * SSL certificate creation, and CDP bridge verification.
 * Authors: Akira-official & dark-yoddha
 */

import fs from 'fs';
import path from 'path';
import { prepareEnvironment } from './core/setupEnvironment.js';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');
const CERTS_DIR = path.join(__dirname, 'certs');

console.log('====================================================');
console.log('   🚀 Quanta IDE Setup Wizard');
console.log('   Developed by Akira-official & dark-yoddha');
console.log('====================================================\n');

function checkNodeVersion() {
  const current = process.versions.node;
  const major = parseInt(current.split('.')[0], 10);
  if (major < 18) {
    console.error(`❌ Node.js version ${current} is too old. Quanta IDE requires Node.js >= 18.0.0`);
    process.exit(1);
  }
  console.log(`✅ Node.js runtime: v${current} (Compatible)`);
}

function ensureSslCerts() {
  const keyPath = path.join(CERTS_DIR, 'server.key');
  const certPath = path.join(CERTS_DIR, 'server.cert');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('✅ SSL Certificates found in ./certs/');
    return;
  }

  console.log('⚙️  Generating self-signed SSL certificates for HTTPS...');
  try {
    execSync('node generate_ssl.js', { cwd: __dirname, stdio: 'inherit' });
    console.log('✅ SSL Certificates generated successfully.');
  } catch (err) {
    console.warn('⚠️  Could not automatically generate SSL certificates:', err.message);
  }
}

function ensureEnvConfiguration() {
  let envContent = '';
  const exists = fs.existsSync(ENV_PATH);

  if (exists) {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
    console.log('ℹ️  Existing .env file detected.');
  } else if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    envContent = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    console.log('⚙️  Creating new .env from template...');
  } else {
    envContent = 'PORT=3000\nAPP_PASSWORD=\nCOOKIE_SECRET=\nSESSION_SECRET=\n';
  }

  const prepared = prepareEnvironment(envContent);
  envContent = prepared.content;
  const updated = prepared.updated;

  if (updated || !exists) {
    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
    console.log('✅ Configuration .env updated with cryptographically secure keys.');
  } else {
    console.log('✅ Configuration .env has required secrets.');
  }
}

async function checkCdpBridge() {
  console.log('\n🔍 Probing Chrome DevTools Protocol (CDP) on 127.0.0.1:9000...');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('http://127.0.0.1:9000/json/version', { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      console.log(`✅ CDP Bridge Connected: ${data.Browser || 'Google Antigravity'}`);
    } else {
      console.warn('⚠️  CDP responded with status:', res.status);
    }
  } catch (err) {
    console.log('ℹ️  Antigravity IDE is not currently running with remote debugging.');
    console.log('   To connect, launch Antigravity with:');
    console.log('   `antigravity --remote-debugging-address=127.0.0.1 --remote-debugging-port=9000`');
  }
}

async function run() {
  checkNodeVersion();
  ensureSslCerts();
  ensureEnvConfiguration();
  await checkCdpBridge();

  console.log('\n====================================================');
  console.log('   🎉 Quanta IDE Setup Complete!');
  console.log('====================================================');
  console.log('Next steps:');
  console.log('1. Start Remote-Control server:');
  console.log('   npm start');
  console.log('2. Run diagnostics anytime with:');
  console.log('   node doctor.js');
  console.log('3. Open the web interface or scan the terminal QR code from your phone!\n');
}

run().catch(err => {
  console.error('❌ Setup failed:', err);
  process.exit(1);
});

