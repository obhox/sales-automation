// Repeatable "random" choices. A campaign step that picks one of several templates or
// wordings has to make the same pick if it runs again for the same contact (a retry after
// a failed send, a preview opened twice); otherwise the retry sends different text, and the
// check that a message was already sent, which compares text, misses it.

/** A stable number in [0, 1) for a string. FNV-1a, then a mixing step so near-identical seeds spread out. */
export function seededUnit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

/** One of `items`, always the same one for the same seed. */
export function seededPick<T>(seed: string, items: readonly T[]): T {
  return items[Math.floor(seededUnit(seed) * items.length)];
}
