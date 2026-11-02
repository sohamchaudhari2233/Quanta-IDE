// Rasterize the existing two-stroke Quanta header mark into valid PWA icons.
// The previous PNG and ICO files had been corrupted by UTF-8 decoding.
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
    return Buffer.concat([length, name, bytes, crc]);
}
function icon(size) {
    const raw = Buffer.alloc(size * (size * 4 + 1));
    const lines = [[8, 18, 12, 6], [12, 18, 16, 6]];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const px = (x + 0.5) * 24 / size, py = (y + 0.5) * 24 / size;
        const gold = lines.some(([x1, y1, x2, y2]) => {
            const t = Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
            return Math.hypot(px - x1 - t * (x2 - x1), py - y1 - t * (y2 - y1)) <= 0.9;
        });
        const offset = y * (size * 4 + 1) + 1 + x * 4;
        raw.set(gold ? [217, 164, 65, 255] : [26, 26, 25, 255], offset);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const assets = new URL('../Remote-Control/public/assets/', import.meta.url);
const large = icon(512);
fs.writeFileSync(new URL('antigravity.png', assets), large);
fs.writeFileSync(new URL('icon-192.png', assets), icon(192));
// ICO supports an embedded PNG image with dimensions encoded as 0 for 256px.
const small = icon(256);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(small.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(new URL('../Remote-Control/public/favicon.ico', import.meta.url), Buffer.concat([ico, small]));
console.log('Generated valid 192px, 512px PNG icons and 256px ICO.');
