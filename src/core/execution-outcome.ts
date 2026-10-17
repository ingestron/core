import { Problem } from "./errors.js";

/** The adapter did not acknowledge whether the original source operation finished. */
export class ExecutionUncertainFailure extends Problem {
  constructor(code = "EXECUTION_UNCERTAIN") {
    super(
      code,
      "The provider did not acknowledge the original execution outcome; inspect and recover the same run before rebuilding",
    );
    this.name = "ExecutionUncertainFailure";
  }
}
