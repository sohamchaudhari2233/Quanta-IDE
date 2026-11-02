import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import * as fs from 'fs';
import * as path from 'path';

let extensionContext: vscode.ExtensionContext | null = null;
let cachedTokens: { accessToken: string; refreshToken?: string; expiresAt?: number } | null = null;

const SECRET_STORAGE_KEY = 'quanta_oauth_tokens';

export function initAuth(context: vscode.ExtensionContext) {
  extensionContext = context;
}

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

export function getCredentials(): { clientId: string; clientSecret: string; redirectUris?: string[] } {
  const config = vscode.workspace.getConfiguration('quanta');
  let clientId = config.get<string>('clientId')?.trim() || '';
  let clientSecret = config.get<string>('clientSecret')?.trim() || '';
  let redirectUris: string[] | undefined = undefined;

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

  // Check client_secret*.json files in workspace and extension roots
  if (!clientId || !clientSecret) {
    const searchDirs: string[] = [];
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      for (const folder of vscode.workspace.workspaceFolders) {
        searchDirs.push(folder.uri.fsPath);
      }
    }
    searchDirs.push(path.join(__dirname, '..'));
    searchDirs.push(__dirname);

    for (const dir of searchDirs) {
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.startsWith('client_secret') && file.endsWith('.json')) {
              const fullPath = path.join(dir, file);
              const content = fs.readFileSync(fullPath, 'utf-8');
              const json = JSON.parse(content);
              const creds = json.installed || json.web;
              if (creds) {
                if (!clientId && creds.client_id) {
                  clientId = creds.client_id.trim();
                }
                if (!clientSecret && creds.client_secret) {
                  clientSecret = creds.client_secret.trim();
                }
                if (Array.isArray(creds.redirect_uris) && creds.redirect_uris.length > 0) {
                  redirectUris = creds.redirect_uris;
                }
              }
              if (clientId && clientSecret) break;
            }
          }
        }
      } catch {
        // Ignore read errors
      }
      if (clientId && clientSecret) break;
    }
  }

  return { clientId, clientSecret, redirectUris };
}

async function loadStoredTokens(): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number } | null> {
  if (cachedTokens) return cachedTokens;
  if (extensionContext) {
    try {
      const raw = await extensionContext.secrets.get(SECRET_STORAGE_KEY);
      if (raw) {
        cachedTokens = JSON.parse(raw);
        return cachedTokens;
      }
    } catch (e) {
      console.error('Failed to read secrets storage:', e);
    }
  }
  return null;
}

async function saveTokens(tokens: { accessToken: string; refreshToken?: string; expiresAt?: number }): Promise<void> {
  cachedTokens = tokens;
  if (extensionContext) {
    try {
      await extensionContext.secrets.store(SECRET_STORAGE_KEY, JSON.stringify(tokens));
    } catch (e) {
      console.error('Failed to write secrets storage:', e);
    }
  }
}

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) {
      console.warn('Failed to refresh Google Drive token:', response.statusText);
      return null;
    }

    const data: any = await response.json();
    if (data.access_token) {
      const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
      const updated = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt
      };
      await saveTokens(updated);
      return updated.accessToken;
    }
  } catch (err) {
    console.error('Token refresh network exception:', err);
  }
  return null;
}

export async function disconnect(): Promise<boolean> {
  const tokens = await loadStoredTokens();
  if (tokens && tokens.accessToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.accessToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch (e) {
      // Best-effort revocation
    }
  }
  cachedTokens = null;
  if (extensionContext) {
    await extensionContext.secrets.delete(SECRET_STORAGE_KEY);
  }
  return true;
}

let activeAuthPromise: Promise<string | null> | null = null;
let activeServer: http.Server | null = null;

export function isLoopbackAddress(addr?: string): boolean {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === 'localhost' ||
    addr.startsWith('127.') ||
    addr.startsWith('::ffff:127.') ||
    addr === '::'
  );
}

