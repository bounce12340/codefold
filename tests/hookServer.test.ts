import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHookEvent } from '../src/agents/events';
import { AgentHookServer } from '../src/agents/hookServer';

const runningServers: AgentHookServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

async function startServer(options: {
  onEvent?: (event: AgentHookEvent) => void | Promise<void>;
  log?: (message: string) => void;
} = {}): Promise<{ server: AgentHookServer; url: string }> {
  const server = new AgentHookServer({
    token: 'correct-token',
    onEvent: options.onEvent ?? (() => undefined),
    log: options.log ?? (() => undefined)
  });
  runningServers.push(server);
  const info = await server.start();
  return { server, url: info.url };
}

function post(
  url: string,
  token: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

describe('agent hook server', () => {
  it('accepts the correct token and rejects an incorrect token with a log', async () => {
    const events: AgentHookEvent[] = [];
    const logs: string[] = [];
    const { url } = await startServer({
      onEvent: (event) => {
        events.push(event);
      },
      log: (message) => logs.push(message)
    });

    const accepted = await post(url, 'correct-token', {
      type: 'agent_edit_start',
      agent_id: 'agent-a',
      path: 'src/a.ts'
    });
    const rejected = await post(url, 'wrong-token', {
      type: 'agent_done',
      agent_id: 'agent-a'
    });

    expect(accepted.status).toBe(202);
    expect(rejected.status).toBe(401);
    expect(events).toHaveLength(1);
    expect(logs.some((message) => message.includes('invalid token'))).toBe(true);
  });

  it('serializes concurrent events in request arrival order', async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const { url } = await startServer({
      onEvent: async (event) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(event.agent_id);
        if (event.agent_id === 'first') {
          signalStarted?.();
          await firstGate;
        }
        completed.push(event.agent_id);
        active -= 1;
      }
    });

    const firstResponse = post(url, 'correct-token', {
      type: 'agent_edit_start',
      agent_id: 'first',
      path: 'src/a.ts'
    });
    await firstStarted;
    const secondResponse = post(url, 'correct-token', {
      type: 'agent_edit_start',
      agent_id: 'second',
      path: 'src/b.ts'
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(['first']);

    releaseFirst?.();
    await Promise.all([firstResponse, secondResponse]);

    expect(started).toEqual(['first', 'second']);
    expect(completed).toEqual(['first', 'second']);
    expect(maximumActive).toBe(1);
  });
});
