export function canUseDemoLogin(req, enabled = process.env.ENABLE_DEMO_LOGIN === 'true') {
    const address = req.socket?.remoteAddress;
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
    const forwarded = Object.keys(req.headers || {}).some(name =>
        /^(forwarded|x-forwarded-.+|cf-connecting-ip|true-client-ip)$/i.test(name));
    return enabled && loopback && !forwarded;
}
