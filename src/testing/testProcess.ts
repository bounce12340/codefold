import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface CommandResult {
  exitCode: number;
  output: string;
}

export function executeTestCommand(
  command: string,
  cwd: string
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      }
    });
    let output = '';
    let capturedBytes = 0;
    let overflowed = false;
    const capture = (chunk: Buffer): void => {
      if (overflowed) {
        return;
      }
      capturedBytes += chunk.byteLength;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (overflowed) {
        reject(new Error(
          `Test command output exceeded ${MAX_CAPTURE_BYTES / 1024 / 1024} MiB.`
        ));
        return;
      }
      resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}
