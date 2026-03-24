/**
 * WebDAV storage provider for the VFS Toolkit.
 *
 * Storage layout:
 *   webdav-account-{accountId}  →  { url, username, password, name, pollInterval }
 *   webdav-conn-{storageId}     →  { accountId }
 *
 * `url` is the full WebDAV endpoint with trailing slash, e.g.
 *   'https://cloud.example.com/remote.php/dav/files/alice/'
 *
 * Multiple add-ons can share a single account. One polling timer runs per
 * account, when external changes are detected every storageId on that account
 * is notified. After a write operation the ETag cache is updated immediately
 * and peer storageIds on the same account are notified without waiting for the
 * next poll tick.
 */

import { VfsProviderImplementation } from './vendor/vfs-provider.mjs';
import { CRED_PREFIX, accountKey, credKey } from './webdav-storage.mjs';

// ── HTTP utilities ────────────────────────────────────────────────────────────

function _authHeader({ username, password }) {
  return 'Basic ' + btoa(`${username}:${password}`);
}

/**
 * Converts a VFS absolute path to a full WebDAV URL.
 * Each path segment is percent-encoded individually.
 */
function _pathToUrl(baseUrl, path) {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (path === '/') return base + '/';
  return base + '/' + path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
}

/**
 * Converts a PROPFIND <D:href> value back to a VFS absolute path.
 * Handles both absolute (http://…) and relative (/path/…) hrefs.
 * Returns null if the href is outside the connection's base URL.
 */
