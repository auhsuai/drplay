// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from './errorLog';
import { downloadDir } from '@tauri-apps/api/path';
import {
  getCustomDownloadPath,
  getEffectiveDownloadPath,
  setCustomDownloadPath
} from './downloadPath';

vi.mock('./errorLog', () => ({
  captureError: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: vi.fn()
}));

const mockedCaptureError = vi.mocked(captureError);
const mockedDownloadDir = vi.mocked(downloadDir);

describe('downloadPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockedDownloadDir.mockResolvedValue('/home/user/Music');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getCustomDownloadPath: SecurityError from localStorage.getItem is caught → returns null and logs', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(getCustomDownloadPath()).toBeNull();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'downloadPath',
      message: 'custom-path-read-failed:SecurityError'
    });
  });

  it('setCustomDownloadPath: QuotaExceededError from setItem does not throw and logs', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => setCustomDownloadPath('C:\\Music')).not.toThrow();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'downloadPath',
      message: 'custom-path-write-failed:QuotaExceededError'
    });
  });

  it('getCustomDownloadPath: returns the stored value verbatim when available', () => {
    localStorage.setItem('drplay_download_path', 'D:\\Songs');
    expect(getCustomDownloadPath()).toBe('D:\\Songs');
  });

  it('getEffectiveDownloadPath: falls back to downloadDir() when no custom path is set', async () => {
    await expect(getEffectiveDownloadPath()).resolves.toBe('/home/user/Music');
    expect(mockedDownloadDir).toHaveBeenCalledTimes(1);
  });

  it('getEffectiveDownloadPath: returns the custom path without touching downloadDir()', async () => {
    localStorage.setItem('drplay_download_path', 'E:\\Flac');
    await expect(getEffectiveDownloadPath()).resolves.toBe('E:\\Flac');
    expect(mockedDownloadDir).not.toHaveBeenCalled();
  });
});
