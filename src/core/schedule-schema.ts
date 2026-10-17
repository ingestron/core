/** Editor-safe schedule definitions. No clocks, filesystem, source or execution access. */
import { z } from "zod";
export const scheduleKinds = [
  "interval",
  "daily",
  "weekly",
  "monthly",
] as const;
export const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
export const scheduleInstantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    "Use an exact UTC timestamp ending in Z",
  )
  .refine((value) => {
    const date = new Date(value);
    return (
      Number.isFinite(date.valueOf()) &&
      date.toISOString() === value.replace("Z", ".000Z")
    );
  }, "Use a valid UTC calendar date and time");
const times = z
  .array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"))
  .min(1)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Choose each time once",
  );
const recurrence = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("interval"),
      minutes: z.number().int().min(1).max(5270400),
    })
    .strict(),
  z.object({ kind: z.literal("daily"), times }).strict(),
  z
    .object({
      kind: z.literal("weekly"),
      weekDays: z
        .array(z.enum(weekdays))
        .min(1)
        .max(7)
        .refine(
          (values) => new Set(values).size === values.length,
          "Choose each weekday once",
        ),
      times,
    })
    .strict(),
  z
    .object({
      kind: z.literal("monthly"),
      monthDays: z
        .array(z.number().int().min(1).max(31))
        .min(1)
        .max(31)
        .refine(
          (values) => new Set(values).size === values.length,
          "Choose each month day once",
        ),
      times,
    })
    .strict(),
]);
export const scheduleSchema = z
  .object({
    apiVersion: z.literal("ingestron.schedule/v1"),
    enabled: z.boolean(),
    timeZone: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Use a supported IANA time zone, such as UTC or Pacific/Auckland"),
    start: scheduleInstantSchema,
    end: scheduleInstantSchema.optional(),
    recurrence,
    daylightSaving: z
      .object({
        gap: z.enum(["skip", "shift-forward"]),
        fold: z.enum(["earlier", "later", "both"]),
      })
      .strict()
      .optional()
      .describe(
        "Reviewed handling of nonexistent and repeated local calendar times",
      ),
    overlap: z
      .enum(["skip", "queue", "native"])
      .default("skip")
      .describe(
        "Choose native only when the target platform owns overlapping-run behaviour",
      ),
    missed: z
      .enum(["skip", "latest", "native"])
      .default("skip")
      .describe(
        "Choose native only when the target platform owns missed-run and daylight-saving behaviour",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.daylightSaving && value.recurrence.kind === "interval")
      ctx.addIssue({
        code: "custom",
        path: ["daylightSaving"],
        message: "Elapsed intervals have no local daylight-saving ambiguity",
      });
    if (value.daylightSaving && value.missed === "native")
      ctx.addIssue({
        code: "custom",
        path: ["daylightSaving"],
        message:
          "Native clock behaviour cannot also promise portable daylight-saving policies",
      });
    if (value.end && value.end <= value.start)
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "End must be later than start",
      });
    if (value.recurrence.kind === "interval" && value.timeZone !== "UTC")
      ctx.addIssue({
        code: "custom",
        path: ["timeZone"],
        message:
          "Elapsed intervals use UTC; choose a calendar schedule for local wall-clock times",
      });
  });
export type Schedule = z.infer<typeof scheduleSchema>;
