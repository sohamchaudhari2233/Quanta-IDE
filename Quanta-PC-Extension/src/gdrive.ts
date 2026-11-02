// gdrive.ts - Helper functions for Google Drive API v3 with Safe Trashing and Changes API

const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/**
 * Fetch wrapper with exponential backoff and jitter for rate-limiting resiliency.
 */
async function fetchWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
        attempt++;
        if (attempt >= maxRetries) return response;
        const delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return fetch(url, options);
}

/**
 * Escapes characters in Google Drive query terms to prevent injection and syntax errors.
 * Single quotes are escaped with \' and backslashes with \\.
 */
export function escapeDriveQueryTerm(value: string): string {
  if (!value) return '';
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * List files in a specific folder (or root)
 */
export async function listDriveFiles(accessToken: string, folderId = 'root') {
  const safeFolderId = escapeDriveQueryTerm(folderId);
  const query = `'${safeFolderId}' in parents and trashed = false`;
  let files: any[] = [];
  let pageToken: string | undefined = undefined;

  do {
    let url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime)&pageSize=1000`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      throw new Error(`Failed to list files: ${response.statusText}`);
    }

    const data: any = await response.json();
    if (Array.isArray(data.files)) {
      files.push(...data.files);
    }
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return files;
}

/**
 * List files recursively in a folder and return them with relative paths
 */
export async function listDriveFilesRecursive(accessToken: string, folderId: string, currentPath = '') {
  const safeFolderId = escapeDriveQueryTerm(folderId);
  const query = `'${safeFolderId}' in parents and trashed = false`;
  
  let allFiles: any[] = [];
  const folderTasks: (() => Promise<any[]>)[] = [];
  let pageToken: string | undefined = undefined;

  do {
    let url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum)&pageSize=1000`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(`Failed to list files recursively: ${response.statusText}`);
    
    const data: any = await response.json();
    for (const file of data.files || []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const folderPath = currentPath + file.name + '/';
        allFiles.push({
          ...file,
          name: folderPath
        });
        folderTasks.push(() => listDriveFilesRecursive(accessToken, file.id, folderPath));
      } else {
        allFiles.push({
          ...file,
          name: currentPath + file.name
        });
      }
    }
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  
  for (let i = 0; i < folderTasks.length; i += 5) {
    const chunk = folderTasks.slice(i, i + 5);
    const subFilesArrays = await Promise.all(chunk.map(fn => fn()));
    for (const subFiles of subFilesArrays) {
      allFiles.push(...subFiles);
    }
  }
  
  return allFiles;
}

/**
 * Read content of a file as a binary Buffer
 */
export async function readDriveFile(accessToken: string, fileId: string): Promise<Buffer> {
  const url = `${API_BASE}/files/${fileId}?alt=media`;
  
  const response = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to read file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Common MIME type mapping by extension with fallback to application/octet-stream
 */
export const MIME_TYPE_MAP: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  // Documents & Data
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  // Binaries & Archives
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.sqlite': 'application/vnd.sqlite3',
  '.sqlite3': 'application/vnd.sqlite3',
  '.db': 'application/vnd.sqlite3',
  // Code / Web text
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.md': 'text/markdown',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.sql': 'text/plain',
  // Media
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

export function getMimeType(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex !== -1) {
    const ext = fileName.slice(dotIndex).toLowerCase();
    if (MIME_TYPE_MAP[ext]) {
      return MIME_TYPE_MAP[ext];
    }
  }
  return 'application/octet-stream';
}

/**
 * Create or update a file (supports string, Uint8Array, or Buffer)
 */
export async function writeDriveFile(
  accessToken: string,
  name: string,
  content: string | Uint8Array | Buffer,
  fileId: string | null = null,
  parentId = 'root',
  mimeTypeOverride?: string
) {
  const mimeType = mimeTypeOverride || getMimeType(name);
  const metadata: any = {
    name: name,
    mimeType: mimeType,
  };

  if (!fileId) {
    metadata.parents = [parentId];
  }

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const contentBuffer = Buffer.isBuffer(content)
    ? content
    : typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content.buffer, content.byteOffset, content.byteLength);

  const headerPart =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n`;

  const multipartRequestBody = Buffer.concat([
    Buffer.from(headerPart, 'utf8'),
    contentBuffer,
    Buffer.from(closeDelimiter, 'utf8'),
  ]);

  let url = `${UPLOAD_BASE}/files?uploadType=multipart`;
  let method = 'POST';

  if (fileId) {
    url = `${UPLOAD_BASE}/files/${fileId}?uploadType=multipart`;
    method = 'PATCH';
  }

  const response = await fetchWithRetry(url, {
    method: method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartRequestBody,
  });

  if (!response.ok) {
    throw new Error(`Failed to write file: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Find or create a specific folder by name inside a parent folder
 */
export async function findOrCreateFolder(accessToken: string, folderName: string, parentId = 'root') {
  const safeName = escapeDriveQueryTerm(folderName);
  const safeParent = escapeDriveQueryTerm(parentId);
  const query = `name = '${safeName}' and '${safeParent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
  
  let response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  let data: any = await response.json();

  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  };

  response = await fetchWithRetry(`${API_BASE}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });

  data = await response.json();
  return data.id;
}

/**
 * Setup standard workspace folder structure: Quanta/Projects/{projectName}
 */
export async function setupWorkspaceFolder(accessToken: string, projectName: string) {
  const quantaId = await findOrCreateFolder(accessToken, 'Quanta', 'root');
  const projectsId = await findOrCreateFolder(accessToken, 'Projects', quantaId);
  return await findOrCreateFolder(accessToken, projectName, projectsId);
}

/**
 * Safe Trashing: Move file to Google Drive Trash (Replaces destructive DELETE)
 */
export async function trashDriveFile(accessToken: string, fileId: string) {
  const url = `${API_BASE}/files/${fileId}`;
  const response = await fetchWithRetry(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ trashed: true })
  });

  if (!response.ok) {
    throw new Error(`Failed to move file to trash: ${response.statusText}`);
  }
  return true;
}

// Backwards-compatible alias: calls trashDriveFile
export const deleteDriveFile = trashDriveFile;

/**
 * Get start page token for Google Drive Changes API
 */
export async function getStartPageToken(accessToken: string): Promise<string | null> {
  try {
    const url = `${API_BASE}/changes/startPageToken`;
    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (response.ok) {
      const data: any = await response.json();
      return data.startPageToken || null;
    }
  } catch (e) {
    console.warn('Failed to get Drive startPageToken:', e);
  }
  return null;
}

/**
 * Get Chats directory under Quanta
 */
export async function getChatsFolder(accessToken: string) {
  const quantaId = await findOrCreateFolder(accessToken, 'Quanta', 'root');
  return await findOrCreateFolder(accessToken, 'Chats', quantaId);
}
