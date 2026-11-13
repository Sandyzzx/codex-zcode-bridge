import { createHash } from 'node:crypto';

const CHANNELS = new WeakSet();
const MAX_FRAME_BYTES = 24_576;
const PROTOCOL = 'bridge-sqlite-runtime-event-v1';
const EVENT_TYPES = new Set([
  'session_ready', 'model_selected', 'turn_started', 'model_tool_call',
  'tool_status', 'model_output', 'turn_completed', 'turn_failed', 'report_ready',
]);
const DETAIL_KEYS = new Map([
  ['session_ready', new Set([
    'session_id', 'project_path', 'execution_path', 'worktree_path',
    'execution_mode', 'model_source', 'selected_model', 'reasoning_level',
    'reasoning_level_source',
  ])],
  ['model_selected', new Set([
    'selected_model', 'model_source', 'provider_id', 'model_id',
    'reasoning_level', 'reasoning_level_source',
  ])],
  ['turn_started', new Set(['rpc_accepted', 'turn_id', 'event_seq'])],
  ['model_tool_call', new Set(['tool_name', 'tool_call_id'])],
  ['tool_status', new Set(['tool_name', 'state', 'tool_call_id'])],
  ['model_output', new Set()],
  ['turn_completed', new Set([
    'token_count', 'tool_call_count', 'event_seq', 'turn_id', 'usage',
  ])],
  ['turn_failed', new Set(['error_code'])],
  ['report_ready', new Set(['needs_master_decision'])],
]);

