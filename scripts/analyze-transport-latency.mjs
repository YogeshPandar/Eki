import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UINT32_MAX = 0xffff_ffff;
export const MAX_SAMPLES = 100_000;
export const MAX_LINE_LENGTH = 4096;
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MARKER = "[Transport]";
const RECORD = /^\[Transport\] seq=(\d{1,10}) status=(-?\d{1,5}) socket_open_before=([01]) headers_ms=(\d{1,10}) total_ms=(\d{1,10}) reusable=([01])$/;

/* parse only the bounded transport record; never retain the serial prefix. */
export function parseRecord(line) {
  if (typeof line !== "string") throw new TypeError("expected a text line");
  if (line.length > MAX_LINE_LENGTH) throw new Error("line length limit exceeded");
  const markerAt = line.indexOf(MARKER);
  if (markerAt === -1) return null;
  const match = RECORD.exec(line.slice(markerAt).trimEnd());
  if (!match) throw new Error("malformed transport record");
  const [seq, status, socketOpenBefore, headersMs, totalMs, reusable] =
    match.slice(1).map(Number);
  const accepted = status === 200 || status === 202;
  if (
    seq > UINT32_MAX || headersMs > UINT32_MAX || totalMs > UINT32_MAX ||
    totalMs < headersMs ||
    !((status >= 100 && status <= 599) || (status < 0 && status >= -32768)) ||
    (reusable === 1 && !accepted)
  ) {
    throw new Error("invalid transport record values");
  }
  return { seq, status, socketOpenBefore, headersMs, totalMs, reusable, accepted };
}

/* keep a bounded partial line even when a capture omits newlines. */
export async function* readBoundedLines(chunks, maxBytes = MAX_INPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INPUT_BYTES) {
    throw new RangeError("invalid byte limit");
  }
  let pending = "";
  let bytes = 0;
  for await (const chunk of chunks) {
    if (typeof chunk !== "string") throw new TypeError("expected decoded text chunks");
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maxBytes) throw new Error("input byte limit exceeded");
    const lines = (pending + chunk).split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (line.length > MAX_LINE_LENGTH) throw new Error("line length limit exceeded");
      yield line;
    }
    if (pending.length > MAX_LINE_LENGTH) throw new Error("line length limit exceeded");
  }
  if (pending.length > 0) yield pending;
}

function distribution(values) {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  /* nearest-rank percentiles never interpolate an unobserved latency. */
  const percentile = (p) => values[Math.ceil((p * values.length) / 100) - 1];
  return {
    min: values[0],
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    max: values[values.length - 1],
  };
}

function summarizeGroup(records) {
  return {
    count: records.length,
    retainedAfterResponse: records.filter((record) => record.reusable === 1).length,
    headersMs: distribution(records.map((record) => record.headersMs)),
    cleanupMs: distribution(records.map((record) => record.totalMs - record.headersMs)),
    totalMs: distribution(records.map((record) => record.totalMs)),
  };
}

export async function analyzeLines(lines, maxSamples = MAX_SAMPLES) {
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > MAX_SAMPLES) {
    throw new RangeError("invalid sample limit");
  }
  const groups = {
    accepted_socket_closed: [],
    accepted_socket_open_candidate: [],
    nonaccepted_socket_closed: [],
    nonaccepted_socket_open_candidate: [],
  };
  const statusCounts = new Map();
  let samples = 0;
  let ignoredLines = 0;
  let lineNumber = 0;
  for await (const line of lines) {
    ++lineNumber;
    let record;
    try {
      record = parseRecord(line);
    } catch {
      throw new Error(`invalid record at line ${lineNumber}`);
    }
    if (record === null) {
      ++ignoredLines;
      continue;
    }
    if (++samples > maxSamples) throw new Error("sample limit exceeded");
    const outcome = record.accepted ? "accepted" : "nonaccepted";
    const socket = record.socketOpenBefore ? "socket_open_candidate" : "socket_closed";
    groups[`${outcome}_${socket}`].push(record);
    statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
  }
  if (samples === 0) throw new Error("no transport records found");
  return {
    samples,
    ignoredLines,
    statusCounts: Object.fromEntries([...statusCounts].sort(([a], [b]) => a - b)),
    groups: Object.fromEntries(
      Object.entries(groups).map(([name, records]) => [name, summarizeGroup(records)]),
    ),
  };
}

export async function analyzeFile(path) {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  try {
    return await analyzeLines(readBoundedLines(stream));
  } catch (error) {
    /* never include private paths in filesystem errors. */
    if (error && typeof error.code === "string") {
      throw new Error("unable to read input file");
    }
    throw error;
  } finally {
    stream.destroy();
  }
}

const usage = "usage: node scripts/analyze-transport-latency.mjs <capture.log> [capture.log ...]";

async function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  if (args.length === 0 || args.some((arg) => arg.startsWith("-"))) {
    throw new Error(usage);
  }
  const captures = [];
  for (let index = 0; index < args.length; ++index) {
    try {
      captures.push({ input: index + 1, ...await analyzeFile(args[index]) });
    } catch (error) {
      throw new Error(`input ${index + 1}: ${error.message}`);
    }
  }
  /* publish no partial report when a later input is invalid. */
  console.log(JSON.stringify({
    schemaVersion: 1,
    percentileMethod: "nearest_rank",
    note: "socket state is a reuse candidate; durations are not TLS-only measurements",
    captures,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
