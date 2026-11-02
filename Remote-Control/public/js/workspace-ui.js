// UI-only enhancements. All commands continue through the existing handlers.
(() => {
    const shortcuts = document.getElementById('promptShortcuts');
    if (shortcuts) shortcuts.open = false;

    const status = document.getElementById('statusText');
    const pill = document.getElementById('agentStatusPill');
    if (status && pill) {
        const updateLabel = () => { pill.title = status.textContent; pill.setAttribute('aria-label', status.textContent); };
        updateLabel();
        new MutationObserver(updateLabel).observe(status, { childList: true, characterData: true, subtree: true });
    }

    document.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('.starter-card[role="button"]');
        if (card) {
            event.preventDefault();
            card.click();
        }
    });
})();
