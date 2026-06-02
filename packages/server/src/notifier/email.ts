import nodemailer, { type Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : undefined;
}

/** True only when all required SMTP env vars are present. */
export function isEmailConfigured(): boolean {
  return Boolean(
    env('AUTOREG_SMTP_HOST') &&
      env('AUTOREG_SMTP_USER') &&
      env('AUTOREG_SMTP_PASS') &&
      env('AUTOREG_EMAIL_TO'),
  );
}

function getTransporter(): Transporter | null {
  if (!isEmailConfigured()) return null;
  if (!transporter) {
    const port = Number(env('AUTOREG_SMTP_PORT') ?? '587');
    transporter = nodemailer.createTransport({
      host: env('AUTOREG_SMTP_HOST'),
      port,
      secure: port === 465,
      auth: { user: env('AUTOREG_SMTP_USER'), pass: env('AUTOREG_SMTP_PASS') },
    });
  }
  return transporter;
}

/** Send a plain-text email. No-op if SMTP isn't configured. */
export async function sendEmail(subject: string, text: string): Promise<void> {
  const t = getTransporter();
  if (!t) return;
  await t.sendMail({ from: env('AUTOREG_SMTP_USER'), to: env('AUTOREG_EMAIL_TO'), subject, text });
}
