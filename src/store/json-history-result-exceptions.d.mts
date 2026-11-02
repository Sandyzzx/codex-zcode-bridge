export interface HistoricalResultArchiveAnomaly {
  readonly code: string;
  readonly path: string;
  readonly record_type: string;
  readonly detail: string;
}

export interface HistoricalResultExceptionDescriptor {
  readonly exception_id: string;
  readonly task_id: string;
  readonly stored_attempt: number;
  readonly internal_attempt: number;
  readonly relative_path: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly archive_anomaly: HistoricalResultArchiveAnomaly;
}

export interface AnnotatedHistoricalResultException extends HistoricalResultExceptionDescriptor {
  readonly artifact_id: string;
}

export const HISTORICAL_RESULT_EXCEPTION_POLICY_VERSION: 1;
export const HISTORICAL_RESULT_EXCEPTIONS: readonly HistoricalResultExceptionDescriptor[];
export function historicalResultExceptionArtifactId(relativePath: string): string;
export function historicalResultExceptionFor(
  taskId: string,
  storedAttempt: number,
  relativePath: string,
  sha256: string,
  byteLength: number,
): HistoricalResultExceptionDescriptor | null;
export function annotateHistoricalResultException(
  entry: HistoricalResultExceptionDescriptor,
): AnnotatedHistoricalResultException;
export function historicalResultExceptionSetDigest(
  entries: readonly AnnotatedHistoricalResultException[],
): string;
export function isCanonicalHistoricalResultExceptionSet(
  entries: unknown,
): entries is readonly AnnotatedHistoricalResultException[];
export function historicalResultExceptionTaskIds(
  entries: readonly Pick<HistoricalResultExceptionDescriptor, "task_id">[],
): string[];
export function historicalResultExceptionArchiveMatches(manifest: unknown): boolean;
