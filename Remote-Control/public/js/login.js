// Quanta IDE — Login Controller with Dynamic 2FA TOTP Support (F-23)
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('loginForm');
    const input = document.getElementById('password');
    const totpInput = document.getElementById('totp');
    const totpGroup = document.getElementById('totpGroup');
    const btnToggleTotp = document.getElementById('btnToggleTotp');
    const btn = document.getElementById('loginBtn');
    const toggleEye = document.getElementById('togglePasswordBtn');
    const errorBox = document.getElementById('loginError');
    const errorText = document.getElementById('loginErrorText');
    let loginPending = false;

    // Theme Switcher Buttons
    const themeButtons = document.querySelectorAll('[data-theme-select]');
    themeButtons.forEach(b => {
        b.addEventListener('click', () => {
            const theme = b.getAttribute('data-theme-select');
            switchTheme(theme);
        });
    });

    function switchTheme(theme) {
        try { localStorage.setItem('quanta_theme', theme); } catch {}
        var effective = theme;
        if (theme === 'system') {
            effective = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'graphite' : 'paper';
        }
        document.documentElement.setAttribute('data-theme', effective);
        var metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
            metaTheme.setAttribute('content', effective === 'paper' ? '#F3EEE3' : (effective === 'ink' ? '#0B0B0A' : '#1A1A19'));
        }
        updateThemeButtons(theme);
    }

    function updateThemeButtons(activeTheme) {
        themeButtons.forEach(b => {
            const matches = b.getAttribute('data-theme-select') === activeTheme;
            b.classList.toggle('active', matches);
            if (matches) {
                b.classList.add('btn-primary');
                b.classList.remove('btn-secondary');
            } else {
                b.classList.remove('btn-primary');
                b.classList.add('btn-secondary');
            }
        });
    }

    let currentTheme = 'system';
    try { currentTheme = localStorage.getItem('quanta_theme') || 'system'; } catch {}
    updateThemeButtons(currentTheme);

    // Toggle 2FA field manually
    if (btnToggleTotp && totpGroup) {
        btnToggleTotp.addEventListener('click', () => {
            const isHidden = totpGroup.style.display === 'none';
            totpGroup.style.display = isHidden ? 'block' : 'none';
            btnToggleTotp.textContent = isHidden ? 'Hide 2FA Code Field' : 'Use 2FA / Authenticator Code';
            if (isHidden && totpInput) totpInput.focus();
        });
    }

    // Password visibility toggle
    if (toggleEye && input) {
        toggleEye.addEventListener('click', () => {
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            toggleEye.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
            toggleEye.classList.toggle('revealed', isPassword);
        });
    }

    // Login Handler
    async function doLogin(e) {
        if (e) e.preventDefault();
        if (loginPending) return;
        const password = input.value;
        const totp = totpInput ? totpInput.value.trim() : '';

        if (!password) {
            showError('Please enter the master password.');
            input.focus();
            return;
        }

        // If TOTP field is visible and user typed non-empty but fewer than 6 digits
        if (totpGroup && totpGroup.style.display !== 'none' && totp && totp.length !== 6) {
            showError('TOTP code must be exactly 6 digits.');
            totpInput.focus();
            return;
        }

        loginPending = true;
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Verifying...';
        if (errorBox) errorBox.style.display = 'none';

        try {
            const payload = { password };
            if (totp) payload.totp = totp;

            const res = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                btn.textContent = 'Authenticated ✓';
                window.location.href = '/';
            } else {
                const data = await res.json().catch(() => ({}));
                if (data.error && data.error.includes('TOTP')) {
                    // Reveal TOTP field for step 2
                    if (totpGroup) {
                        totpGroup.style.display = 'block';
                        if (btnToggleTotp) btnToggleTotp.style.display = 'none';
                    }
                    showError(data.error || 'Two-Factor Authentication required: Please enter 6-digit TOTP code.');
                    if (totpInput) {
                        totpInput.focus();
                        totpInput.select();
                    }
                } else if (res.status === 429) {
                    showError(data.error || 'Too many failed attempts. Please wait.');
                } else {
                    showError(data.error || 'Invalid master password. Please verify credentials.');
                    input.select();
                }
                btn.disabled = false;
                btn.textContent = originalText;
            }
        } catch (err) {
            showError('Connection failed. Please ensure the Quanta server is running.');
            btn.disabled = false;
            btn.textContent = originalText;
        } finally {
            loginPending = false;
        }
    }

    function showError(msg) {
        if (errorBox && errorText) {
            errorText.textContent = msg;
            errorBox.style.display = 'flex';
        }
    }

    if (form) {
        form.addEventListener('submit', doLogin);
    } else if (btn) {
        btn.addEventListener('click', doLogin);
    }

    // Auto-advance: when user enters 6 digits in TOTP, automatically submit
    if (totpInput) {
        totpInput.addEventListener('input', () => {
            totpInput.value = totpInput.value.replace(/[^0-9]/g, '');
            if (totpInput.value.length === 6 && input.value) {
                doLogin();
            }
        });
    }
});
