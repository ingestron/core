/** Shared host protocol. Native adapters opt in separately from flow calendars. */
import { z } from "zod";
import { scheduleKinds } from "./schedule-schema.js";

export const connectorSchedulingSchema = z
  .object({
    apiVersion: z.literal("ingestron.connector-schedule/v1"),
    clock: z.enum(["portable", "platform-native"]),
    recurrences: z
      .array(z.enum(scheduleKinds))
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

export type ConnectorScheduling = z.infer<typeof connectorSchedulingSchema>;

export const connectorScheduleOwnerSchema = z
  .object({
    project: z.string().min(1).max(128),
    environment: z.string().min(1).max(128),
    flow: z.string().min(1).max(128),
    connection: z.string().min(1).max(128),
  })
  .strict();

export type ConnectorScheduleOwner = z.infer<
  typeof connectorScheduleOwnerSchema
>;
