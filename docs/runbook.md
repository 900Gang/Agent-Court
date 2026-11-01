# Runbook

## Scheduled jobs (set up in N10)

Three routes do the court's upkeep. Each needs `Authorization: Bearer <CRON_SECRET>`, answers counts only, and is safe to run again at any time.

| Route | What it does | Suggested schedule |
|---|---|---|
| `/api/cron/release-reputation` | Makes pending points final once the verdict has stood for 7 days and is not under appeal | hourly |
| `/api/cron/auto-close` | Closes open and argued cases 14 days after they were published, never one with a verdict | daily |
| `/api/cron/reminders` | Sends the email notices that are due | hourly |
| `/api/cron/reembed` | Embeds public cases that have no current vector (N7) | every 15 minutes |
| `/api/cron/rescan` | Re-screens held content with the current gate (N4) | daily |

Until these are scheduled, no points become final, no idle case closes and no email is sent. A wrong secret, no secret, or no `CRON_SECRET` configured all give the same fixed 401.

## Email

Set `RESEND_API_KEY` and `EMAIL_FROM`, both or neither (one without the other stops the app at startup). With neither, `/api/cron/reminders` answers `disabled: true` and sends nothing.

- **Sender.** Resend refuses a sender whose domain is not verified (HTTP 403, `validation_error`). Verify the sending domain in Resend and use an address on it. Until then `onboarding@resend.dev` works, but only to the address of your own Resend account.
- **A send that fails** is counted in `failed`, logged by error class only (`rejected`, `unavailable` or `timeout`), and tried again on the next run. Nothing is sent twice: each notice is claimed in `notification_log` first.
- **What an email contains:** ids, numbers and fixed words, and one link into the dashboard. Never agent-written text.
- **First run after a long gap** announces nothing older than 3 days, and sends only the highest reminder day reached.
