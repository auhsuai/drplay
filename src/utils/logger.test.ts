import { describe, it, expect } from 'vitest';
import { sanitizeString, sanitizeArg } from './logger';

describe('logger sanitizeString', () => {
  it('redacts local proxy link with id → [REDACTED_LINK]', () => {
    const input = 'http://127.0.0.1:62216/stream?id=1RoFd1kOvoIn_0C8vmcuUHZ4DdZEx01pp&ext=mp3';
    expect(sanitizeString(input)).toBe('[REDACTED_LINK]');
  });

  it('redacts googleapis file url → [REDACTED_LINK]', () => {
    const input = 'https://www.googleapis.com/drive/v3/files/1RoFd1kOvoIn_0C8vmcuUHZ4DdZEx01pp?alt=media';
    expect(sanitizeString(input)).toBe('[REDACTED_LINK]');
  });

  it('redacts ?id=xxx → ?id=[REDACTED_ID]', () => {
    expect(sanitizeString('?id=1RoFd1kOvoIn')).toBe('?id=[REDACTED_ID]');
  });

  it('redacts access_token=xxx → [REDACTED_TOKEN]', () => {
    expect(sanitizeString('access_token=ya29.secretToken')).toBe('[REDACTED_TOKEN]');
    expect(sanitizeString('?access_token=ya29.secretToken')).toBe('[REDACTED_TOKEN]');
  });

  it('redacts Bearer xxx → Bearer [REDACTED_TOKEN]', () => {
    expect(sanitizeString('Bearer eyJhbGciOiJIUzI1NiIs')).toBe('Bearer [REDACTED_TOKEN]');
  });
});

describe('logger sanitizeArg', () => {
  it('redacts Error object message', () => {
    const err = new Error('fetch failed: http://127.0.0.1:62216/stream?id=1RoFd1kOvoIn&ext=mp3');
    const san = sanitizeArg(err);
    expect(san).toBeInstanceOf(Error);
    expect(san.message).toBe('fetch failed: [REDACTED_LINK]');
    expect(san.name).toBe('Error');
  });

  it('redacts nested object values', () => {
    const obj = { url: 'http://127.0.0.1:62216/x?id=abc', token: 'Bearer xyz.abc.def' };
    const san = sanitizeArg(obj);
    expect(san.url).toBe('[REDACTED_LINK]');
    expect(san.token).toBe('Bearer [REDACTED_TOKEN]');
  });

  it('returns primitives untouched when not sensitive', () => {
    expect(sanitizeArg(42)).toBe(42);
    expect(sanitizeArg('hello world')).toBe('hello world');
  });
});
