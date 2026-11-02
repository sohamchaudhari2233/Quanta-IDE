import crypto from 'crypto';
import { isLoopbackAddress } from './requestPolicy.js';

/**
 * In-memory Token Bucket Rate Limiter with Temporary Lockout and Exponential Backoff.
 */
export class RateLimiter {
    constructor(options = {}) {
        this.maxAttempts = options.maxAttempts || 5;
        this.lockoutDurationMs = options.lockoutDurationMs || 15 * 60 * 1000; // 15 minutes
        this.windowMs = options.windowMs || 60 * 1000; // 1 minute
        this.attempts = new Map(); // ip -> { count, firstAttempt, lockedUntil }
        
        // Periodic cleanup every 5 minutes
        this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
        if (this.cleanupInterval.unref) this.cleanupInterval.unref();
    }

    /**
     * Check if an IP is currently locked out.
     */
    isLocked(ip) {
        const record = this.attempts.get(ip);
        if (!record) return false;
        if (record.lockedUntil && Date.now() < record.lockedUntil) {
            return true;
        }
        if (record.lockedUntil && Date.now() >= record.lockedUntil) {
            this.attempts.delete(ip);
            return false;
        }
        return false;
    }

    /**
     * Get remaining lockout time in seconds.
     */
    getRemainingLockoutSec(ip) {
        const record = this.attempts.get(ip);
        if (!record || !record.lockedUntil) return 0;
        return Math.max(0, Math.ceil((record.lockedUntil - Date.now()) / 1000));
    }

    /**
     * Record a failed attempt. Triggers lockout if threshold is exceeded.
     */
    recordFailure(ip) {
        const now = Date.now();
        let record = this.attempts.get(ip);

        if (!record) {
            record = { count: 1, firstAttempt: now, lockedUntil: null };
            this.attempts.set(ip, record);
            return { locked: false, attemptsRemaining: this.maxAttempts - 1 };
        }

        // Reset if window has elapsed and not locked
        if (!record.lockedUntil && now - record.firstAttempt > this.windowMs) {
            record.count = 1;
            record.firstAttempt = now;
            return { locked: false, attemptsRemaining: this.maxAttempts - 1 };
        }

        record.count += 1;
        if (record.count >= this.maxAttempts) {
            // Apply exponential backoff based on previous lockouts
            const multiplier = record.lockoutCount ? Math.min(record.lockoutCount * 2, 8) : 1;
            record.lockoutCount = (record.lockoutCount || 0) + 1;
            record.lockedUntil = now + (this.lockoutDurationMs * multiplier);
            return { locked: true, lockoutSec: Math.ceil((this.lockoutDurationMs * multiplier) / 1000) };
        }

        return { locked: false, attemptsRemaining: Math.max(0, this.maxAttempts - record.count) };
    }

    /**
     * Record a successful attempt, resetting failure count.
     */
    recordSuccess(ip) {
        this.attempts.delete(ip);
    }

    /**
     * Remove stale records.
     */
    cleanup() {
        const now = Date.now();
        for (const [ip, record] of this.attempts.entries()) {
            if (record.lockedUntil && now >= record.lockedUntil) {
                this.attempts.delete(ip);
            } else if (!record.lockedUntil && now - record.firstAttempt > this.windowMs) {
                this.attempts.delete(ip);
            }
        }
    }
}

/**
 * Resolve client IP using explicit tunnel provider rules.
 */
export function getClientIp(req, trustProxyMode = 'auto') {
    const peer = req.socket?.remoteAddress || req.ip || 'unknown';
    // A local tunnel process may supply forwarding headers. Direct LAN/internet
    // clients cannot choose their own rate-limit bucket with a forged header.
    if (!isLoopbackAddress(peer) || trustProxyMode === 'false') return peer;
    if (trustProxyMode === 'cloudflare') {
        const cfIp = req.headers['cf-connecting-ip'];
        if (cfIp) return Array.isArray(cfIp) ? cfIp[0].trim() : cfIp.split(',')[0].trim();
    }

    if (trustProxyMode === 'true' || trustProxyMode === 'auto' || trustProxyMode === 'ngrok') {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
            const list = Array.isArray(forwarded) ? forwarded[0] : forwarded;
            return list.split(',')[0].trim();
        }
        const realIp = req.headers['x-real-ip'];
        if (realIp) return Array.isArray(realIp) ? realIp[0].trim() : realIp.trim();
    }

    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

