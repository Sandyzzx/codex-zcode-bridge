// Offline research only. No production imports or Provider traffic.
import { randomUUID } from 'node:crypto';
const proofs = new WeakSet();
const fields = ['account','provider','model','task','attempt','session','turn'];
export const sameScope = (a,b) => fields.every(k => a?.[k] === b?.[k] && (k==='attempt' ? Number.isSafeInteger(a?.[k]) && a[k]>0 : typeof a?.[k]==='string' && a[k].length>0));
export async function checkLive(scope, adapter, signal) {
  if (signal.aborted) throw Error('cancelled');
  // adapter is a trusted composition dependency, never a task-supplied boolean.
  const result = await adapter(scope, signal);
  if (signal.aborted) throw Error('cancelled');
  if (!sameScope(scope,result.scope) || result.status !== 'eligible') throw Error(result.status || 'unknown');
  const proof = Object.freeze({scope:Object.freeze({...scope}), observedAt:Date.now()});
  proofs.add(proof);
  return proof;
}
export function createLease({proof,scope,credential,identity,probe,signal,ttlMs=2000,now=Date.now}) {
  if (!proofs.has(proof) || !sameScope(scope,proof.scope) || Date.now()-proof.observedAt>5000) throw Error('live_proof_required');
  proofs.delete(proof);
  scope=Object.freeze({...scope});identity=Object.freeze({...identity});
  if (credential.account !== scope.account || typeof credential.jwt!=='string' || !credential.jwt || !Number.isFinite(credential.expiresAt) || credential.expiresAt<=now()) throw Error('credential_invalid');
  if (!Number.isInteger(ttlMs) || ttlMs<1 || ttlMs>5000 || !identity.creation || !identity.pid) throw Error('lease_invalid');
  let material=credential.jwt, state='active';
  const expiresAt=Math.min(now()+ttlMs,credential.expiresAt);
  const revoke=()=>{state='revoked';material=null;};
  const timer=setTimeout(revoke,ttlMs);timer.unref();
  signal.addEventListener('abort',revoke,{once:true});
  const clear=()=>{clearTimeout(timer);signal.removeEventListener('abort',revoke);material=null;};
  return {
    revoke(){revoke();clear();},
    async deliver(request,write) {
      if(state!=='active')throw Error('lease_inactive');
      if(signal.aborted||now()>=expiresAt){revoke();clear();throw Error('lease_inactive');}
      state='verifying'; // reserve before await: two concurrent consumes cannot win
      try {
        if(!sameScope(scope,request))throw Error('scope_mismatch');
        const current=await probe(identity.pid);
        if(current.pid!==identity.pid||current.creation!==identity.creation)throw Error('identity_mismatch');
        if(state!=='verifying'||signal.aborted||now()>=expiresAt)throw Error('lease_inactive');
        state='consumed';
        await write({id:randomUUID(),scope:{...scope},expiresAt,jwt:material});
      } catch(e){revoke();throw e;} finally{clear();}
    },
  };
}
