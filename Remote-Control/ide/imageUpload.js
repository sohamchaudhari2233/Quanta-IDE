import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { auditLogger } from '../security/auditLogger.js';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Sniffs MIME type from buffer magic bytes.
 */
export function sniffImageMimeType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return { mime: 'image/png', ext: 'png' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }

  // GIF: 'GIF87a' or 'GIF89a'
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { mime: 'image/gif', ext: 'gif' };
  }

  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }

  return null;
}

/**
 * Strips APP1 EXIF segment from JPEG buffer in pure JS to protect user privacy.
 */
export function stripJpegExif(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    return buffer;
  }

  const pieces = [Buffer.from([0xFF, 0xD8])];
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      // Non-marker byte, remainder is entropy-coded image data
      pieces.push(buffer.subarray(offset));
      break;
    }

    const marker = buffer[offset + 1];
    offset += 2;

    // Standalone markers without length: SOI(D8), EOI(D9), TEM(01), RST0-7(D0-D7)
    if (marker === 0xD9) {
      pieces.push(Buffer.from([0xFF, 0xD9]));
      break;
    }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      pieces.push(Buffer.from([0xFF, marker]));
      continue;
    }

    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > buffer.length) break;

    // Check if APP1 (0xE1) is EXIF (starts with Exif\0\0)
    const isApp1 = marker === 0xE1;
    let isExif = false;
    if (isApp1 && segmentLength >= 8) {
      const header = buffer.toString('utf8', offset + 2, offset + 6);
      if (header === 'Exif') {
        isExif = true;
      }
    }

    if (!isExif) {
      // Keep marker and segment
      pieces.push(Buffer.from([0xFF, marker]));
      pieces.push(buffer.subarray(offset, segmentEnd));
    }

    offset = segmentEnd;

    // SOS (Start of Scan) marker indicates rest of data is image scan
    if (marker === 0xDA) {
      pieces.push(buffer.subarray(offset));
      break;
    }
  }

  return Buffer.concat(pieces);
}

export class ImageUploader {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.uploadDir = path.join(this.workspaceRoot, '.quanta', 'uploads');
  }

  setWorkspaceRoot(root) {
    this.workspaceRoot = path.resolve(root);
    this.uploadDir = path.join(this.workspaceRoot, '.quanta', 'uploads');
  }

  /**
   * Process and save image buffer.
   * @param {Buffer} buffer 
   * @param {string} originalName 
   * @param {object} session 
   */
  async processAndSaveImage(buffer, originalName = 'upload.png', session = null) {
    if (!buffer || buffer.length === 0) {
      throw new Error('Image buffer cannot be empty');
    }

    if (buffer.length > MAX_IMAGE_SIZE) {
      throw new Error(`Image size exceeds ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit`);
    }

    const typeInfo = sniffImageMimeType(buffer);
    if (!typeInfo) {
      throw new Error('Unsupported image format. Allowed: PNG, JPEG, GIF, WEBP');
    }

    let cleanBuffer = buffer;
    if (typeInfo.ext === 'jpg') {
      try {
        cleanBuffer = stripJpegExif(buffer);
      } catch (err) {
        // If stripping fails, fall back to original cleanBuffer
      }
    }

    const hash = crypto.createHash('sha256').update(cleanBuffer).digest('hex');
    const filename = `${hash.slice(0, 16)}.${typeInfo.ext}`;

    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }

    const targetPath = path.join(this.uploadDir, filename);
    fs.writeFileSync(targetPath, cleanBuffer);

    const relativePath = path.posix.join('.quanta', 'uploads', filename);
    const markdown = `![${path.basename(originalName, path.extname(originalName)) || 'image'}](${relativePath})`;

    auditLogger.log('IMAGE_UPLOAD', {
      filename,
      relativePath,
      bytes: cleanBuffer.length,
      mime: typeInfo.mime,
      user: session?.user || 'remote'
    });

    return {
      filename,
      relativePath,
      url: `/api/uploads/${filename}`,
      bytes: cleanBuffer.length,
      mime: typeInfo.mime,
      hash,
      markdown
    };
  }
}

export const imageUploader = new ImageUploader();

