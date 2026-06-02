# Email Notification Setup

Email notifications are **optional**. Desktop + sound notifications and the in-app
log work without any of this. Set up email only if you want to be alerted when
you're away from the machine.

Credentials live in a local `.env` file that is **gitignored** — they are never
committed or uploaded.

## 1. Create your `.env`

Copy the example file in the project root:

```bash
cp .env.example .env
```

Then edit `.env` with your SMTP details (below).

## 2a. Gmail (recommended for most people)

Gmail does **not** accept your normal password over SMTP. You need an **App
Password**, which requires 2-Step Verification on your Google account.

1. Turn on **2-Step Verification**: <https://myaccount.google.com/signinoptions/twosv>
2. Create an **App Password**: <https://myaccount.google.com/apppasswords>
   - App: "Mail", Device: "Other" → name it "AutoRegister".
   - Google shows a **16-character password** (e.g. `abcd efgh ijkl mnop`).
3. Put these in `.env` (remove the spaces from the app password):

```
AUTOREG_SMTP_HOST=smtp.gmail.com
AUTOREG_SMTP_PORT=587
AUTOREG_SMTP_USER=yourname@gmail.com
AUTOREG_SMTP_PASS=abcdefghijklmnop
AUTOREG_EMAIL_TO=yourname@gmail.com
```

## 2b. Outlook / Office 365

```
AUTOREG_SMTP_HOST=smtp.office365.com
AUTOREG_SMTP_PORT=587
AUTOREG_SMTP_USER=yourname@outlook.com
AUTOREG_SMTP_PASS=your_password_or_app_password
AUTOREG_EMAIL_TO=yourname@outlook.com
```

## 2c. Any other SMTP provider

Fill in your provider's SMTP host, port (587 for STARTTLS, 465 for SSL),
username, and password.

## 3. Enable the email channel

In the app's **Settings**, turn the **Email** notification channel on. (Email is
off by default.) If `.env` isn't configured, email sends are skipped silently and
the other channels still work.

## Notes

- Use port **465** only if your provider requires SSL; otherwise **587**.
- If emails don't arrive: check spam, verify the app password (not your login
  password), and confirm `AUTOREG_EMAIL_TO` is correct.
