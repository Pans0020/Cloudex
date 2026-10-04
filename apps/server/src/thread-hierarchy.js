// SessionSource is a tagged object in both persisted rollouts and app-server.
// Keep this normalization shared so API and local-history lists agree.
export function threadRelationship(thread) {
  const source = thread.source;
  const subagent = source && typeof source === "object" ? source.subAgent ?? source.subagent : null;
  const spawn = subagent && typeof subagent === "object" ? subagent.thread_spawn ?? subagent.threadSpawn : null;
  const text = (...values) => values.find(value => typeof value === "string" && value.trim())?.trim() || null;
  const parentThreadId = text(thread.parentThreadId, thread.parent_thread_id, spawn?.parent_thread_id, spawn?.parentThreadId);
  const threadSource = text(thread.threadSource, thread.thread_source);
  const isSubagent = Boolean(parentThreadId || subagent != null || /^subagent/i.test(threadSource || "") || /^subagent/i.test(typeof source === "string" ? source : ""));
  return {
    parentThreadId,
    agentNickname: text(thread.agentNickname, thread.agent_nickname, spawn?.agent_nickname, spawn?.agentNickname),
    agentRole: text(thread.agentRole, thread.agent_role, spawn?.agent_role, spawn?.agentRole),
    agentPath: text(thread.agentPath, thread.agent_path, spawn?.agent_path, spawn?.agentPath),
    threadSource: isSubagent ? "subagent" : threadSource,
    source: typeof source === "string" ? source : isSubagent ? "subagent" : text(source?.custom) || "unknown",
    isSubagent,
  };
}

export function agentStatus(value) {
  const type = typeof value === "string" ? value : value?.type;
  return ({ pendingInit: "pending", pending: "pending", running: "active", started: "active", inProgress: "active", active: "active",
    completed: "completed", done: "completed", errored: "failed", failed: "failed", systemError: "failed",
    interrupted: "interrupted", shutdown: "closed", closed: "closed", waiting: "waiting", notFound: "unknown" })[type] || "unknown";
}

export function threadAgentStatus(thread) {
  if (thread.status?.type === "active") {
    return thread.status.activeFlags?.some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)) ? "waiting" : "active";
  }
  if (thread.status?.type === "systemError") return "failed";
  if (thread.agentStatus) return agentStatus(thread.agentStatus);
  const latest = thread.turns?.at(-1);
  return latest?.status === "inProgress" ? "unknown" : agentStatus(latest?.status);
}

export function threadsWithHierarchy(threads) {
  const nodes = new Map();
  const pending = [...threads];
  while (pending.length) {
    const thread = pending.pop();
    if (nodes.has(thread.id)) continue;
    const relationship = threadRelationship(thread);
    const { turns: _turns, subagents = [], _subagentStates, ...summary } = thread;
    const node = { ...summary, ...relationship, subagents: [], _subagentStates,
      ...(relationship.isSubagent ? { canAcceptDirectInput: false, agentStatus: threadAgentStatus(thread) } : {}) };
    nodes.set(thread.id, node);
    pending.push(...subagents);
  }
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentThreadId);
    if (node.isSubagent && parent && parent !== node) parent.subagents.push(node);
  }
  // Missing parents and malformed cycles stay hidden; neither identifies a
  // user conversation. Forked conversations retain their independent roots.
  const roots = threads.filter(thread => nodes.has(thread.id) && !nodes.get(thread.id).isSubagent).map(thread => nodes.get(thread.id));
  const visiting = [...roots];
  while (visiting.length) {
    const node = visiting.pop();
    node.subagents.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
    for (const child of node.subagents) {
      const observed = node._subagentStates?.[child.id];
      if (observed && (observed.updatedAt || 0) >= (child._agentStatusUpdatedAt || child.updatedAt || 0)
          && !(child.status?.type === "active" && !child._statusFromHistory)
          && !(observed.evidence === "activity" && observed.status === "completed" && ["failed", "interrupted", "closed"].includes(child.agentStatus))) {
        child.agentStatus = agentStatus(observed.status);
      }
      visiting.push(child);
    }
    delete node.isSubagent;
    delete node._subagentStates;
    delete node._agentStatusUpdatedAt;
    delete node._statusFromHistory;
  }
  return roots;
}

export function flattenThreads(threads) {
  const result = [];
  const pending = [...threads].reverse();
  const visited = new Set();
  while (pending.length) {
    const thread = pending.pop();
    if (visited.has(thread.id)) continue;
    visited.add(thread.id);
    result.push(thread);
    pending.push(...(thread.subagents || []).toReversed());
  }
  return result;
}

export function observedThreadIds(threads, subscribedIds) {
  const subscribed = new Set(subscribedIds);
  const observed = new Set(subscribed);
  for (const thread of flattenThreads(threads)) {
    if (subscribed.has(thread.id)) for (const child of flattenThreads(thread.subagents || [])) observed.add(child.id);
    if (thread.status?.type === "active" || ["active", "waiting", "pending"].includes(thread.agentStatus)) observed.add(thread.id);
  }
  return [...observed];
}