class JsonLineReader {
  #iterator;
  #buffer = Buffer.alloc(0);
  constructor(stream) { this.#iterator = stream[Symbol.asyncIterator](); }
  async read() {
    for (;;) {
      const end = this.#buffer.indexOf(0x0a);
      if (end >= 0) {
        const frame = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(end + 1);
        if (!frame.length || frame.length > MAX_FRAME_BYTES) throw coded('runtime_event_frame_invalid');
        let value;
        try { value = JSON.parse(frame.toString('utf8')); }
        catch { throw coded('runtime_event_frame_invalid'); }
        if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
          throw coded('runtime_event_frame_invalid');
        }
        return value;
      }
      if (this.#buffer.length > MAX_FRAME_BYTES) throw coded('runtime_event_frame_too_large');
      const next = await this.#iterator.next();
      if (next.done) throw coded(this.#buffer.length ? 'runtime_event_frame_truncated' : 'runtime_event_channel_closed');
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }
  }
}

/** Manager side of the one-way Worker event channel. Task, Attempt, Generation
 * and Claim fields come only from the persisted Operation, never the Worker. */
export async function createCandidateRuntimeEventChannel(child, operation, verifyProcessIdentity) {
  if (!child || !Number.isSafeInteger(child.pid) || !Array.isArray(child.stdio) || child.stdio.length < 15
    || !operation || operation.operation_kind !== 'attempt_lifecycle' || operation.phase !== 'running'
    || !Number.isSafeInteger(operation.generation) || operation.generation < 1
    || !operation.claim_id || operation.claim_generation !== operation.generation
    || !operation.claim_worker_identity_json || !operation.launch_identity_json
    || !operation.claim_worker_identity_digest || typeof verifyProcessIdentity !== 'function') {
    throw coded('runtime_event_channel_unavailable');
  }
  let worker;
  let launch;
  try {
    worker = JSON.parse(operation.claim_worker_identity_json);
    launch = JSON.parse(operation.launch_identity_json);
  } catch {
    throw coded('runtime_event_channel_identity_invalid');
  }
  if (worker.process_id !== child.pid || worker.process_id !== launch.process_id
    || worker.start_fingerprint !== launch.start_fingerprint
    || sha256(stableJson(worker)) !== operation.claim_worker_identity_digest) {
    throw coded('runtime_event_channel_identity_mismatch');
  }
  const stream = child.stdio[14];
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw coded('runtime_event_channel_unavailable');
  }
  const binding = Object.freeze({
    operation_id: operation.operation_id,
    task_id: operation.task_id,
    attempt: operation.attempt,
    generation: operation.generation,
    claim_id: operation.claim_id,
    worker_identity_digest: operation.claim_worker_identity_digest,
    process_id: worker.process_id,
    start_fingerprint: worker.start_fingerprint,
  });
  const reader = new JsonLineReader(stream);
  const channel = {
    binding,
    async receiveEvent() {
      const frame = await reader.read();
      const keys = ['at', 'details', 'event_type', 'protocol', 'summary', 'worker_sequence'];
      const actualKeys = Object.keys(frame).sort();
      const expectedKeys = Object.hasOwn(frame, 'details')
        ? keys
        : keys.filter((key) => key !== 'details');
      if (!validFrame(frame) || actualKeys.join('|') !== expectedKeys.join('|')) {
        throw coded('runtime_event_frame_identity_mismatch');
      }
      return Object.freeze({ binding, event: Object.freeze({
        worker_sequence: frame.worker_sequence,
        event_type: frame.event_type,
        at: frame.at,
        summary: frame.summary,
        ...(frame.details === undefined ? {} : { details: frame.details }),
      }) });
    },
  };
  if (child.exitCode !== null || child.signalCode !== null) throw coded('runtime_event_worker_not_live');
  let observed;
  try { observed = await verifyProcessIdentity({ child, expected: binding }); }
  catch { throw coded('runtime_event_channel_identity_unknown'); }
  if (!observed || observed.state !== 'verified' || observed.process_id !== binding.process_id
    || observed.start_fingerprint !== binding.start_fingerprint) {
    throw coded('runtime_event_channel_identity_mismatch');
  }
  CHANNELS.add(channel);
  return Object.freeze(channel);
}

export function isCandidateRuntimeEventChannel(value) { return !!value && CHANNELS.has(value); }

/** Worker side of the same one-way channel. send() is non-blocking and never
 * changes Adapter execution; close() is awaited before the Result frame so the
 * Manager can drain every event first. */
export async function createCandidateWorkerRuntimeEventChannel({
  writeStream,
  now = () => new Date().toISOString(),
} = {}) {
  if (!writeStream || typeof writeStream.write !== 'function' || typeof writeStream.end !== 'function'
    || typeof now !== 'function') throw new TypeError('runtime event write stream required');
  let sequence = 0;
  let queue = Promise.resolve();
  let firstError;
  let closed = false;
  const send = (event) => {
    if (closed) throw coded('runtime_event_channel_closed');
    if (!event || Object.getPrototypeOf(event) !== Object.prototype || !EVENT_TYPES.has(event.type)) {
      throw coded('runtime_event_type_invalid');
    }
    const summary = boundedText(event.summary, 8_192, { allowNewlines: true });
    if (!summary) throw coded('runtime_event_summary_invalid');
    const details = sanitizeDetails(event.type, event.details);
    const frame = {
      protocol: PROTOCOL,
      worker_sequence: ++sequence,
      event_type: event.type,
      at: now(),
      summary,
      ...(details === undefined ? {} : { details }),
    };
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) throw coded('runtime_event_frame_too_large');
    queue = queue.then(() => writeFrame(writeStream, encoded)).catch((error) => {
      firstError ??= error;
    });
    return frame.worker_sequence;
  };
  const close = async () => {
    if (closed) {
      await queue;
      if (firstError) throw coded('runtime_event_write_failed');
      return;
    }
    closed = true;
    await queue;
    await endStream(writeStream);
    if (firstError) throw coded('runtime_event_write_failed');
  };
  return Object.freeze({ send, close });
}

