import * as vfs from '../vendor/vfs-provider.mjs';
import { localizeDocument } from '../vendor/i18n.mjs';
import { accountKey, credKey } from '../webdav-storage.mjs';

const i18n = (key, subs) => browser.i18n.getMessage(key, subs);
const CONNECTIONS_KEY = 'vfs-toolkit-connections';

localizeDocument();

const params = new URLSearchParams(location.search);
const storageId = params.get('storageId');

const nameInput   = document.getElementById('conn-name');
const accNameEl   = document.getElementById('acc-name');
const accUrlEl    = document.getElementById('acc-url');
const accUserEl   = document.getElementById('acc-username');
const manageBtn   = document.getElementById('manage-accounts-btn');
const saveBtn     = document.getElementById('save-btn');
const cancelBtn   = document.getElementById('cancel-btn');
const statusEl    = document.getElementById('status');

const storage = await browser.storage.local.get(null);
const { accountId } = storage[credKey(storageId)] ?? {};
const account = (accountId && storage[accountKey(accountId)]) || {};
const conn = (storage[CONNECTIONS_KEY] ?? []).find(c => c.storageId === storageId) ?? {};

nameInput.value = conn.name ?? '';
accNameEl.textContent = account.name ?? '\u2014';
accUrlEl.textContent  = account.url ?? '\u2014';
accUserEl.textContent = account.username ?? '\u2014';

cancelBtn.addEventListener('click', () => window.close());
manageBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

saveBtn.addEventListener('click', async () => {
  if (!conn.addonId) { window.close(); return; }
  const newName = nameInput.value.trim() || i18n('fallbackConnName', [account.username ?? '']);
  if (newName === conn.name) { window.close(); return; }
  saveBtn.disabled = true;
  try {
    await vfs.reportNewConnection(conn.addonId, conn.addonName, storageId, newName, conn.capabilities);
    setStatus(i18n('configStatusSaved'), 'ok');
    setTimeout(() => window.close(), 600);
  } catch {
    setStatus(i18n('configStatusSaveFailed'), 'error');
    saveBtn.disabled = false;
  }
});
