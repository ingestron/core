/** Pure, bounded portable clock evaluation. Never reads the current clock or runs work. */
import { Temporal } from "@js-temporal/polyfill";
import { scheduleClockMetadata } from "./schedule-clock-metadata.js";
import { z } from "zod";
import { canonical, check, digest } from "./errors.js";
import {
  scheduleInstantSchema,
  scheduleSchema,
  weekdays,
} from "./schedule-schema.js";

export const scheduleOccurrencesSchema = z
  .object({
    schedule: scheduleSchema,
    from: scheduleInstantSchema,
    to: scheduleInstantSchema,
    limit: z.number().int().min(1).max(1000).default(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    const duration = Date.parse(value.to) - Date.parse(value.from);
    if (duration <= 0 || duration > 366 * 86400000)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "Choose a later end within 366 elapsed days",
      });
  });

type Occurrence = {
  id: string;
  at: string;
  localTime: string;
  offset: string;
  requestedSlots: string[];
  resolution: "exact" | "fold-earlier" | "fold-later" | "shift-forward";
};
export function scheduleOccurrences(
  input: z.input<typeof scheduleOccurrencesSchema>,
) {
  const args = scheduleOccurrencesSchema.parse(input);
  const { schedule } = args;
  check(
    schedule.missed !== "native",
    "SCHEDULE_NATIVE_CLOCK",
    "The target owns this clock; portable occurrence evaluation cannot promise native timing",
  );
  const definitionDigest = digest(canonical(schedule));
  const clock = scheduleClockMetadata();
  const lower = Math.max(Date.parse(args.from), Date.parse(schedule.start));
  const upper = Math.min(
    Date.parse(args.to),
    schedule.end ? Date.parse(schedule.end) : Infinity,
  );
  const inRange = (value: number) => value >= lower && value < upper;
  const found = new Map<number, Occurrence>();
  const skipped: {
    requestedLocalTime: string;
    reason: "nonexistent-local-time";
  }[] = [];
  let skippedCount = 0;
  const add = (
    value: Temporal.ZonedDateTime,
    requested: string,
    resolution: Occurrence["resolution"],
  ) => {
    const epoch = value.epochMilliseconds;
    if (!inRange(epoch)) return;
    const previous = found.get(epoch);
    if (previous) {
      if (!previous.requestedSlots.includes(requested))
        previous.requestedSlots.push(requested);
      return;
    }
    const at = value.toInstant().toString({ smallestUnit: "second" });
    found.set(epoch, {
      id: digest(
        canonical({ definitionDigest, timeZoneData: clock.timeZoneData, at }),
      ),
      at,
      localTime: value.toPlainDateTime().toString({ smallestUnit: "second" }),
      offset: value.offset,
      requestedSlots: [requested],
      resolution,
    });
  };
  const recurrence = schedule.recurrence;
  if (lower < upper && recurrence.kind === "interval") {
    const anchor = Date.parse(schedule.start),
      interval = recurrence.minutes * 60000;
    const first = anchor + Math.ceil((lower - anchor) / interval) * interval;
    // One extra proves truncation without iterating an unbounded minute history.
    for (
      let epoch = first;
      epoch < upper && found.size <= args.limit;
      epoch += interval
    ) {
      const zoned =
        Temporal.Instant.fromEpochMilliseconds(epoch).toZonedDateTimeISO("UTC");
      add(
        zoned,
        zoned.toPlainDateTime().toString({ smallestUnit: "second" }),
        "exact",
      );
    }
  } else if (lower < upper && recurrence.kind !== "interval") {
    // Include adjacent calendar dates for offset jumps and a shifted skipped date.
    let date = Temporal.Instant.fromEpochMilliseconds(lower)
      .toZonedDateTimeISO(schedule.timeZone)
      .toPlainDate()
      .subtract({ days: 2 });
    const last = Temporal.Instant.fromEpochMilliseconds(upper - 1)
      .toZonedDateTimeISO(schedule.timeZone)
      .toPlainDate()
      .add({ days: 2 });
    for (
      ;
      Temporal.PlainDate.compare(date, last) <= 0;
      date = date.add({ days: 1 })
    ) {
      if (
        recurrence.kind === "weekly" &&
        !recurrence.weekDays.includes(weekdays[date.dayOfWeek - 1]!)
      )
        continue;
      if (
        recurrence.kind === "monthly" &&
        !recurrence.monthDays.includes(date.day)
      )
        continue;
      for (const slot of recurrence.times) {
        const requested = date.toPlainDateTime(Temporal.PlainTime.from(slot));
        const fields = {
          timeZone: schedule.timeZone,
          year: date.year,
          month: date.month,
          day: date.day,
          hour: requested.hour,
          minute: requested.minute,
        };
        const earlier = Temporal.ZonedDateTime.from(fields, {
          disambiguation: "earlier",
        });
        const later = Temporal.ZonedDateTime.from(fields, {
          disambiguation: "later",
        });
        if (
          !inRange(earlier.epochMilliseconds) &&
          !inRange(later.epochMilliseconds)
        )
          continue;
        const label = requested.toString({ smallestUnit: "second" });
        if (earlier.epochMilliseconds === later.epochMilliseconds) {
          add(earlier, label, "exact");
          continue;
        }
        check(
          schedule.daylightSaving,
          "SCHEDULE_DST_REVIEW",
          `Review daylight-saving choices for ${label} in ${schedule.timeZone}`,
        );
        const policy = schedule.daylightSaving!;
        if (!earlier.toPlainDateTime().equals(requested)) {
          if (policy.gap === "shift-forward")
            add(later, label, "shift-forward");
          else {
            skippedCount++;
            if (skipped.length < 100)
              skipped.push({
                requestedLocalTime: label,
                reason: "nonexistent-local-time",
              });
          }
        } else {
          if (policy.fold !== "later") add(earlier, label, "fold-earlier");
          if (policy.fold !== "earlier") add(later, label, "fold-later");
        }
      }
    }
  }
  const ordered = [...found]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);
  return {
    apiVersion: "ingestron.schedule-occurrences/v1",
    definitionDigest,
    timeZone: schedule.timeZone,
    enabled: schedule.enabled,
    scope: "portable-clock-preview",
    executionEnabled: false,
    bounds: {
      from: args.from,
      to: args.to,
      startInclusive: true,
      endExclusive: true,
    },
    clock,
    occurrences: ordered.slice(0, args.limit),
    truncated: ordered.length > args.limit,
    skipped,
    skippedTruncated: skippedCount > skipped.length,
  };
}
