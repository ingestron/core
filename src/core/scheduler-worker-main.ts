/** Built-in installed entry, never selected from project input. Bootstrap is bounded stdin only. */
import { runSchedulerWorker, workerConfigSchema } from "./scheduler-worker.js";
let input = "";
try {
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 10000) throw new Error("Bootstrap exceeds bound");
  }
  await runSchedulerWorker(workerConfigSchema.parse(JSON.parse(input)));
} catch {
  process.exitCode = 2;
}
