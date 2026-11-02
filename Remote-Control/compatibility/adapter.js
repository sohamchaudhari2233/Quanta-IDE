/**
 * Antigravity Compatibility & Version Adapter
 * Centralizes DOM selectors, brain folder discovery, and CDP target patterns.
 */

export const SELECTOR_PRESETS = {
  v1: {
    chatInput: 'textarea, [contenteditable="true"], .monaco-editor',
    sendButton: 'button[aria-label="Send"], button.send-button, .action-send',
    stopButton: 'button[aria-label="Stop"], button.stop-button',
    chatContainer: '.chat-container, .conversation-pane, .interactive-session',
    messageList: '.chat-history, .interactive-item-container'
  },
  modern: {
    chatInput: 'div[role="textbox"], textarea.interactive-input-editor',
    sendButton: 'button.interactive-input-send-button, button[title*="Send"]',
    stopButton: 'button[title*="Stop"], button.interactive-input-stop-button',
    chatContainer: '.monaco-workbench .part.panel, .interactive-session',
    messageList: '.monaco-list-rows'
  }
};

export class AntigravityAdapter {
  constructor() {
    this.version = 'unknown';
    this.activePreset = SELECTOR_PRESETS.v1;
  }

  async detectVersion(cdpConnection) {
    if (!cdpConnection) return 'disconnected';
    try {
      const versionInfo = await cdpConnection.send('Browser.getVersion');
      this.version = versionInfo.product || 'Antigravity-Electron';
      this.activePreset = SELECTOR_PRESETS.modern;
      return this.version;
    } catch (e) {
      this.version = 'Antigravity-Legacy';
      this.activePreset = SELECTOR_PRESETS.v1;
      return this.version;
    }
  }

  getSelectors() {
    return this.activePreset;
  }

  isSelectorSupported(selectorKey) {
    return !!this.activePreset[selectorKey];
  }
}

export const antigravityAdapter = new AntigravityAdapter();

