/** One job's valid log records, aggregated in chronological timestamp order. */
export type DigestRow = {
  job: string;
  /** Owner on the latest record, including an explicit null. */
  owner: string | null;
  /** Total valid records for this job, including retries and failures. */
  runs: number;
  /** Number of this job's records whose status is retry. */
  retries: number;
  /** Status on the latest record, not the most severe status seen. */
  lastStatus: 'ok' | 'retry' | 'fail';
  /** Most recent available error; later records without an error do not clear it. */
  lastError: string | null;
  /** Earliest timestamp, retained verbatim with its original offset. */
  firstAt: string;
  /** Latest timestamp, retained verbatim with its original offset. */
  lastAt: string;
};

export type NightDigest = {
  /** Valid calendar date in YYYY-MM-DD form identifying the log file. */
  night: string;
  /** One row per job, sorted lexically by job (not by time or status). */
  rows: DigestRow[];
  /** Malformed JSON or schema-invalid nonblank lines, excluded from aggregation. */
  badLines: number;
  /** Counts of valid log records by status, not counts of job final states. */
  counts: {
    ok: number;
    retry: number;
    fail: number;
  };
};

/**
 * Synchronously read runsDir/<night>.jsonl. Implemented in src/digest/reader.ts
 * as `export const readNight: ReadNight = ...`.
 *
 * Validate night as a real YYYY-MM-DD calendar date before accessing the file;
 * invalid names (including paths) and missing files return null. An existing
 * empty file returns a digest with rows [], badLines 0 and all counts 0.
 *
 * Each nonblank line must contain a JSON object with a valid offset-bearing
 * timestamp `at`, string `job`, status ok | retry | fail, string-or-null `owner`,
 * and optional string `error`. Malformed or invalid records increment badLines
 * and are skipped, never aborting the night. Blank lines are ignored.
 *
 * Compare timestamps chronologically, not lexically, retaining their original
 * strings and offsets for display. For equal instants, later lines are later
 * records. Owner and lastStatus come from the latest record; lastError comes
 * from the latest record with an error, or is null when none has an error.
 * Rows are sorted lexically by job. Counts include every valid record, including
 * retries and failures for jobs whose lastStatus is ok.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
