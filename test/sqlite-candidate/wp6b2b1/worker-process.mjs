import { IsolatedAdmissionStore } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';
const [root,taskId,attempt,generation,workspace] = process.argv.slice(2);
let store;
try {
  store=IsolatedAdmissionStore.open(root);
  const result=store.admitSyntheticFixtureOperation({operation_id:`op-${taskId}-${attempt}`,task_id:taskId,attempt:Number(attempt),generation:Number(generation),workspace_ref:workspace},{
    workspaceValidator:()=>({state:'allow',fixture:true}),
    executionPermissionCheck:()=>({state:'allow',fixture:true}),
  });
  process.stdout.write(JSON.stringify({ok:true,result}));
} catch(error) {process.stdout.write(JSON.stringify({ok:false,code:error.code??'error',message:String(error.message)}));process.exitCode=2;}
finally {try{store?.close();}catch{}}
