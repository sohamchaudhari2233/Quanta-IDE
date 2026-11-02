/**
 * Provider-Agnostic Cloud Storage Abstraction Interface
 */

export interface StorageFile {
  id: string;
  name: string; // relative file path
  mimeType?: string;
  size?: number;
  modifiedTime?: string;
  md5Checksum?: string;
  isFolder?: boolean;
}

export interface StorageProvider {
  readonly name: string;

  /**
   * List files in a directory or recursively across the project tree.
   */
  list(folderIdOrPath: string, recursive?: boolean): Promise<StorageFile[]>;

  /**
   * Retrieve file text content by ID or path.
   */
  get(fileIdOrPath: string): Promise<string>;

  /**
   * Create or update a file.
   */
  put(
    name: string,
    content: string,
    fileIdOrPath?: string | null,
    parentIdOrPath?: string
  ): Promise<StorageFile>;

  /**
   * Move file to non-destructive trash.
   */
  trash(fileIdOrPath: string): Promise<boolean>;

  /**
   * Find or create folder hierarchy.
   */
  ensureFolder(name: string, parentIdOrPath?: string): Promise<string>;

  /**
   * Optional incremental changes feed.
   */
  getChangesFeed?(cursor?: string): Promise<{ changes: StorageFile[]; nextCursor?: string }>;
}

