import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement } from '../src/kicad/draft/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

async function place(intent: SchematicIntent) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-readability-219-'));
  try {
    const v = await validateIntent(intent, new SymbolSource(repo, [SYMLIB], false), null);
    expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
    return draftSchematicPlacement(v.validated!, 'board', '2020-01-01');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('schematic readability & wiring quality (#219)', () => {
  it('routes collinear facing pins directly as a single wire without stub overshoot', async () => {
    // Two two-pin resistors facing each other vertically on the same net.
    // R1 pin 2 (facing down) connects to R2 pin 1 (facing up).
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'Net-(R1-Pad2)', pins: ['R1.2', 'R2.1'] },
      ],
    };

    const { model, report } = await place(intent);

    expect(report.mergedNets).toEqual([]);
    expect(report.labelOverlapBudgetExceeded).toBe(false);

    // The net Net-(R1-Pad2) must be wired between R1.2 and R2.1
    const netWires = model.wires.filter((w) => w.net === 'Net-(R1-Pad2)');
    expect(netWires.length).toBeGreaterThanOrEqual(1);

    // It must NOT emit two crossing stubs and global labels for this local connection
    const netLabels = model.labels.filter((l) => l.name === 'Net-(R1-Pad2)');
    expect(netLabels.every((l) => l.kind !== 'global')).toBe(true);
  });

  it('keeps fully-wired short anonymous net unlabelled when no anchor clears symbol bodies', async () => {
    // An anonymous net connecting two series passives with tight pin spacing
    // must not force a colliding local label over the component body.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '1k', group: 'MAIN' },
      ],
      nets: [
        { name: 'Net-(R1-Pad2)', pins: ['R1.2', 'R2.1'] },
      ],
    };

    const { report } = await place(intent);
    expect(report.mergedNets).toEqual([]);
    expect(report.labelsOverBodies).toBe(0);
  });

  it('preserves user-named net labels on wired runs while avoiding bodies', async () => {
    // A user-named net on a wired run must still receive a label naming the net.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'MID_BIAS', pins: ['R1.2', 'R2.1'] },
      ],
    };

    const { model, report } = await place(intent);
    expect(report.mergedNets).toEqual([]);
    const biasLabel = model.labels.find((l) => l.name === 'MID_BIAS');
    expect(biasLabel).toBeDefined();
    expect(biasLabel?.kind).toBe('local');
  });

  it('accounts for pin lead length beyond symbol body in facing label clearance', async () => {
    // When components have extended pin leads facing a channel, the channel widening
    // must account for the pin lead protrusion to prevent facing label text collisions.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
        { ref: 'U2', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
      ],
      nets: [
        { name: 'LONG_NET_NAME_BUS_0', pins: ['U1.2', 'U2.4'] },
      ],
    };

    const { report } = await place(intent);
    expect(report.mergedNets).toEqual([]);
    expect(report.labelOverlapBudgetExceeded).toBe(false);
  });
});
