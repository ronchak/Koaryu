export class CommandOutcomeUnknown extends Error {
  readonly outcome = "unknown";
  readonly requestId?: string;
  constructor(requestId?: string, message?: string) {
    super(
      message ??
        "The request may have been saved, but confirmation was lost. Check the record before submitting again.",
    );
    this.name = "CommandOutcomeUnknown";
    this.requestId = requestId;
  }
}
