import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { execa } from 'execa';
import type { Command } from 'commander';
import { kicadCliVersion } from '../kicad/cli.js';

const execFileP = promisify(execFile);

/**
 * Protocol identifier for the Copperhead CLI-to-consumer boundary (Issue #258).
 * Breaking wire or semantic changes increment the protocol major.
 * Additive enhancements retain the major version.
 */
export const COPPERHEAD_RUN_PROTOCOL = 'copperhead-run/1';

/**
 * The protocol major version supported by this build of Copperhead.
 */
export const SUPPORTED_PROTOCOL_MAJOR = 1;

/**
 * Protocol features implemented and supported on the wire in this build.
 * A capability is only listed here once its CLI flags, wire transports, and
 * handling are fully implemented and verified in this codebase.
 * In Phase 0 (capability handshake), no Phase 1-4 stream features are active.
 */
export const IMPLEMENTED_PROTOCOL_FEATURES: readonly string[] = [];

/**
 * Canonical public commands provided by the Copperhead CLI.
 * Kept sorted lexicographically for determinism.
 */
export const CANONICAL_PUBLIC_COMMANDS: readonly string[] = [
  'capabilities',
  'check',
  'create',
  'demo',
  'do',
  'doctor',
  'draft',
  'export',
  'init',
  'mcp',
  'repl',
  'score',
  'skill',
  'sync',
];

export interface ToolVersions {
  kicadCli: string | null;
  git: string | null;
  openspec: string | null;
  node: string;
}

export interface CapabilityReport {
  protocol: string;
  cli: string;
  commands: string[];
  features: string[];
  tools: ToolVersions;
}

export interface CapabilityDeps {
  nodeVersion?: string;
  cliVersion?: string;
  kicadVersion?: () => Promise<string | null>;
  gitVersion?: () => Promise<string | null>;
  openspecVersion?: () => Promise<string | null>;
}

function ownVersion(): string {
  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  return version;
}

async function probeSafe<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    const res = await fn();
    return res ?? null;
  } catch {
    return null;
  }
}

function defaultDeps(): CapabilityDeps {
  return {
    nodeVersion: process.version,
    cliVersion: ownVersion(),
    kicadVersion: async () => {
      const raw = await kicadCliVersion();
      if (!raw) return null;
      const match = raw.match(/(?:^|\n)\s*(?:kicad-cli\s+)?v?(\d+\.\d+(?:\.\d+)?)/m);
      return match ? match[1]! : raw.trim();
    },
    gitVersion: async () => {
      const { stdout } = await execFileP('git', ['--version'], { timeout: 5000 });
      const trimmed = stdout.trim().replace(/^git version\s+/, '');
      return trimmed || null;
    },
    openspecVersion: async () => {
      const { stdout } = await execa('openspec', ['--version'], { timeout: 5000 });
      const trimmed = stdout.trim();
      return trimmed || null;
    },
  };
}

export interface CollectCapabilitiesOptions {
  deps?: CapabilityDeps;
  program?: Command;
  commands?: string[];
}

/**
 * Extract public top-level commands from a Commander instance or command array.
 */
export function extractPublicCommands(program?: Command, explicitCommands?: string[]): string[] {
  if (explicitCommands) {
    return [...explicitCommands].sort();
  }
  if (program && Array.isArray(program.commands) && program.commands.length > 0) {
    const names = program.commands
      .map((cmd) => cmd.name())
      .filter((name) => name !== 'help' && !name.startsWith('_'));
    return [...new Set(names)].sort();
  }
  return [...CANONICAL_PUBLIC_COMMANDS];
}

/**
 * Collect Copperhead's versioned protocol and runtime capability descriptor.
 * Completely offline, network-free, credential-free, and repository-independent.
 */
export async function collectCapabilities(
  opts: CollectCapabilitiesOptions = {},
): Promise<CapabilityReport> {
  const defaults = defaultDeps();
  const nodeVersion = opts.deps?.nodeVersion ?? defaults.nodeVersion!;
  const cliVersion = opts.deps?.cliVersion ?? defaults.cliVersion!;
  const kicadProbe = opts.deps?.kicadVersion ?? defaults.kicadVersion!;
  const gitProbe = opts.deps?.gitVersion ?? defaults.gitVersion!;
  const openspecProbe = opts.deps?.openspecVersion ?? defaults.openspecVersion!;

  const [kicadCli, git, openspec] = await Promise.all([
    probeSafe(kicadProbe),
    probeSafe(gitProbe),
    probeSafe(openspecProbe),
  ]);

  const commands = extractPublicCommands(opts.program, opts.commands);

  return {
    protocol: COPPERHEAD_RUN_PROTOCOL,
    cli: cliVersion,
    commands,
    features: [...IMPLEMENTED_PROTOCOL_FEATURES],
    tools: {
      kicadCli,
      git,
      openspec,
      node: nodeVersion,
    },
  };
}

/**
 * Execute capability handshake action for the CLI command.
 */
export async function runCapabilities(
  opts: CollectCapabilitiesOptions & { json?: boolean } = {},
): Promise<CapabilityReport> {
  return collectCapabilities(opts);
}

/**
 * Verify if a given protocol string is compatible with the expected protocol major.
 */
export function isProtocolCompatible(
  protocol: string,
  expectedMajor = SUPPORTED_PROTOCOL_MAJOR,
): boolean {
  if (!protocol || typeof protocol !== 'string') return false;
  const match = protocol.match(/^copperhead-run\/(\d+)(?:\.|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  return Number.isFinite(major) && major === expectedMajor;
}

/**
 * Assert that a capability document or protocol identifier is compatible.
 * Throws an actionable error if the protocol major differs.
 */
export function assertProtocolCompatible(
  report: { protocol: string; [key: string]: unknown },
  expectedMajor = SUPPORTED_PROTOCOL_MAJOR,
): void {
  if (!report || !isProtocolCompatible(report.protocol, expectedMajor)) {
    const received = report?.protocol ?? String(report);
    throw new Error(
      `Unsupported protocol version "${received}". Expected copperhead-run/${expectedMajor}.`,
    );
  }
}

/**
 * Format capability report for human terminal inspection.
 */
export function formatCapabilities(report: CapabilityReport): string {
  const lines = [
    `Protocol:    ${report.protocol}`,
    `CLI Version: ${report.cli}`,
    `Commands:    ${report.commands.join(', ')}`,
    `Features:    ${report.features.length > 0 ? report.features.join(', ') : 'none'}`,
    `Tools:`,
    `  node:      ${report.tools.node}`,
    `  kicad-cli: ${report.tools.kicadCli ?? 'none (not found / not installed)'}`,
    `  git:       ${report.tools.git ?? 'none (not found / not installed)'}`,
    `  openspec:  ${report.tools.openspec ?? 'none (not found / not installed)'}`,
  ];
  return lines.join('\n');
}
