import { localizeDocument } from '../vendor/i18n.mjs';
import { discover } from '../webdav-discover.mjs';
import { ACCOUNT_PREFIX, CRED_PREFIX, loadAccounts } from '../webdav-storage.mjs';

localizeDocument();

const CONNECTIONS_KEY = 'vfs-toolkit-connections';


async function render() {
  const storage = await browser.storage.local.get(null);
  const connections = (storage[CONNECTIONS_KEY] ?? []).filter(
    c => storage[CRED_PREFIX + c.storageId] != null
  );
  renderAccounts(loadAccounts(storage), connections, storage);
  renderConnections(connections, storage);
}

function renderAccounts(accounts, connections, storage) {
  const tbody = document.getElementById('accounts-body');
  const empty = document.getElementById('accounts-empty-state');

  tbody.replaceChildren();

  if (accounts.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  for (const account of accounts) {
    const accountConns = connections.filter(
      c => storage[CRED_PREFIX + c.storageId]?.accountId === account.accountId
    );

    const tdAccount = document.createElement('td');
    tdAccount.textContent = account.name ?? '\u2014';
    const detail = document.createElement('div');
    detail.className = 'server-url';
    const host = account.url ? new URL(account.url).hostname : null;
    const userHost = account.username && host ? `${account.username}@${host}` : (account.username ?? host ?? '');
    if (userHost && userHost !== (account.name ?? '')) {
      detail.textContent = userHost;
      tdAccount.appendChild(detail);
    }

    const btn = document.createElement('button');
    btn.className = 'revoke-btn';
    btn.textContent = browser.i18n.getMessage('btnDelete');
    btn.addEventListener('click', () => deleteAccount(account.accountId, accountConns));

    const tdAction = document.createElement('td');
    tdAction.appendChild(btn);

    const tr = document.createElement('tr');
    tr.append(tdAccount, tdAction);
    tbody.appendChild(tr);
  }
}

function renderConnections(connections, storage) {
  const tbody = document.getElementById('connections-body');
  const empty = document.getElementById('empty-state');

  tbody.replaceChildren();

  if (!connections.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  for (const conn of connections) {

    const btn = document.createElement('button');
    btn.className = 'revoke-btn';
    btn.textContent = browser.i18n.getMessage('btnRevoke');
    btn.addEventListener('click', () => revokeAccess(conn.addonId, conn.storageId));

    const accountId = storage[CRED_PREFIX + conn.storageId]?.accountId;
    const accountName = accountId ? (storage[ACCOUNT_PREFIX + accountId]?.name ?? '\u2014') : '\u2014';

    const tdConn = document.createElement('td');
    tdConn.textContent = conn.name ?? '\u2014';
    const accountLine = document.createElement('div');
    accountLine.className = 'addon-name';
    accountLine.textContent = `${browser.i18n.getMessage('optionsConnAccount')} ${accountName}`;
    const addonLine = document.createElement('div');
    addonLine.className = 'addon-name';
    addonLine.textContent = `${browser.i18n.getMessage('optionsConnExtension')} ${conn.addonName ?? conn.addonId ?? '\u2014'}`;
    tdConn.append(accountLine, addonLine);

    const tdAction = document.createElement('td');
    tdAction.appendChild(btn);

    const tr = document.createElement('tr');
    tr.append(tdConn, tdAction);
    tbody.appendChild(tr);
  }
}

async function deleteAccount(accountId, connections) {
  // Remove all connections using this account from the VFS Toolkit list.
  const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
  const storageIds = connections.map(c => c.storageId);
  const updated = rv[CONNECTIONS_KEY].filter(c => !storageIds.includes(c.storageId));
  await browser.storage.local.set({ [CONNECTIONS_KEY]: updated });

  // Remove stored credential entries and the account itself.
  await browser.storage.local.remove([
    ...storageIds.map(id => CRED_PREFIX + id),
    ACCOUNT_PREFIX + accountId,
  ]);

  // Notify each add-on so it can update its UI.
  for (const conn of connections) {
    browser.runtime.sendMessage(conn.addonId, {
      type: 'vfs-toolkit-remove-connection',
      storageId: conn.storageId,
    }).catch(() => { /* add-on may not be listening */ });
  }

  render();
}

async function revokeAccess(addonId, storageId) {
  // Remove from VFS Toolkit connection list.
  const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
  const updated = rv[CONNECTIONS_KEY].filter(
    c => !(c.addonId === addonId && c.storageId === storageId)
  );
  await browser.storage.local.set({ [CONNECTIONS_KEY]: updated });

  // Remove stored WebDAV credentials for this connection.
  await browser.storage.local.remove(CRED_PREFIX + storageId);

  // Notify the add-on so it can update its UI.
  browser.runtime.sendMessage(addonId, {
    type: 'vfs-toolkit-remove-connection',
    storageId,
  }).catch(() => { /* add-on may not be listening */ });

  render();
}

render();

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const relevant = Object.keys(changes).some(k =>
    k === CONNECTIONS_KEY || k.startsWith(ACCOUNT_PREFIX) || k.startsWith(CRED_PREFIX)
  );
  if (relevant) render();
});

// ── Add-account popover ───────────────────────────────────────────────────────

const popover     = document.getElementById('add-account-popover');
const serverInput = document.getElementById('aa-server');
const userInput   = document.getElementById('aa-username');
const passInput   = document.getElementById('aa-password');
const testBtn     = document.getElementById('aa-test-btn');
const statusEl    = document.getElementById('aa-status');
const nameInput   = document.getElementById('aa-name');
const cancelBtn   = document.getElementById('aa-cancel-btn');

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function resetPopover() {
  serverInput.value = '';
  userInput.value = '';
  passInput.value = '';
  nameInput.value = '';
  setStatus('');
  testBtn.disabled = false;
}

document.getElementById('add-account-btn').addEventListener('click', () => {
  resetPopover();
  popover.showPopover();
});

const hidePopover = () => popover.hidePopover();

cancelBtn.addEventListener('click', hidePopover);

popover.addEventListener('toggle', e => {
  if (e.newState === 'open') {
    document.addEventListener('keydown', onEsc);
  } else {
    document.removeEventListener('keydown', onEsc);
  }
});

function onEsc(e) {
  if (e.key === 'Escape') hidePopover();
}

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  setStatus(browser.i18n.getMessage('setupStatusDiscovering'), 'info');
  try {
    const url = await discover(serverInput.value, userInput.value, passInput.value);

    const storage = await browser.storage.local.get(null);
    const matching = loadAccounts(storage).find(
      a => a.url === url && a.username === userInput.value
    );

    if (matching) {
      setStatus(browser.i18n.getMessage('optionsErrorAccountExists'), 'error');
      testBtn.disabled = false;
      return;
    }

    const accountId = crypto.randomUUID();
    await browser.storage.local.set({
      [ACCOUNT_PREFIX + accountId]: {
        url,
        username: userInput.value,
        password: passInput.value,
        name: nameInput.value.trim() || `${userInput.value}@${new URL(url).hostname}`,
        pollInterval: 60,
      },
    });
    popover.hidePopover();
    render();
  } catch (e) {
    setStatus(e.message, 'error');
    testBtn.disabled = false;
  }
});
