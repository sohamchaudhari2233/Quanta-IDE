// Quanta IDE — Synchronous Pre-paint Theme Initializer
(function() {
    try {
        var params = new URLSearchParams(window.location.search);
        var urlTheme = params.get('theme');
        var stored = urlTheme || localStorage.getItem('quanta_theme');
        var theme = stored;
        if (!theme || theme === 'system') {
            theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'graphite' : 'paper';
        }
        document.documentElement.setAttribute('data-theme', theme);
        var metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
            metaTheme.setAttribute('content', theme === 'paper' ? '#F3EEE3' : (theme === 'ink' ? '#0B0B0A' : '#1A1A19'));
        }
    } catch (e) {}
})();
