import { createHash } from 'node:crypto';

const CHANNELS = new WeakSet();
const ACKNOWLEDGEMENTS = new WeakSet();
const PREPARED_ACKNOWLEDGEMENTS = new WeakSet();
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_FRAME_BYTES = MAX_REQUEST_BYTES + 8_192;

class JsonLineReader {
  #iterator;
  #buffer = Buffer.alloc(0);
  constructor(stream) { this.#iterator = stream[Symbol.asyncIterator](); }
  async read(maximum = MAX_FRAME_BYTES) {
    for (;;) {
      const end = this.#buffer.indexOf(0x0a);
      if (end >= 0) {
        const frame = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(end + 1);
        if (!frame.length || frame.length > maximum) throw coded('interaction_frame_invalid');
        let value;
        try { value = JSON.parse(frame.toString('utf8')); } catch { throw coded('interaction_frame_invalid'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw coded('interaction_frame_invalid');
        return value;
      }
      if (this.#buffer.length > maximum) throw coded('interaction_frame_too_large');
      const next = await this.#iterator.next();
      if (next.done) throw coded(this.#buffer.length ? 'interaction_frame_truncated' : 'interaction_channel_closed');
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }
  }
}

/** Candidate-only manager side. The verifier must use the Manager's OS process
 * probe; a process id or Worker echo alone is never accepted as identity proof. */
export async function createCandidateInteractionChannel(child, operation, verifyProcessIdentity) {
  if (!child || !Number.isSafeInteger(child.pid) || !Array.isArray(child.stdio) || child.stdio.length < 10
    || !operation || operation.operation_kind !== 'attempt_lifecycle' || operation.phase !== 'running'
    || !Number.isSafeInteger(operation.generation) || operation.generation < 1
    || !operation.claim_id || operation.claim_generation !== operation.generation
    || !operation.claim_worker_identity_json || !operation.launch_identity_json || !operation.claim_worker_identity_digest
    || typeof verifyProcessIdentity !== 'function') throw coded('interaction_channel_unavailable');
  let worker;
  let launch;
  try { worker = JSON.parse(operation.claim_worker_identity_json); launch = JSON.parse(operation.launch_identity_json); }
  catch { throw coded('interaction_channel_identity_invalid'); }
  if (worker.process_id !== child.pid || worker.process_id !== launch.process_id
    || worker.start_fingerprint !== launch.start_fingerprint || sha256(stableJson(worker)) !== operation.claim_worker_identity_digest)
    throw coded('interaction_channel_identity_mismatch');
  const requestStream = child.stdio[7];
  const replyStream = child.stdio[8];
  const ackStream = child.stdio[9];
  if (!requestStream || typeof requestStream[Symbol.asyncIterator] !== 'function'
    || !replyStream || typeof replyStream.write !== 'function'
    || !ackStream || typeof ackStream[Symbol.asyncIterator] !== 'function') throw coded('interaction_channel_unavailable');
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
  const requestReader = new JsonLineReader(requestStream);
  const ackReader = new JsonLineReader(ackStream);
  let sendPending = false;
  const verifyLive = async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw coded('interaction_worker_not_live');
    let observed;
    try { observed = await verifyProcessIdentity({ child, expected: binding }); }
    catch { throw coded('interaction_channel_identity_unknown'); }
    if (!observed || observed.state !== 'verified' || observed.process_id !== binding.process_id
      || observed.start_fingerprint !== binding.start_fingerprint) throw coded('interaction_channel_identity_mismatch');
  };
  const channel = {
    binding,
    async receiveRequest() {
      await verifyLive();
      const frame = await requestReader.read();
      const expected = ['attempt','claim_id','generation','operation_id','process_id','protocol','request','start_fingerprint','task_id','worker_identity_digest'];
      if (Object.keys(frame).sort().join('|') !== expected.join('|')
        || frame.protocol !== 'bridge-sqlite-interaction-request-v1'
        || !sameBinding(frame, binding) || !validRequest(frame.request)) throw coded('interaction_frame_identity_mismatch');
      return Object.freeze({ binding, request: Object.freeze(frame.request) });
    },
    async prepareReply(reply) {
      if (sendPending) throw coded('interaction_channel_busy');
      sendPending = true;
      try {
        await verifyLive();
        if (!sameBinding(reply, binding) || !validId(reply.request_id) || !validId(reply.reply_id)
          || !Number.isSafeInteger(reply.revision) || reply.revision < 1 || !/^[0-9a-f]{64}$/u.test(reply.answer_digest)
          || !reply.answer || Object.getPrototypeOf(reply.answer) !== Object.prototype) throw coded('interaction_reply_binding_mismatch');
        const frame = { protocol: 'bridge-sqlite-interaction-prepare-v1', ...binding, request_id: reply.request_id,
          reply_id: reply.reply_id, revision: reply.revision, answer: reply.answer, answer_digest: reply.answer_digest };
        await writeFrame(replyStream, frame);
        await verifyLive();
        const ack = await ackReader.read(8_192);
        validateAck(ack, 'prepared', binding, reply);
        const proof = Object.freeze({ ...binding, request_id: reply.request_id, reply_id: reply.reply_id,
          revision: reply.revision, answer_digest: reply.answer_digest, ack_digest: sha256(stableJson(ack)) });
        PREPARED_ACKNOWLEDGEMENTS.add(proof);
        return proof;
      } finally { sendPending = false; }
    },
    async commitReply(reply, commit) {
      if (sendPending) throw coded('interaction_channel_busy');
      if (!commit || commit.state !== 'committed' || !sameBinding(commit, binding)
        || commit.request_id !== reply.request_id || commit.reply_id !== reply.reply_id
        || commit.answer_digest !== reply.answer_digest || !Number.isSafeInteger(commit.revision)
        || !/^[0-9a-f]{64}$/u.test(commit.prepared_digest) || !/^[0-9a-f]{64}$/u.test(commit.commit_digest)) throw coded('interaction_commit_binding_mismatch');
      sendPending = true;
      try {
        await verifyLive();
        const frame = { protocol: 'bridge-sqlite-interaction-commit-v1', ...binding,
          request_id: reply.request_id, reply_id: reply.reply_id, revision: commit.revision,
          answer_digest: reply.answer_digest, prepared_digest: commit.prepared_digest, commit_digest: commit.commit_digest };
        await writeFrame(replyStream, frame);
        // The bound acknowledgement arrives on this child's inherited private pipe. The Worker may
        // validly exit after sending it and the Result frame, so a post-send liveness probe races
        // with successful completion; identity is verified immediately before the commit frame.
        const ack = await ackReader.read(8_192);
        validateAck(ack, 'accepted', binding, { ...reply, revision: commit.revision });
        const proof = Object.freeze({ ...binding, request_id: reply.request_id, reply_id: reply.reply_id,
          revision: commit.revision, answer_digest: reply.answer_digest, commit_digest: commit.commit_digest, ack_digest: sha256(stableJson(ack)) });
        ACKNOWLEDGEMENTS.add(proof);
        return proof;
      } finally { sendPending = false; }
    },
  };
  await verifyLive();
  await writeFrame(replyStream, { protocol: 'bridge-sqlite-interaction-bind-v1', ...binding });
  CHANNELS.add(channel);
  return Object.freeze(channel);
}

/** Worker side for a private inherited pipe pair. The expected binding comes
 * only from the parent Bridge's private bind frame, then is checked against
 * the Worker's OS-observed identity before any request or answer is accepted. */
export async function createCandidateWorkerInteractionChannel({ requestStream, replyStream, ackStream, processId, verifySelfIdentity,
  onStage = /** @type {(stage: string) => void} */ (() => {}) }) {
  if (!Number.isSafeInteger(processId) || processId < 1 || typeof verifySelfIdentity !== 'function'
    || !requestStream || typeof requestStream.write !== 'function'
    || !replyStream || typeof replyStream[Symbol.asyncIterator] !== 'function'
    || !ackStream || typeof ackStream.write !== 'function') throw coded('interaction_channel_unavailable');
  const replyReader = new JsonLineReader(replyStream);
  onStage('worker bind read');
  const bind = await replyReader.read(8_192);
  onStage('worker bind received');
  const bindKeys = ['attempt','claim_id','generation','operation_id','process_id','protocol','start_fingerprint','task_id','worker_identity_digest'];
  if (Object.keys(bind).sort().join('|') !== bindKeys.join('|') || bind.protocol !== 'bridge-sqlite-interaction-bind-v1'
    || !validBinding(bind) || bind.process_id !== processId) throw coded('interaction_bind_invalid');
  let observed;
  onStage('worker identity verification');
  try { observed = await verifySelfIdentity({ processId, expected: bind }); } catch { throw coded('interaction_channel_identity_unknown'); }
  if (!observed || observed.state !== 'verified' || observed.process_id !== processId
    || observed.start_fingerprint !== bind.start_fingerprint) throw coded('interaction_bind_identity_mismatch');
  onStage('worker identity verified');
  let pendingReply = null;
  let closed = false;
  const channel = {
    async close() {
      if (closed) return;
      closed = true;
      onStage('worker close request stream start');
      await closeWritable(requestStream);
      onStage('worker close request stream complete');
      await closeReadable(replyStream);
      onStage('worker close reply stream complete');
      await closeWritable(ackStream);
      onStage('worker close acknowledgement stream complete');
    },
    binding: Object.freeze({ ...bind, protocol: undefined }),
    async sendRequest(request) {
      if (closed) throw coded('interaction_channel_closed');
      if (pendingReply) throw coded('interaction_channel_busy');
      if (!validRequest(request)) throw coded('interaction_frame_invalid');
      onStage('worker request write');
      await writeFrame(requestStream, { ...bindingWithoutProtocol(bind), protocol: 'bridge-sqlite-interaction-request-v1', request });
      onStage('worker request written');
      onStage('worker prepare reply read');
      const frame = await replyReader.read();
      onStage('worker prepare reply received');
      const keys = ['answer','answer_digest','attempt','claim_id','generation','operation_id','process_id','protocol','reply_id','request_id','revision','start_fingerprint','task_id','worker_identity_digest'];
      if (Object.keys(frame).sort().join('|') !== keys.join('|') || frame.protocol !== 'bridge-sqlite-interaction-prepare-v1'
        || !sameBinding(frame, bind) || frame.request_id !== request.request_id || !validId(frame.reply_id)
        || !Number.isSafeInteger(frame.revision) || frame.revision < 1 || !/^[0-9a-f]{64}$/u.test(frame.answer_digest)
        || !validPersistedInteractionAnswer(request, frame.answer)
        || interactionReplyDigest(bind, request.request_id, frame.answer) !== frame.answer_digest) throw coded('interaction_prepare_invalid');
      const preparedAck = { protocol: 'bridge-sqlite-interaction-ack-v1', state: 'prepared', ...bindingWithoutProtocol(bind),
        request_id: request.request_id, reply_id: frame.reply_id, revision: frame.revision, answer_digest: frame.answer_digest };
      await writeFrame(ackStream, preparedAck);
      pendingReply = { request, frame, preparedAck };
      return Object.freeze({ state: 'prepared', request_id: request.request_id, reply_id: frame.reply_id });
    },
    async acceptCommittedReply() {
      if (closed) throw coded('interaction_channel_closed');
      if (!pendingReply) throw coded('interaction_reply_not_prepared');
      onStage('worker committed reply frame read');
      const { request, frame, preparedAck } = pendingReply;
      const commit = await replyReader.read(8_192);
      onStage('worker committed reply frame received');
      const commitKeys = ['answer_digest','attempt','claim_id','commit_digest','generation','operation_id','prepared_digest','process_id','protocol','reply_id','request_id','revision','start_fingerprint','task_id','worker_identity_digest'];
      if (Object.keys(commit).sort().join('|') !== commitKeys.join('|') || commit.protocol !== 'bridge-sqlite-interaction-commit-v1'
        || !sameBinding(commit, bind) || commit.request_id !== request.request_id || commit.reply_id !== frame.reply_id
        || commit.answer_digest !== frame.answer_digest || commit.revision <= frame.revision
        || commit.prepared_digest !== sha256(stableJson(preparedAck))
        || commit.commit_digest !== interactionCommitDigest(bind, commit)) throw coded('interaction_commit_invalid');
      const ack = { protocol: 'bridge-sqlite-interaction-ack-v1', state: 'accepted', ...bindingWithoutProtocol(bind),
        request_id: request.request_id, reply_id: frame.reply_id, revision: commit.revision, answer_digest: frame.answer_digest };
      onStage('worker accepted acknowledgement write start');
      await writeFrame(ackStream, ack);
      onStage('worker accepted acknowledgement write complete');
      pendingReply = null;
      return Object.freeze({ answer: frame.answer, reply_id: frame.reply_id, answer_digest: frame.answer_digest });
    },
  };
  return Object.freeze(channel);
}

export function isCandidateInteractionPreparedAcknowledgement(value) { return !!value && PREPARED_ACKNOWLEDGEMENTS.has(value); }
export function isCandidateInteractionAcknowledgement(value) { return !!value && ACKNOWLEDGEMENTS.has(value); }
export function isCandidateInteractionChannel(value) { return !!value && CHANNELS.has(value); }

async function writeFrame(stream, frame) {
  const bytes = Buffer.from(`${stableJson(frame)}\n`, 'utf8');
  if (bytes.length > MAX_FRAME_BYTES) throw coded('interaction_frame_too_large');
  await new Promise((resolve, reject) => {
    try { stream.write(bytes, error => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
  });
}
function validateAck(ack, state, binding, reply) {
  const keys = ['answer_digest','attempt','claim_id','generation','operation_id','process_id','protocol','reply_id','request_id','revision','start_fingerprint','state','task_id','worker_identity_digest'];
  if (Object.keys(ack).sort().join('|') !== keys.join('|') || ack.protocol !== 'bridge-sqlite-interaction-ack-v1'
    || ack.state !== state || !sameBinding(ack, binding) || ack.request_id !== reply.request_id
    || ack.reply_id !== reply.reply_id || ack.revision !== reply.revision || ack.answer_digest !== reply.answer_digest)
    throw coded('interaction_ack_mismatch');
}
function validBinding(value) {
  return value.protocol === 'bridge-sqlite-interaction-bind-v1' && validId(value.operation_id) && validId(value.task_id)
    && Number.isSafeInteger(value.attempt) && value.attempt > 0 && Number.isSafeInteger(value.generation) && value.generation > 0
    && validId(value.claim_id) && /^[0-9a-f]{64}$/u.test(value.worker_identity_digest)
    && Number.isSafeInteger(value.process_id) && value.process_id > 0 && typeof value.start_fingerprint === 'string' && !!value.start_fingerprint;
}
function bindingWithoutProtocol(value) {
  const { protocol: _protocol, ...binding } = value;
  return binding;
}
function interactionReplyDigest(binding, requestId, answer) {
  return sha256(stableJson({ interaction_reply_contract_version: 1, operation_id: binding.operation_id,
    task_id: binding.task_id, attempt: binding.attempt, generation: binding.generation, claim_id: binding.claim_id,
    worker_identity_digest: binding.worker_identity_digest, request_id: requestId, answer }));
}
function interactionCommitDigest(binding, commit) {
  return sha256(stableJson({ interaction_commit_contract_version: 1, operation_id: binding.operation_id,
    task_id: binding.task_id, attempt: binding.attempt, generation: binding.generation, claim_id: binding.claim_id,
    worker_identity_digest: binding.worker_identity_digest, request_id: commit.request_id, reply_id: commit.reply_id,
    revision: commit.revision, answer_digest: commit.answer_digest, prepared_digest: commit.prepared_digest }));
}
function validPersistedInteractionAnswer(request, answer) {
  if (!answer || Object.getPrototypeOf(answer) !== Object.prototype) return false;
  if (request.method === 'interaction/requestPermission') {
    const keys = Object.keys(answer).sort().join('|');
    if (answer.decision === 'allow') return keys === 'decision' && Array.isArray(request.params.options)
      && request.params.options.some(option => option && Object.getPrototypeOf(option) === Object.prototype
        && typeof option.kind === 'string' && option.kind.startsWith('allow'));
    return answer.decision === 'deny' && keys === 'decision|reason' && typeof answer.reason === 'string' && answer.reason.length <= 2000;
  }
  if (answer.action === 'decline') return Object.keys(answer).join('|') === 'action';
  if (answer.action !== 'accept' || Object.keys(answer).sort().join('|') !== 'action|content'
    || !answer.content || Object.getPrototypeOf(answer.content) !== Object.prototype) return false;
  if (request.params.schema && Object.getPrototypeOf(request.params.schema) === Object.prototype
    && request.params.schema.interaction === 'plan_approval') return Object.keys(answer.content).join('|') === 'answer_0'
      && answer.content.answer_0 === 'approve';
  if (Object.keys(answer.content).join('|') !== 'answers' || !answer.content.answers
    || Object.getPrototypeOf(answer.content.answers) !== Object.prototype) return false;
  const nested = request.params.input && Object.getPrototypeOf(request.params.input) === Object.prototype ? request.params.input : {};
  const raw = Array.isArray(request.params.questions) ? request.params.questions : Array.isArray(nested.questions) ? nested.questions : [];
  const questions = raw.filter(question => question && Object.getPrototypeOf(question) === Object.prototype
    && typeof question.question === 'string').map(question => question.question);
  const entries = Object.entries(answer.content.answers);
  return entries.length > 0 && entries.every(([key, value]) => questions.includes(key) && typeof value === 'string'
    && !!value.trim() && value.length <= 4000) && Buffer.byteLength(stableJson(answer.content.answers), 'utf8') <= 16000;
}

function sameBinding(value, binding) {
  return value.operation_id === binding.operation_id && value.task_id === binding.task_id
    && value.attempt === binding.attempt && value.generation === binding.generation
    && value.claim_id === binding.claim_id && value.worker_identity_digest === binding.worker_identity_digest
    && value.process_id === binding.process_id && value.start_fingerprint === binding.start_fingerprint;
}
function validRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join('|') !== 'method|params|request_id'
    || !validId(value.request_id) || value.request_id.length > 512
    || !['interaction/requestPermission','interaction/requestUserInput'].includes(value.method)
    || !value.params || Object.getPrototypeOf(value.params) !== Object.prototype) return false;
  try { return Buffer.byteLength(stableJson(value), 'utf8') <= MAX_REQUEST_BYTES; } catch { return false; }
}
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/u.test(value); }
function stableJson(value, depth = 0) {
  if (depth > 32) throw coded('interaction_json_too_deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 256) throw coded('interaction_json_too_large');
    return `[${value.map(item => stableJson(item, depth + 1)).join(',')}]`;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > 256 || keys.some(key => key !== key.normalize('NFC'))) throw coded('interaction_json_invalid');
    return `{${keys.sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(',')}}`;
  }
  throw coded('interaction_json_invalid');
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function coded(code) { return Object.assign(new Error(code), { code }); }
function closeWritable(stream) {
  if (stream.closed) return Promise.resolve();
  const closed = new Promise((resolve, reject) => {
    stream.once('close', resolve);
    stream.once('error', reject);
  });
  stream.end();
  return closed;
}
async function closeReadable(stream) {
  if (stream.closed) return;
  const closed = new Promise(resolve => stream.once('close', resolve));
  if (typeof stream.close === 'function') stream.close();
  else if (!stream.destroyed) stream.destroy();
  // Wait for this Worker's local inherited descriptor to close. The Manager
  // waits for the Result frame before closing its peer endpoint, so waiting on
  // the peer would deadlock; this local close is the resource release signal.
  await closed;
}
