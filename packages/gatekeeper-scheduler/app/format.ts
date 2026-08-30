import type { ManagementSchedule } from "../src/management-types";
import type { ScheduleCadence, Weekday } from "../src/types";
import { getSchedulerLocale, schedulerMessageForLocale } from "./i18n";

const WEEKDAY_OFFSET: Record<Weekday, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export type ScheduleTiming = {
  relative: string;
  absolute?: string;
  diagnostic?: string;
};

export function formatCadence(cadence: ScheduleCadence, locale = getSchedulerLocale()): string {
  if (cadence.kind === "interval") return formatInterval(cadence.everyMs, locale);
  if (cadence.kind === "once") {
    const date = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(cadence.fireAt);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(cadence.fireAt);
    return message(locale, "Once on {{date}} at {{time}}", { date, time });
  }

  const { rule } = cadence;
  if (rule.freq === "hourly") {
    const minute = rule.minute.toString().padStart(2, "0");
    return rule.interval === 1
      ? message(locale, "Hourly at :{{minute}}", { minute })
      : message(locale, "Every {{count}} hours at :{{minute}}", {
          count: rule.interval,
          minute,
        });
  }
  const time = formatClock(rule.hour, rule.minute, locale);
  if (rule.freq === "daily") {
    return rule.interval === 1
      ? message(locale, "Daily at {{time}}", { time })
      : message(locale, "Every {{count}} days at {{time}}", { count: rule.interval, time });
  }
  if (rule.interval === 1 && rule.byDay.join(",") === "MO,TU,WE,TH,FR") {
    return message(locale, "Weekdays at {{time}}", { time });
  }
  const days = new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(
    rule.byDay.map((day) => formatWeekday(day, locale)),
  );
  return rule.interval === 1
    ? message(locale, "Weekly on {{days}} at {{time}}", { days, time })
    : message(locale, "Every {{count}} weeks on {{days}} at {{time}}", {
        count: rule.interval,
        days,
        time,
      });
}

/** Describes a finite recurrence bound and, for a counted bound, progress toward it. */
export function formatOccurrences(
  schedule: ManagementSchedule,
  locale = getSchedulerLocale(),
): string | undefined {
  const bound = schedule.occurrences;
  if (!bound) return undefined;
  if ("count" in bound) {
    return message(
      locale,
      bound.count === 1
        ? "{{current}} of {{total}} occurrence"
        : "{{current}} of {{total}} occurrences",
      { current: schedule.occurrenceCount ?? 0, total: bound.count },
    );
  }
  return message(locale, "until {{date}}", {
    date: formatAbsolute(bound.until, scheduleTimeZone(schedule), locale),
  });
}

export function formatTiming(
  schedule: ManagementSchedule,
  now = Date.now(),
  locale = getSchedulerLocale(),
): ScheduleTiming {
  const timestamp = scheduleTimestamp(schedule);
  if (timestamp === undefined) return { relative: message(locale, "Next run pending") };
  const absolute = formatAbsolute(timestamp, scheduleTimeZone(schedule), locale);
  if (schedule.status === "active") {
    return {
      relative: message(
        locale,
        schedule.retrying ? "Next run {{relative}} (retry)" : "Next run {{relative}}",
        { relative: formatRelative(timestamp - now, locale) },
      ),
      absolute,
    };
  }
  if (schedule.status === "dead") {
    return {
      relative: message(locale, "Failed {{relative}}", {
        relative: formatRelative(schedule.failedAt - now, locale),
      }),
      absolute,
      diagnostic:
        schedule.failureCode === "authorization_failed"
          ? message(locale, "Authorization failed after retries.")
          : message(locale, "Task callback failed after retries."),
    };
  }
  if (schedule.status === "completed") {
    return {
      relative: message(locale, "Completed {{relative}}", {
        relative: formatRelative(schedule.completedAt - now, locale),
      }),
      absolute,
      diagnostic: schedule.occurrences
        ? message(locale, "This recurring task used its last scheduled occurrence.")
        : message(locale, "This one-time task completed."),
    };
  }
  return {
    relative: message(locale, "Expired {{relative}}", {
      relative: formatRelative(schedule.expiredAt - now, locale),
    }),
    absolute,
    diagnostic: schedule.cadence.kind === "once"
      ? message(locale, "This one-time task passed without delivery.")
      : message(locale, "This recurring task's cutoff passed before its first occurrence."),
  };
}

function formatInterval(milliseconds: number, locale: string): string {
  const units = [
    [7 * 24 * 60 * 60_000, "week"],
    [24 * 60 * 60_000, "day"],
    [60 * 60_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ] as const;
  const [unitMs, unit] = units.find(([size]) => milliseconds % size === 0) ?? [1, "millisecond"];
  const count = milliseconds / unitMs;
  return message(locale, count === 1 ? `Every ${unit}` : `Every {{count}} ${unit}s`, { count });
}

function formatWeekday(day: Weekday, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(
    Date.UTC(2020, 0, 5 + WEEKDAY_OFFSET[day]),
  );
}

function formatClock(hour: number, minute: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.UTC(2020, 0, 1, hour, minute));
}

function formatRelative(milliseconds: number, locale: string): string {
  const absolute = Math.abs(milliseconds);
  const [size, unit] =
    absolute >= 24 * 60 * 60_000
      ? ([24 * 60 * 60_000, "day"] as const)
      : absolute >= 60 * 60_000
        ? ([60 * 60_000, "hour"] as const)
        : absolute >= 60_000
          ? ([60_000, "minute"] as const)
          : ([1_000, "second"] as const);
  const value = Math.round(milliseconds / size);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit);
}

function formatAbsolute(timestamp: number, timeZone: string | undefined, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timestamp);
}

function scheduleTimestamp(schedule: ManagementSchedule): number | undefined {
  if (schedule.status === "active") return schedule.nextFire;
  if (schedule.status === "dead") return schedule.failedAt;
  if (schedule.status === "completed") return schedule.completedAt;
  return schedule.expiredAt;
}

function scheduleTimeZone(schedule: ManagementSchedule): string | undefined {
  return schedule.cadence.kind === "interval" ? undefined : schedule.cadence.timeZone;
}

function message(
  locale: string,
  source: string,
  variables?: Record<string, string | number>,
): string {
  return schedulerMessageForLocale(locale, source, variables);
}
