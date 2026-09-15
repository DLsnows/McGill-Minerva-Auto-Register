import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEvent, Settings } from '@autoregister/shared';
import { DEFAULT_SETTINGS } from '@autoregister/shared';
import { isEmailConfigured, sendEmail } from './email';
import { Notifier } from './notifier';

vi.mock('node-notifier', () => ({ default: { notify: vi.fn() } }));
vi.mock('./email', () => ({
  sendEmail: vi.fn(async () => undefined),
  isEmailConfigured: vi.fn(() => true),
}));

const event: LogEvent = { id: '1', ts: 0, level: 'ok', message: 'Registered COMP 551!' };

const settings = (notify: Partial<Settings['notify']>): Settings => ({
  ...DEFAULT_SETTINGS,
  email: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', to: 'to@example.com' },
  notify: { ...DEFAULT_SETTINGS.notify, ...notify },
});

afterEach(() => vi.clearAllMocks());

describe('Notifier email channel (temporarily sunset)', () => {
  it('never sends email when notify.email is false, even with a full SMTP config', async () => {
    await new Notifier(() => settings({ email: false })).notify(event);
    expect(isEmailConfigured).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still sends email when the channel is on (code path kept for the restore)', async () => {
    await new Notifier(() => settings({ email: true })).notify(event);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
