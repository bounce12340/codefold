import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentHookEvent } from './events';
import { parseAgentHookEvent } from './events';

const MAX_BODY_BYTES = 256 * 1024;

export interface HookServerOptions {
  onEvent: (event: AgentHookEvent) => void | Promise<void>;
  log: (message: string) => void;
  token?: string;
}

export interface HookServerInfo {
  host: '127.0.0.1';
  port: number;
  token: string;
  url: string;
}

export class AgentHookServer {
  readonly token: string;
  private server: Server | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: HookServerOptions) {
    this.token = options.token ?? randomBytes(24).toString('hex');
  }

  async start(): Promise<HookServerInfo> {
    if (this.server) {
      throw new Error('CodeFold agent hook server is already running.');
    }

    this.server = createServer((request, response) => {
      this.accept(request, response);
    });
    this.server.on('clientError', (error, socket) => {
      this.options.log(`Agent hook client error: ${error.message}`);
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error('CodeFold agent hook server was not created.'));
        return;
      }
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = this.server.address() as AddressInfo;
    return {
      host: '127.0.0.1',
      port: address.port,
      token: this.token,
      url: `http://127.0.0.1:${address.port}/events`
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await this.queue.catch((error) => {
      this.options.log(
        `Agent hook queue ended with an error while stopping: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private accept(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST' || request.url !== '/events') {
      drain(request);
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }

    if (!this.hasValidToken(request)) {
      this.options.log(
        `Rejected agent hook request with invalid token from ${request.socket.remoteAddress ?? 'unknown'}.`
      );
      drain(request);
      sendJson(response, 401, { error: 'Invalid token.' });
      return;
    }

    const body = readBody(request);
    const process = async (): Promise<void> => {
      try {
        const text = await body;
        const parsed = parseAgentHookEvent(JSON.parse(text) as unknown);
        await this.options.onEvent(parsed);
        sendJson(response, 202, { accepted: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log(`Rejected agent hook event: ${message}`);
        sendJson(response, 400, { error: message });
      }
    };

    // Enqueue at request arrival, before awaiting the body, so concurrent
    // senders are processed in the same order the HTTP server observes them.
    this.queue = this.queue.then(process, process);
  }

  private hasValidToken(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    const header = request.headers['x-codefold-token'];
    const candidate = bearer ?? (Array.isArray(header) ? header[0] : header);
    if (!candidate) {
      return false;
    }
    const expectedBuffer = Buffer.from(this.token);
    const candidateBuffer = Buffer.from(candidate);
    return expectedBuffer.length === candidateBuffer.length &&
      timingSafeEqual(expectedBuffer, candidateBuffer);
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Agent hook request body exceeds 256 KiB.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new Error('Agent hook request body is empty.');
  }
  return Buffer.concat(chunks).toString('utf8');
}

function drain(request: IncomingMessage): void {
  request.resume();
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
