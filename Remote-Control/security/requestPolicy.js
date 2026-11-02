import net from 'node:net';

export function isLoopbackAddress(address = '') {
    return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

export function isLocalRequest(req) {
    if (Object.keys(req.headers || {}).some(name => /^(forwarded|x-forwarded-.+|x-real-ip|cf-connecting-ip|true-client-ip)$/i.test(name))) return false;
    let ip = req.socket?.remoteAddress || req.ip || '';
    if (isLoopbackAddress(ip)) return true;
    ip = ip.replace(/^::ffff:/i, '');
    if (net.isIP(ip) !== 4) return false;
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function isSameOrigin(req, origin) {
    if (!origin) return true; // Native clients may omit Origin.
    try {
        const url = new URL(origin);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
            url.origin === `${url.protocol}//${req.headers.host}`;
    } catch { return false; }
}

export function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
}

export function apiErrorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ success: false, error: status === 500 ? 'Request failed. Check server diagnostics.' :
        (error.type === 'entity.too.large' ? 'Request is too large.' : 'Invalid request.') });
}
