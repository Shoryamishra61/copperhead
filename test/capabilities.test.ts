import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Command } from 'commander';
import {
  COPPERHEAD_RUN_PROTOCOL,
  SUPPORTED_PROTOCOL_MAJOR,
  IMPLEMENTED_PROTOCOL_FEATURES,
  CANONICAL_PUBLIC_COMMANDS,
  collectCapabilities,
  isProtocolCompatible,
  assertProtocolCompatible,
  formatCapabilities,
  type CapabilityReport,
  type CapabilityDeps,
} from '../src/commands/capabilities.js';
import { runDoctor } from '../src/commands/doctor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_CLI = path.join(ROOT, 'dist', 'cli.js');
const SRC_CLI = path.join(ROOT, 'src', 'cli.ts');

describe('protocol constant and version semantics', () => {
  it('defines the protocol identifier as copperhead-run/1', () => {
    expect(COPPERHEAD_RUN_PROTOCOL).toBe('copperhead-run/1');
    expect(SUPPORTED_PROTOCOL_MAJOR).toBe(1);
  });

  it('advertises an empty feature array in Phase 0 (truthfulness invariant)', () => {
    expect(IMPLEMENTED_PROTOCOL_FEATURES).toEqual([]);
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('event-stream');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('result-document');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('run-id');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('sigterm');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('stream-compat');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('findings');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('control');
  });

  it('accepts matching protocol major 1', () => {
    expect(isProtocolCompatible('copperhead-run/1')).toBe(true);
    expect(isProtocolCompatible('copperhead-run/1.0')).toBe(true);
    expect(isProtocolCompatible('copperhead-run/1.4')).toBe(true);
  });

  it('rejects unknown protocol major or non-matching protocol strings', () => {
    expect(isProtocolCompatible('copperhead-run/2')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/0')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/3.0')).toBe(false);
    expect(isProtocolCompatible('other-protocol/1')).toBe(false);
    expect(isProtocolCompatible('')).toBe(false);
    expect(isProtocolCompatible('copperhead-run')).toBe(false);
  });

  it('assertProtocolCompatible accepts valid report and rejects unknown major', () => {
    const validReport: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
      commands: ['check', 'do'],
      features: [],
      tools: {
        kicadCli: '9.0.1',
        git: '2.43.0',
        openspec: '1.6.0',
        node: process.version,
      },
    };

    expect(() => assertProtocolCompatible(validReport, 1)).not.toThrow();

    expect(() =>
      assertProtocolCompatible({ ...validReport, protocol: 'copperhead-run/2' }, 1),
    ).toThrow(/unsupported protocol version/i);

    expect(() =>
      assertProtocolCompatible({ ...validReport, protocol: 'copperhead-run/99' }, 1),
    ).toThrow(/unsupported protocol version/i);

    expect(() =>
      assertProtocolCompatible({ ...validReport, protocol: 'unknown-protocol/1' }, 1),
    ).toThrow(/unsupported protocol version/i);
  });

  it('consumer compatibility ignores unknown added JSON fields (extensibility)', () => {
    const extendedReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
      commands: ['check', 'do'],
      features: [],
      tools: {
        kicadCli: null,
        git: null,
        openspec: null,
        node: process.version,
      },
      futureField: 'additive-payload',
      experimentalTelemetry: { active: false },
    };

    expect(() => assertProtocolCompatible(extendedReport, 1)).not.toThrow();
  });
});

