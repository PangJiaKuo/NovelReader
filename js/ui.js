/* Shared UI primitives: toasts and promise-based confirmation dialogs. */

const ICONS = {
  success: 'icon-check',
  error: 'icon-alert',
  warning: 'icon-alert',
  info: 'icon-info',
};

let toastStack = null;

function ensureToastStack() {
  if (toastStack?.isConnected) return toastStack;
  toastStack = document.createElement('div');
  toastStack.className = 'toast-stack';
  toastStack.setAttribute('role', 'status');
  toastStack.setAttribute('aria-live', 'polite');
  document.body.append(toastStack);
  return toastStack;
}

function makeIcon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

/**
 * Show a transient message.
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error'|'warning', duration?: number}} options
 */
export function toast(message, { type = 'info', duration = 3400 } = {}) {
  const stack = ensureToastStack();
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  const icon = makeIcon(ICONS[type] || ICONS.info, 'icon toast-icon');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = String(message ?? '');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  item.append(icon, text, close);
  stack.append(item);

  let timer = 0;
  let remaining = duration;
  let startedAt = Date.now();
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    item.classList.add('is-leaving');
    setTimeout(() => item.remove(), 220);
  };

  const start = () => {
    startedAt = Date.now();
    clearTimeout(timer);
    timer = setTimeout(dismiss, remaining);
  };

  const pause = () => {
    clearTimeout(timer);
    remaining = Math.max(600, remaining - (Date.now() - startedAt));
  };

  close.addEventListener('click', dismiss);
  item.addEventListener('pointerenter', pause);
  item.addEventListener('pointerleave', start);
  start();

  // Keep the stack short even if a lot of errors arrive together.
  while (stack.children.length > 4) stack.firstElementChild.remove();
  return dismiss;
}

/**
 * Ask the user to confirm an action.
 * @param {{title?: string, message?: string, confirmText?: string, cancelText?: string, danger?: boolean}} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = '请确认',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';

    const card = document.createElement('div');
    card.className = 'confirm-card';

    const iconWrap = document.createElement('div');
    iconWrap.className = `confirm-icon${danger ? ' is-danger' : ''}`;
    iconWrap.append(makeIcon(danger ? 'icon-alert' : 'icon-info'));

    const copy = document.createElement('div');
    copy.className = 'confirm-copy';
    const heading = document.createElement('h2');
    heading.id = `confirm-title-${Date.now()}`;
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    copy.append(heading, paragraph);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button-ghost';
    cancel.textContent = cancelText;
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = danger ? 'button-danger' : 'button-primary';
    accept.textContent = confirmText;
    actions.append(cancel, accept);

    card.append(iconWrap, copy, actions);
    dialog.append(card);
    dialog.setAttribute('aria-labelledby', heading.id);
    document.body.append(dialog);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (typeof dialog.close === 'function' && dialog.open) {
        try { dialog.close(); } catch { /* ignore */ }
      }
      dialog.remove();
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus?.({ preventScroll: true });
      }
      resolve(Boolean(value));
    };

    cancel.addEventListener('click', () => finish(false));
    accept.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false);
    });
    dialog.addEventListener('close', () => {
      if (!settled) finish(false);
    });

    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
    requestAnimationFrame(() => {
      if (danger) cancel.focus({ preventScroll: true });
      else accept.focus({ preventScroll: true });
    });
  });
}

export { makeIcon };
