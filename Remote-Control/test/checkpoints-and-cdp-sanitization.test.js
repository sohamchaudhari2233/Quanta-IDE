import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import vm from 'vm';
import { checkpointManager, CheckpointManager } from '../agent/checkpoints.js';

// =========================================================================
// Helper: CDP Expression Builders mirroring server.js logic
// =========================================================================
function buildClickExpression({ selector, index = 0, textContent = '' }) {
    if (!selector || typeof selector !== 'string') {
        throw new Error('Selector must be a non-empty string');
    }
    const safeSelector = JSON.stringify(selector);
    const targetIndex = Number.isInteger(Number(index)) ? Math.max(0, parseInt(index, 10)) : 0;
    const safeText = JSON.stringify(typeof textContent === 'string' ? textContent : '');

    return `(async () => {
        try {
            const selectorStr = ${safeSelector};
            const targetIndex = ${targetIndex};
            const filterText = ${safeText};

            const root = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade') || document;
            let elements = Array.from(root.querySelectorAll(selectorStr));
            if (filterText) {
                elements = elements.filter(el => {
                    const txt = (el.innerText || el.textContent || '').trim();
                    const firstLine = txt.split('\\n')[0].trim();
                    return firstLine === filterText || txt.includes(filterText);
                });
                elements = elements.filter(el => {
                    return !elements.some(other => other !== el && el.contains(other));
                });
            }
            const target = elements[targetIndex];
            if (target) {
                if (target.focus) target.focus();
                target.click();
                return { success: true, found: elements.length, indexUsed: targetIndex };
            }
            return { error: 'Element not found at index ' + targetIndex + ' among ' + elements.length + ' matches' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;
}

function buildScrollExpression({ scrollTop = 0, scrollPercent }) {
    const hasPercent = scrollPercent !== undefined && scrollPercent !== null && Number.isFinite(Number(scrollPercent));
    const safePercent = hasPercent ? Math.min(Math.max(Number(scrollPercent), 0), 1) : null;
    const safeScrollTop = (scrollTop !== undefined && scrollTop !== null && Number.isFinite(Number(scrollTop)))
        ? Math.max(0, Number(scrollTop))
        : 0;

    return `(async () => {
        try {
            const percent = ${JSON.stringify(safePercent)};
            const topVal = ${JSON.stringify(safeScrollTop)};

            const scrollables = [...document.querySelectorAll('#conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], #conversation [style*="overflow"], #chat [style*="overflow"], #cascade [style*="overflow"]')]
                .filter(el => el.scrollHeight > el.clientHeight);
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            const target = scrollables[0];
            if (percent !== null) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * percent;
            } else {
                target.scrollTop = topVal;
            }
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;
}

// =========================================================================
// Suite 1: CheckpointManager Integration & Shadow Git Operations
// =========================================================================
test('CheckpointManager: listCheckpoints with no arguments defaults to process.cwd() without throwing', () => {
    // Calling with no arguments must cleanly return an array without throwing TypeError
    const res = checkpointManager.listCheckpoints();
    assert.ok(Array.isArray(res));
});

test('CheckpointManager: listCheckpoints with numeric limit only defaults root', () => {
    const res = checkpointManager.listCheckpoints(10);
    assert.ok(Array.isArray(res));
});

test('CheckpointManager: full snapshot, list, and rollback lifecycle in temporary workspace', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-ckpt-lifecycle-'));
    try {
        const mgr = new CheckpointManager();
        const testFile = path.join(tempDir, 'app.js');

        // Initial snapshot
        fs.writeFileSync(testFile, 'console.log("v1");', 'utf8');
        const ckpt1 = mgr.createCheckpoint(tempDir, 'Initial v1 commit');
        assert.ok(ckpt1);
        assert.ok(ckpt1.id);

        // List checkpoints
        const list = mgr.listCheckpoints(tempDir, 10);
        assert.ok(list.length >= 1);
        assert.equal(list[0].id, ckpt1.id);

        // Modify file & second snapshot
        fs.writeFileSync(testFile, 'console.log("v2 modified");', 'utf8');
        const ckpt2 = mgr.createCheckpoint(tempDir, 'Update v2');
        assert.ok(ckpt2);

        assert.equal(fs.readFileSync(testFile, 'utf8'), 'console.log("v2 modified");');

        // Rollback to v1
        const rollbackRes = mgr.rollback(tempDir, ckpt1.id);
        assert.equal(rollbackRes.success, true);
        assert.equal(fs.readFileSync(testFile, 'utf8'), 'console.log("v1");');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('CheckpointManager: polymorphic rollback gracefully accepts (checkpointId, options)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanta-ckpt-polytest-'));
    const origCwd = process.cwd();
    try {
        const mgr = new CheckpointManager();
        process.chdir(tempDir);

        const testFile = path.join(tempDir, 'index.js');
        fs.writeFileSync(testFile, 'const x = 1;', 'utf8');
        const c1 = mgr.createCheckpoint(tempDir, 'v1');

        fs.writeFileSync(testFile, 'const x = 2;', 'utf8');
        mgr.createCheckpoint(tempDir, 'v2');

        // Call with (checkpointId, options) signature matching server.js:2308
        const res = mgr.rollback(c1.id, { user: 'mobile' });
        assert.equal(res.success, true);
        assert.equal(fs.readFileSync(testFile, 'utf8'), 'const x = 1;');
    } finally {
        process.chdir(origCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('CheckpointManager: rollback strictly rejects shell injection in checkpointId', () => {
    const mgr = new CheckpointManager();
    assert.throws(
        () => mgr.rollback('C:\\fake\\path', 'HEAD; rm -rf /'),
        /Invalid checkpointId format/i
    );
    assert.throws(
        () => mgr.rollback('C:\\fake\\path', 'abc" & calc.exe & "'),
        /Invalid checkpointId format/i
    );
});

// =========================================================================
// Suite 2: CDP Script Sanitization & Anti-Injection
// =========================================================================
test('CDP Sanitization: buildClickExpression safely neutralizes code breakout in selector', () => {
    const maliciousSelector = "button')); (()=>{ globalThis.__pwned_click = true; })(); (('";
    const expression = buildClickExpression({ selector: maliciousSelector, index: 0 });

    const mockDom = {
        globalThis: {},
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: (sel) => {
                // Assert the selector was parsed as an intact string literal
                assert.equal(sel, maliciousSelector);
                return [];
            }
        }
    };
    vm.createContext(mockDom);
    vm.runInContext(expression, mockDom);

    assert.equal(mockDom.globalThis.__pwned_click, undefined);
});

test('CDP Sanitization: buildClickExpression sanitizes index parameter injection', () => {
    const maliciousIndex = "0]; (()=>{ globalThis.__pwned_idx = true; })(); elements[0";
    const expression = buildClickExpression({ selector: 'button', index: maliciousIndex });

    const mockDom = {
        globalThis: {},
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        }
    };
    vm.createContext(mockDom);
    vm.runInContext(expression, mockDom);

    assert.equal(mockDom.globalThis.__pwned_idx, undefined);
});

test('CDP Sanitization: buildScrollExpression neutralizes injection in scrollPercent and scrollTop', () => {
    const maliciousScrollPercent = "(()=>{ globalThis.__pwned_scroll = true; return 0.5; })()";
    const maliciousScrollTop = "(()=>{ globalThis.__pwned_top = true; return 100; })()";

    const expr = buildScrollExpression({
        scrollPercent: maliciousScrollPercent,
        scrollTop: maliciousScrollTop
    });

    const mockDom = {
        globalThis: {},
        document: {
            querySelectorAll: () => [{ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }]
        }
    };
    vm.createContext(mockDom);
    vm.runInContext(expr, mockDom);

    assert.equal(mockDom.globalThis.__pwned_scroll, undefined);
    assert.equal(mockDom.globalThis.__pwned_top, undefined);
});

test('CDP Sanitization: buildScrollExpression correctly handles valid numeric scroll values', () => {
    const expr = buildScrollExpression({ scrollPercent: 0.5, scrollTop: 120 });
    const mockTarget = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const mockDom = {
        document: { querySelectorAll: () => [mockTarget] }
    };
    vm.createContext(mockDom);
    vm.runInContext(expr, mockDom);

    // Max scroll is 1000 - 200 = 800. 50% is 400.
    assert.equal(mockTarget.scrollTop, 400);
});
