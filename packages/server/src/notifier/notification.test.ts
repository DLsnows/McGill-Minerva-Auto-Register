import { describe, expect, it } from 'vitest';
import type { LogEvent, LogLevel } from '@autoregister/shared';
import { buildNotification, shouldNotify } from './notification';

const ev = (level: LogLevel, message = 'm'): LogEvent => ({ id: '1', ts: 0, level, message });

describe('shouldNotify', () => {
  it('skips routine info events', () => {
    expect(shouldNotify(ev('info'))).toBe(false);
  });

  it('notifies on action/ok/warn/error', () => {
    for (const l of ['action', 'ok', 'warn', 'error'] as const) {
      expect(shouldNotify(ev(l))).toBe(true);
    }
  });
});

describe('buildNotification', () => {
  it('builds a per-level title and uses the message as the body', () => {
    const n = buildNotification(ev('ok', 'Registered COMP 551!'));
    expect(n.title).toContain('AutoRegister');
    expect(n.body).toBe('Registered COMP 551!');
  });

  it('uses an opening-found title for action events', () => {
    expect(buildNotification(ev('action', 'Opening found')).title).toMatch(/opening found/i);
  });
});
