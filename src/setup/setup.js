import * as vfs from '../vendor/vfs-provider.mjs';
import { localizeDocument } from '../vendor/i18n.mjs';
import { discover } from '../webdav-discover.mjs';
import { accountKey, connectionKey, loadAccounts } from '../webdav-storage.mjs';

const i18n = (key, subs) => browser.i18n.getMessage(key, subs);

localizeDocument();

const params = new URLSearchParams(location.search);
const addonId = params.get('addonId');
const addonName = params.get('addonName');
const setupToken = params.get('setupToken');

const capabilities = {
  file: { read: true, add: true, modify: true, delete: true },
  folder: { read: true, add: true, modify: true, delete: true },
};

// ── UI refs ───────────────────────────────────────────────────────────────────

const addonNameEl    = document.getElementById('addon-name');
const accountSection = document.getElementById('account-section');
const accountSelect  = document.getElementById('account-select');
const newAccountForm = document.getElementById('new-account-form');
const nameInput      = document.getElementById('conn-name');
const serverInput    = document.getElementById('server');
const userInput      = document.getElementById('username');
const passInput      = document.getElementById('password');
const statusEl       = document.getElementById('status');
const connectBtn     = document.getElementById('connect-btn');
const cancelBtn      = document.getElementById('cancel-btn');

cancelBtn.addEventListener('click', () => window.close());

addonNameEl.textContent = addonName || i18n('setupSubtitleDefaultAddon');

// ── Existing accounts ─────────────────────────────────────────────────────────

const all = await browser.storage.local.get(null);
const existingAccounts = loadAccounts(all);

if (existingAccounts.length > 0) {
  for (const acc of existingAccounts) {
    const opt = document.createElement('option');
    opt.value = acc.accountId;
    const host = acc.url ? new URL(acc.url).hostname : '';
    opt.textContent = `${acc.name} - ${acc.username}@${host}`;
    accountSelect.appendChild(opt);
  }
  accountSection.hidden = false;

  accountSelect.addEventListener('change', () => {
    const reusing = !!accountSelect.value;
    newAccountForm.hidden = reusing;
    setStatus('');
    if (reusing) {
      const acc = existingAccounts.find(a => a.accountId === accountSelect.value);
      nameInput.value = acc?.name ?? '';
      connectBtn.textContent = i18n('setupBtnConnect');
    } else {
      nameInput.value = '';
      connectBtn.textContent = i18n('setupBtnCreateAndConnect');
    }
  });
}

// ── Status display ────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

// ── Connect ───────────────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const selectedAccountId = accountSelect.value;
  connectBtn.disabled = true;

  const storageId = crypto.randomUUID();
  let name, finalAccountId;

  if (selectedAccountId) {
    // Reuse explicitly selected existing account.
    finalAccountId = selectedAccountId;
    const acc = existingAccounts.find(a => a.accountId === selectedAccountId);
    name = nameInput.value.trim()
      || acc?.name
      || i18n('fallbackConnName', [acc?.username ?? '']);
    await browser.storage.local.set({
      [connectionKey(storageId)]: { accountId: finalAccountId },
    });
  } else {
    // Discover endpoint, then reuse a matching account or create a new one.
    setStatus(i18n('setupStatusDiscovering'), 'info');
    try {
      const url = await discover(serverInput.value, userInput.value, passInput.value);

      const fresh = await browser.storage.local.get(null);
      const matching = loadAccounts(fresh).find(a => a.url === url && a.username === userInput.value);

      name = nameInput.value.trim() || `${userInput.value}@${new URL(url).hostname}`;

      if (matching) {
        finalAccountId = matching.accountId;
        await browser.storage.local.set({
          [connectionKey(storageId)]: { accountId: finalAccountId },
        });
      } else {
        finalAccountId = crypto.randomUUID();
        await browser.storage.local.set({
          [accountKey(finalAccountId)]: {
            url,
            username: userInput.value,
            password: passInput.value,
            name,
            pollInterval: 60,
          },
          [connectionKey(storageId)]: { accountId: finalAccountId },
        });
      }
    } catch (e) {
      setStatus(e.message, 'error');
      connectBtn.disabled = false;
      return;
    }
  }

  await vfs.reportNewConnection(addonId, addonName, storageId, name, capabilities, setupToken);
  window.close();
});
