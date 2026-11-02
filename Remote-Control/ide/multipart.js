const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function parseMultipart(req) {
    const type = req.headers['content-type'] || '';
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
    if (!/^multipart\/form-data\b/i.test(type) || !boundary) throw Object.assign(new Error('A multipart file is required'), { status: 400 });
    const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
    if (marker.length > 202) throw Object.assign(new Error('Invalid boundary'), { status: 400 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Upload exceeds 10 MB'), { status: 413 });
        chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const start = buffer.indexOf(marker);
    const headerEnd = buffer.indexOf('\r\n\r\n', start + marker.length);
    if (start !== 0 || headerEnd < 0 || headerEnd > 16384) throw Object.assign(new Error('Invalid multipart headers'), { status: 400 });
    const header = buffer.subarray(marker.length, headerEnd).toString('utf8');
    const filename = /filename="([^"\r\n]+)"/.exec(header)?.[1];
    const end = buffer.indexOf(Buffer.concat([Buffer.from('\r\n'), marker]), headerEnd + 4);
    if (!filename || end < 0) throw Object.assign(new Error('Invalid multipart file'), { status: 400 });
    return { filename, data: buffer.subarray(headerEnd + 4, end) };
}
