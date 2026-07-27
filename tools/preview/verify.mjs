import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const previewDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(previewDirectory, '..', '..');
const temporaryRoot = path.join(rootDirectory, '.tmp');
await mkdir(temporaryRoot, { recursive: true });
const browserProfile = await mkdtemp(path.join(temporaryRoot, 'preview-browser-'));
const browserExecutable = await findBrowser();

let previewProcess;
try {
  const preview = await startPreviewServer();
  previewProcess = preview.process;
  console.log(`Preview server ready at ${preview.url}.`);
  const scenarios = [
    ['clean', 'dark'],
    ['editing', 'dark'],
    ['dirty', 'dark'],
    ['parallel', 'dark'],
    ['conflict', 'dark'],
    ['hierarchy', 'dark'],
    ['error', 'dark'],
    ['passing', 'dark'],
    ['status-colors', 'dark'],
    ['status-colors', 'light'],
    ['functions', 'dark']
  ];
  const results = [];
  let baselinePositions;
  for (const [scenarioId, theme] of scenarios) {
    const resultId = `${scenarioId}-${theme}`;
    const profile = path.join(browserProfile, resultId);
    await mkdir(profile, { recursive: true });
    const browserResult = await runBrowser(
      browserExecutable,
      [
        '--headless=new',
        '--disable-gpu',
        '--disable-gpu-sandbox',
        '--disable-software-rasterizer',
        '--no-sandbox',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-logging=stderr',
        '--log-level=0',
        '--dump-dom',
        '--virtual-time-budget=1000',
        `--user-data-dir=${profile}`,
        `${preview.url}?scenario=${scenarioId}&theme=${theme}`
      ]
    );
    if (browserResult.exitCode !== 0) {
      throw new Error(
        `${scenarioId}: browser exited ${browserResult.exitCode}: ${browserResult.stderr}`
      );
    }
    const browserErrors = browserResult.stderr
      .split(/\r?\n/)
      .filter((line) => /\bCONSOLE\b.*\b(error|assert)\b/i.test(line));
    assert(browserErrors.length === 0, `${scenarioId}: console errors: ${browserErrors}`);
    const summary = summarizeDom(browserResult.stdout);
    assertScenario(summary);
    if (!baselinePositions) {
      baselinePositions = summary.groupPositions;
    } else {
      assertEqual(
        summary.groupPositions,
        baselinePositions,
        `${scenarioId}: existing group x/y transforms changed`
      );
    }
    results.push(summary);
    console.log(
      `${resultId}: groups=${summary.expandedGroups}, cards=${summary.fileCards}, `
      + `functions=${summary.functionCards}, badges=${summary.badges}, `
      + `conflicts=${summary.conflictCards}`
    );
    if (
      scenarioId === 'editing'
      || scenarioId === 'dirty'
      || scenarioId === 'status-colors'
      || scenarioId === 'functions'
    ) {
      console.log(`${resultId}-metrics: ${JSON.stringify(summary.metrics)}`);
    }
  }
  console.log(
    `Verified ${results.length} scenarios in ${path.basename(browserExecutable)}; `
    + 'browserExitCodes=0, consoleErrors=0.'
  );
} finally {
  previewProcess?.kill();
  await rm(browserProfile, { recursive: true, force: true });
}

async function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
  throw new Error('Could not find Microsoft Edge or Google Chrome for preview verification.');
}

async function startPreviewServer() {
  const child = spawn(
    process.execPath,
    [path.join(previewDirectory, 'serve.mjs'), '--port=0'],
    {
      cwd: rootDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = output.match(/CodeFold preview: (http:\/\/127\.0\.0\.1:\d+\/tools\/preview\/)/);
    if (match) {
      return { process: child, url: match[1] };
    }
    if (child.exitCode !== null) {
      throw new Error(`Preview server exited early: ${errors || output}`);
    }
    await delay(50);
  }
  child.kill();
  throw new Error(`Timed out starting preview server: ${errors || output}`);
}

async function runBrowser(executable, arguments_) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: rootDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for the headless browser DOM dump.'));
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function summarizeDom(html) {
  const fileCards = elementsWithClass(html, 'file-card');
  const functionCards = elementsWithClass(html, 'function-card');
  const badges = elementsWithClass(html, 'agent-badge');
  const groups = elementsWithClass(html, 'folder-group');
  const hierarchy = summarizeAgentHierarchy(html);
  const htmlTag = html.match(/<html\b[^>]*>/)?.[0] ?? '';
  const encodedMetrics = attributeValue(htmlTag, 'data-preview-metrics');
  const countState = (state) =>
    fileCards.filter(({ classes }) => classes.includes(`node-state-${state}`)).length;
  return {
    scenario: attributeValue(htmlTag, 'data-preview-scenario'),
    metrics: encodedMetrics === ''
      ? null
      : JSON.parse(Buffer.from(encodedMetrics, 'base64').toString('utf8')),
    expandedGroups: groups.filter(({ classes }) => classes.includes('expanded')).length,
    groupPositions: Object.fromEntries(groups.map(({ tag }) => [
      attributeValue(tag, 'data-group-id'),
      attributeValue(tag, 'style').match(/transform:\s*([^;]+)/)?.[1] ?? ''
    ])),
    fileCards: fileCards.length,
    functionCards: functionCards.length,
    callEdges: elementsWithClass(html, 'dependency')
      .filter(({ classes }) => classes.includes('call')).length,
    badges: badges.length - hierarchy.roots - hierarchy.nested,
    badgeTones: badges.map(({ classes }) =>
      classes.find((name) => name.startsWith('tone-'))
    ),
    conflictCards: [...fileCards, ...functionCards]
      .filter(({ classes }) => classes.includes('node-conflict')).length,
    conflictText: html.includes('Potential conflicts') ? 'Potential conflicts' : '',
    nestedAgents: hierarchy.nested,
    rootAgents: hierarchy.roots,
    editing: countState('editing'),
    dirty: countState('dirty'),
    error: countState('error'),
    passing: countState('passing')
  };
}

function elementsWithClass(html, className) {
  const elements = [];
  for (const match of html.matchAll(/<[^>]+\bclass="([^"]*)"[^>]*>/g)) {
    const classes = match[1].split(/\s+/).filter(Boolean);
    if (classes.includes(className)) {
      elements.push({ tag: match[0], classes });
    }
  }
  return elements;
}

