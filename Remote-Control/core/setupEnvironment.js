import crypto from 'node:crypto';
import dotenv from 'dotenv';

export function prepareEnvironment(content) {
    const values = dotenv.parse(content);
    let updated = false;
    for (const key of ['APP_PASSWORD', 'SESSION_SECRET', 'AUTH_SALT']) {
        const value = values[key]?.trim();
        const placeholder = !value || /^your[-_]/i.test(value) ||
            ['antigravity', 'antigravity_secret_key_1337', 'antigravity_default_salt_99', 'password', 'admin', 'quanta', '12345678'].includes(value.toLowerCase());
        if (!placeholder) continue;
        const secret = crypto.randomBytes(key === 'APP_PASSWORD' ? 18 : 32).toString('hex');
        const assignment = new RegExp(`^\\s*${key}\\s*=.*$`, 'gm');
        content = content.replace(assignment, '');
        content += `\n${key}=${secret}\n`;
        updated = true;
    }
    return { content, updated };
}