function _hrefToPath(baseUrl, href) {
  const hrefPath = href.startsWith('http') ? new URL(href).pathname : href;
  const decoded = decodeURIComponent(hrefPath);
  const basePath = new URL(baseUrl).pathname;
  const baseNorm = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const hrefNorm = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
  if (!hrefNorm.startsWith(baseNorm)) return null;
  const rel = hrefNorm.slice(baseNorm.length);
  return rel || '/';
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:getetag/>
  </D:prop>
</D:propfind>`;

/** Parses a PROPFIND 207 Multi-Status body into VFS entry objects. */
function _parsePropfind(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const ns = 'DAV:';
  return [...doc.getElementsByTagNameNS(ns, 'response')].flatMap(resp => {
    const href = resp.getElementsByTagNameNS(ns, 'href')[0]?.textContent ?? '';
    const path = _hrefToPath(baseUrl, href);
    if (!path) return [];
    const isDir = !!resp.getElementsByTagNameNS(ns, 'collection')[0];
    const size = parseInt(resp.getElementsByTagNameNS(ns, 'getcontentlength')[0]?.textContent ?? '', 10);
    const lm = resp.getElementsByTagNameNS(ns, 'getlastmodified')[0]?.textContent;
    const etag = resp.getElementsByTagNameNS(ns, 'getetag')[0]?.textContent?.replace(/"/g, '');
    const name = path === '/' ? '' : path.split('/').filter(Boolean).pop();
    return [{
      path, name, kind: isDir ? 'directory' : 'file',
      size: !isDir && !isNaN(size) ? size : undefined,
      lastModified: lm ? new Date(lm).getTime() : undefined, etag
    }];
  });
}

/**
 * Throws a typed VFS error for non-OK HTTP responses.
 */
function _checkStatus(resp) {
  if (resp.ok) return;
  const e = new Error(browser.i18n.getMessage('errorHttp', [resp.status]));
  if (resp.status === 401 || resp.status === 403) {
    e.code = 'E:AUTH';
  } else if (resp.status === 412) {
    e.code = 'E:EXIST';
  } else if (resp.status === 409) {
    Object.assign(e, {
      code: 'E:PROVIDER', details: {
        id: 'conflict',
        title: browser.i18n.getMessage('errorConflictTitle'),
        description: browser.i18n.getMessage('errorConflictDescription'),
      }
    });
  } else {
    Object.assign(e, {
      code: 'E:PROVIDER', details: {
        id: `http-${resp.status}`,
        title: browser.i18n.getMessage('errorHttpTitle', [resp.status]),
        description: browser.i18n.getMessage('errorHttpDescription', [resp.status]),
      }
    });
  }
  throw e;
}

// ── Provider ──────────────────────────────────────────────────────────────────

class WebDavProvider extends VfsProviderImplementation {
  /** requestId → AbortController (for in-flight operations) */
  #aborts = new Map();
  /** accountId → intervalId (for polling timers) */
  #polls = new Map();
  /** accountId → Map<path, { etag, kind }> (for change detection) */
  #etags = new Map();

  constructor() {
    super({
      name: 'WebDAV',
      setupPath: '/setup/setup.html',
      setupWidth: 540,
      setupHeight: 680,
      configPath: '/config/config.html',
      configWidth: 540,
      configHeight: 680,
    });
  }

  // ── Cancellation ──────────────────────────────────────────────────────────

  onCancel(canceledRequestId) {
    this.#aborts.get(canceledRequestId)?.abort();
  }

  #signal(requestId) {
    const ac = new AbortController();
    this.#aborts.set(requestId, ac);
    return ac.signal;
  }

  #done(requestId) {
    this.#aborts.delete(requestId);
  }

  // ── Account / connection lookup ───────────────────────────────────────────

  async #accountData(accountId) {
    const key = accountKey(accountId);
    const data = (await browser.storage.local.get(key))[key];
    if (!data?.url) throw Object.assign(
      new Error(browser.i18n.getMessage('errorUnknownConnection')), { code: 'E:AUTH' }
    );
    return data;
  }

  /** Returns the account for a storageId, including its accountId. */
  async #account(storageId) {
    const connKey = credKey(storageId);
    const conn = (await browser.storage.local.get(connKey))[connKey];
    if (!conn?.accountId) throw Object.assign(
      new Error(browser.i18n.getMessage('errorUnknownConnection')), { code: 'E:AUTH' }
    );
    const data = await this.#accountData(conn.accountId);
    return { ...data, accountId: conn.accountId };
  }

  // ── Peer discovery ────────────────────────────────────────────────────────

  async #allStorageIdsForAccount(accountId) {
    const all = await browser.storage.local.get(null);
    return Object.entries(all)
      .filter(([k, v]) => k.startsWith(CRED_PREFIX) && v?.accountId === accountId)
      .map(([k]) => k.slice(CRED_PREFIX.length));
  }

  // ── Polling / external change detection ──────────────────────────────────

  /** Starts the polling timer for an accountId if not already running. */
  async startPoll(accountId) {
    if (this.#polls.has(accountId)) return;
    const account = await this.#accountData(accountId).catch(() => null);
    if (!account || !(account.pollInterval > 0)) return;
    await this.#refreshCache(accountId, account).catch(() => { });
    const ms = Math.max(10, account.pollInterval) * 1000;
    this.#polls.set(accountId, setInterval(() => this.#poll(accountId), ms));
  }

  /** Stops the polling timer for an accountId if no connections reference it anymore. */
  async stopPoll(accountId) {
    const remaining = await this.#allStorageIdsForAccount(accountId);
    if (remaining.length > 0) return;
    const id = this.#polls.get(accountId);
    if (id != null) { clearInterval(id); this.#polls.delete(accountId); }
    this.#etags.delete(accountId);
    // Clean up orphaned account data
    await browser.storage.local.remove(accountKey(accountId));
  }

  async #refreshCache(accountId, account) {
    const entries = await this.#collectAll(account, '/');
    this.#etags.set(accountId, new Map(entries.map(e => [e.path, { etag: e.etag, kind: e.kind }])));
  }

  async #poll(accountId) {
    const account = await this.#accountData(accountId).catch(() => null);
    if (!account) {
      const id = this.#polls.get(accountId);
      if (id != null) { clearInterval(id); this.#polls.delete(accountId); }
      return;
    }
    let fresh;
    try { fresh = await this.#collectAll(account, '/'); }
    catch { return; }

    const old = this.#etags.get(accountId) ?? new Map();
    const next = new Map();
    const changes = [];

    for (const e of fresh) {
      next.set(e.path, { etag: e.etag, kind: e.kind });
      const prev = old.get(e.path);
      if (!prev) {
        changes.push({ kind: e.kind, action: 'created', target: { path: e.path } });
      } else if (e.kind === 'file' && prev.etag && e.etag && prev.etag !== e.etag) {
        changes.push({ kind: 'file', action: 'modified', target: { path: e.path } });
      }
    }
    for (const [path, { kind }] of old) {
      if (!next.has(path)) changes.push({ kind, action: 'deleted', target: { path } });
    }

    this.#etags.set(accountId, next);
    if (changes.length > 0) {
      const storageIds = await this.#allStorageIdsForAccount(accountId);
      for (const storageId of storageIds) {
        this.reportStorageChange(storageId, changes);
      }
    }
  }

  // ── Post-write cache sync + peer broadcast ────────────────────────────────

  /** Removes a path and all its descendants from the ETag cache. */
  #evictPath(cache, path) {
    const prefix = path.endsWith('/') ? path : path + '/';
    for (const p of [...cache.keys()]) {
      if (p === path || p.startsWith(prefix)) cache.delete(p);
    }
  }

  /**
   * After a successful write, updates the ETag cache and broadcasts changes
   * to peer storageIds on the same account so they don't have to wait for
   * the next poll tick.  Also prevents the poll from firing a double
   * notification by ensuring the cache already reflects the new state.
   */
  async #syncAndBroadcast(accountId, account, changes, signal = null) {
    const cache = this.#etags.get(accountId);
    if (cache) {
      for (const change of changes) {
        const tgt = change.target?.path;
        const src = change.source?.path;
        if (change.action === 'deleted') {
          if (tgt) this.#evictPath(cache, tgt);
        } else if (change.action === 'moved') {
          // Remap old → new prefix in the cache.
          // Server-side MOVE preserves ETags, so no re-fetch needed.
          if (src && tgt) {
            const srcNorm = src.replace(/\/$/, '');
            const dstNorm = tgt.replace(/\/$/, '');
            for (const [p, v] of [...cache.entries()]) {
              if (p === srcNorm || p.startsWith(srcNorm + '/')) {
                cache.delete(p);
                cache.set(dstNorm + p.slice(srcNorm.length), v);
              }
            }
          }
        } else if (tgt) {
          // created / modified / copied - fetch the fresh ETag for files.
          if (change.kind === 'file') {
            try {
              const es = await this.#propfind(account, tgt, '0', signal);
              const e = es.find(x => x.path === tgt);
              if (e) cache.set(tgt, { etag: e.etag, kind: e.kind });
            } catch { /* poll will reconcile */ }
          } else {
            cache.set(tgt, { etag: undefined, kind: 'directory' });
          }
        }
      }
    }
    // Broadcast to all connections on this account, including the initiating
    // storageId, so that other windows of the same add-on also update.
    const allIds = await this.#allStorageIdsForAccount(accountId);
    for (const sid of allIds) this.reportStorageChange(sid, changes);
  }

  /**
   * Used by merge operations: broadcasts completed changes to all connections
   * on the account and schedules a full cache refresh so the poll doesn't
   * double-fire. Fire-and-forget - safe to call from catch blocks.
   */
  #broadcastToAll(accountId, account, changes) {
    if (changes.length === 0) return;
    this.#allStorageIdsForAccount(accountId).then(ids => {
      for (const sid of ids) this.reportStorageChange(sid, changes);
      return this.#refreshCache(accountId, account);
    }).catch(() => { });
  }

  // ── Low-level recursive collection helper ────────────────────────────────

  /**
   * Recursively collects all descendants of `path` using PROPFIND Depth:1 per
   * directory level.  Avoids PROPFIND Depth:infinity, which some servers (e.g.
   * OpenCloud) reject with HTTP 400.
   */
  async #collectAll(account, path, signal) {
    const norm = path.endsWith('/') ? path.slice(0, -1) : path;
    const items = await this.#propfind(account, norm || '/', '1', signal);
    const result = [];
    for (const item of items) {
      if (item.path === norm || item.path === '/') continue;
      result.push(item);
      if (item.kind === 'directory') {
        const sub = await this.#collectAll(account, item.path, signal);
        result.push(...sub);
      }
    }
    return result;
  }

  // ── Low-level WebDAV helpers ──────────────────────────────────────────────

  async #propfind(account, path, depth, signal) {
    const resp = await fetch(_pathToUrl(account.url, path), {
      method: 'PROPFIND',
      headers: {
        'Authorization': _authHeader(account),
        'Depth': depth,
        'Content-Type': 'application/xml; charset="utf-8"',
      },
      body: PROPFIND_BODY,
      signal,
    });
    _checkStatus(resp);
    return _parsePropfind(await resp.text(), account.url);
  }

  async #fetch(method, account, path, extraHeaders, body, signal) {
    return fetch(_pathToUrl(account.url, path), {
      method,
      headers: { 'Authorization': _authHeader(account), ...extraHeaders },
      body,
      signal,
    });
  }

  // ── Read operations ───────────────────────────────────────────────────────

  async onList(requestId, storageId, path) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      const all = await this.#propfind(account, path, '1', signal);
      const norm = path.replace(/\/$/, '') || '/';
      return all
        .filter(e => e.path !== norm)
        .map(({ path, name, kind, size, lastModified }) => ({ path, name, kind, size, lastModified }))
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } finally { this.#done(requestId); }
  }

  async onReadFile(requestId, storageId, path) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      const resp = await this.#fetch('GET', account, path, {}, undefined, signal);
      _checkStatus(resp);
      const blob = await resp.blob();
      return new File([blob], path.split('/').pop(), { type: blob.type || 'application/octet-stream' });
    } finally { this.#done(requestId); }
  }

  async onStorageUsage(storageId) {
    const account = await this.#account(storageId).catch(() => null);
    if (!account) return { usage: null, quota: null };
    try {
      const resp = await fetch(_pathToUrl(account.url, '/'), {
        method: 'PROPFIND',
        headers: {
          'Authorization': _authHeader(account),
          'Depth': '0',
          'Content-Type': 'application/xml; charset="utf-8"',
        },
        body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:quota-available-bytes/><D:quota-used-bytes/></D:prop></D:propfind>`,
      });
      if (!resp.ok) return { usage: null, quota: null };
      const doc = new DOMParser().parseFromString(await resp.text(), 'application/xml');
      const ns = 'DAV:';
      const available = parseInt(doc.getElementsByTagNameNS(ns, 'quota-available-bytes')[0]?.textContent ?? '', 10);
      const used = parseInt(doc.getElementsByTagNameNS(ns, 'quota-used-bytes')[0]?.textContent ?? '', 10);
      const hasQuota = !isNaN(used) && !isNaN(available) && available >= 0;
      return {
        usage: isNaN(used) ? null : used,
        quota: hasQuota ? used + available : null,
      };
    } catch { return { usage: null, quota: null }; }
  }

  // ── Write operations ──────────────────────────────────────────────────────

  async onWriteFile(requestId, storageId, path, file, overwrite) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      await this.#mkdirpParent(account, path, signal);

      if (!overwrite) {
        const checkResp = await this.#fetch('PROPFIND', account, path, {
          'Depth': '0',
          'Content-Type': 'application/xml; charset="utf-8"',
        }, PROPFIND_BODY, signal);
        if (checkResp.ok || checkResp.status === 207) {
          throw Object.assign(new Error(browser.i18n.getMessage('errorFileExists')), { code: 'E:EXIST' });
        }
        if (checkResp.status !== 404) _checkStatus(checkResp);
      }

      const action = this.#etags.get(account.accountId)?.has(path) ? 'modified' : 'created';
      const resp = await this.#fetch('PUT', account, path, {}, file, signal);
      _checkStatus(resp);
      await this.#syncAndBroadcast(account.accountId, account,
        [{ kind: 'file', action, target: { path } }], signal);
    } finally { this.#done(requestId); }
  }

  async onAddFolder(requestId, storageId, path) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      await this.#mkdirpParent(account, path, signal);
      const resp = await this.#fetch('MKCOL', account, path, {}, undefined, signal);
      if (resp.status === 405) throw Object.assign(new Error(browser.i18n.getMessage('errorFolderExists')), { code: 'E:EXIST' });
      _checkStatus(resp);
      await this.#syncAndBroadcast(account.accountId, account,
        [{ kind: 'directory', action: 'created', target: { path } }], signal);
    } finally { this.#done(requestId); }
  }

  // ── Move / copy / delete ──────────────────────────────────────────────────

  async onMoveFile(requestId, storageId, oldPath, newPath, overwrite) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      const resp = await this.#fetch('MOVE', account, oldPath, {
        'Destination': _pathToUrl(account.url, newPath),
        'Overwrite': overwrite ? 'T' : 'F',
      }, undefined, signal);
      _checkStatus(resp);
      await this.#syncAndBroadcast(account.accountId, account,
        [{ kind: 'file', action: 'moved', source: { path: oldPath }, target: { path: newPath } }], signal);
    } finally { this.#done(requestId); }
  }

  async onCopyFile(requestId, storageId, oldPath, newPath, overwrite) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      const resp = await this.#fetch('COPY', account, oldPath, {
        'Destination': _pathToUrl(account.url, newPath),
        'Overwrite': overwrite ? 'T' : 'F',
        'Depth': '0',
      }, undefined, signal);
      _checkStatus(resp);
      await this.#syncAndBroadcast(account.accountId, account,
        [{ kind: 'file', action: 'copied', source: { path: oldPath }, target: { path: newPath } }], signal);
    } finally { this.#done(requestId); }
  }

  async onMoveFolder(requestId, storageId, oldPath, newPath, merge) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      if (merge) {
        await this.#mergeMove(account, storageId, oldPath, newPath, signal);
      } else {
        const resp = await this.#fetch('MOVE', account, oldPath, {
          'Destination': _pathToUrl(account.url, newPath),
          'Overwrite': 'F',
        }, undefined, signal);
        _checkStatus(resp);
        await this.#syncAndBroadcast(account.accountId, account,
          [{ kind: 'directory', action: 'moved', source: { path: oldPath }, target: { path: newPath } }], signal);
      }
    } finally { this.#done(requestId); }
  }

  async onCopyFolder(requestId, storageId, oldPath, newPath, merge) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      if (merge) {
        await this.#mergeCopy(account, storageId, oldPath, newPath, signal);
      } else {
        const resp = await this.#fetch('COPY', account, oldPath, {
          'Destination': _pathToUrl(account.url, newPath),
          'Overwrite': 'F',
          'Depth': 'infinity',
        }, undefined, signal);
        _checkStatus(resp);
        // Enumerate copied contents to update cache with correct ETags.
        const newItems = await this.#collectAll(account, newPath, signal).catch(() => []);
        const cache = this.#etags.get(account.accountId);
        if (cache) {
          cache.set(newPath, { etag: undefined, kind: 'directory' });
          for (const e of newItems) cache.set(e.path, { etag: e.etag, kind: e.kind });
        }
        const changes = [
          { kind: 'directory', action: 'created', target: { path: newPath } },
          ...newItems.map(e => ({ kind: e.kind, action: 'created', target: { path: e.path } })),
        ];
        const allIds = await this.#allStorageIdsForAccount(account.accountId);
        for (const sid of allIds) this.reportStorageChange(sid, changes);
      }
    } finally { this.#done(requestId); }
  }

  async onDeleteFile(requestId, storageId, path) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      const resp = await this.#fetch('DELETE', account, path, {}, undefined, signal);
      if (resp.status !== 404) _checkStatus(resp);
      await this.#syncAndBroadcast(account.accountId, account,
        [{ kind: 'file', action: 'deleted', target: { path } }], signal);
    } finally { this.#done(requestId); }
  }

  async onDeleteFolder(requestId, storageId, path) {
    const account = await this.#account(storageId);
    const signal = this.#signal(requestId);
    try {
      const resp = await this.#fetch('DELETE', account, path, {}, undefined, signal);
      if (resp.status !== 404) _checkStatus(resp);
      await this.#syncAndBroadcast(account.accountId, account,
        [{ kind: 'directory', action: 'deleted', target: { path } }], signal);
    } finally { this.#done(requestId); }
  }

  // ── Merge helpers ─────────────────────────────────────────────────────────

  async #mergeCopy(account, storageId, srcPath, destPath, signal) {
    const srcNorm = srcPath.replace(/\/$/, '');
    const dstNorm = destPath.replace(/\/$/, '');
    const entries = await this.#collectAll(account, srcPath, signal);

    await this.#mkcolSafe(account, dstNorm, signal);

    const dirs = entries.filter(e => e.kind === 'directory').sort((a, b) => a.path.localeCompare(b.path));
    const files = entries.filter(e => e.kind === 'file');
    const completed = [];
    try {
      for (const d of dirs) {
        if (signal?.aborted) { this.#emitPartial(storageId, account, completed); return; }
        const dest = dstNorm + d.path.slice(srcNorm.length);
        await this.#mkcolSafe(account, dest, signal);
        completed.push({ kind: 'directory', action: 'created', target: { path: dest } });
      }
      for (const f of files) {
        if (signal?.aborted) { this.#emitPartial(storageId, account, completed); return; }
        const dest = dstNorm + f.path.slice(srcNorm.length);
        const resp = await this.#fetch('COPY', account, f.path, {
          'Destination': _pathToUrl(account.url, dest),
          'Overwrite': 'T',
          'Depth': '0',
        }, undefined, signal);
        _checkStatus(resp);
        completed.push({ kind: 'file', action: 'copied', source: { path: f.path }, target: { path: dest } });
      }
    } catch (e) {
      this.#emitPartial(storageId, account, completed);
      if (e.name !== 'AbortError') throw e;
      return;
    }
    this.#broadcastToAll(account.accountId, account, completed);
  }

  async #mergeMove(account, storageId, srcPath, destPath, signal) {
    const srcNorm = srcPath.replace(/\/$/, '');
    const dstNorm = destPath.replace(/\/$/, '');
    const entries = await this.#collectAll(account, srcPath, signal);

    await this.#mkcolSafe(account, dstNorm, signal);

    const dirs = entries.filter(e => e.kind === 'directory').sort((a, b) => a.path.localeCompare(b.path));
    const files = entries.filter(e => e.kind === 'file');
    const completed = [];
    try {
      for (const d of dirs) {
        if (signal?.aborted) { this.#emitPartial(storageId, account, completed); return; }
        await this.#mkcolSafe(account, dstNorm + d.path.slice(srcNorm.length), signal);
      }
      for (const f of files) {
        if (signal?.aborted) { this.#emitPartial(storageId, account, completed); return; }
        const dest = dstNorm + f.path.slice(srcNorm.length);
        const resp = await this.#fetch('MOVE', account, f.path, {
          'Destination': _pathToUrl(account.url, dest),
          'Overwrite': 'T',
        }, undefined, signal);
        if (resp.status !== 404) _checkStatus(resp);
        completed.push({ kind: 'file', action: 'moved', source: { path: f.path }, target: { path: dest } });
      }
    } catch (e) {
      this.#emitPartial(storageId, account, completed);
      if (e.name !== 'AbortError') throw e;
      return;
    }
    const delResp = await this.#fetch('DELETE', account, srcPath, {}, undefined, signal);
    if (delResp.status !== 404) _checkStatus(delResp);
    this.#broadcastToAll(account.accountId, account, completed);
  }

  /** MKCOL that silently ignores 405 (collection already exists). */
  async #mkcolSafe(account, path, signal) {
    const resp = await this.#fetch('MKCOL', account, path, {}, undefined, signal);
    if (resp.status !== 405) _checkStatus(resp);
  }

  async #mkdirpParent(account, path, signal) {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return;
    const segments = path.slice(1, lastSlash).split('/').filter(Boolean);
    let current = '';
    for (const seg of segments) {
      current += '/' + seg;
      await this.#mkcolSafe(account, current, signal);
    }
  }

  /** Notifies all connections of partial results (abort/error mid-merge). */
  #emitPartial(storageId, account, completed) {
    if (completed.length === 0) return;
    this.reportStorageChange(storageId, completed);
    this.#broadcastToAll(account.accountId, account, completed);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const provider = new WebDavProvider();
provider.init();

// Start one poll per unique account referenced by existing connections.
browser.storage.local.get(null).then(all => {
  const accountIds = new Set();
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith(CRED_PREFIX) && val?.accountId)
      accountIds.add(val.accountId);
  }
  for (const accountId of accountIds)
    provider.startPoll(accountId);
});

// React to connections being added or removed.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    if (!key.startsWith(CRED_PREFIX)) continue;
    if (newValue?.accountId) provider.startPoll(newValue.accountId);
    else if (oldValue?.accountId) provider.stopPoll(oldValue.accountId);
  }
});
