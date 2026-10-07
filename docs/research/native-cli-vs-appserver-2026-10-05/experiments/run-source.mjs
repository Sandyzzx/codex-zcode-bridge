import path from 'node:path';
import {Server,base,save,snapshot} from './probe.mjs';
const cwd=path.join(base,'source-review');
const s=new Server(cwd);
const result={};
try{
  await s.init();result.created=snapshot(await s.create(cwd));
  console.log(JSON.stringify({sessionId:s.sid,model:result.created.model,thought:result.created.thought,mode:result.created.mode}));
  result.run=await s.run(`研究任务，仅生成源码证据文档。官方源码位于 ${base}/official，commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e，CLI 安装版 0.16.9 不保证与其对应。只读官方源码。当前 Bridge worktree HEAD 2596759198fa826c2b7ac0478c5682da996e9727。
只允许写当前目录 docs/research/source-audit/CALLCHAIN.md、RUNTIME_DIFFERENCES.md、HANDOFF_SOURCE.md。禁止修改 Bridge实现/test/plugins/package或官方源码；禁止启动其他zcode/模型、git提交、网络、读取私人配置凭据DB日志memory。用文件读取、搜索工具追踪源码即可。
CALLCHAIN: Native packages/cli/src/run.ts -> prompt-command.ts runPrompt/createZCodeApp/submitPrompt，与 bootstrap/src/zcode-protocol-entrypoint.ts -> zcode-protocol/server-operations.ts materializeSessionRecord/sessionSend 进入 model runtime 的实际汇合点。追踪到模型request执行函数。所有引用有实际文件行号、固定commit GitHub链接。
RUNTIME_DIFFERENCES: system prompt、MCS、workspace AGENTS/skills/MCP、memory use vs extraction、tools registry vs permission policy、browser、provider account auth、model reasoning low/high/max/default、foreground/background subagent、workflow terminal settle。记录每个默认值和覆盖位置。当前 Bridge 的请求RuntimePreferences与turn.completed收口也列出。
HANDOFF_SOURCE: 追踪持久化 session entries/model/mode/workspace/read state/usage 与 resume；close是否删除、EOF是否保留、stop做什么；检查跨进程 session ownership/lock，不把SQLite migration/file锁当作session执行锁。运行时注册Map只在同进程还是跨进程。发现双Runtime并发写风险需明确，但不要运行探针。
用中文。直接源码事实标CONFIRMED — SOURCE；不能确定的写不确定/UNKNOWN。不要假定benchmark或runtime验证结果，不编造行号。尽可能深入检查实际实现。完成返回简短报告列文件、关键事实、未知项。`,900000);
  console.log(JSON.stringify({completed:result.run.terminal?.resultType,usage:result.run.terminal?.usage,tools:result.run.events.filter(e=>e.type.startsWith('tool.')).length}));
}catch(e){result.error=e.message;console.log(result.error);}finally{await s.finish();save('source-task',result);}
