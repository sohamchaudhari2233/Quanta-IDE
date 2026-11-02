import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEVICES_FILE = process.env.QUANTA_DATA_DIR ? path.join(process.env.QUANTA_DATA_DIR, 'devices.json') : path.join(__dirname, '..', 'config', 'devices.json');

/**
 * Constant-time comparison of two string secrets using SHA-256 hashing.
 */
export function timingSafeEqualString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
    const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Validate password strength and disallow known weak/default passwords.
 */
export function validatePasswordSecurity(password, isExternalOrTunnel = false) {
    if (!password || typeof password !== 'string') {
        return { valid: false, reason: 'Password is required' };
    }
    const trimmed = password.trim();
    const disallowed = ['antigravity', 'your-secure-password', 'your-app-password', 'password', '12345678', 'admin', 'quanta'];
    if (disallowed.includes(trimmed.toLowerCase())) {
        return { valid: false, reason: `Default or common password '${trimmed}' is forbidden` };
    }
    if (isExternalOrTunnel && trimmed.length < 8) {
        return { valid: false, reason: 'External/tunnel mode requires an APP_PASSWORD of at least 8 characters' };
    }
    return { valid: true };
}

/**
 * RFC 6238 TOTP Engine using pure Node crypto.
 */
export class TotpEngine {
    static generateSecret(length = 20) {
        const randomBytes = crypto.randomBytes(length);
        return TotpEngine.base32Encode(randomBytes);
    }

    static base32Encode(buffer) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0;
        let value = 0;
        let output = '';
        for (let i = 0; i < buffer.length; i++) {
            value = (value << 8) | buffer[i];
            bits += 8;
            while (bits >= 5) {
                output += alphabet[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        if (bits > 0) {
            output += alphabet[(value << (5 - bits)) & 31];
        }
        return output;
    }

    static base32Decode(base32Str) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const cleaned = base32Str.toUpperCase().replace(/=+$/, '');
        let bits = 0;
        let value = 0;
        const bytes = [];
        for (let i = 0; i < cleaned.length; i++) {
            const idx = alphabet.indexOf(cleaned[i]);
            if (idx === -1) continue;
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8) {
                bytes.push((value >>> (bits - 8)) & 255);
                bits -= 8;
            }
        }
        return Buffer.from(bytes);
    }

    static generateToken(secretBase32, timeStepSeconds = 30, forTimeMs = Date.now()) {
        const key = TotpEngine.base32Decode(secretBase32);
        const counter = Math.floor(forTimeMs / 1000 / timeStepSeconds);
        const counterBuffer = Buffer.alloc(8);
        counterBuffer.writeBigUInt64BE(BigInt(counter));

        const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
        const offset = hmac[hmac.length - 1] & 0xf;
        const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
        return code.toString().padStart(6, '0');
    }

    static verifyToken(token, secretBase32, windowSteps = 1) {
        if (typeof token !== 'string' || typeof secretBase32 !== 'string' || !/^[A-Z2-7]+=*$/i.test(secretBase32)) return false;
        const cleanedToken = token.trim();
        if (!/^\d{6}$/.test(cleanedToken)) return false;
        const now = Date.now();
        const stepMs = 30 * 1000;

        for (let step = -windowSteps; step <= windowSteps; step++) {
            const expected = TotpEngine.generateToken(secretBase32, 30, now + (step * stepMs));
            if (timingSafeEqualString(cleanedToken, expected)) {
                return true;
            }
        }
        return false;
    }
}

/**
 * Server-Side Session & Device Pairing Registry.
 */
