// Envelope shape extracted from the ZCode CLI JSON result. Kept separate so
// tests and callers can import the type without pulling in parsing code.
export interface ZcodeEnvelope {
  readonly sessionId: string;
  readonly response: string;
  readonly usage: Record<string, unknown> | null;
}
