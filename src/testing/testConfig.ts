import type { SupportedLanguage } from '../scanner/model';

export const DEFAULT_RUN_TESTS_ON_SAVE = false;
export const DEFAULT_JAVASCRIPT_COVERAGE_FILE =
  'coverage/coverage-final.json';
export const DEFAULT_PYTHON_COVERAGE_FILE = 'coverage.json';

export interface TestSettingsValues {
  runTestsOnSave?: boolean;
  javascriptCommand?: string;
  pythonCommand?: string;
  javascriptCoverageFile?: string;
  pythonCoverageFile?: string;
}

export interface TestSettings {
  runTestsOnSave: boolean;
  javascriptCommand: string;
  pythonCommand: string;
  javascriptCoverageFile: string;
  pythonCoverageFile: string;
}

export interface TestCommandPlan {
  language: 'javascript' | 'python';
  command: string;
  afterCommand?: string;
  coverageFile: string;
}

export function resolveTestSettings(
  values: TestSettingsValues = {}
): TestSettings {
  return {
    runTestsOnSave: values.runTestsOnSave ?? DEFAULT_RUN_TESTS_ON_SAVE,
    javascriptCommand: values.javascriptCommand?.trim() ?? '',
    pythonCommand: values.pythonCommand?.trim() ?? '',
    javascriptCoverageFile:
      values.javascriptCoverageFile?.trim() || DEFAULT_JAVASCRIPT_COVERAGE_FILE,
    pythonCoverageFile:
      values.pythonCoverageFile?.trim() || DEFAULT_PYTHON_COVERAGE_FILE
  };
}

export function createTestCommandPlans(
  settings: TestSettings,
  languages: ReadonlySet<SupportedLanguage>,
  packageJson: unknown
): TestCommandPlan[] {
  const plans: TestCommandPlan[] = [];
  if (languages.has('ts') || languages.has('js')) {
    plans.push({
      language: 'javascript',
      command: settings.javascriptCommand
        || defaultJavascriptCommand(packageJson),
      coverageFile: settings.javascriptCoverageFile
    });
  }
  if (languages.has('py')) {
    plans.push({
      language: 'python',
      command: settings.pythonCommand
        || 'python -m coverage run -m pytest',
      afterCommand: settings.pythonCommand
        ? undefined
        : `python -m coverage json -o "${settings.pythonCoverageFile}"`,
      coverageFile: settings.pythonCoverageFile
    });
  }
  return plans;
}

function defaultJavascriptCommand(packageJson: unknown): string {
  const packages = packageNames(packageJson);
  if (packages.has('jest')) {
    return 'npx --no-install jest --coverage --coverageReporters=json';
  }
  return 'npx --no-install vitest run --coverage --coverage.reporter=json';
}

function packageNames(value: unknown): Set<string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return new Set();
  }
  const result = new Set<string>();
  for (const key of ['dependencies', 'devDependencies']) {
    const record = key in value
      ? (value as Record<string, unknown>)[key]
      : undefined;
    if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
      for (const name of Object.keys(record)) {
        result.add(name);
      }
    }
  }
  return result;
}
