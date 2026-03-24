# VFS Toolkit WebDAV Provider

A WebDAV storage provider add-on for Thunderbird using the VFS Toolkit.

## Build

Set the desired version in `package.json`, then run:

```
npm run build
```

This will:
- Copy the latest `vfs-provider` library into `src/vendor/vfs-provider/`
- Sync the version from `package.json` into `src/manifest.json`
- Create `dist/vfs-toolkit-webdav-provider_<version>.xpi` - the installable add-on

## Storage model

The add-on centrally manages accounts for WebDAV servers and allows add-ons to either
use existing accounts or create new accounts during their own setup flow. Multiple
add-ons can share a single account.

## Account management (Options page)

The options page lists all stored WebDAV accounts and active connections. The user
can create or delete accounts and revoke access for installed add-ons.

## Setup flow

When an add-on requests a WebDAV connection, the setup page opens. The user can:

1. Select an **existing account** from the dropdown to reuse it without re-entering
   credentials.
2. Enter new credentials to **create a new account and connection**.

For new credentials, the add-on runs autodiscovery to locate the WebDAV endpoint:

1. **OPTIONS** on the entered URL - if the server returns a `DAV:` header (RFC 4918),
   the URL is confirmed immediately.
2. **PROPFIND** candidates derived from the entered URL: the URL itself, then
   Nextcloud/ownCloud paths (`/remote.php/dav/files/{user}/`, `/remote.php/webdav/`),
   then `/dav/`.
3. If none match, the same candidates are retried from the **bare origin** in case
   the user entered a sub-path.

A 500 ms delay is inserted between each probe to avoid triggering rate-limits on
the server. If a matching account (same WebDAV resource URL + username) already
exists it is reused instead of creating a duplicate.

## Config page

Each active connection has a config page where the user can update the connection
name, WebDAV endpoint URL, credentials, and poll interval.

## External change detection (polling)

WebDAV has no push notification mechanism, so the add-on detects external changes
by periodically polling the server.

When a connection is active, the add-on performs a full recursive `PROPFIND` of
the WebDAV endpoint and caches the ETag and path of every file and folder. On each
poll cycle it repeats the `PROPFIND` and compares against the cache to detect:

- **Created** - a path that was not in the previous snapshot
- **Modified** - a file whose ETag has changed
- **Deleted** - a path that no longer exists on the server

Detected changes are reported to the `vfs toolkit` so the UI can update accordingly.
After a local update the cache is updated immediately and all connections are notified
without waiting for the next poll tick.

The poll interval is configured per account (in seconds, minimum 10 s, default 60 s).
Setting it to **0** disables polling entirely.

## Logo

The logo is provided by http://www.webdav.org/
