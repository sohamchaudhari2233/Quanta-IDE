import * as vscode from 'vscode';
import * as http from 'http';
import { URL } from 'url';
import * as fs from 'fs';
import * as path from 'path';

let cachedToken: string | null = null;

function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          let val = trimmed.substring(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.substring(1, val.length - 1);
          }
          env[key] = val;
        }
      }
    }
  } catch {
    // Ignore error reading .env
  }
  return env;
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const config = vscode.workspace.getConfiguration('quanta');
  let clientId = config.get<string>('clientId')?.trim() || '';
  let clientSecret = config.get<string>('clientSecret')?.trim() || '';

  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }

  // Check process.env
  clientId = clientId || process.env.QUANTA_CLIENT_ID?.trim() || process.env.GOOGLE_CLIENT_ID?.trim() || '';
  clientSecret = clientSecret || process.env.QUANTA_CLIENT_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim() || '';

  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }

  // Check .env files (workspace root, parent workspace, extension directory)
  const candidatePaths: string[] = [];
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const wsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    candidatePaths.push(path.join(wsPath, '.env'));
    candidatePaths.push(path.join(wsPath, '..', '.env'));
  }
  candidatePaths.push(path.join(__dirname, '..', '.env'));
  candidatePaths.push(path.join(__dirname, '.env'));

  for (const envPath of candidatePaths) {
    const envVars = parseEnvFile(envPath);
    if (!clientId) {
      clientId = envVars.QUANTA_CLIENT_ID?.trim() || envVars.GOOGLE_CLIENT_ID?.trim() || '';
    }
    if (!clientSecret) {
      clientSecret = envVars.QUANTA_CLIENT_SECRET?.trim() || envVars.GOOGLE_CLIENT_SECRET?.trim() || '';
    }
    if (clientId && clientSecret) {
      break;
    }
  }

  return { clientId, clientSecret };
}

export async function authenticate(): Promise<string | null> {
  if (cachedToken) return cachedToken;

  const { clientId, clientSecret } = getCredentials();

  if (!clientId || !clientSecret) {
    vscode.window.showErrorMessage('Please set Quanta Client ID and Client Secret in VS Code Settings (quanta.clientId, quanta.clientSecret) or in a secure .env file.');
    return null;
  }

  return new Promise((resolve) => {
    const port = 3000;
    const redirectUri = `http://localhost:${port}/oauth2callback`;

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '', `http://localhost:${port}`);
        if (url.pathname === '/oauth2callback') {
          const code = url.searchParams.get('code');
          if (code) {
            // Exchange code for token
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
              })
            });

            const tokenData: any = await tokenResponse.json();
            if (tokenData.access_token) {
              cachedToken = tokenData.access_token;
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<h1>Authentication successful!</h1><p>You can close this window and return to VS Code.</p><script>window.close()</script>');
              server.close();
              resolve(cachedToken);
              return;
            } else {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`<h1>Authentication failed!</h1><pre>${JSON.stringify(tokenData)}</pre>`);
            }
          }
        }
      } catch (err) {
        console.error(err);
      }
      res.writeHead(400);
      res.end('Invalid request');
      server.close();
      resolve(null);
    });

    server.listen(port, () => {
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive')}&access_type=offline`;
      vscode.env.openExternal(vscode.Uri.parse(authUrl));
    });
  });
}
