#!/usr/bin/env node

const input = await readInput();
const endpoint = process.env.CODEFOLD_URL;
const token = process.env.CODEFOLD_TOKEN;

if (!endpoint || !token) {
  console.error('CodeFold hook skipped: CODEFOLD_URL and CODEFOLD_TOKEN are required.');
  process.exitCode = 1;
} else {
  const events = translateHookInput(input);
  if (events.length === 0) {
    console.warn(
      `CodeFold hook received ${String(input.hook_event_name ?? 'an unknown event')} `
      + 'without a resolvable file or agent target; FileSystemWatcher remains the fallback.'
    );
  }
  for (const event of events) {
    await reportEvent(endpoint, token, event);
  }
}

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  if (!text.trim()) {
    throw new Error('CodeFold hook received empty stdin.');
  }
  return JSON.parse(text);
}

function translateHookInput(value) {
  const hookName = value.hook_event_name;
  const sessionId = nonEmpty(value.session_id) ?? process.env.CODEFOLD_AGENT_ID;
  const currentAgentId = nonEmpty(value.agent_id) ?? sessionId;
  if (hookName === 'SubagentStart') {
    const childId = nonEmpty(value.agent_id);
    const parentId = nonEmpty(value.parent_agent_id) ?? sessionId;
    if (!childId || !parentId) {
      return [];
    }
    return [{
      type: 'agent_spawn',
      agent_id: childId,
      agent_name: nonEmpty(value.agent_type) ?? childId,
      parent_agent_id: parentId
    }];
  }
  if (hookName === 'SubagentStop') {
    const childId = nonEmpty(value.agent_id);
    return childId ? [{ type: 'agent_done', agent_id: childId }] : [];
  }
  if ((hookName !== 'PreToolUse' && hookName !== 'PostToolUse') || !currentAgentId) {
    return [];
  }
  return extractPaths(value.tool_input).map((path) => ({
    type: hookName === 'PreToolUse' ? 'agent_edit_start' : 'agent_edit_end',
    agent_id: currentAgentId,
    agent_name: process.env.CODEFOLD_AGENT_NAME ?? currentAgentId,
    path
  }));
}

function extractPaths(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return [];
  }
  const direct = [
    toolInput.file_path,
    toolInput.path,
    toolInput.target_file
  ].map(nonEmpty).filter(Boolean);
  const patch = nonEmpty(toolInput.patch) ?? nonEmpty(toolInput.input);
  if (patch) {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      direct.push(match[1].trim());
    }
  }
  return [...new Set(direct)];
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function reportEvent(endpoint, token, event) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(event)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`CodeFold hook endpoint returned ${response.status}: ${detail}`);
  }
}
