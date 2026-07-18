/**
 * The entire local footprint that a person can remove from SonIQ Settings.
 * Keep this list explicit: reset must never broaden into Storage.clear().
 */
export const soniqOwnedStorageKeys = [
  "soniq:onboarding-v4-complete",
  "soniq:display-name",
  "soniq:theme",
  "soniq:scan-history-v1",
  "soniq:soundtrack-library-v2",
] as const;

/** Deliberately restricts API so callers cannot clear unrelated data. */
export function removeSoniqOwnedStorage(storage: Pick<Storage, "removeItem" | "length" | "key">) {
  for (const key of soniqOwnedStorageKeys) storage.removeItem(key);
}
