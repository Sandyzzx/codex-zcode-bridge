import { MCP_DISPATCH_TOOL_NAMES } from "./constants.mjs";
import { compareTuple, isRecord } from "./util.mjs";

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))].sort();
}

function parentByThread(agent, agentsByThread) {
  if (!agent.parent_thread_id) return null;
  return agentsByThread.get(agent.parent_thread_id) ?? null;
}

function dispatchCallerForWorker(agent, tools, agentsById) {
  if (agent.kind !== "WORKER" || !agent.task_id) return null;
  const candidates = tools
    .filter((tool) => (
      tool.task_id === agent.task_id
      && MCP_DISPATCH_TOOL_NAMES.includes(tool.name)
      && agentsById.has(tool.agent_id)
    ))
    .sort((left, right) => (
      (left.started_at ?? "").localeCompare(right.started_at ?? "")
      || left.tool_event_id.localeCompare(right.tool_event_id)
    ));
  return candidates[0] ?? null;
}

function lineageFor(agent, agentsById) {
  const lineage = [agent.agent_id];
  const seen = new Set(lineage);
  let current = agent;
  while (current.parent_agent_id) {
    const parent = agentsById.get(current.parent_agent_id);
    if (!parent || seen.has(parent.agent_id)) break;
    lineage.push(parent.agent_id);
    seen.add(parent.agent_id);
    current = parent;
  }
  return lineage;
}

export function correlateProfilerAgents(agents, tools = []) {
  const ordered = [...agents].sort((left, right) => (
    compareTuple(
      [left.kind, left.started_at, left.agent_id],
      [right.kind, right.started_at, right.agent_id],
    )
  ));
  const agentsById = new Map(ordered.map((agent) => [agent.agent_id, agent]));
  const agentsByThread = new Map();
  for (const agent of ordered) {
    if (agent.thread_id && !agentsByThread.has(agent.thread_id)) {
      agentsByThread.set(agent.thread_id, agent);
    }
  }

  for (const agent of ordered) {
    if (agent.kind === "WORKER") {
      const dispatch = dispatchCallerForWorker(agent, tools, agentsById);
      if (dispatch) {
        agent.parent_agent_id = dispatch.agent_id;
        agent.correlation = {
          status: "EXPLICIT_TASK_DISPATCH",
          evidence: "mcp_task_dispatch",
          evidence_ref: dispatch.tool_event_id,
          task_id: agent.task_id,
        };
      } else {
        agent.parent_agent_id = null;
        agent.correlation = {
          status: "UNRESOLVED",
          evidence: "bridge_task_identity",
          task_id: agent.task_id,
        };
      }
      continue;
    }

    if (agent.parent_thread_id) {
      const parent = parentByThread(agent, agentsByThread);
      if (parent && parent.agent_id !== agent.agent_id) {
        agent.parent_agent_id = parent.agent_id;
        agent.correlation = {
          status: "EXPLICIT_PARENT",
          evidence: "thread_spawn",
          parent_thread_id: agent.parent_thread_id,
        };
      } else {
        agent.parent_agent_id = null;
        agent.correlation = {
          status: "UNRESOLVED",
          evidence: "thread_spawn",
          parent_thread_id: agent.parent_thread_id,
        };
      }
    } else {
      agent.parent_agent_id = null;
      agent.correlation = {
        status: "ROOT",
        evidence: "session_meta",
      };
    }
  }

  for (const agent of ordered) {
    const lineage = lineageFor(agent, agentsById);
    const root = agentsById.get(lineage.at(-1));
    agent.lineage = lineage;
    agent.root_agent_id = root?.agent_id ?? agent.agent_id;
    const parent = agent.parent_agent_id ? agentsById.get(agent.parent_agent_id) : null;
    agent.goal_id = parent?.goal_id ?? agent.goal_id ?? agent.root_agent_id;
    agent.source_refs = uniqueStrings(agent.source_refs ?? []);
  }

  return ordered;
}

export function groupAgentsByGoal(agents) {
  const groups = new Map();
  for (const agent of agents) {
    const goalId = agent.goal_id ?? agent.root_agent_id ?? "UNKNOWN_GOAL";
    if (!groups.has(goalId)) groups.set(goalId, []);
    groups.get(goalId).push(agent);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([goalId, members]) => ({
      goal_id: goalId,
      agent_ids: members.map((agent) => agent.agent_id).sort(),
      agent_kinds: uniqueStrings(members.map((agent) => agent.kind)),
      master_agent_ids: members.filter((agent) => agent.kind === "MASTER")
        .map((agent) => agent.agent_id).sort(),
      subagent_agent_ids: members.filter((agent) => agent.kind === "SUBAGENT")
        .map((agent) => agent.agent_id).sort(),
      worker_agent_ids: members.filter((agent) => agent.kind === "WORKER")
        .map((agent) => agent.agent_id).sort(),
      unresolved_agent_ids: members.filter((agent) => (
        !isRecord(agent.correlation)
        || agent.correlation.status === "UNRESOLVED"
      )).map((agent) => agent.agent_id).sort(),
    }));
}
