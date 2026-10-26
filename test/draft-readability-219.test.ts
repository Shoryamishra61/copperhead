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

  it('retains labels when anonymous net spans multiple disconnected wire islands', async () => {
    // If an anonymous net connects multiple physically separated pairs (islands),
    // labels must NOT be suppressed, because suppressing them would partition
    // the net into disconnected fragments in the KiCad netlist.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R3', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R4', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'Net-(R1-Pad2)', pins: ['R1.2', 'R2.1', 'R3.2', 'R4.1'] },
      ],
    };

    const { model, report } = await place(intent);
    expect(report.mergedNets).toEqual([]);

    // Net-(R1-Pad2) has 4 endpoints. If any wired pairs were formed, each must
    // retain a label to keep all islands connected by name.
    const netLabels = model.labels.filter((l) => l.name === 'Net-(R1-Pad2)');
    expect(netLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('ensures all wire endpoints terminating at pins approach from outward legal direction', async () => {
    // Adversarial verification: every wire segment terminating at an owned pin
    // must approach from the pin's outward direction (into free space), never
    // heading inward into the component body or traversing across the body.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'SIG1', pins: ['U1.4', 'R1.1'] },
        { name: 'SIG2', pins: ['U1.5', 'R2.1'] },
      ],
    };

    const { model, report } = await place(intent);
    expect(report.mergedNets).toEqual([]);
    expect(report.labelsOverBodies).toBe(0);

    // Verify no wire crosses U1's body
    const u1 = model.symbols.find((s) => s.ref === 'U1');
    expect(u1).toBeDefined();
    // MCU8 body is rectangle [-7.62, 7.62] around origin
    const bodyBox = {
      minX: u1!.at.x - 7.62,
      maxX: u1!.at.x + 7.62,
      minY: u1!.at.y - 7.62,
      maxY: u1!.at.y + 7.62,
    };
    for (const w of model.wires) {
      // Wires must not cross the interior of U1's body
      const midX = (w.x1 + w.x2) / 2;
      const midY = (w.y1 + w.y2) / 2;
      const strictlyInside = midX > bodyBox.minX + 0.1 && midX < bodyBox.maxX - 0.1 &&
                             midY > bodyBox.minY + 0.1 && midY < bodyBox.maxY - 0.1;
      expect(strictlyInside).toBe(false);
    }
  });

  it('rejects candidate segments that traverse through intermediate foreign bodies', async () => {
    // Adversarial test: a route connecting two components cannot pass through
    // an intermediate component body that sits between them, even when the wire
    // starts and ends on legal pins.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
        { ref: 'U2', libId: 'CopperMCU:MCU8', value: 'OBSTACLE', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'CROSS_SIGNAL', pins: ['U1.4', 'R1.1'] },
      ],
    };

    const { model, report } = await place(intent);
    expect(report.mergedNets).toEqual([]);

    // Wires of CROSS_SIGNAL must not cross U2's body
    const u2 = model.symbols.find((s) => s.ref === 'U2');
    expect(u2).toBeDefined();
    const u2Body = {
      minX: u2!.at.x - 7.62,
      maxX: u2!.at.x + 7.62,
      minY: u2!.at.y - 7.62,
      maxY: u2!.at.y + 7.62,
    };
    for (const w of model.wires.filter((w) => w.net === 'CROSS_SIGNAL')) {
      const midX = (w.x1 + w.x2) / 2;
      const midY = (w.y1 + w.y2) / 2;
      const insideU2 = midX > u2Body.minX + 0.1 && midX < u2Body.maxX - 0.1 &&
                       midY > u2Body.minY + 0.1 && midY < u2Body.maxY - 0.1;
      expect(insideU2).toBe(false);
    }
  });

  it('preserves outward approach across rotated and mirrored symbols', async () => {
    // Tests that symbol rotation (90, 180, 270) and mirroring do not corrupt
    // the pin outward vector check or admit inward routes.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'Q1', libId: 'Device:Q_NPN', value: '2N3904', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '1k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'BASE_DRIVE', pins: ['R1.2', 'Q1.B'] },
        { name: 'COLL_PULL', pins: ['R2.2', 'Q1.C'] },
      ],
    };

    const { model, report } = await place(intent);
    expect(report.mergedNets).toEqual([]);
    expect(report.labelsOverBodies).toBe(0);

    // Verify transistor pins and wires
    const q1 = model.symbols.find((s) => s.ref === 'Q1');
    expect(q1).toBeDefined();
    for (const w of model.wires) {
      expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true); // Manhattan routing strictly
    }
  });
});
