import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_LINE_LENGTH,
  analyzeFile,
  analyzeLines,
  parseRecord,
  readBoundedLines,
} from "./analyze-transport-latency.mjs";

const script = fileURLToPath(new URL("./analyze-transport-latency.mjs", import.meta.url));

function line({
  seq = 1,
  status = 202,
  open = 0,
  headers = 4400,
  total = 4402,
  reuse = 1,
  attempts = 1,
  connect = 4200,
  legacy = false,
} = {}) {
  const base = `[Transport] seq=${seq} status=${status} socket_open_before=${open} headers_ms=${headers} total_ms=${total} reusable=${reuse}`;
  return legacy ? base : `${base} connect_attempts=${attempts} connect_ms=${connect}`;
}

async function collect(lines) {
  const result = [];
  for await (const value of lines) result.push(value);
  return result;
}

async function temporaryFiles(t) {
  const directory = await mkdtemp(join(tmpdir(), "eki-transport-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function cli(args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test("ignores unrelated lines and discards serial prefixes", () => {
  assert.equal(parseRecord("[GNSS] connected"), null);
  assert.deepEqual(parseRecord(`12:34:56 > ${line()}\r`), {
    seq: 1,
    status: 202,
    socketOpenBefore: 0,
    headersMs: 4400,
    totalMs: 4402,
    reusable: 1,
    connectAttempts: 1,
    connectMs: 4200,
    accepted: true,
  });
});

test("accepts legacy records without inventing connection observations", () => {
  assert.deepEqual(parseRecord(line({ legacy: true })), {
    seq: 1,
    status: 202,
    socketOpenBefore: 0,
    headersMs: 4400,
    totalMs: 4402,
    reusable: 1,
    connectAttempts: null,
    connectMs: null,
    accepted: true,
  });
});

test("rejects malformed and incomplete records without leaking their contents", async () => {
  const secret = "private-placeholder-do-not-copy";
  for (const value of [
    "[Transport]",
    `${line()} extra=1`,
    `${line()} ${secret}`,
    `${line({ legacy: true })} connect_attempts=1`,
    `${line({ legacy: true })} connect_ms=40`,
  ]) {
    await assert.rejects(analyzeLines([value]), (error) => {
      assert.equal(error.message, "invalid record at line 1");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test("rejects invalid numeric ranges and inconsistent response state", () => {
  for (const value of [
    line({ seq: 4294967296 }),
    line({ headers: -1 }),
    line({ total: 4294967296 }),
    line({ headers: 9, total: 8, connect: 8 }),
    line({ status: 0, reuse: 0 }),
    line({ status: 600, reuse: 0 }),
    line({ status: -32769, reuse: 0 }),
    line({ status: 429, reuse: 1 }),
    line({ open: 2 }),
    line({ reuse: 2 }),
    line({ attempts: 4294967296 }),
    line({ connect: 4294967296 }),
    line({ attempts: 0, connect: 1 }),
    line({ headers: 10, total: 10, attempts: 1, connect: 11 }),
  ]) assert.throws(() => parseRecord(value));
});

test("accepts unsigned boundaries, zero durations and negative transport errors", () => {
  assert.equal(
    parseRecord(line({
      seq: 4294967295,
      headers: 0,
      total: 0,
      attempts: 0,
      connect: 0,
    })).seq,
    4294967295,
  );
  assert.equal(
    parseRecord(line({
      headers: 4294967295,
      total: 4294967295,
      connect: 4294967295,
    })).totalMs,
    4294967295,
  );
  assert.equal(
    parseRecord(line({ status: -11, reuse: 0, attempts: 1 })).accepted,
    false,
  );
});

test("separates accepted requests, failures and socket candidates", async () => {
  const result = await analyzeLines([
    "[GNSS] connected",
    line(),
    line({ seq: 2, open: 1, headers: 20, total: 23, attempts: 0, connect: 0 }),
    line({ seq: 3, status: -1, reuse: 0 }),
    line({ seq: 4, status: 503, open: 1, reuse: 0 }),
  ]);
  assert.equal(result.samples, 4);
  assert.equal(result.ignoredLines, 1);
  assert.deepEqual(result.statusCounts, { "202": 2, "-1": 1, "503": 1 });
  for (const group of Object.values(result.groups)) assert.equal(group.count, 1);
  assert.equal(result.groups.accepted_socket_open_candidate.cleanupMs.p99, 3);
  assert.equal(result.groups.nonaccepted_socket_closed.retainedAfterResponse, 0);
});

test("reports exact observed connection attempts separately from socket guesses", async () => {
  const result = await analyzeLines([
    line({ seq: 1, open: 0, attempts: 1, connect: 4200 }),
    line({ seq: 2, open: 1, headers: 25, total: 27, attempts: 0, connect: 0 }),
    line({ seq: 3, status: -1, reuse: 0, attempts: 1, connect: 4000 }),
    line({ seq: 4, status: 503, open: 1, reuse: 0, attempts: 0, connect: 0 }),
    line({ seq: 5, legacy: true }),
  ]);
  assert.deepEqual(result.connectionObservations, {
    observedRecords: 4,
    unknownRecords: 1,
    requestsWithAttempt: 2,
    totalAttempts: 2,
    connectMs: { min: 4000, p50: 4000, p95: 4200, p99: 4200, max: 4200 },
  });
  assert.equal(result.connectionGroups.accepted_connect_attempted.count, 1);
  assert.equal(result.connectionGroups.accepted_no_connect_attempt.count, 1);
  assert.equal(result.connectionGroups.nonaccepted_connect_attempted.count, 1);
  assert.equal(result.connectionGroups.nonaccepted_no_connect_attempt.count, 1);
  assert.equal(
    result.connectionGroups.accepted_no_connect_attempt.socketOpenBefore,
    1,
  );
  assert.equal(
    result.connectionGroups.accepted_connect_attempted.totalConnectAttempts,
    1,
  );
  assert.deepEqual(
    result.connectionGroups.accepted_no_connect_attempt.connectMs,
    null,
  );
});

test("does not convert legacy connection fields into zero-latency samples", async () => {
  const result = await analyzeLines([
    line({ legacy: true }),
    line({ seq: 2, attempts: 0, connect: 0, headers: 20, total: 22 }),
  ]);
  assert.equal(result.connectionObservations.observedRecords, 1);
  assert.equal(result.connectionObservations.unknownRecords, 1);
  assert.equal(result.connectionObservations.requestsWithAttempt, 0);
  assert.equal(result.connectionObservations.connectMs, null);
  assert.equal(result.connectionGroups.accepted_no_connect_attempt.count, 1);
});

test("uses exact nearest-rank percentiles without blending connection groups", async () => {
  const lines = Array.from({ length: 100 }, (_, index) => line({
    seq: index + 1,
    open: 1,
    headers: index + 1,
    total: index + 3,
    attempts: 0,
    connect: 0,
  })).reverse();
  lines.push(line({ seq: 101, headers: 4400, total: 4402, connect: 4200 }));
  const result = await analyzeLines(lines);
  assert.deepEqual(result.groups.accepted_socket_open_candidate.headersMs, {
    min: 1,
    p50: 50,
    p95: 95,
    p99: 99,
    max: 100,
  });
  assert.equal(result.connectionGroups.accepted_connect_attempted.headersMs.p50, 4400);
  assert.equal(result.connectionGroups.accepted_no_connect_attempt.headersMs.p99, 99);
});

test("empty groups are explicit and duplicate sequence attempts remain", async () => {
  const result = await analyzeLines([
    line(),
    line({ open: 1, attempts: 0, connect: 0, headers: 20, total: 22 }),
  ]);
  assert.equal(result.samples, 2);
  assert.deepEqual(result.groups.nonaccepted_socket_closed, {
    count: 0,
    retainedAfterResponse: 0,
    headersMs: null,
    cleanupMs: null,
    totalMs: null,
  });
  assert.deepEqual(result.connectionGroups.nonaccepted_connect_attempted, {
    count: 0,
    retainedAfterResponse: 0,
    headersMs: null,
    cleanupMs: null,
    totalMs: null,
    socketOpenBefore: 0,
    totalConnectAttempts: 0,
    connectMs: null,
  });
});

test("accepted status remains accepted when cleanup cannot retain the socket", async () => {
  const result = await analyzeLines([line({ reuse: 0, total: 5400 })]);
  assert.equal(result.groups.accepted_socket_closed.count, 1);
  assert.equal(result.groups.accepted_socket_closed.retainedAfterResponse, 0);
});

test("fails on absent data instead of emitting an empty benchmark", async () => {
  await assert.rejects(analyzeLines([]), /no transport records/);
  await assert.rejects(analyzeLines(["ordinary log"]), /no transport records/);
});

test("caps samples without silently truncating the capture", async () => {
  assert.equal((await analyzeLines([line()], 1)).samples, 1);
  await assert.rejects(analyzeLines([line(), line()], 1), /sample limit exceeded/);
  for (const limit of [0, -1, 0.5, 100001, Number.NaN]) {
    await assert.rejects(analyzeLines([line()], limit), /invalid sample limit/);
  }
});

test("assembles fragmented CRLF input and an unterminated final record", async () => {
  const text = `${line()}\r\n${line({ seq: 2, legacy: true })}`;
  const chunks = [text.slice(0, 7), text.slice(7, 23), text.slice(23)];
  const result = await analyzeLines(readBoundedLines(chunks));
  assert.equal(result.samples, 2);
  assert.equal(result.connectionObservations.unknownRecords, 1);
});

test("limits both completed and partial long lines", async () => {
  const value = "x".repeat(MAX_LINE_LENGTH);
  assert.deepEqual(await collect(readBoundedLines([value])), [value]);
  await assert.rejects(
    collect(readBoundedLines([`${value}x\n`])),
    /line length limit/,
  );
  await assert.rejects(
    collect(readBoundedLines([value, "x"])),
    /line length limit/,
  );
});

test("enforces a byte budget rather than a character count", async () => {
  assert.deepEqual(await collect(readBoundedLines(["é"], 2)), ["é"]);
  await assert.rejects(collect(readBoundedLines(["é"], 1)), /byte limit/);
  for (const limit of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      collect(readBoundedLines(["x"], limit)),
      /invalid byte limit/,
    );
  }
});

test("propagates stream failures and closes streams on parser failure", async () => {
  async function* failing() {
    yield line();
    throw new Error("read failure");
  }
  await assert.rejects(analyzeLines(readBoundedLines(failing())), /read failure/);
  const stream = Readable.from(["[Transport] invalid\n", "more\n"], {
    encoding: "utf8",
  });
  await assert.rejects(analyzeLines(readBoundedLines(stream)), /invalid record/);
  assert.equal(stream.destroyed, true);
});

test("reads UTF-8 files without retaining unrelated sensitive lines", async (t) => {
  const directory = await temporaryFiles(t);
  const path = join(directory, "capture.log");
  const privateLine = "private-placeholder-not-a-transport-record";
  await writeFile(path, `${privateLine}\néquipement ${line()}\r\n`);
  const report = await analyzeFile(path);
  assert.equal(report.samples, 1);
  assert.equal(JSON.stringify(report).includes(privateLine), false);
});

test("CLI emits ordered independent captures and schema version two", async (t) => {
  const directory = await temporaryFiles(t);
  const before = join(directory, "before.log");
  const after = join(directory, "after.log");
  await writeFile(before, line({ legacy: true }));
  await writeFile(after, line({ open: 1, headers: 20, total: 21, attempts: 0, connect: 0 }));
  const result = cli([before, after]);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.percentileMethod, "nearest_rank");
  assert.deepEqual(report.captures.map((capture) => capture.input), [1, 2]);
  assert.match(report.note, /not TLS-only/);
  assert.equal(report.captures[0].connectionObservations.unknownRecords, 1);
  assert.equal(result.stdout.includes(directory), false);
});

test("CLI errors publish no partial report or filesystem paths", async (t) => {
  const directory = await temporaryFiles(t);
  const valid = join(directory, "valid.log");
  await writeFile(valid, line());
  const result = cli([valid, join(directory, "missing.log")]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(directory), false);
  assert.match(result.stderr, /unable to read input file/);
});

test("CLI validates usage and provides help without reading files", () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["--unknown"]).status, 2);
  const result = cli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage:/);
});