function validFrame(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.protocol !== PROTOCOL
    || !Number.isSafeInteger(value.worker_sequence) || value.worker_sequence < 1
    || !EVENT_TYPES.has(value.event_type) || typeof value.at !== 'string' || value.at.length > 64
    || Number.isNaN(Date.parse(value.at)) || typeof value.summary !== 'string'
    || Buffer.byteLength(value.summary, 'utf8') < 1 || Buffer.byteLength(value.summary, 'utf8') > 8192
    || value.summary.includes('\0')) return false;
  if (value.details !== undefined) {
    if (!value.details || Object.getPrototypeOf(value.details) !== Object.prototype) return false;
    try {
      if (Buffer.byteLength(stableJson(value.details), 'utf8') > 8192) return false;
    } catch { return false; }
    if (!validDetails(value.event_type, value.details)) return false;
  }
  return true;
}

function validDetails(type, value) {
  const allowed = DETAIL_KEYS.get(type);
  const entries = Object.entries(value);
  if (!allowed || !entries.length) return false;
  for (const [key, item] of entries) {
    if (!allowed.has(key)) return false;
    if (key === 'usage') {
      if (!validUsage(item)) return false;
    } else if (!(item === null || typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item) && Number.isSafeInteger(item))) {
      return false;
    }
  }
  return true;
}

function validUsage(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  for (const key of keys) {
    if (!['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
      'reasoningTokens', 'input_tokens', 'output_tokens', 'total_tokens',
      'cached_input_tokens', 'reasoning_tokens'].includes(key)) return false;
    const item = value[key];
    if (typeof item !== 'number' || !Number.isFinite(item)
      || !Number.isSafeInteger(item) || item < 0) return false;
  }
  return true;
}

function sanitizeDetails(type, value) {
  if (value === undefined) return undefined;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw coded('runtime_event_details_invalid');
  const allowed = DETAIL_KEYS.get(type);
  const details = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (key === 'usage') {
      const usage = sanitizeUsage(item);
      if (usage !== undefined) details[key] = usage;
    } else if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item) && Number.isSafeInteger(item)) {
      details[key] = item;
    }
  }
  if (!Object.keys(details).length) return undefined;
  if (Buffer.byteLength(stableJson(details), 'utf8') > 8_192) throw coded('runtime_event_details_too_large');
  return details;
}

function sanitizeUsage(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
    'reasoningTokens', 'input_tokens', 'output_tokens', 'total_tokens',
    'cached_input_tokens', 'reasoning_tokens']) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== 'number' || !Number.isFinite(item) || !Number.isSafeInteger(item) || item < 0) continue;
    usage[key] = item;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function boundedText(value, maximumBytes, { allowNewlines = false } = {}) {
  if (typeof value !== 'string') return null;
  const normalized = allowNewlines
    ? value.replace(/[\u0000\u0001-\u0009\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    : value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  if (!normalized) return null;
  if (Buffer.byteLength(normalized, 'utf8') <= maximumBytes) return normalized;
  const bytes = Buffer.from(normalized, 'utf8').subarray(0, maximumBytes);
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (bytes[end - 1] & 0xc0) === 0xc0) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function writeFrame(stream, frame) {
  return new Promise((resolve, reject) => {
    stream.write(frame, 'utf8', (error) => error ? reject(error) : resolve());
  });
}

function endStream(stream) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once('finish', finish);
    stream.once('close', finish);
    stream.once('error', finish);
    try { stream.end(); } catch { finish(); }
  });
}

function stableJson(value, depth = 0) {
  if (depth > 24) throw coded('runtime_event_json_too_deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 256) throw coded('runtime_event_json_too_large');
    return `[${value.map((item) => stableJson(item, depth + 1)).join(',')}]`;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > 128 || keys.some((key) => key !== key.normalize('NFC'))) {
      throw coded('runtime_event_json_too_large');
    }
    return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(',')}}`;
  }
  throw coded('runtime_event_json_invalid');
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function coded(code) { return Object.assign(new Error(code), { code }); }
