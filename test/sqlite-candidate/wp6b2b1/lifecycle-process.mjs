// Controlled child-process harness for SQLite lifecycle races; never starts a Worker.
import { IsolatedAdmissionStore } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';

const [mode,root,payloadText,fault]=process.argv.slice(2);
let store;
try {
  const payload=JSON.parse(payloadText);
  if(mode==='recovery'){
    store=IsolatedAdmissionStore.openForRecovery(root);
    process.stdout.write(JSON.stringify({ok:true,result:store.rebuildRecoveryState()}));
    process.exitCode=0;
  } else {
  store=IsolatedAdmissionStore.open(root,{fault});
  let result;
  if(mode==='admit')result=Object.hasOwn(payload,'generation')
    ?store.admitSyntheticFixtureOperation(payload,{
      workspaceValidator:()=>({state:'allow',fixture:true}),
      executionPermissionCheck:()=>({state:'allow',fixture:true}),
    })
    :store.admitOperation(payload,{
    workspaceValidator:()=>({state:'allow',fixture:true}),
    executionPermissionCheck:()=>({state:'allow',fixture:true}),
  });
  else if(mode==='intent')result=store.createLaunchIntent(payload);
  else if(mode==='receipt')result=store.recordLaunchReceipt(payload);
  else if(mode==='claim')result=store.commitPermanentClaim(payload);
  else if(mode==='result')result=store.commitResult(payload);
  else throw Object.assign(new Error('unknown_mode'),{code:'unknown_mode'});
  process.stdout.write(JSON.stringify({ok:true,result}));
  }
} catch(error) {
  process.stdout.write(JSON.stringify({ok:false,code:error.code??'error',message:String(error.message)}));
  process.exitCode=2;
} finally { try{store?.close();}catch{} }
