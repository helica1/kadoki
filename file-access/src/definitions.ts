export interface FileAccessPlugin {
  /**
   * Take persistent URI permission for future access
   */
  takePersistableUriPermission(options: { uri: string }): Promise<void>;
  
  /**
   * Get all persisted URI permissions
   */
  getPersistedUriPermissions(): Promise<{ uris: string[] }>;
  
  /**
   * Read file using persisted URI
   */
  readFileFromUri(options: { uri: string }): Promise<{ data: string; name: string }>;
  
  /**
   * Check if URI permission still exists
   */
  checkUriPermission(options: { uri: string }): Promise<{ hasPermission: boolean }>;
  
  /**
   * Open file picker and return file with URI
   */
  pickFileWithUri(): Promise<{ uri: string; name: string }>;

  /**
   * Stream a content:// URI into the app's cache directory.
   * Returns a real filesystem path that can be read via fetch(convertFileSrc(path)).
   * Idempotent: re-uses cache file if size matches the source.
   */
  materializeToCache(options: { uri: string }): Promise<{ path: string; size: number; cached: boolean }>;
}