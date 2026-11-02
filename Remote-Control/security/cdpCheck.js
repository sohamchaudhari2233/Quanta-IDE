import os from 'os';
import http from 'http';

/**
 * Audit and verify that Chromium/Antigravity CDP is NOT exposed to external/LAN network interfaces.
 */
export async function verifyCdpSecurity(port = 9000) {
    const interfaces = os.networkInterfaces();
    const externalIps = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (!iface.internal && (iface.family === 'IPv4' || iface.family === 4)) {
                externalIps.push(iface.address);
            }
        }
    }

    const exposed = [];

    for (const ip of externalIps) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.get(`http://${ip}:${port}/json/version`, { timeout: 800 }, (res) => {
                    if (res.statusCode === 200) {
                        exposed.push(ip);
                    }
                    resolve();
                });
                req.on('error', () => resolve());
                req.on('timeout', () => { req.destroy(); resolve(); });
            });
        } catch (e) {
            // Ignored, connection failed as expected
        }
    }

    if (exposed.length > 0) {
        console.error('\n' + '='.repeat(70));
        console.error('🚨 CRITICAL SECURITY WARNING: CDP PORT EXPOSED ON NETWORK');
        console.error(`   Antigravity remote debugging port ${port} is reachable on:`);
        exposed.forEach(ip => console.error(`   👉 http://${ip}:${port}`));
        console.error('   ANY DEVICE ON YOUR NETWORK CAN EXECUTE CODE ON YOUR MACHINE!');
        console.error('   REMEDIATION:');
        console.error('   Start Antigravity with explicit loopback binding:');
        console.error(`   antigravity . --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`);
        console.error('='.repeat(70) + '\n');
        return { secure: false, exposedIps: exposed };
    }

    return { secure: true, exposedIps: [] };
}

