export const ACCOUNT_PREFIX = 'webdav-account-';
export const CRED_PREFIX = 'webdav-conn-';
export const accountKey = id => ACCOUNT_PREFIX + id;
export const credKey = id => CRED_PREFIX + id;

/**
 * Returns all stored accounts from a full storage snapshot.
 * Each entry is the stored object extended with an `accountId` field.
 */
export function loadAccounts(storage) {
  return Object.entries(storage)
    .filter(([k]) => k.startsWith(ACCOUNT_PREFIX))
    .map(([k, v]) => ({ accountId: k.slice(ACCOUNT_PREFIX.length), ...v }));
}
