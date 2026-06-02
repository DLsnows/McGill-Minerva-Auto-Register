import notifier from 'node-notifier';
import type { LogEvent, Settings } from '@autoregister/shared';
import { isEmailConfigured, sendEmail } from './email';
import { buildNotification, shouldNotify } from './notification';

/**
 * Dispatches significant scheduler events to the enabled channels (desktop,
 * sound, email). The in-app log is handled separately by the Store. A failing
 * channel never breaks the others.
 */
export class Notifier {
  constructor(private readonly getSettings: () => Settings) {}

  async notify(event: LogEvent): Promise<void> {
    if (!shouldNotify(event)) return;
    const { title, body } = buildNotification(event);
    const s = this.getSettings();

    if (s.notify.desktop) {
      try {
        notifier.notify({ title, message: body, sound: s.notify.sound });
      } catch (e) {
        console.warn('desktop notification failed:', e instanceof Error ? e.message : e);
      }
    }

    if (s.notify.email && isEmailConfigured(s.email)) {
      try {
        await sendEmail(s.email, title, body);
      } catch (e) {
        console.warn('email notification failed:', e instanceof Error ? e.message : e);
      }
    }
  }
}
