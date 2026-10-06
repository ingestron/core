/** Host clock provenance participates in both preview and compiled-boundary identity. */
export function scheduleClockMetadata() {
  return {
    implementation: "temporal-polyfill@0.5.1",
    timeZoneData: process.versions.tz ?? "unknown",
    icu: process.versions.icu ?? "unknown",
  };
}
