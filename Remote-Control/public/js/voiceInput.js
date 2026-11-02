/**
 * Web Speech API Voice Dictation Controller for Quanta IDE Mobile Prompting
 * Supports real-time interim results, language selection, pulse animation, and error handling.
 */
export class VoiceInputManager {
  constructor(inputElement, micButtonElement, langSelectElement, options = {}) {
    this.inputElement = inputElement;
    this.micButtonElement = micButtonElement;
    this.langSelectElement = langSelectElement;
    this.options = options;
    this.isListening = false;
    this.recognition = null;
    this.baseText = '';

    this.init();
  }

  init() {
    const SpeechRecognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
    if (!SpeechRecognition) {
      if (this.micButtonElement) {
        this.micButtonElement.title = 'Voice input not supported on this browser';
        this.micButtonElement.style.opacity = '0.35';
        this.micButtonElement.style.cursor = 'not-allowed';
      }
      return;
    }

    try {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = this.langSelectElement ? this.langSelectElement.value : 'en-IN';

      if (this.langSelectElement) {
        this.langSelectElement.addEventListener('change', () => {
          if (this.recognition) {
            this.recognition.lang = this.langSelectElement.value;
          }
        });
      }

      this.recognition.onstart = () => {
        this.isListening = true;
        this.baseText = this.inputElement && this.inputElement.value ? (this.inputElement.value.trim() + ' ') : '';
        if (this.micButtonElement) {
          this.micButtonElement.classList.add('listening');
          this.micButtonElement.setAttribute('aria-pressed', 'true');
          this.micButtonElement.title = 'Listening... (Click to stop)';
        }
      };

      this.recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; ++i) {
          const item = event.results[i];
          if (item.isFinal) {
            finalTranscript += item[0].transcript;
          } else {
            interimTranscript += item[0].transcript;
          }
        }

        const combined = this.baseText + finalTranscript + interimTranscript;
        if (this.inputElement) {
          this.inputElement.value = combined;
          this.inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };

      this.recognition.onerror = (event) => {
        console.warn('[VoiceInput] Speech recognition error:', event.error);
        let userMsg = 'Voice recognition error';
        if (event.error === 'not-allowed') {
          userMsg = 'Microphone access denied. Please grant microphone permission.';
        } else if (event.error === 'no-speech') {
          userMsg = 'No speech detected. Please speak into microphone.';
        } else if (event.error === 'network') {
          userMsg = 'Speech network connectivity error.';
        }

        if (typeof this.options.onError === 'function') {
          this.options.onError(event.error, userMsg);
        } else if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
          window.showToast(userMsg);
        }
        this.stop();
      };

      this.recognition.onend = () => {
        this.stop();
      };

      if (this.micButtonElement) {
        this.micButtonElement.addEventListener('click', (e) => {
          if (e && e.preventDefault) e.preventDefault();
          if (this.isListening) {
            this.stop();
          } else {
            this.start();
          }
        });
      }
    } catch (e) {
      console.warn('[VoiceInput] Failed to initialize SpeechRecognition:', e);
    }
  }

  start() {
    if (!this.recognition) return;
    try {
      this.recognition.lang = this.langSelectElement ? this.langSelectElement.value : 'en-IN';
      this.recognition.start();
    } catch (e) {
      console.warn('[VoiceInput] Speech recognition start exception:', e);
    }
  }

  stop() {
    this.isListening = false;
    if (this.recognition) {
      try { this.recognition.stop(); } catch {}
    }
    if (this.micButtonElement) {
      this.micButtonElement.classList.remove('listening');
      this.micButtonElement.setAttribute('aria-pressed', 'false');
      this.micButtonElement.title = 'Voice dictation (Click to speak)';
      this.micButtonElement.style.color = '';
    }
  }
}

// Aliases and global attachment
export const VoiceInputController = VoiceInputManager;

if (typeof window !== 'undefined') {
  window.VoiceInputManager = VoiceInputManager;
  window.VoiceInputController = VoiceInputManager;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceInputManager, VoiceInputController };
}