export class SessionManager {
    constructor(options = {}) {
        this.absoluteLifetimeMs = options.absoluteLifetimeMs || 24 * 60 * 60 * 1000; // 24 hours
        this.idleTimeoutMs = options.idleTimeoutMs || 2 * 60 * 60 * 1000; // 2 hours
        this.elevationTimeoutMs = options.elevationTimeoutMs || 30 * 60 * 1000; // 30 mins
        this.requirePairing = options.requirePairing ?? false;
        this.allowLanAutoTrust = options.allowLanAutoTrust ?? false;

        this.sessions = new Map(); // sessionId -> sessionData
        this.pairingTickets = new Map(); // ticket -> { createdAt, expiresAt }
        this.pendingDevices = new Map(); // deviceFingerprint -> { id, userAgent, ip, requestedAt }
        this.approvedDevices = this.loadApprovedDevices();
        this.activeControllerSessionId = null;

        // Cleanup interval
        this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
        if (this.cleanupInterval.unref) this.cleanupInterval.unref();
    }

    loadApprovedDevices() {
        try {
            if (fs.existsSync(DEVICES_FILE)) {
                return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('Failed to load devices.json:', e.message);
        }
        return {};
    }

    saveApprovedDevices() {
        try {
            const dir = path.dirname(DEVICES_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(DEVICES_FILE, JSON.stringify(this.approvedDevices, null, 2), 'utf8');
        } catch (e) {
            console.error('Failed to save devices.json:', e.message);
        }
    }

    createPairingTicket(ttlSeconds = 120) {
        const ticket = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        this.pairingTickets.set(ticket, {
            createdAt: now,
            expiresAt: now + (ttlSeconds * 1000)
        });
        return ticket;
    }

    consumePairingTicket(ticket) {
        if (!ticket) return false;
        const entry = this.pairingTickets.get(ticket);
        if (!entry) return false;
        this.pairingTickets.delete(ticket);
        if (Date.now() > entry.expiresAt) return false;
        return true;
    }

    computeDeviceFingerprint(req) {
        const ua = req.headers['user-agent'] || 'unknown';
        const lang = req.headers['accept-language'] || '';
        return crypto.createHash('sha256').update(`${ua}|${lang}`).digest('hex').substring(0, 16);
    }

    isDeviceApproved(fingerprint) {
        return !!this.approvedDevices[fingerprint];
    }

    requestDevicePairing(fingerprint, userAgent, ip) {
        if (this.isDeviceApproved(fingerprint)) return true;
        if (!this.pendingDevices.has(fingerprint)) {
            this.pendingDevices.set(fingerprint, {
                fingerprint,
                userAgent,
                ip,
                requestedAt: Date.now()
            });
            console.log(`\n🔔 NEW DEVICE PAIRING REQUEST: [${fingerprint}] from ${ip} (${userAgent})`);
            console.log(`   Run command or call approve endpoint to authorize this device.\n`);
        }
        return false;
    }

    approveDevice(fingerprint) {
        this.pendingDevices.delete(fingerprint);
        this.approvedDevices[fingerprint] = {
            approvedAt: Date.now(),
            lastSeen: Date.now()
        };
        this.saveApprovedDevices();
        return true;
    }

    revokeDevice(fingerprint) {
        delete this.approvedDevices[fingerprint];
        this.saveApprovedDevices();
        // Invalidate any active sessions for this device
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.deviceFingerprint === fingerprint) {
                this.destroySession(sessionId);
            }
        }
    }

    createSession({ ip, userAgent, isLocal, isTunnel, deviceFingerprint }) {
        const sessionId = crypto.randomBytes(48).toString('hex');
        const now = Date.now();
        const fingerprint = crypto.createHash('sha256').update(`${userAgent}|${ip}`).digest('hex').substring(0, 16);

        // Security baseline: external/tunnel is read-only by default. Local LAN is control if configured.
        const defaultMode = (isLocal && !isTunnel) ? 'control' : 'read-only';

        const session = {
            id: sessionId,
            deviceFingerprint: deviceFingerprint || fingerprint,
            ip,
            userAgent,
            isLocal: !!isLocal,
            isTunnel: !!isTunnel,
            mode: defaultMode,
            elevatedUntil: defaultMode === 'control' ? (now + this.elevationTimeoutMs) : null,
            createdAt: now,
            lastSeenAt: now
        };

        this.sessions.set(sessionId, session);
        return session;
    }

