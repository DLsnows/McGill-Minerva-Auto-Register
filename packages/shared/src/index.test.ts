import { describe, it, expect } from 'vitest';
import { VERSION } from './index';

describe('shared package', () => {
  it('exposes a version string', () => {
    expect(VERSION).toBe('0.0.0');
  });
});
