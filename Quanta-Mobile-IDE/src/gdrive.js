// gdrive.js - Helper functions for Google Drive API

const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/**
 * List files in a specific folder (or root)
 */
export async function listDriveFiles(accessToken, folderId = 'root') {
  const query = `'${folderId}' in parents and trashed = false`;
  const url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)`;
  
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.statusText}`);
  }

  const data = await response.json();
  return data.files;
}

/**
 * List files recursively in a folder and return them with relative paths
 */
export async function listDriveFilesRecursive(accessToken, folderId, currentPath = '') {
  const query = `'${folderId}' in parents and trashed = false`;
  const url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)`;
  
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Failed to list files recursively: ${response.statusText}`);
  
  const data = await response.json();
  let allFiles = [];
  
  for (const file of data.files) {
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      const folderPath = currentPath + file.name + '/';
      allFiles.push({
        ...file,
        name: folderPath
      });
      const subFiles = await listDriveFilesRecursive(accessToken, file.id, folderPath);
      allFiles.push(...subFiles);
    } else {
      allFiles.push({
        ...file,
        name: currentPath + file.name // Replace name with full relative path
      });
    }
  }
  
  return allFiles;
}

/**
 * Read text content of a file
 */
export async function readDriveFile(accessToken, fileId) {
  const url = `${API_BASE}/files/${fileId}?alt=media`;
  
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to read file: ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Create or update a text file
 */
export async function writeDriveFile(accessToken, name, content, fileId = null, parentId = 'root') {
  const metadata = {
    name: name,
    mimeType: 'text/plain', // or specific mime types based on extension
  };

  if (!fileId) {
    metadata.parents = [parentId];
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'text/plain' }));

  const url = fileId 
    ? `${UPLOAD_BASE}/files/${fileId}?uploadType=multipart`
    : `${UPLOAD_BASE}/files?uploadType=multipart`;

  const method = fileId ? 'PATCH' : 'POST';

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Failed to write file: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Find a folder by name, or create it if it doesn't exist
 */
export async function findOrCreateFolder(accessToken, folderName, parentId = 'root') {
  const query = `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
  
  let response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  let data = await response.json();

  if (data.files && data.files.length > 0) {
    return data.files[0].id; // Return existing folder ID
  }

  // Create folder if it doesn't exist
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  };

  response = await fetch(`${API_BASE}/files`, {
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
 * Recursively create folders for a file path (e.g. src/components/Button.jsx)
 * Returns the folder ID of the innermost folder.
 */
export async function ensurePathInDrive(accessToken, filePath, rootFolderId) {
  const parts = filePath.split('/');
  if (parts.length <= 1) return rootFolderId;
  
  let currentParentId = rootFolderId;
  for (let i = 0; i < parts.length - 1; i++) {
    const folderName = parts[i];
    currentParentId = await findOrCreateFolder(accessToken, folderName, currentParentId);
  }
  return currentParentId;
}

/**
 * Set up the "Quanta IDE/<projectname>/" folder structure
 */
export async function setupWorkspaceFolder(accessToken, projectName = 'My App') {
  const quantaId = await findOrCreateFolder(accessToken, 'Quanta IDE', 'root');
  const projectId = await findOrCreateFolder(accessToken, projectName, quantaId);
  return projectId;
}

/**
 * Get or create "Quanta IDE/Antigravity Chats" folder
 */
export async function getChatsFolder(accessToken) {
  const quantaId = await findOrCreateFolder(accessToken, 'Quanta IDE', 'root');
  const chatsId = await findOrCreateFolder(accessToken, 'Antigravity Chats', quantaId);
  return chatsId;
}

/**
 * Delete a file (moves to trash)
 */
export async function deleteDriveFile(accessToken, fileId) {
  const url = `${API_BASE}/files/${fileId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete file: ${response.statusText}`);
  }
  return true;
}

/**
 * Rename a file or folder on Google Drive
 */
export async function renameDriveItem(accessToken, fileId, newName) {
  const url = `${API_BASE}/files/${fileId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: newName }),
  });

  if (!response.ok) {
    throw new Error(`Failed to rename item: ${response.statusText}`);
  }
  return await response.json();
}

/**
 * List all project folders inside "Quanta IDE"
 */
export async function listProjectFolders(accessToken) {
  const quantaId = await findOrCreateFolder(accessToken, 'Quanta IDE', 'root');
  const query = `'${quantaId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
  
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return [];
  const data = await response.json();
  return data.files || [];
}

/**
 * List all items (files & subfolders) inside a given folder
 */
export async function listDriveFolderContents(accessToken, folderId = 'root') {
  const query = `'${folderId}' in parents and trashed = false`;
  const url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size,modifiedTime)`;
  
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list directory contents: ${response.statusText}`);
  }

  const data = await response.json();
  return data.files || [];
}
