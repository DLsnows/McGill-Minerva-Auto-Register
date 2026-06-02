# Email Notification Setup

Email notifications are **optional**. Desktop + sound notifications and the in-app
log work without any of this. Set up email only if you want alerts when you're
away from the machine.

You configure email **in the app's Settings page** (Notifications → Email). The
values are stored locally on your machine only — never committed or uploaded.

## What you'll enter in Settings → Email

| Field | Example | Notes |
|-------|---------|-------|
| Host | `smtp.gmail.com` | Your SMTP server |
| Port | `587` | `587` (STARTTLS) or `465` (SSL) |
| User | `you@gmail.com` | The sending account |
| Password | (app password) | NOT your normal login password for Gmail |
| To | `you@gmail.com` | Where alerts are sent (can be the same) |

Then enable the **Email** toggle under Notifications.

## Gmail (recommended)

Gmail does not accept your normal password over SMTP — you need an **App
Password**, which requires 2-Step Verification.

1. Turn on **2-Step Verification**: <https://myaccount.google.com/signinoptions/twosv>
2. Create an **App Password**: <https://myaccount.google.com/apppasswords>
   - App: "Mail", Device: "Other" → name it "AutoRegister".
   - Google shows a **16-character password** (e.g. `abcd efgh ijkl mnop`).
3. In Settings → Email, enter:
   - Host `smtp.gmail.com`, Port `587`, User `you@gmail.com`,
     Password = the 16-char app password (spaces optional), To `you@gmail.com`.

## Outlook / Office 365

Host `smtp.office365.com`, Port `587`, your address + password (or app password).

## Any other SMTP provider

Use your provider's SMTP host, port (`587` STARTTLS / `465` SSL), username, and password.

## Notes

- If emails don't arrive: check spam, verify the app password (not your login
  password), and confirm the "To" address.
- Credentials are stored in the app's local data file (gitignored) — they never
  leave your machine.
