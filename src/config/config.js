import { localizeDocument } from '../vendor/i18n.mjs';
import { accountKey, credKey } from '../webdav-storage.mjs';

const i18n = (key, subs) => browser.i18n.getMessage(key, subs);

localizeDocument();

const params = new URLSearchParams(location.search);
const storageId = params.get('storageId');
const CRED_KEY = credKey(storageId);

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`;

// ── UI refs ───────────────────────────────────────────────────────────────────

const nameInput = document.getElementById('conn-name');
const urlInput = document.getElementById('url');
const userInput = document.getElementById('username');
const passInput = document.getElementById('password');
const pollInput = document.getElementById('poll-interval');
const saveBtn   = document.getElementById('save-btn');
const testBtn   = document.getElementById('test-btn');
const cancelBtn = document.getElementById('cancel-btn');
const statusEl  = document.getElementById('status');

// ── Load existing settings ────────────────────────────────────────────────────

const connRv = await browser.storage.local.get(CRED_KEY);
const { accountId } = connRv[CRED_KEY] ?? {};

const ACCOUNT_KEY = accountId ? accountKey(accountId) : null;
const accRv = ACCOUNT_KEY ? await browser.storage.local.get(ACCOUNT_KEY) : {};
const account = (ACCOUNT_KEY ? accRv[ACCOUNT_KEY] : null) ?? {};

nameInput.value = account.name ?? '';
urlInput.value = account.url ?? '';
userInput.value = account.username ?? '';
passInput.value = account.password ?? '';
pollInput.value = account.pollInterval ?? 60;

cancelBtn.addEventListener('click', () => window.close());

// ── Status display ────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

// ── Event handlers ────────────────────────────────────────────────────────────

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  setStatus(i18n('configStatusTesting'), 'info');
  try {
    let url = urlInput.value.trim();
    if (!url.endsWith('/')) url += '/';
    const auth = 'Basic ' + btoa(`${userInput.value}:${passInput.value}`);
    const resp = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        'Authorization': auth,
        'Depth': '0',
        'Content-Type': 'application/xml; charset="utf-8"',
      },
      body: PROPFIND_BODY,
    });
    if (resp.status === 401 || resp.status === 403) throw new Error(i18n('configStatusAuthFailed'));
    if (resp.ok || resp.status === 207) setStatus(i18n('configStatusOk'), 'ok');
    else throw new Error(i18n('configStatusHttpError', [resp.status]));
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    testBtn.disabled = false;
  }
});

saveBtn.addEventListener('click', async () => {
  if (!ACCOUNT_KEY) return;
  saveBtn.disabled = true;
  try {
    let url = urlInput.value.trim();
    if (url && !url.endsWith('/')) url += '/';

    const pollInterval = Math.max(0, parseInt(pollInput.value, 10) || 0);
    const name = nameInput.value.trim() || i18n('fallbackConnName', [userInput.value]);

    await browser.storage.local.set({
      [ACCOUNT_KEY]: {
        url,
        username: userInput.value,
        password: passInput.value,
        name,
        pollInterval,
      },
    });

    setStatus(i18n('configStatusSaved'), 'ok');
    setTimeout(() => window.close(), 800);
  } catch {
    setStatus(i18n('configStatusSaveFailed'), 'error');
    saveBtn.disabled = false;
  }
});
