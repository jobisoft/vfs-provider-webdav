const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Probes candidate WebDAV endpoint URLs in order and returns the first one
 * that responds with a successful PROPFIND.
 *
 * Autodiscovery order:
 *   1. OPTIONS on the entered URL — if the server returns a DAV: header the
 *      URL is already a valid WebDAV endpoint (RFC 4918 compliant check).
 *   2. The URL as entered via PROPFIND (fallback for servers that don't
 *      advertise DAV: on OPTIONS but still respond to PROPFIND).
 *   3. Nextcloud / ownCloud: /remote.php/dav/files/{username}/
 *   4. Nextcloud legacy:     /remote.php/webdav/
 *   5. Generic:              /dav/
 *
 * Throws a localised error on auth failure or no endpoint found.
 */
export async function discover(rawServer, username, password) {
  let base = rawServer.trim();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  if (!base.endsWith('/')) base += '/';

  const auth = 'Basic ' + btoa(`${username}:${password}`);

  // RFC 4918: an OPTIONS response with a DAV: header confirms a WebDAV endpoint.
  try {
    const resp = await fetch(base, {
      method: 'OPTIONS',
      headers: { 'Authorization': auth },
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(browser.i18n.getMessage('setupErrorAuth'));
    }
    if (resp.headers.get('DAV')) return base;
  } catch (e) {
    if (e.message === browser.i18n.getMessage('setupErrorAuth')) throw e;
    // Network error — fall through to PROPFIND candidates.
  }

  const enc = encodeURIComponent(username);
  const origin = new URL(base).origin + '/';

  // Build candidate list: guesses from the entered URL first, then from the
  // bare origin (in case the user entered a wrong sub-path). Deduplicate so
  // we don't probe the same URL twice when base already equals the origin.
  const candidateSet = new Set([
    base,
    `${base}remote.php/dav/files/${enc}/`,
    `${base}remote.php/webdav/`,
    `${base}dav/`,
    origin,
    `${origin}remote.php/dav/files/${enc}/`,
    `${origin}remote.php/webdav/`,
    `${origin}dav/`,
  ]);
  const candidates = [...candidateSet];

  for (const url of candidates) {
    await sleep(500);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'PROPFIND',
        headers: {
          'Authorization': auth,
          'Depth': '0',
          'Content-Type': 'application/xml; charset="utf-8"',
        },
        body: PROPFIND_BODY,
      });
    } catch {
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(browser.i18n.getMessage('setupErrorAuth'));
    }
    if (resp.ok || resp.status === 207) return url;
  }

  throw new Error(browser.i18n.getMessage('setupErrorNoEndpoint'));
}
