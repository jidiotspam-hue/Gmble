// Picks the storage backend: Firebase when js/config.js provides a config, else localStorage.
// getStore() returns one shared store instance (memoized). Call `await store.init()` before use;
// init() is idempotent. If the Firebase SDK fails to load, the error is rethrown so the UI can show it.
import { FIREBASE_CONFIG } from '../config.js';

let storePromise = null;

export function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      if (FIREBASE_CONFIG) {
        const { createFirebaseStore } = await import('./firebase.js');
        return createFirebaseStore(FIREBASE_CONFIG);
      }
      const { createLocalStore } = await import('./local.js');
      return createLocalStore();
    })();
    // Allow a retry after a failure (e.g. offline when the CDN was requested).
    storePromise.catch(() => { storePromise = null; });
  }
  return storePromise;
}
