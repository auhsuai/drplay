import { describe, expect, it } from 'vitest';
import { classifyPlayerError, isAbortError } from './utils';

describe('isAbortError (duck-typed)', () => {
  it('true cho DOMException AbortError thật', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
  });

  it('true cho object duck-typed { name: "AbortError" } không phải DOMException (jsdom)', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
  });

  it('false cho DOMException khác tên', () => {
    expect(isAbortError(new DOMException('NotAllowed', 'NotAllowedError'))).toBe(false);
  });

  it('false cho Error thường, string, null, undefined', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it('classifyPlayerError vẫn hoạt động như cũ', () => {
    expect(classifyPlayerError(new Error('x')).name).toBe('Error');
    expect(classifyPlayerError('x').message).toBe('x');
    expect(classifyPlayerError(42).name).toBe('UnknownError');
  });
});
