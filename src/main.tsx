// The local storage key is unlocked from the device keystore before the rest of the app loads,
// because several modules read secure storage as soon as they are imported.
import { initSecureStorageKey } from './lib/native-key';

initSecureStorageKey().finally(() => {
  import('./app-entry').catch(error => console.error('[Boot] failed to load the app:', error));
});