describe('collectCapabilities with dependency injection', () => {
  it('returns well-formed schema when all tools report versions', async () => {
    const mockDeps: CapabilityDeps = {
      nodeVersion: 'v20.19.0',
      cliVersion: '0.11.0',
      kicadVersion: async () => '9.0.1',
      gitVersion: async () => '2.43.0',
      openspecVersion: async () => '1.6.0',
    };

    const report = await collectCapabilities({ deps: mockDeps, commands: ['check', 'do'] });

    expect(report).toEqual({
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
      commands: ['check', 'do'],
      features: [],
      tools: {
        kicadCli: '9.0.1',
        git: '2.43.0',
        openspec: '1.6.0',
        node: 'v20.19.0',
      },
    });
  });

  it('reports missing kicadCli as null without failing (missing KiCad test)', async () => {
    const mockDeps: CapabilityDeps = {
      nodeVersion: 'v20.19.0',
      cliVersion: '0.11.0',
      kicadVersion: async () => null,
      gitVersion: async () => '2.43.0',
      openspecVersion: async () => '1.6.0',
    };

    const report = await collectCapabilities({ deps: mockDeps, commands: ['check'] });
    expect(report.tools.kicadCli).toBeNull();
    expect(report.tools.git).toBe('2.43.0');
    expect(report.tools.openspec).toBe('1.6.0');
    expect(report.protocol).toBe('copperhead-run/1');
  });

  it('reports missing git as null without failing (missing Git test)', async () => {
    const mockDeps: CapabilityDeps = {
      nodeVersion: 'v20.19.0',
      cliVersion: '0.11.0',
      kicadVersion: async () => '9.0.1',
      gitVersion: async () => null,
      openspecVersion: async () => '1.6.0',
    };

    const report = await collectCapabilities({ deps: mockDeps, commands: ['check'] });
    expect(report.tools.git).toBeNull();
    expect(report.tools.kicadCli).toBe('9.0.1');
    expect(report.protocol).toBe('copperhead-run/1');
  });

  it('reports missing openspec as null without failing (missing OpenSpec test)', async () => {
    const mockDeps: CapabilityDeps = {
      nodeVersion: 'v20.19.0',
      cliVersion: '0.11.0',
      kicadVersion: async () => '9.0.1',
      gitVersion: async () => '2.43.0',
      openspecVersion: async () => null,
    };

    const report = await collectCapabilities({ deps: mockDeps, commands: ['check'] });
    expect(report.tools.openspec).toBeNull();
    expect(report.tools.kicadCli).toBe('9.0.1');
    expect(report.protocol).toBe('copperhead-run/1');
  });

  it('isolates probe exceptions and never leaks host paths or stack traces', async () => {
    const mockDeps: CapabilityDeps = {
      nodeVersion: 'v20.19.0',
      cliVersion: '0.11.0',
      kicadVersion: async () => {
        throw new Error('Command failed: /home/user/private/bin/kicad-cli (ENOENT)');
      },
      gitVersion: async () => {
        throw new Error('fatal: not a git repository');
      },
      openspecVersion: async () => {
        throw new Error('spawn openspec ENOENT');
      },
    };

    const report = await collectCapabilities({ deps: mockDeps, commands: ['check'] });
    expect(report.tools.kicadCli).toBeNull();
    expect(report.tools.git).toBeNull();
    expect(report.tools.openspec).toBeNull();
    expect(report.tools.node).toBe('v20.19.0');

    // Ensure no error strings leaked into JSON payload
    const jsonStr = JSON.stringify(report);
    expect(jsonStr).not.toContain('private');
    expect(jsonStr).not.toContain('ENOENT');
  });

  it('sorts commands deterministically across invocations', async () => {
    const mockDeps: CapabilityDeps = {
      nodeVersion: 'v20.19.0',
      cliVersion: '0.11.0',
    };

    const report1 = await collectCapabilities({
      deps: mockDeps,
      commands: ['sync', 'check', 'do', 'init', 'doctor'],
    });

    const report2 = await collectCapabilities({
      deps: mockDeps,
      commands: ['do', 'doctor', 'check', 'sync', 'init'],
    });

    expect(report1.commands).toEqual(['check', 'do', 'doctor', 'init', 'sync']);
    expect(report2.commands).toEqual(['check', 'do', 'doctor', 'init', 'sync']);
    expect(report1.commands).toEqual(report2.commands);
  });

  it('dynamically extracts public command names from a Commander program', async () => {
    const prog = new Command();
    prog.command('check').description('check command');
    prog.command('do').description('do command');
    prog.command('capabilities').description('capabilities command');

    const report = await collectCapabilities({ program: prog });
    expect(report.commands).toEqual(['capabilities', 'check', 'do']);
  });

  it('guarantees parity between canonical command catalog and default output', async () => {
    const report = await collectCapabilities();
    expect(report.commands).toEqual([...CANONICAL_PUBLIC_COMMANDS].sort());
    expect(report.commands).toContain('capabilities');
    expect(report.commands).toContain('check');
    expect(report.commands).toContain('create');
    expect(report.commands).toContain('demo');
    expect(report.commands).toContain('do');
    expect(report.commands).toContain('doctor');
    expect(report.commands).toContain('draft');
    expect(report.commands).toContain('export');
    expect(report.commands).toContain('init');
    expect(report.commands).toContain('mcp');
    expect(report.commands).toContain('repl');
    expect(report.commands).toContain('score');
    expect(report.commands).toContain('skill');
    expect(report.commands).toContain('sync');
  });
});

