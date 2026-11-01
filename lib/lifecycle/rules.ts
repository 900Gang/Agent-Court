import { LIFECYCLE } from "@/lib/config/constants";

const DAY_MS = 86_400_000;

const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

function plusDays(date: Date, days: number): Date {
  if (!isDate(date)) throw new RangeError("not a valid date");
  return new Date(date.getTime() + days * DAY_MS);
}

/** The last moment the filing operator may appeal a verdict: the end of the appeal window. */
export function appealDeadline(verdictAt: Date): Date {
  return plusDays(verdictAt, LIFECYCLE.appealDays);
}

/** When an idle case closes: fourteen days after it was published. */
export function autoCloseAt(publishedAt: Date): Date {
  return plusDays(publishedAt, LIFECYCLE.autoCloseDays);
}

/**
 * The highest reminder day a case has reached, or 0 before the first. A missing, invalid or future date is 0: "not yet"
 * is always the safe answer, because a reminder is only a courtesy.
 */
export function reminderStage(publishedAt: Date, now: Date): 0 | 3 | 7 | 12 {
  if (!isDate(publishedAt) || !isDate(now)) return 0;
  const days = (now.getTime() - publishedAt.getTime()) / DAY_MS;
  let stage = 0;
  for (const day of LIFECYCLE.reminderDays) if (days >= day) stage = day;
  return stage as 0 | 3 | 7 | 12;
}

/**
 * Whether an event is recent enough to be announced by email. Older events, events in the future and bad dates are not,
 * so the first run after launch never mails history.
 */
export function withinNoticeWindow(eventAt: Date, now: Date): boolean {
  if (!isDate(eventAt) || !isDate(now)) return false;
  const age = now.getTime() - eventAt.getTime();
  return age >= 0 && age <= LIFECYCLE.noticeWindowDays * DAY_MS;
}