    getSession(sessionId, touch = true) {
        if (!sessionId) return null;
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        const now = Date.now();
        // Check absolute expiry
        if (now - session.createdAt > this.absoluteLifetimeMs) {
            this.destroySession(sessionId);
            return null;
        }
        // Check idle timeout
        if (now - session.lastSeenAt > this.idleTimeoutMs) {
            this.destroySession(sessionId);
            return null;
        }

        // Check if elevated control mode has expired
        if (session.mode === 'control' && session.isTunnel && session.elevatedUntil && now > session.elevatedUntil) {
            session.mode = 'read-only';
            session.elevatedUntil = null;
        }

        if (touch) session.lastSeenAt = now;
        return session;
    }

    elevateSession(sessionId, durationMs = this.elevationTimeoutMs) {
        const session = this.getSession(sessionId);
        if (!session) return false;
        session.mode = 'control';
        session.elevatedUntil = Date.now() + durationMs;
        // Automatically claim controller lock if none exists
        if (!this.activeControllerSessionId || !this.getSession(this.activeControllerSessionId)) {
            this.activeControllerSessionId = sessionId;
        }
        return true;
    }

    claimController(sessionId, force = false) {
        const session = this.getSession(sessionId);
        if (!session) return { success: false, reason: 'Invalid session' };
        if (session.mode !== 'control') return { success: false, reason: 'Session must be elevated to control mode' };

        const currentActive = this.activeControllerSessionId ? this.getSession(this.activeControllerSessionId) : null;
        if (currentActive && currentActive.id !== sessionId && !force) {
            return {
                success: false,
                reason: 'Another device is currently controlling',
                currentController: {
                    ip: currentActive.ip,
                    userAgent: currentActive.userAgent,
                    lastSeenAt: currentActive.lastSeenAt
                }
            };
        }

        this.activeControllerSessionId = sessionId;
        return { success: true };
    }

    releaseController(sessionId) {
        if (this.activeControllerSessionId === sessionId) {
            this.activeControllerSessionId = null;
            return true;
        }
        return false;
    }

    isController(sessionId) {
        const active = this.sessions.get(this.activeControllerSessionId);
        if (!active || active.mode !== 'control' || !this.getSession(active.id, false)) this.activeControllerSessionId = null;
        if (!this.activeControllerSessionId) {
            const session = this.getSession(sessionId);
            if (session && session.mode === 'control') {
                this.activeControllerSessionId = sessionId;
                return true;
            }
            return false;
        }
        return this.activeControllerSessionId === sessionId;
    }

    getConnectedDevices() {
        const list = [];
        const now = Date.now();
        for (const s of this.sessions.values()) {
            if (now - s.lastSeenAt <= this.idleTimeoutMs) {
                list.push({
                    sessionId: s.id.substring(0, 8) + '...',
                    fingerprint: s.deviceFingerprint,
                    ip: s.ip,
                    userAgent: s.userAgent,
                    mode: s.mode,
                    role: this.activeControllerSessionId === s.id ? 'controller' : 'spectator',
                    connectedDurationSeconds: Math.round((now - s.createdAt) / 1000)
                });
            }
        }
        return list;
    }

    demoteSession(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) return false;
        session.mode = 'read-only';
        session.elevatedUntil = null;
        this.releaseController(sessionId);
        return true;
    }

    destroySession(sessionId) {
        this.releaseController(sessionId);
        return this.sessions.delete(sessionId);
    }

    cleanup() {
        const now = Date.now();
        // Clean sessions
        for (const [id, s] of this.sessions.entries()) {
            if (now - s.createdAt > this.absoluteLifetimeMs || now - s.lastSeenAt > this.idleTimeoutMs) {
                this.destroySession(id);
            }
        }
        // Clean pairing tickets
        for (const [ticket, entry] of this.pairingTickets.entries()) {
            if (now > entry.expiresAt) {
                this.pairingTickets.delete(ticket);
            }
        }
    }
}

