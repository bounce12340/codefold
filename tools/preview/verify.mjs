import { spawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    ['state-passing', 'dark'],
    ['verifying', 'dark'],
    ['passing', 'dark'],
    ['test-failure', 'dark'],
    ['test-mixed', 'dark'],
    ['status-colors', 'dark'],
    ['status-colors', 'light'],
    ['functions', 'dark'],
    ['diagnostics', 'dark'],
    ['diagnostics-warning', 'dark'],
    ['diagnostics-multi-source', 'dark'],
    ['agent-report', 'dark'],
    ['all-error-sources', 'dark'],
    ['status-bar-summary', 'dark'],
    ['multi-agent-lifecycle', 'dark', 'active'],
    ['multi-agent-lifecycle', 'dark', 'done'],
    ['coverage-gap', 'dark'],
    ['coverage-gap', 'light']
  ];
  const results = [];
  let baselinePositions;
  for (const [scenarioId, theme, step] of scenarios) {
    const resultId = `${scenarioId}-${theme}${step ? `-${step}` : ''}`;
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
          + (step ? `&step=${step}` : '')
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
      || scenarioId.startsWith('diagnostics')
      || scenarioId === 'verifying'
      || scenarioId === 'passing'
      || scenarioId.startsWith('test-')
      || scenarioId === 'agent-report'
      || scenarioId === 'all-error-sources'
      || scenarioId === 'status-bar-summary'
      || scenarioId === 'multi-agent-lifecycle'
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
  const override = process.env.CODEFOLD_PREVIEW_BROWSER;
  if (override) {
    if (await isExecutable(override)) {
      return override;
    }
    throw new Error(
      `CODEFOLD_PREVIEW_BROWSER is set to ${override}, but no executable is readable there.`
    );
  }
  for (const candidate of browserCandidates()) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'Could not find Chrome, Chromium, or Edge for preview verification on '
    + `${process.platform}. Install one of them, or set CODEFOLD_PREVIEW_BROWSER `
    + 'to the absolute path of a Chromium-based executable.'
  );
}

function browserCandidates() {
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ...executablesOnPath(['google-chrome', 'chromium'])
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    ...executablesOnPath([
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge'
    ])
  ];
}

function executablesOnPath(names) {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((entry) => names.map((name) => path.join(entry, name)));
}

