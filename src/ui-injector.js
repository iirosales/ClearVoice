const BUTTON_CLASS = 'clearvoice-btn';
const STYLE_ID = 'clearvoice-player-styles';

const STATE_CONFIG = {
  disabled: {
    tooltip: 'ClearVoice: No English transcript available',
    pressed: 'false',
    disabled: true,
  },
  off: {
    tooltip: 'ClearVoice: Enhance Speech (Off)',
    pressed: 'false',
    disabled: false,
  },
  loading: {
    tooltip: 'ClearVoice: Loading Voice Model...',
    pressed: 'true',
    disabled: false,
  },
  active: {
    tooltip: 'ClearVoice: Active',
    pressed: 'true',
    disabled: false,
  },
};

const ICON_SVG = `
<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" class="clearvoice-icon">
  <rect x="3.5" y="9.5" width="2.4" height="5" rx="1.2" fill="currentColor"></rect>
  <rect x="8.2" y="5" width="2.4" height="14" rx="1.2" fill="currentColor"></rect>
  <rect x="13" y="7" width="2.4" height="10" rx="1.2" fill="currentColor"></rect>
  <rect x="17.8" y="9" width="2.4" height="6" rx="1.2" fill="currentColor"></rect>
</svg>
`;

export class UIInjector {
  constructor({ onToggle } = {}) {
    this.onToggle = onToggle || (() => {});
    this.state = 'disabled';
    this.button = null;
  }

  ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ytp-button.clearvoice-btn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #ffffff;
        transition: opacity 0.15s ease, color 0.15s ease, transform 0.12s ease;
        vertical-align: top;
      }

      .ytp-button.clearvoice-btn .clearvoice-icon {
        display: block;
        pointer-events: none;
      }

      .ytp-button.clearvoice-btn[data-cv-state="disabled"] {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .ytp-button.clearvoice-btn[data-cv-state="off"] {
        opacity: 0.9;
        cursor: pointer;
      }

      .ytp-button.clearvoice-btn[data-cv-state="off"]:hover {
        opacity: 1;
      }

      .ytp-button.clearvoice-btn[data-cv-state="loading"] {
        color: #3ea6ff;
        opacity: 0.95;
        cursor: pointer;
        animation: clearvoice-pulse 1.2s ease-in-out infinite;
      }

      .ytp-button.clearvoice-btn[data-cv-state="active"] {
        color: #3ea6ff;
        opacity: 1;
        cursor: pointer;
      }

      .ytp-button.clearvoice-btn[data-cv-state="active"]::after {
        content: "";
        position: absolute;
        left: 25%;
        right: 25%;
        bottom: 6px;
        height: 2.5px;
        border-radius: 2px;
        background: #3ea6ff;
      }

      @keyframes clearvoice-pulse {
        0%, 100% { opacity: 0.65; }
        50% { opacity: 1; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  inject() {
    this.ensureStyles();
    const rightControls = document.querySelector('#movie_player .ytp-right-controls');
    if (!rightControls) return false;

    const existing = rightControls.querySelector(`.${BUTTON_CLASS}`);
    if (existing) {
      this.button = existing;
      this.applyState();
      return true;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ytp-button ${BUTTON_CLASS}`;
    btn.innerHTML = ICON_SVG;

    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.state === 'disabled') return;
      this.onToggle();
    });

    const subtitlesBtn = rightControls.querySelector('.ytp-subtitles-button');
    if (subtitlesBtn && subtitlesBtn.parentElement === rightControls) {
      rightControls.insertBefore(btn, subtitlesBtn);
    } else {
      rightControls.insertBefore(btn, rightControls.firstChild);
    }

    this.button = btn;
    this.applyState();
    return true;
  }

  setState(nextState) {
    if (!STATE_CONFIG[nextState]) return;
    this.state = nextState;
    this.applyState();
  }

  applyState() {
    if (!this.button) return;
    const cfg = STATE_CONFIG[this.state] || STATE_CONFIG.disabled;
    this.button.dataset.cvState = this.state;
    this.button.title = cfg.tooltip;
    this.button.setAttribute('aria-label', cfg.tooltip);
    this.button.setAttribute('aria-pressed', cfg.pressed);
    this.button.setAttribute('aria-disabled', cfg.disabled ? 'true' : 'false');
    this.button.setAttribute('data-title-no-tooltip', cfg.tooltip);
  }
}
