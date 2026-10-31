/**
 * Internal candidate-only SQLite lifecycle port. It exposes only capabilities
 * implemented and explicitly gated through WP6C-C3. It is not imported by
 * production composition.
 */
import { IsolatedAdmissionStore } from './store.mjs';
import { createCandidateInteractionChannel, isCandidateInteractionChannel } from './interaction-channel.mjs';

export class UnsupportedLifecycleOperationError extends Error {
  constructor(operation) {
    super(`lifecycle operation is not implemented in the candidate: ${operation}`);
    this.name = 'UnsupportedLifecycleOperationError';
    this.code = 'lifecycle_operation_unsupported';
    this.operation = operation;
  }
}

const B1_METHODS = Object.freeze([
  'createTask', 'readTask', 'readTaskProjection', 'readAttempt', 'readTaskLifecycle', 'readRecoverableQueuedAttempts', 'readTaskEvents', 'readTaskFeedback',
  'provisionCapacity', 'assertCapacityPolicy', 'admitOperation', 'readOperation',
  'createLaunchIntent', 'recordLaunchReceipt', 'commitPermanentClaim',
]);
const C1_METHODS = Object.freeze(['readLifecycleEvents','commitResult','readCommittedResult']);
const C2_METHODS = Object.freeze(['beginCleanup','recordCleanupEvidence','reverifyCleanup','releaseCapacity']);
const C3_READ_METHODS = Object.freeze(['readRecoverySnapshot']);
const CANCEL_METHODS = Object.freeze(['requestCancellation','recordCancellationVerification']);
const QUEUED_CANCEL_METHODS = Object.freeze(['cancelQueuedAttempt']);
const INTERACTION_METHODS = Object.freeze(['recordInteractionRequest','readInteractionRequest','beginInteractionReply','commitInteractionReply','completeInteractionReply']);

