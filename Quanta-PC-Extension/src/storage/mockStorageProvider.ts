import * as crypto from 'crypto';
import type { StorageProvider, StorageFile } from './storageProvider.ts';

/**
 * In-Memory Mock Storage Provider for Unit Testing and Offline Verification.
 */
export class MockStorageProvider implements StorageProvider {
  public readonly name = 'mock';
  private files: Map<string, { content: string; md5: string; trashed: boolean }> = new Map();

  async list(folderIdOrPath: string, recursive: boolean = true): Promise<StorageFile[]> {
    const results: StorageFile[] = [];
    for (const [path, entry] of this.files.entries()) {
      if (!entry.trashed) {
        results.push({
          id: `id-${path}`,
          name: path,
          md5Checksum: entry.md5,
          size: entry.content.length,
          modifiedTime: new Date().toISOString()
        });
      }
    }
    return results;
  }

  async get(fileIdOrPath: string): Promise<string> {
    const cleanPath = fileIdOrPath.replace(/^id-/, '');
    const entry = this.files.get(cleanPath);
    if (!entry || entry.trashed) {
      throw new Error(`File not found: ${cleanPath}`);
    }
    return entry.content;
  }

  async put(
    name: string,
    content: string,
    fileIdOrPath?: string | null,
    parentIdOrPath?: string
  ): Promise<StorageFile> {
    const md5 = crypto.createHash('md5').update(content).digest('hex');
    this.files.set(name, { content, md5, trashed: false });
    return {
      id: `id-${name}`,
      name,
      md5Checksum: md5,
      size: content.length,
      modifiedTime: new Date().toISOString()
    };
  }

  async trash(fileIdOrPath: string): Promise<boolean> {
    const cleanPath = fileIdOrPath.replace(/^id-/, '');
    const entry = this.files.get(cleanPath);
    if (entry) {
      entry.trashed = true;
      return true;
    }
    return false;
  }

  async ensureFolder(name: string, parentIdOrPath?: string): Promise<string> {
    return `folder-${name}`;
  }
}
