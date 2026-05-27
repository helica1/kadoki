import { WebPlugin } from '@capacitor/core';

import type { FileAccessPlugin } from './definitions';

export class FileAccessWeb extends WebPlugin implements FileAccessPlugin {
  async takePersistableUriPermission(): Promise<void> {
    throw new Error('Not implemented on web');
  }

  async getPersistedUriPermissions(): Promise<{ uris: string[] }> {
    throw new Error('Not implemented on web');
  }

  async readFileFromUri(): Promise<{ data: string; name: string }> {
    throw new Error('Not implemented on web');
  }

  async checkUriPermission(): Promise<{ hasPermission: boolean }> {
    throw new Error('Not implemented on web');
  }

  async pickFileWithUri(): Promise<{ uri: string; name: string }> {
    throw new Error('Not implemented on web');
  }

  async materializeToCache(): Promise<{ path: string; size: number; cached: boolean }> {
    throw new Error('Not implemented on web');
  }
}