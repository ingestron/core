/** Reviewed schedule handover; never reads a live clock or launches work. */
import { z } from "zod";
import { canonical, check, digest, isMap } from "./errors.js";
import { scheduleSchema } from "./schedule-schema.js";
import { resolveScheduleBoundaries } from "./schedule-boundaries.js";
import {
  connectorSchedulingSchema,
  connectorScheduleOwnerSchema,
  type ConnectorScheduleOwner,
} from "./connector-schedule-schema.js";

export function connectorScheduleHandover(
  input: z.input<typeof scheduleSchema>,
  capability: unknown,
  owner: ConnectorScheduleOwner,
) {
  // The envelope is a JSON protocol: optional undefined properties have no wire value.
  const definition: z.infer<typeof scheduleSchema> = JSON.parse(
    canonical(scheduleSchema.parse(input)),
  );
  const declared = connectorSchedulingSchema.safeParse(capability);
  check(
    declared.success,
    "SCHEDULE_UNSUPPORTED",
    `${owner.flow}: connector preparation has no bounded schedule handover; native asset schedule support does not schedule connector jobs`,
  );
  const scheduling = declared.data!;
  check(
    scheduling.recurrences.includes(definition.recurrence.kind),
    "SCHEDULE_UNSUPPORTED",
    `${owner.flow}: connector adapter does not support ${definition.recurrence.kind} schedules`,
  );
  check(
    scheduling.clock === "platform-native"
      ? definition.overlap === "native" && definition.missed === "native"
      : definition.overlap !== "native" && definition.missed !== "native",
    "SCHEDULE_POLICY",
    `${owner.flow}: schedule overlap and missed-run policies must match the connector adapter's ${scheduling.clock} clock`,
  );
  const body = {
    apiVersion: "ingestron.connector-schedule/v1" as const,
    owner: connectorScheduleOwnerSchema.parse(owner),
    clock: scheduling.clock,
    definition,
    boundaries: resolveScheduleBoundaries(definition),
  };
  return { ...body, digest: digest(canonical(body)) };
}

/** Node host/adapter validation against current host clock data and exact scope.
 * Self-consistent hashes alone cannot authorise moving intent to another flow. */
export function validateConnectorScheduleHandover(
  input: unknown,
  capability: unknown,
  owner: ConnectorScheduleOwner,
  reviewedDefinition: z.input<typeof scheduleSchema>,
) {
  check(
    isMap(input) &&
      Object.keys(input).length === 6 &&
      [
        "apiVersion",
        "owner",
        "clock",
        "definition",
        "boundaries",
        "digest",
      ].every((key) => Object.hasOwn(input, key)),
    "CONNECTOR_SCHEDULE",
    "Malformed connector schedule handover",
  );
  const expected = connectorScheduleHandover(
    reviewedDefinition,
    capability,
    owner,
  );
  check(
    canonical(input) === canonical(expected),
    "CONNECTOR_SCHEDULE",
    "Connector schedule handover differs from its scope, reviewed definition or current clock resolution",
  );
  return expected;
}