export function createSqliteLifecyclePort(store,{recoveryEvidenceVerifier,workerIdentityVerifier,cancellationVerifier}={}) {
  if (!(store instanceof IsolatedAdmissionStore)) throw new TypeError('IsolatedAdmissionStore required');
  for (const method of B1_METHODS) {
    if (typeof store[method] !== 'function') throw new TypeError(`candidate SQLite Store missing ${method}`);
  }
  for (const method of C1_METHODS) {
    if (typeof store[method] !== 'function') throw new TypeError(`candidate SQLite Store missing ${method}`);
  }
  for (const method of C2_METHODS) {
    if (typeof store[method] !== 'function') throw new TypeError(`candidate SQLite Store missing ${method}`);
  }
  for (const method of C3_READ_METHODS) {
    if (typeof store[method] !== 'function') throw new TypeError(`candidate SQLite Store missing ${method}`);
  }
  for (const method of CANCEL_METHODS) {
    if (typeof store[method] !== 'function') throw new TypeError(`candidate SQLite Store missing ${method}`);
  }
  for (const method of QUEUED_CANCEL_METHODS) {
    if (typeof store[method] !== 'function') throw new TypeError(`candidate SQLite Store missing ${method}`);
  }
  for (const method of INTERACTION_METHODS) {
    if (typeof store[method] !== 'function') throw new TypeError(`candidate SQLite Store missing ${method}`);
  }
  if(typeof store.compareAndSwapRecoveryObservation!=='function')throw new TypeError('candidate SQLite Store missing compareAndSwapRecoveryObservation');

  const port = {};
  for (const method of B1_METHODS) {
    Object.defineProperty(port, method, {
      enumerable: true,
      value: (...args) => store[method](...args),
    });
  }
  for (const method of C1_METHODS) {
    Object.defineProperty(port, method, {
      enumerable: true,
      value: (...args) => store[method](...args),
    });
  }
  for (const method of C2_METHODS) {
    Object.defineProperty(port, method, {
      enumerable: true,
      value: (...args) => store[method](...args),
    });
  }
  for (const method of C3_READ_METHODS) {
    Object.defineProperty(port, method, {
      enumerable: true,
      value: (...args) => store[method](...args),
    });
  }
  Object.defineProperty(port,'requestCancellation',{
    enumerable:true,
    value:(input,evidence)=>store.requestCancellation(input,evidence,workerIdentityVerifier),
  });
  Object.defineProperty(port,'recordCancellationVerification',{
    enumerable:true,
    value:(input,evidence)=>store.recordCancellationVerification(input,evidence,cancellationVerifier),
  });
  Object.defineProperty(port,'cancelQueuedAttempt',{
    enumerable:true,
    value:input=>store.cancelQueuedAttempt(input),
  });
  Object.defineProperty(port,'readInteractionRequest',{
    enumerable:true,
    value:(taskId,requestId)=>store.readInteractionRequest(taskId,requestId),
  });
  Object.defineProperty(port,'openInteractionChannel',{
    enumerable:true,
    value:(child,operation,verifyProcessIdentity)=>createCandidateInteractionChannel(child,operation,verifyProcessIdentity),
  });
  Object.defineProperty(port,'receiveInteractionRequest',{
    enumerable:true,
    value:async(channel)=>{
      if(!isCandidateInteractionChannel(channel))throw Object.assign(new Error('candidate interaction channel required'),{code:'interaction_channel_unavailable'});
      const received=await channel.receiveRequest();
      const current=store.readOperation(received.binding.operation_id);
      const { operation_id, task_id, attempt, generation, claim_id, worker_identity_digest } = received.binding;
      const recorded=store.recordInteractionRequest({ operation_id, task_id, attempt, generation, claim_id,
        worker_identity_digest, expected_revision:current?.revision, request:received.request });
      return { ...recorded, request: received.request };
    },
  });
  Object.defineProperty(port,'replyToInteractionRequest',{
    enumerable:true,
    value:async(input,channel)=>{
      if(!isCandidateInteractionChannel(channel))throw Object.assign(new Error('candidate interaction channel required'),{code:'interaction_channel_unavailable'});
      const persisted=store.readInteractionRequest(input.task_id,input.request_id);
      const binding=channel.binding;
      if(persisted?.state==='unknown')throw Object.assign(new Error('interaction reply outcome is unknown'),{code:'interaction_reply_outcome_unknown'});
      if(!persisted||persisted.state!=='pending'||binding.operation_id!==persisted.operation_id||binding.task_id!==persisted.task_id
        ||binding.attempt!==persisted.attempt||binding.generation!==persisted.generation||binding.claim_id!==persisted.claim_id
        ||binding.worker_identity_digest!==persisted.worker_identity_digest)throw Object.assign(new Error('interaction channel binding mismatch'),{code:'interaction_channel_identity_mismatch'});
      const reply=store.beginInteractionReply(input);
      if(binding.operation_id!==reply.operation_id||binding.task_id!==reply.task_id||binding.attempt!==reply.attempt
        ||binding.generation!==reply.generation||binding.claim_id!==reply.claim_id
        ||binding.worker_identity_digest!==reply.worker_identity_digest||binding.process_id!==reply.process_id
        ||binding.start_fingerprint!==reply.start_fingerprint)throw Object.assign(new Error('interaction channel binding mismatch'),{code:'interaction_channel_identity_mismatch'});
      const prepared=await channel.prepareReply(reply);
      const commit=store.commitInteractionReply(prepared);
      const accepted=await channel.commitReply(reply,commit);
      return store.completeInteractionReply(accepted);
    },
  });
  Object.defineProperty(port,'recordRecoveryObservation',{
    enumerable:true,
    value:(input,evidence)=>{
      if(typeof recoveryEvidenceVerifier!=='function')throw Object.assign(new Error('recovery evidence verifier required'),{code:'recovery_evidence_verifier_required'});
      return store.compareAndSwapRecoveryObservation(input,evidence,recoveryEvidenceVerifier);
    },
  });
  for (const operation of [
    'appendLifecycleEvent',
    'readLifecycleStatus', 'writeLifecycleStatus',
    'recoverOperation',
  ]) {
    Object.defineProperty(port, operation, {
      enumerable: true,
      value: () => { throw new UnsupportedLifecycleOperationError(operation); },
    });
  }
  if(typeof store.createNextAttempt!=='function')throw new TypeError('candidate SQLite Store missing createNextAttempt');
  Object.defineProperty(port,'createNextAttempt',{
    enumerable:true,
    value:(input,gates)=>store.createNextAttempt(input,gates),
  });
  return Object.freeze(port);
}
