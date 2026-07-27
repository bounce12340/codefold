import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreviewHarness } from './build.mjs';

const previewDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(previewDirectory, '..', '..');
const requestedPort = Number(
  process.argv.find((argument) => argument.startsWith('--port='))
    ?.slice('--port='.length)
  ?? process.env.PORT
  ?? 4173
);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error(`Invalid preview port: ${requestedPort}`);
}

await buildPreviewHarness(rootDirectory);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (
      pathname === '/'
      || pathname === '/tools/preview'
      || pathname === '/tools/preview/'
    ) {
      pathname = '/tools/preview/index.html';
    }
    const absolutePath = path.resolve(rootDirectory, `.${pathname}`);
    if (
      absolutePath !== rootDirectory
      && !absolutePath.startsWith(`${rootDirectory}${path.sep}`)
    ) {
      send(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
      return;
    }
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    const body = await readFile(absolutePath);
    send(response, 200, contentType(absolutePath), body);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
    if (code === 'ENOENT') {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    console.error(`Preview request failed: ${formatError(error)}`);
    send(response, 500, 'text/plain; charset=utf-8', 'Internal server error');
  }
});

server.on('clientError', (error, socket) => {
  console.error(`Preview client error: ${error.message}`);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  console.log(`CodeFold preview: http://127.0.0.1:${port}/tools/preview/?scenario=clean`);
});

function send(response, statusCode, type, body) {
  response.writeHead(statusCode, {
    'content-type': type,
    'cache-control': 'no-store'
  });
  response.end(body);
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
