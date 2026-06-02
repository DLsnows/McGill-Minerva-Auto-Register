import nodemailer from 'nodemailer';
import type { EmailConfig } from '@autoregister/shared';

/** True only when all required SMTP fields are present. */
export function isEmailConfigured(cfg?: EmailConfig): cfg is EmailConfig {
  return Boolean(cfg && cfg.host && cfg.user && cfg.pass && cfg.to);
}

/** Send a plain-text email using the given SMTP config. */
export async function sendEmail(cfg: EmailConfig, subject: string, text: string): Promise<void> {
  const port = cfg.port || 587;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port,
    secure: port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  try {
    await transporter.sendMail({ from: cfg.user, to: cfg.to, subject, text });
  } finally {
    transporter.close();
  }
}