async function isExecutable(candidate) {
  try {
    // X_OK falls back to an existence check on Windows, which is what we want
    // there — the candidate list is already made of concrete .exe paths.
    await access(candidate, constants.X_OK);
    return true;
  } catch (error) {
    if (isMissing(error) || error?.code === 'EACCES' || error?.code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
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
  const countFunctionState = (state) =>
    functionCards.filter(({ classes }) => classes.includes(`node-state-${state}`)).length;
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
    diagnosticEntries: elementsWithClass(html, 'diagnostic-entry').length,
    diagnosticText: textById(html, 'node-diagnostics'),
    testFailureEntries: elementsWithClass(html, 'test-failure-entry').length,
    testFailureText: textById(html, 'node-test-failures'),
    agentReportEntries: elementsWithClass(html, 'agent-report-entry').length,
    agentReportText: textById(html, 'node-agent-reports'),
    errorSourceEntries: elementsWithClass(html, 'error-source-chip').length,
    errorSourceText: textById(html, 'node-error-source-list'),
    statusSummaryText: textById(html, 'state-summary'),
    selectedState: textById(html, 'node-state'),
    selectedErrorSources: textById(html, 'node-errors'),
    editing: countState('editing'),
    dirty: countState('dirty'),
    error: countState('error'),
    passing: countState('passing'),
    verifying: countState('verifying'),
    idle: countState('idle'),
    functionError: countFunctionState('error'),
    functionVerifying: countFunctionState('verifying'),
    passingGroups: groups.filter(({ classes }) =>
      classes.includes('test-run-passing')
    ).length,
    flowNodes: [...fileCards, ...functionCards].filter(({ classes }) =>
      classes.includes('test-flow-active')
    ).length,
    flowEdges: elementsWithClass(html, 'test-flow-edge').length
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

function textById(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(
    new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*\\bid="${escapedId}"[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i')
  );
  return (match?.[2] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
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
    case 'state-passing':
      assert(summary.passing === 1, 'passing card missing');
      break;
    case 'verifying':
      assert(summary.expandedGroups >= 2, 'verifying path did not expand its groups');
      assert(
        summary.verifying >= 1 && summary.functionVerifying >= 3,
        'verifying file/function states are incomplete'
      );
      assert(summary.flowNodes >= 4, 'ordered flow node classes are missing');
      assert(summary.flowEdges >= 2, 'flow did not illuminate visible edges');
      assert(
        summary.metrics.stateCards.verifying.borderColor
        === summary.metrics.stateCards.verifying.lampColor,
        'verifying glow does not reuse the neutral state color'
      );
      break;
    case 'passing':
      assert(summary.expandedGroups === 0, 'passing groups did not fold');
      assert(summary.fileCards === 0, 'passing file cards remain expanded');
      assert(summary.passingGroups === 2, 'covered groups are not marked passing');
      assert(summary.metrics.testRun.passingGroups === 2, 'passing metric is incomplete');
      break;
    case 'test-failure':
      assert(summary.expandedGroups === 1, 'failed path did not stay expanded');
      assert(
        summary.error === 1 && summary.functionError === 1,
        'failed file/function nodes are not red'
      );
      assert(summary.testFailureEntries === 1, 'test failure sidebar entry missing');
      assert(
        summary.testFailureText.includes('test: panel renders state')
        && summary.testFailureText.includes('AssertionError')
        && summary.testFailureText.includes('renderPanel'),
        'test name or stack trace is missing'
      );
      break;
    case 'test-mixed':
      assert(
        summary.passing === 1 && summary.error === 1,
        'mixed green/red states are not both visible'
      );
      assert(summary.expandedGroups === 2, 'mixed result groups are not both visible');
      assert(summary.testFailureEntries === 1, 'runtime failure detail is missing');
      assert(
        summary.testFailureText.includes('runtime: test_extracts_functions')
        && summary.testFailureText.includes('RuntimeError'),
        'runtime source or stack trace is missing'
      );
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
      assertDistinctShapes(summary, ['editing', 'dirty', 'error', 'passing']);
      for (const state of ['editing', 'dirty', 'error', 'passing']) {
        assert(
          summary.metrics.stateCards[state].cardLabel.includes(`state ${state}`),
          `${summary.metrics.theme} ${state}: card aria-label does not carry the state`
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
    case 'diagnostics':
      assert(summary.error === 1, 'diagnostic Error did not mark the file red');
      assert(summary.functionError === 1, 'diagnostic Error did not mark the function red');
      assert(summary.diagnosticEntries === 1, 'diagnostic details are missing');
      assert(
        summary.diagnosticText.includes('tsc · error')
        && summary.diagnosticText.includes("Type 'string' is not assignable"),
        'diagnostic source or message is missing'
      );
      assert(summary.selectedState === 'error', 'diagnostic function is not selected as error');
      assert(
        summary.metrics.stateCards.error.animationName.includes('error'),
        'diagnostic Error card is not using the red error animation'
      );
      break;
    case 'diagnostics-warning':
      assert(summary.error === 0, 'Warning incorrectly marked a file red');
      assert(summary.functionError === 0, 'Warning incorrectly marked a function red');
      assert(summary.diagnosticEntries === 1, 'Warning details are missing');
      assert(
        summary.diagnosticText.includes('eslint · warning'),
        'Warning source and severity are missing'
      );
      assert(summary.selectedState === 'idle', 'Warning changed the node state');
      break;
    case 'diagnostics-multi-source':
      assert(summary.error === 1 && summary.editing === 0, 'Error did not outrank editing');
      assert(summary.badges === 1, 'Editing agent badge is missing from the error card');
      assert(summary.diagnosticEntries === 1, 'Multi-source diagnostic details are missing');
      assert(
        summary.selectedErrorSources.includes('diagnostic')
        && summary.selectedErrorSources.includes('agent'),
        'Multiple errorSources were not preserved'
      );
      assert(summary.selectedState === 'error', 'Multi-source node did not resolve to error');
      break;
    case 'agent-report':
      assert(
        summary.error === 1 && summary.functionError === 1,
        'agent report did not mark its file and function red'
      );
      assert(summary.agentReportEntries === 1, 'agent report detail is missing');
      assert(
        summary.agentReportText.includes('Codex reviewer (codex-reviewer)')
        && summary.agentReportText.includes('request body length'),
        'agent report attribution or message is missing'
      );
      assert(
        summary.errorSourceText.includes('agent — Agent report'),
        'agent source label is missing'
      );
      break;
    case 'all-error-sources':
      assert(summary.errorSourceEntries === 4, 'not all four source chips are visible');
      for (const source of ['test', 'diagnostic', 'runtime', 'agent']) {
        assert(
          summary.errorSourceText.includes(source),
          `${source} source is not distinguished in the sidebar`
        );
      }
      assert(summary.diagnosticEntries === 1, 'diagnostic detail is missing');
      assert(summary.testFailureEntries === 2, 'test/runtime details are incomplete');
      assert(summary.agentReportEntries === 1, 'agent detail is missing');
      break;
    case 'status-bar-summary':
      assert(
        summary.statusSummaryText
        === '2 agents active · 2 editing · 1 errors · 2 passing',
        'status summary counts are incorrect'
      );
      assert(summary.metrics.phase5.flashDisabled, 'flash setting was not applied');
      assert(
        summary.metrics.phase5.editingAnimation === 'none'
        && summary.metrics.phase5.errorAnimation === 'none',
        'editing/error animation still runs while flashing is disabled'
      );
      // With flashing off the animation difference is gone, so shape is the
      // only non-colour cue left. This is the regression that made red and
      // green indistinguishable to colour-blind viewers.
      assertDistinctShapes(summary, ['editing', 'error', 'passing']);
      break;
    case 'multi-agent-lifecycle':
      assert(
        summary.rootAgents === 1 && summary.nestedAgents === 2,
        'main agent and two subagents are not nested'
      );
      if (summary.metrics.phase5.step === 'done') {
        assert(summary.badges === 0, 'agent_done left node badges behind');
        assert(summary.metrics.phase5.doneAgents === 3, 'done statuses are incomplete');
        assert(
          summary.statusSummaryText
          === '0 agents active · 0 editing · 0 errors · 0 passing',
          'completed lifecycle summary is incorrect'
        );
      } else {
        assert(summary.badges === 2, 'parallel subagent badges are missing');
        assert(summary.expandedGroups >= 2, 'parallel subagent groups did not expand');
        assert(
          summary.statusSummaryText
          === '3 agents active · 2 editing · 0 errors · 0 passing',
          'active lifecycle summary is incorrect'
        );
      }
      break;
    case 'coverage-gap': {
      const coverage = summary.metrics.coverage;
      assert(coverage.gapCards === 2, 'both dark-zone cards are not rendered');
      assert(
        summary.error === 2 || summary.error + summary.functionError >= 2,
        'dark-zone scenario lost the error state it shares with the lit card'
      );
      // Same state on both sides, so any visual difference is the overlay.
      assert(
        Number.parseFloat(coverage.gapOpacity) < Number.parseFloat(coverage.litOpacity),
        `dark zone is not dimmer than a covered card `
        + `(${coverage.gapOpacity} vs ${coverage.litOpacity})`
      );
      assert(
        coverage.gapBorderStyle.includes('dashed')
        && !coverage.litBorderStyle.includes('dashed'),
        'dark zone is not distinguishable by border style'
      );
      assert(
        coverage.gapLabels.length === 2
        && coverage.gapLabels.every((label) => label.includes('not covered by tests')),
        `dark-zone cards do not announce the gap: ${JSON.stringify(coverage.gapLabels)}`
      );
      break;
    }
    default:
      throw new Error(`Unexpected preview scenario: ${summary.scenario}`);
  }
}

// PROMPT.md requires red/green to differ by shape or icon, not colour alone.
// Compares the colour-independent lamp signature across the given states.
function assertDistinctShapes(summary, states) {
  const shapes = new Map();
  for (const state of states) {
    const metrics = summary.metrics.stateCards[state];
    assert(metrics, `${summary.scenario}: ${state} card is missing from the scenario`);
    const shape = metrics.lampShape;
    assert(
      shape && !shape.startsWith('/'),
      `${summary.scenario}: ${state} lamp shape could not be measured`
    );
    const clash = shapes.get(shape);
    assert(
      clash === undefined,
      `${summary.scenario}: ${state} and ${clash} share the lamp shape ${shape}, `
      + 'so they are separable by colour alone'
    );
    shapes.set(shape, state);
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
