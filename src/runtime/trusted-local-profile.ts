/**
 * Bounded execution profiles understood by the SQLite candidate. These map
 * stable Owner policy IDs to the actual app-server session mode parameter.
 * This does not claim that ZCode enforces a particular OS permission boundary.
 */
export interface TrustedLocalExecutionProfile {
  readonly id: string;
  readonly sessionMode: "build";
  readonly unrestricted: false;
}

const PROFILES: Readonly<Record<string, TrustedLocalExecutionProfile>> = Object.freeze({
  "local-build-v1": Object.freeze({
    id: "local-build-v1",
    sessionMode: "build",
    unrestricted: false,
  }),
});

export function resolveTrustedLocalExecutionProfile(id: string): TrustedLocalExecutionProfile | null {
  return PROFILES[id] ?? null;
}