export interface TokenExchangeResult {
  success: boolean;
  accessToken?: string;
  error?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUriToUse: string,
  clientId: string,
  clientSecret: string,
  codeVerifier: string
): Promise<TokenExchangeResult> {
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code.trim(),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUriToUse,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier
      })
    });

    const tokenData: any = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenData) {
      const errorMsg = tokenData?.error_description || tokenData?.error || `HTTP ${tokenResponse.status} ${tokenResponse.statusText}`;
      console.error('Token exchange failed:', errorMsg);
      return { success: false, error: errorMsg };
    }

    if (tokenData.access_token) {
      const expiresAt = Date.now() + ((tokenData.expires_in || 3600) * 1000);
      await saveTokens({
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt
      });
      return { success: true, accessToken: tokenData.access_token };
    }

    return { success: false, error: 'Token response missing access_token' };
  } catch (err: any) {
    console.error('Network exception during token exchange:', err);
    return { success: false, error: err?.message || 'Network error reaching Google OAuth servers' };
  }
}

export async function authenticate(): Promise<string | null> {
  if (activeAuthPromise) {
    return activeAuthPromise;
  }

  activeAuthPromise = (async () => {
    try {
      return await executeAuth();
    } finally {
      activeAuthPromise = null;
      if (activeServer) {
        try { activeServer.close(); } catch {}
        activeServer = null;
      }
    }
  })();

  return activeAuthPromise;
}