function attributeValue(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tag.match(new RegExp(`\\b${escapedName}="([^"]*)"`))?.[1] ?? '';
}

function summarizeAgentHierarchy(html) {
  const start = html.indexOf('<ul id="agent-tree"');
  if (start < 0) {
    return { roots: 0, nested: 0 };
  }
  let depth = 0;
  let roots = 0;
  let nested = 0;
  for (const match of html.slice(start).matchAll(/<ul\b[^>]*>|<\/ul>|<li\b[^>]*\bclass="([^"]*)"[^>]*>/g)) {
    const token = match[0];
    if (token.startsWith('<ul')) {
      depth += 1;
      continue;
    }
    if (token === '</ul>') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      continue;
    }
    if ((match[1] ?? '').split(/\s+/).includes('agent-entry')) {
      if (depth === 1) {
        roots += 1;
      } else if (depth > 1) {
        nested += 1;
      }
    }
  }
  return { roots, nested };
}

function assertScenario(summary) {
  assert(summary.metrics !== null, `${summary.scenario}: visual metrics missing`);
  switch (summary.scenario) {
    case 'clean':
      assert(summary.expandedGroups === 0 && summary.fileCards === 0, 'clean is not folded');
      break;
    case 'editing':
      assert(summary.expandedGroups === 1 && summary.editing === 1, 'editing did not expand');
      assert(
        summary.metrics.stateCards.editing.borderWidth === '2px',
        'editing does not have the strong static border'
      );
      break;
    case 'dirty':
      assert(summary.expandedGroups === 1 && summary.dirty === 1, 'dirty state missing');
      assert(
        summary.metrics.stateCards.dirty.borderWidth === '1px 1px 1px 4px',
        'dirty does not have the asymmetric static rail'
      );
      assert(
        summary.metrics.stateCards.dirty.lampWidth === '12px'
        && summary.metrics.stateCards.dirty.lampHeight === '5px',
        'dirty does not have the distinct bar lamp'
      );
      break;
    case 'parallel':
      assert(summary.expandedGroups >= 2, 'parallel groups did not both expand');
      assert(summary.badges === 2, 'parallel badges missing');
      assert(new Set(summary.badgeTones).size === 2, 'parallel tones are not distinct');
      assert(summary.rootAgents === 2, 'parallel agents are not separate roots');
      break;
    case 'conflict':
      assert(summary.badges === 2 && summary.conflictCards === 1, 'conflict markers missing');
      assert(summary.conflictText.includes('Potential conflicts'), 'conflict sidebar text missing');
      break;
    case 'hierarchy':
      assert(summary.nestedAgents === 1 && summary.rootAgents === 1, 'agent hierarchy is not nested');
      break;
    case 'error':
      assert(summary.error === 1, 'error card missing');
      break;
    case 'passing':
      assert(summary.passing === 1, 'passing card missing');
      break;
    case 'status-colors':
      assert(
        summary.editing === 1
        && summary.dirty === 1
        && summary.error === 1
        && summary.passing === 1,
        'four-state comparison is incomplete'
      );
      for (const state of ['editing', 'dirty', 'error', 'passing']) {
        const metrics = summary.metrics.stateCards[state];
        assert(
          contrastRatio(metrics.borderColor, metrics.backgroundColor) >= 3,
          `${summary.metrics.theme} ${state}: border contrast is below 3:1`
        );
      }
      break;
    case 'functions':
      assert(summary.functionCards >= 3, 'function cards missing');
      assert(summary.callEdges >= 1, 'function call edges missing');
      assert(
        summary.metrics.functions.ownerLabels.every((label) => label === 'panel.ts ›'),
        'function owner labels missing'
      );
      assert(
        Number.parseFloat(summary.metrics.functions.containsStrokeWidth) >= 2,
        'contains edges are too thin'
      );
      assert(
        summary.metrics.functions.parentToFirstGap < 100,
        'function panel is too far from its owner'
      );
      assert(
        maxDuration(summary.metrics.functions.functionTransitionDuration) <= 0.3
        && maxDuration(summary.metrics.functions.groupTransitionDuration) <= 0.3,
        'function expansion geometry exceeds 300ms'
      );
      break;
    default:
      throw new Error(`Unexpected preview scenario: ${summary.scenario}`);
  }
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(parseCssColor(foreground));
  const backgroundLuminance = relativeLuminance(parseCssColor(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssColor(value) {
  const rgb = value.match(/^rgb\(([\d.]+),?\s+([\d.]+),?\s+([\d.]+)\)$/);
  if (rgb) {
    return rgb.slice(1).map(Number);
  }
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb) {
    return srgb.slice(1).map((component) => Number(component) * 255);
  }
  throw new Error(`Unsupported computed color: ${value}`);
}

function relativeLuminance(rgb) {
  const [red, green, blue] = rgb.map((component) => {
    const value = component / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function maxDuration(value) {
  return Math.max(...value.split(',').map((duration) => {
    const trimmed = duration.trim();
    return trimmed.endsWith('ms')
      ? Number.parseFloat(trimmed) / 1000
      : Number.parseFloat(trimmed);
  }));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify({ actual, expected })}`);
  }
}

function isMissing(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
