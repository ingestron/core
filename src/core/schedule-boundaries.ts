import { Temporal } from "@js-temporal/polyfill";
import type { z } from "zod";
import { canonical, digest } from "./errors.js";
import { scheduleSchema } from "./schedule-schema.js";
import { scheduleClockMetadata } from "./schedule-clock-metadata.js";
import type { ScheduleBoundary, ScheduleBoundaryMetadata } from "./schema.js";

/** Resolve exact instants before metadata-only provider execution. This does not
 * interpret native recurrence, choose a fold policy or read the current clock. */
export function resolveScheduleBoundaries(
  input: z.input<typeof scheduleSchema>,
): ScheduleBoundaryMetadata {
  const schedule = scheduleSchema.parse(input);
  const resolve = (instant: string): ScheduleBoundary => {
    const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(
      schedule.timeZone,
    );
    const local = zoned.toPlainDateTime();
    const candidates = ["earlier", "later"].map((disambiguation) =>
      local.toZonedDateTime(schedule.timeZone, {
        disambiguation: disambiguation as "earlier" | "later",
      }),
    );
    const unique = [
      ...new Map(
        candidates.map((value) => [value.epochNanoseconds, value]),
      ).values(),
    ];
    return {
      instant,
      localTime: local.toString({ smallestUnit: "second" }),
      offset: zoned.offset,
      ambiguous: unique.length > 1,
      possibleInstants: unique.map((value) => ({
        instant: value.toInstant().toString({ smallestUnit: "second" }),
        offset: value.offset,
      })),
    };
  };
  return {
    apiVersion: "ingestron.schedule-boundaries/v1",
    definitionDigest: digest(canonical(schedule)),
    timeZone: schedule.timeZone,
    clock: scheduleClockMetadata(),
    start: resolve(schedule.start),
    ...(schedule.end ? { end: resolve(schedule.end) } : {}),
  };
}
