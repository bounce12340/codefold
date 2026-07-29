import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const commandHandlers = new Map<string, () => Promise<void>>();
  let panelDispose: (() => void) | undefined;
  let openOnStartup = false;
  const outputLines: string[] = [];

  return {
    commandHandlers,
    outputLines,
    start: vi.fn(async () => ({
      host: '127.0.0.1' as const,
      port: 49152,
      token: 'test-token',
      url: 'http://127.0.0.1:49152/events'
    })),
    stop: vi.fn(async () => undefined),
    setOpenOnStartup(value: boolean) {
      openOnStartup = value;
    },
    getOpenOnStartup() {
      return openOnStartup;
    },
    setPanelDispose(callback: () => void) {
      panelDispose = callback;
    },
    disposePanel() {
      panelDispose?.();
    },
    resetPanelDispose() {
      panelDispose = undefined;
    }
  };
});

vi.mock('vscode', () => {
  const disposable = { dispose: vi.fn() };
  const uri = (value: string) => ({
    fsPath: value,
    scheme: 'file',
    toString: () => value
  });

  return {
    commands: {
      registerCommand: vi.fn((command: string, handler: () => Promise<void>) => {
        mocks.commandHandlers.set(command, handler);
        return disposable;
      }),
      executeCommand: vi.fn(async (command: string) => {
        await mocks.commandHandlers.get(command)?.();
      })
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: (message: string) => mocks.outputLines.push(message),
        show: vi.fn(),
        dispose: vi.fn()
      })),
      createStatusBarItem: vi.fn(() => ({
        name: '',
        command: '',
        text: '',
        tooltip: '',
        show: vi.fn(),
        dispose: vi.fn()
      })),
      createWebviewPanel: vi.fn(() => {
        const webview = {
          asWebviewUri: (value: unknown) => value,
          cspSource: 'test-csp',
          html: '',
          onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
          postMessage: vi.fn(async () => true)
        };
        return {
          webview,
          onDidDispose: vi.fn((callback: () => void) => {
            mocks.setPanelDispose(callback);
            return disposable;
          }),
          reveal: vi.fn(),
          dispose: vi.fn()
        };
      }),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn()
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: vi.fn(() => ({
        get: (key: string, fallback: unknown) => (
          key === 'openOnStartup' ? mocks.getOpenOnStartup() : fallback
        )
      }))
    },
    languages: {
      getDiagnostics: vi.fn(() => []),
      onDidChangeDiagnostics: vi.fn(() => disposable)
    },
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { Beside: 2 },
    Uri: {
      file: uri,
      joinPath: (base: { fsPath: string }, ...parts: string[]) => (
        uri([base.fsPath, ...parts].join('/'))
      )
    },
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3
    },
    FileSystemError: class FileSystemError extends Error {
      code = 'Unknown';
    }
  };
});

vi.mock('../src/agents/hookServer', () => ({
  AgentHookServer: class AgentHookServer {
    start = mocks.start;
    stop = mocks.stop;
  }
}));

import { activate, deactivate } from '../src/extension';

function createContext() {
  return {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    extensionUri: {
      fsPath: 'C:/extension',
      scheme: 'file',
      toString: () => 'C:/extension'
    }
  };
}

async function runCommand(command: 'codefold.open' | 'codefold.open3d'): Promise<void> {
  const handler = mocks.commandHandlers.get(command);
  if (!handler) {
    throw new Error(`Command was not registered: ${command}`);
  }
  await handler();
}

beforeEach(async () => {
  await deactivate();
  mocks.commandHandlers.clear();
  mocks.outputLines.length = 0;
  mocks.start.mockClear();
  mocks.stop.mockClear();
  mocks.setOpenOnStartup(false);
  mocks.resetPanelDispose();
});

describe('extension agent hook lifecycle', () => {
  it('does not start the hook server during activation when openOnStartup is false', async () => {
    await activate(createContext() as never);

    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('starts the hook server and logs its credentials when the 2D open command runs', async () => {
    await activate(createContext() as never);
    await runCommand('codefold.open');

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.outputLines).toContain(
      'Agent hook endpoint: http://127.0.0.1:49152/events'
    );
    expect(mocks.outputLines).toContain('Agent hook token: test-token');
  });

  it('starts the hook server when the 3D open command runs first', async () => {
    await activate(createContext() as never);

    await runCommand('codefold.open3d');

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.outputLines).toContain(
      'Agent hook endpoint: http://127.0.0.1:49152/events'
    );
  });

  it('starts the hook server once across repeated 2D and 3D open commands', async () => {
    await activate(createContext() as never);

    await Promise.all([
      runCommand('codefold.open'),
      runCommand('codefold.open'),
      runCommand('codefold.open3d')
    ]);

    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('keeps the hook server running after the canvas closes', async () => {
    await activate(createContext() as never);
    await runCommand('codefold.open');

    mocks.disposePanel();

    expect(mocks.stop).not.toHaveBeenCalled();
    await runCommand('codefold.open');
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('stops the hook server when the extension deactivates', async () => {
    await activate(createContext() as never);
    await runCommand('codefold.open');

    await deactivate();

    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('starts the hook server while automatically opening the 2D canvas', async () => {
    mocks.setOpenOnStartup(true);

    await activate(createContext() as never);

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  });
});