describe('formatCapabilities human output', () => {
  it('formats a clean summary for human consumption', () => {
    const report: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
      commands: ['check', 'do', 'create'],
      features: [],
      tools: {
        kicadCli: '9.0.1',
        git: '2.43.0',
        openspec: '1.6.0',
        node: 'v20.19.0',
      },
    };

    const formatted = formatCapabilities(report);
    expect(formatted).toContain('copperhead-run/1');
    expect(formatted).toContain('0.11.0');
    expect(formatted).toContain('check, do, create');
    expect(formatted).toContain('9.0.1');
    expect(formatted).toContain('2.43.0');
  });

  it('formats missing tools cleanly as not found / none', () => {
    const report: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
      commands: ['check'],
      features: [],
      tools: {
        kicadCli: null,
        git: null,
        openspec: null,
        node: 'v20.19.0',
      },
    };

    const formatted = formatCapabilities(report);
    expect(formatted).toContain('none');
  });
});

describe('doctor independence', () => {
  it('doctor remains independent and its report is unaffected by capabilities', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-doc-test-'));
    try {
      const report = await runDoctor({ repoRoot: scratchDir });
      expect(report).toHaveProperty('ok');
      expect(report).toHaveProperty('checks');
      expect(Array.isArray(report.checks)).toBe(true);
      const names = report.checks.map((c) => c.name);
      expect(names).toContain('node');
      expect(names).toContain('git');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

describe('real CLI process execution (published build and source entry point)', () => {
  it('node dist/cli.js capabilities --json produces valid JSON outside a repo with clean stderr', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-dist-cap-'));
    try {
      const res = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
        cwd: scratchDir,
        reject: false,
        env: {
          NO_COLOR: '1',
          PATH: process.env.PATH,
        },
      });

      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe('');

      const parsed = JSON.parse(res.stdout) as CapabilityReport;
      expect(parsed.protocol).toBe('copperhead-run/1');
      expect(parsed.cli).toMatch(/^\d+\.\d+\.\d+/);
      expect(parsed.commands).toContain('capabilities');
      expect(parsed.commands).toContain('check');
      expect(parsed.commands).toContain('do');
      expect(parsed.commands).toContain('doctor');
      expect(parsed.features).toEqual([]);
      expect(parsed.tools.node).toMatch(/^v\d+/);

      // Verify no repository artifacts or metadata created in working directory
      const files = await readdir(scratchDir);
      expect(files).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs cleanly without any model API keys or credentials in environment', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-cap-no-keys-'));
    try {
      const res = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
        cwd: scratchDir,
        reject: false,
        env: {
          NO_COLOR: '1',
          PATH: process.env.PATH,
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          COPPERHEAD_MODEL: '',
        },
      });

      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout) as CapabilityReport;
      expect(parsed.protocol).toBe('copperhead-run/1');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('shows capabilities in help output of published build', async () => {
    const res = await execa(process.execPath, [DIST_CLI, '--help'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('capabilities');
  }, 60_000);

  it('prints human summary when invoked without --json', async () => {
    const res = await execa(process.execPath, [DIST_CLI, 'capabilities'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('copperhead-run/1');
    expect(res.stdout).toContain('Protocol:');
  }, 60_000);

  it('guarantees build versus source CLI semantic parity', async () => {
    const distRes = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    const srcRes = await execa('npx', ['tsx', SRC_CLI, 'capabilities', '--json'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    expect(distRes.exitCode).toBe(0);
    expect(srcRes.exitCode).toBe(0);

    const distJson = JSON.parse(distRes.stdout) as CapabilityReport;
    const srcJson = JSON.parse(srcRes.stdout) as CapabilityReport;

    expect(distJson.protocol).toBe(srcJson.protocol);
    expect(distJson.cli).toBe(srcJson.cli);
    expect(distJson.commands).toEqual(srcJson.commands);
    expect(distJson.features).toEqual(srcJson.features);
    expect(distJson.tools.node).toBe(srcJson.tools.node);
    expect(distJson.tools.kicadCli).toBe(srcJson.tools.kicadCli);
    expect(distJson.tools.git).toBe(srcJson.tools.git);
    expect(distJson.tools.openspec).toBe(srcJson.tools.openspec);
  }, 60_000);
});
