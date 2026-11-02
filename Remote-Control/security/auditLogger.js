import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = process.env.QUANTA_LOG_DIR || path.join(__dirname, '..', 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.jsonl');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

export class AuditLogger {
    constructor() {
        this.ensureDir();
    }

    ensureDir() {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
    }

    /**
     * Redact sensitive tokens and passwords before logging.
     */
    redact(text) {
        if (typeof text !== 'string') return text;
        return text
            .replace(/(password|secret|token|key|apiKey)=([^\s&]+)/gi, '$1=[REDACTED]')
            .replace(/"(password|secret|token|key|apiKey)"\s*:\s*"[^"]+"/gi, '"$1":"[REDACTED]"')
            .replace(/(AIza[0-9A-Za-z-_]{35})/g, '[REDACTED_API_KEY]')
            .replace(/(ghp_[a-zA-Z0-9]{36})/g, '[REDACTED_GITHUB_TOKEN]')
            .replace(/(Bearer\s+[A-Za-z0-9\-._~+/]+=*)/gi, 'Bearer [REDACTED]')
            .replace(/(sk-[a-zA-Z0-9]{20,})/g, '[REDACTED_SECRET]');
    }

    rotate() {
        try {
            if (!fs.existsSync(AUDIT_FILE)) return;
            const stats = fs.statSync(AUDIT_FILE);
            if (stats.size >= MAX_LOG_SIZE) {
                const rotated2 = path.join(LOG_DIR, 'audit.2.jsonl');
                const rotated1 = path.join(LOG_DIR, 'audit.1.jsonl');
                if (fs.existsSync(rotated1)) fs.renameSync(rotated1, rotated2);
                fs.renameSync(AUDIT_FILE, rotated1);
            }
        } catch (e) {
            console.error('Audit log rotation failed:', e.message);
        }
    }

    log(eventOrType, maybeDetailsOrSummary) {
        try {
            this.ensureDir();
            this.rotate();

            let type = 'INFO';
            let ip = '127.0.0.1';
            let deviceId = 'anonymous';
            let summary = '';
            let details = undefined;

            if (typeof eventOrType === 'string') {
                type = eventOrType;
                if (typeof maybeDetailsOrSummary === 'string') {
                    summary = maybeDetailsOrSummary;
                } else if (maybeDetailsOrSummary && typeof maybeDetailsOrSummary === 'object') {
                    ip = maybeDetailsOrSummary.ip || ip;
                    deviceId = maybeDetailsOrSummary.deviceId || deviceId;
                    summary = maybeDetailsOrSummary.summary || maybeDetailsOrSummary.actionSummary || '';
                    if (maybeDetailsOrSummary.details !== undefined) {
                        details = maybeDetailsOrSummary.details;
                    } else {
                        const { ip: _ip, deviceId: _did, summary: _s, actionSummary: _as, ...rest } = maybeDetailsOrSummary;
                        details = Object.keys(rest).length > 0 ? rest : undefined;
                    }
                }
            } else if (eventOrType && typeof eventOrType === 'object') {
                type = eventOrType.type || eventOrType.eventType || type;
                ip = eventOrType.ip || ip;
                deviceId = eventOrType.deviceId || deviceId;
                summary = eventOrType.summary || eventOrType.actionSummary || '';
                details = eventOrType.details;
            }

            const entry = {
                timestamp: new Date().toISOString(),
                eventType: type,
                ip,
                deviceId,
                actionSummary: this.redact(summary),
                details: details ? JSON.parse(this.redact(JSON.stringify(details))) : undefined
            };

            const line = JSON.stringify(entry) + '\n';
            fs.appendFileSync(AUDIT_FILE, line, { encoding: 'utf8', mode: 0o600 });
        } catch (e) {
            console.error('Failed to write audit log:', e.message);
        }
    }

    getRecentEntries(limit = 50) {
        try {
            if (!fs.existsSync(AUDIT_FILE)) return [];
            const content = fs.readFileSync(AUDIT_FILE, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            return lines
                .slice(-limit)
                .map(line => {
                    try { return JSON.parse(line); } catch (e) { return null; }
                })
                .filter(Boolean)
                .reverse();
        } catch (e) {
            console.error('Failed to read audit log:', e.message);
            return [];
        }
    }
}

export const auditLogger = new AuditLogger();