async function executeAuth(): Promise<string | null> {
  const { clientId, clientSecret, redirectUris } = getCredentials();

  if (!clientId || !clientSecret) {
    vscode.window.showErrorMessage('Please set Quanta Client ID and Client Secret in VS Code Settings (quanta.clientId, quanta.clientSecret) or in a secure .env file.');
    return null;
  }

  // Check stored tokens & refresh if near expiration
  const stored = await loadStoredTokens();
  if (stored && stored.accessToken) {
    const isExpiringSoon = stored.expiresAt ? (Date.now() > (stored.expiresAt - 5 * 60 * 1000)) : false;
    if (!isExpiringSoon) {
      return stored.accessToken;
    }
    if (stored.refreshToken) {
      const refreshed = await refreshAccessToken(stored.refreshToken, clientId, clientSecret);
      if (refreshed) return refreshed;
    }
  }

  // Generate PKCE code_verifier and code_challenge (RFC 7636)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  // Configurable scope (drive.file vs drive)
  const driveScopeConfig = vscode.workspace.getConfiguration('quanta').get<string>('driveScope', 'drive.file');
  const scope = driveScopeConfig === 'drive'
    ? 'https://www.googleapis.com/auth/drive'
    : 'https://www.googleapis.com/auth/drive.file';

  return new Promise((resolve) => {
    const config = vscode.workspace.getConfiguration('quanta');
    let preferredPort = config.get<number>('oauthPort', 8085);
    let preferredHost = config.get<string>('oauthHost', 'localhost');
    const explicitUri = config.get<string>('oauthRedirectUri', '')?.trim();
    const explicitPath = config.get<string>('oauthPath', '')?.trim();

    // Auto-detect port and host from credentials file if present
    if (redirectUris && redirectUris.length > 0) {
      for (const uri of redirectUris) {
        try {
          const parsed = new URL(uri);
          if (parsed.port) {
            preferredPort = parseInt(parsed.port, 10);
            if (config.get<string>('oauthHost') === undefined) {
              preferredHost = parsed.hostname;
            }
            break;
          } else if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
            // Port-less http loopback URI defaults to port 8085 if not explicitly overridden
            if (config.get<number>('oauthPort') === undefined) {
              preferredPort = 8085;
            }
            if (config.get<string>('oauthHost') === undefined) {
              preferredHost = parsed.hostname;
            }
          }
        } catch {}
      }
    }

    const computeRedirectUri = (port: number) => {
      if (explicitUri) return explicitUri;
      const subPath = explicitPath ? (explicitPath.startsWith('/') ? explicitPath : `/${explicitPath}`) : '';
      return port === 80
        ? `http://${preferredHost}${subPath}`
        : `http://${preferredHost}:${port}${subPath}`;
    };

    let activeRedirectUri = computeRedirectUri(preferredPort);
    let triedFallback = false;

    // Cleanup helper
    let timeoutTimer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (activeServer) {
        try { activeServer.close(); } catch {}
        activeServer = null;
      }
    };

    const promptManualInput = async (redirectUriToUse: string, onDone: (token: string | null) => void) => {
      const manualInput = await vscode.window.showInputBox({
        prompt: 'If your browser redirected or shows an error, paste the full URL or code here:',
        placeHolder: 'http://localhost/?code=... or 4/0A...'
      });
      if (manualInput && manualInput.trim()) {
        let manualCode = manualInput.trim();
        if (manualCode.includes('code=')) {
          try {
            const urlObj = new URL(manualCode.startsWith('http') ? manualCode : `http://localhost/${manualCode}`);
            manualCode = urlObj.searchParams.get('code') || manualCode;
          } catch {}
        }
        if (manualCode) {
          try {
            const result = await exchangeCodeForTokens(manualCode, redirectUriToUse, clientId, clientSecret, codeVerifier);
            if (result.success && result.accessToken) {
              vscode.window.showInformationMessage('Quanta: Google Drive connected successfully!');
              cleanup();
              onDone(result.accessToken);
              return;
            } else {
              vscode.window.showErrorMessage(`Quanta: Failed to exchange authorization code: ${result.error || 'Unknown error'}`);
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Quanta: Exception during code exchange: ${err?.message || err}`);
          }
        }
      }
    };

    // Loopback HTTP server
    const server = http.createServer(async (req, res) => {
      try {
        const remoteAddr = req.socket.remoteAddress;
        if (!isLoopbackAddress(remoteAddr)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: Non-loopback requests are not permitted.');
          return;
        }

        const address = server.address();
        const currentPort = typeof address === 'object' && address ? address.port : preferredPort;
        const url = new URL(req.url || '', `http://${preferredHost}:${currentPort}`);

        if (url.pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authentication canceled or failed: ${encodeURIComponent(error)}</h1>`);
          cleanup();
          resolve(null);
          return;
        }

        if (code) {
          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>Authentication failed: Invalid state parameter.</h1>');
            cleanup();
            resolve(null);
            return;
          }

          const result = await exchangeCodeForTokens(code, activeRedirectUri, clientId, clientSecret, codeVerifier);
          if (result.success && result.accessToken) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Authentication successful!</h1><p>You can close this window and return to VS Code.</p><script>window.close()</script>');
            cleanup();
            resolve(result.accessToken);
            return;
          } else {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h1>Authentication failed! Could not exchange authorization code: ${encodeURIComponent(result.error || 'Unknown error')}</h1>`);
            cleanup();
            resolve(null);
            return;
          }
        }
      } catch (err) {
        console.error('OAuth callback handler error:', err);
      }
      res.writeHead(400);
      res.end('Invalid request');
      cleanup();
      resolve(null);
    });

    activeServer = server;

    // 120s timeout guard
    timeoutTimer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 120000);

    const startListener = (port: number) => {
      activeRedirectUri = computeRedirectUri(port);
      server.listen(port, () => {
        const address = server.address();
        const allocatedPort = typeof address === 'object' && address ? address.port : port;
        activeRedirectUri = computeRedirectUri(allocatedPort);

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(activeRedirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&state=${encodeURIComponent(state)}`;
        
        vscode.env.openExternal(vscode.Uri.parse(authUrl));

        // Display user-friendly notification with manual paste and copy-URI options
        vscode.window.showInformationMessage(
          `Quanta: Signing in with Google (${activeRedirectUri})...`,
          'Paste Code / URL',
          'Copy Redirect URI'
        ).then(async selection => {
          if (selection === 'Copy Redirect URI') {
            await vscode.env.clipboard.writeText(activeRedirectUri);
            vscode.window.showInformationMessage(`Copied "${activeRedirectUri}" to clipboard. Ensure this URI is registered in Google Cloud Console.`);
          } else if (selection === 'Paste Code / URL') {
            await promptManualInput(activeRedirectUri, resolve);
          }
        });
      });
    };

    server.on('error', (err: any) => {
      if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && !triedFallback && preferredPort !== 8085) {
        triedFallback = true;
        console.warn(`OAuth port ${preferredPort} unavailable (${err.code}), trying port 8085...`);
        startListener(8085);
      } else if (err.code === 'EADDRINUSE') {
        vscode.window.showErrorMessage(
          `Quanta OAuth: Port ${preferredPort} is in use by another application. Please free port ${preferredPort} or paste the code manually.`,
          'Paste Code'
        ).then(choice => {
          if (choice === 'Paste Code') {
            promptManualInput(activeRedirectUri, resolve);
          }
        });
        cleanup();
        resolve(null);
      } else {
        vscode.window.showErrorMessage(`OAuth loopback server error: ${err.message}`);
        cleanup();
        resolve(null);
      }
    });

    server.on('close', () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (activeServer === server) {
        activeServer = null;
      }
    });

    startListener(preferredPort);
  });
}
