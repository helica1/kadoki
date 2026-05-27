import { registerPlugin } from '@capacitor/core';

import type { FileAccessPlugin } from './definitions';

const FileAccess = registerPlugin<FileAccessPlugin>('FileAccess', {
  web: () => import('./web').then((m) => new m.FileAccessWeb()),
});

export * from './definitions';
export { FileAccess };
