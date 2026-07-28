export type AgentHookEvent =
  | AgentEditEvent
  | AgentReportEvent
  | AgentSpawnEvent
  | AgentDoneEvent;

interface AgentEventBase {
  agent_id: string;
  agent_name?: string;
}

export interface AgentEditEvent extends AgentEventBase {
  type: 'agent_edit_start' | 'agent_edit_end';
  path?: string;
  node_id?: string;
  symbol?: string;
  line?: number;
}

export interface AgentReportEvent extends AgentEventBase {
  type: 'agent_report';
  path?: string;
  node_id?: string;
  symbol?: string;
  line?: number;
  message: string;
  level?: 'info' | 'error';
}

export interface AgentSpawnEvent extends AgentEventBase {
  type: 'agent_spawn';
  parent_agent_id: string;
}

export interface AgentDoneEvent extends AgentEventBase {
  type: 'agent_done';
}

const eventTypes = new Set([
  'agent_edit_start',
  'agent_edit_end',
  'agent_report',
  'agent_spawn',
  'agent_done'
]);

export function parseAgentHookEvent(value: unknown): AgentHookEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || !eventTypes.has(value.type)) {
    throw new Error('Unsupported or missing agent hook event type.');
  }
  if (!nonEmptyString(value.agent_id)) {
    throw new Error('Every agent hook event requires a non-empty agent_id.');
  }

  if (value.type === 'agent_spawn' && !nonEmptyString(value.parent_agent_id)) {
    throw new Error('agent_spawn requires a non-empty parent_agent_id.');
  }
  if (value.type === 'agent_report' && !nonEmptyString(value.message)) {
    throw new Error('agent_report requires a non-empty message.');
  }
  if (
    value.type === 'agent_report'
    && value.level !== undefined
    && value.level !== 'info'
    && value.level !== 'error'
  ) {
    throw new Error('agent_report level must be info or error when provided.');
  }
  if ('line' in value && value.line !== undefined &&
    (typeof value.line !== 'number' || !Number.isInteger(value.line) || value.line < 1)) {
    throw new Error('line must be a positive 1-based integer.');
  }

  return value as unknown as AgentHookEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
