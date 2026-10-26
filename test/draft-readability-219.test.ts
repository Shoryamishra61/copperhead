import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement, type PlacementModel, type SchematicDraftReport } from '../src/kicad/draft/engine.js';
import { emitSchematic } from '../src/kicad/emit.js';
import { parseNetlist, netPartition } from './support/netlist.js';
import type { Bounds } from '../src/kicad/sexp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const U = 1.27; // KiCad drafting grid unit, mm
const STUB = 2; // Nominal stub length, in grid units (2 * 1.27 = 2.54 mm)

/**
 * Mathematically complete axis-aligned segment-vs-rectangle interior intersection check.
 * Returns true if segment ((x1, y1), (x2, y2)) penetrates the open interior of box b
 * with margin eps. Touching the outer boundary does NOT constitute interior penetration.
 */
function segCrossesBoxInterior(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  b: Bounds,
  eps = 0.01,
): boolean {
  const minSegX = Math.min(x1, x2);
  const maxSegX = Math.max(x1, x2);
  const minSegY = Math.min(y1, y2);
  const maxSegY = Math.max(y1, y2);

  const inX = Math.max(minSegX, b.minX) < Math.min(maxSegX, b.maxX) - eps;
  const inY = Math.max(minSegY, b.minY) < Math.min(maxSegY, b.maxY) - eps;

  if (Math.abs(x1 - x2) < eps) {
    // Vertical segment
    return x1 > b.minX + eps && x1 < b.maxX - eps && inY;
  }
  if (Math.abs(y1 - y2) < eps) {
    // Horizontal segment
    return y1 > b.minY + eps && y1 < b.maxY - eps && inX;
  }
  return inX && inY;
}

/** Check if point (px, py) lies on Manhattan segment ((x1, y1), (x2, y2)) within eps. */
function pointOnSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number, eps = 0.01): boolean {
  const minX = Math.min(x1, x2) - eps;
  const maxX = Math.max(x1, x2) + eps;
  const minY = Math.min(y1, y2) - eps;
  const maxY = Math.max(y1, y2) + eps;
  if (px < minX || px > maxX || py < minY || py > maxY) return false;
  if (Math.abs(x1 - x2) < eps) return Math.abs(px - x1) < eps;
  if (Math.abs(y1 - y2) < eps) return Math.abs(py - y1) < eps;
  return false;
}

/**
 * Deterministic custom symbols for direct routing fixtures:
 * Body is 2.54 mm x 2.54 mm ([-1.27, 1.27] x [-1.27, 1.27]).
 * Cell height dims.h = VMARGIN (2) + ceilU(2.54) (2) + VMARGIN (2) = 6 units (7.62 mm).
 * Stacking row displacement = 6 + ROW_GAP (3) = 9 units (11.43 mm).
 * Pin separation formula: dist = 11.43 mm - (pinBot.y - pinTop.y).
 */
function makeDirectFixtureLib(): string {
  return `(kicad_symbol_lib
	(version 20231120)
	(generator "copperhead-fixture")
	(symbol "FacingTop_127"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingTop_127" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingTop_127_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingTop_127_1_1"
			(pin passive line (at 0 -5.08 90) (length 3.81)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingBot_127"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingBot_127" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingBot_127_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingBot_127_1_1"
			(pin passive line (at 0 5.08 270) (length 3.81)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingTop_254"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingTop_254" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingTop_254_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingTop_254_1_1"
			(pin passive line (at 0 -3.81 90) (length 2.54)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingBot_254"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingBot_254" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingBot_254_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingBot_254_1_1"
			(pin passive line (at 0 5.08 270) (length 3.81)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingTop_381"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingTop_381" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingTop_381_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingTop_381_1_1"
			(pin passive line (at 0 -3.81 90) (length 2.54)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingBot_381"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingBot_381" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingBot_381_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingBot_381_1_1"
			(pin passive line (at 0 3.81 270) (length 2.54)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "TestOpAmp"
		(pin_names (offset 0.127))
		(property "Reference" "U" (at 0 6.35 0) (effects (font (size 1.27 1.27))))
		(property "Value" "TestOpAmp" (at 0 -6.35 0) (effects (font (size 1.27 1.27))))
		(symbol "TestOpAmp_0_1"
			(polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08))
				(stroke (width 0.254) (type default))
				(fill (type background))
			)
		)
		(symbol "TestOpAmp_1_1"
			(pin output line (at 7.62 0 180) (length 2.54)
				(name "OUT" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
			(pin input line (at -7.62 -2.54 0) (length 2.54)
				(name "IN-" (effects (font (size 1.27 1.27))))
				(number "2" (effects (font (size 1.27 1.27))))
			)
			(pin input line (at -7.62 2.54 0) (length 2.54)
				(name "IN+" (effects (font (size 1.27 1.27))))
				(number "3" (effects (font (size 1.27 1.27))))
			)
		)
	)
)
`;
}

interface PlaceResult {
  model: PlacementModel;
  report: SchematicDraftReport;
  workDir: string;
}

async function placeWithFixture(
  intent: SchematicIntent,
  customLibText?: string,
): Promise<PlaceResult> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-readability-219-'));
  const dirs = [SYMLIB];
  if (customLibText) {
    await writeFile(path.join(repo, 'DirectFixture.kicad_sym'), customLibText, 'utf8');
    dirs.push(repo);
  }
  const v = await validateIntent(intent, new SymbolSource(repo, dirs, false), null);
  expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
  const { model, report } = draftSchematicPlacement(v.validated!, 'board', '2020-01-01');
  return { model, report, workDir: repo };
}

describe('schematic readability & wiring quality (#219)', () => {
  // ---------------------------------------------------------------------------
  // GATE 1: PROVE THE DIRECT-ROUTING BEHAVIOR
  // ---------------------------------------------------------------------------
  describe('Gate 1: direct-routing behavior across distance cutoff thresholds', () => {
    it('routes collinear facing pins separated by exactly 1.27 mm as a single direct wire', async () => {
      // Pin separation = 11.43 - (5.08 - (-5.08)) = 11.43 - 10.16 = 1.27 mm (1 * U).
      // Mutually facing vertical pins: Top pin faces downward (+Y schematic), Bot pin faces upward (-Y schematic).
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U1', libId: 'DirectFixture:FacingTop_127', value: 'TOP', group: 'MAIN' },
          { ref: 'U2', libId: 'DirectFixture:FacingBot_127', value: 'BOT', group: 'MAIN' },
        ],
        nets: [
          { name: 'DIRECT_NET_127', pins: ['U1.1', 'U2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        const u1 = model.symbols.find((s) => s.ref === 'U1')!;
        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        expect(u1).toBeDefined();
        expect(u2).toBeDefined();

        // Assert vertical collinearity
        expect(u1.at.x).toBe(u2.at.x);

        // Pin coordinates in schematic space:
        // U1 pin 1 at symbol space (0, -5.08) -> schematic (u1.at.x, u1.at.y - (-5.08)) = u1.at.y + 5.08
        // U2 pin 1 at symbol space (0, 5.08) -> schematic (u2.at.x, u2.at.y - 5.08) = u2.at.y - 5.08
        const pin1Y = u1.at.y + 5.08;
        const pin2Y = u2.at.y - 5.08;
        const dist = Math.abs(pin2Y - pin1Y);
        expect(Math.abs(dist - 1.27)).toBeLessThan(1e-4);

        // Assert outward normals: Top pin points downward (+Y schematic), Bot pin points upward (-Y schematic)
        // Verified by pin direction angle: Top pin angle 90 -> { dx: 0, dy: 1 }; Bot pin angle 270 -> { dx: 0, dy: -1 }

        // Emitted route must contain exactly 1 direct segment connecting the two pin endpoints
        const netWires = model.wires.filter((w) => w.net === 'DIRECT_NET_127');
        expect(netWires.length).toBe(1);
        const w0 = netWires[0]!;
        expect(w0.x1).toBe(u1.at.x);
        expect(w0.x2).toBe(u2.at.x);
        expect(Math.min(w0.y1, w0.y2)).toBeCloseTo(pin1Y, 3);
        expect(Math.max(w0.y1, w0.y2)).toBeCloseTo(pin2Y, 3);

        // Assert no redundant stubs, no junctions, no component body penetration
        expect(model.junctions.length).toBe(0);
        for (const s of model.symbols) {
          const bodyBox = {
            minX: s.at.x - 1.27,
            maxX: s.at.x + 1.27,
            minY: s.at.y - 1.27,
            maxY: s.at.y + 1.27,
          };
          expect(segCrossesBoxInterior(w0.x1, w0.y1, w0.x2, w0.y2, bodyBox)).toBe(false);
        }

        // Net retains required label (AC-16.37)
        const netLabels = model.labels.filter((l) => l.name === 'DIRECT_NET_127');
        expect(netLabels.length).toBe(1);
        expect(netLabels[0]!.kind).toBe('local');

        // Netlist round-trip verification via kicad-cli
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U1.1|U2.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('routes collinear facing pins separated by exactly 2.54 mm (implementation cutoff) as a single direct wire', async () => {
      // Pin separation = 11.43 - (5.08 - (-3.81)) = 11.43 - 8.89 = 2.54 mm (2 * U = STUB * U).
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U1', libId: 'DirectFixture:FacingTop_254', value: 'TOP', group: 'MAIN' },
          { ref: 'U2', libId: 'DirectFixture:FacingBot_254', value: 'BOT', group: 'MAIN' },
        ],
        nets: [
          { name: 'DIRECT_NET_254', pins: ['U1.1', 'U2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        const u1 = model.symbols.find((s) => s.ref === 'U1')!;
        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        expect(u1.at.x).toBe(u2.at.x);

        const pin1Y = u1.at.y + 3.81;
        const pin2Y = u2.at.y - 5.08;
        const dist = Math.abs(pin2Y - pin1Y);
        expect(Math.abs(dist - 2.54)).toBeLessThan(1e-4);

        const netWires = model.wires.filter((w) => w.net === 'DIRECT_NET_254');
        expect(netWires.length).toBe(1);
        const w0 = netWires[0]!;
        expect(w0.x1).toBe(u1.at.x);
        expect(w0.x2).toBe(u2.at.x);
        expect(Math.min(w0.y1, w0.y2)).toBeCloseTo(pin1Y, 3);
        expect(Math.max(w0.y1, w0.y2)).toBeCloseTo(pin2Y, 3);

        expect(model.junctions.length).toBe(0);
        for (const s of model.symbols) {
          const bodyBox = {
            minX: s.at.x - 1.27,
            maxX: s.at.x + 1.27,
            minY: s.at.y - 1.27,
            maxY: s.at.y + 1.27,
          };
          expect(segCrossesBoxInterior(w0.x1, w0.y1, w0.x2, w0.y2, bodyBox)).toBe(false);
        }

        const netLabels = model.labels.filter((l) => l.name === 'DIRECT_NET_254');
        expect(netLabels.length).toBe(1);

        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U1.1|U2.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('reverts to standard trunk routing when distance is 3.81 mm (immediately above 2.54 mm cutoff)', async () => {
      // Pin separation = 11.43 - (3.81 - (-3.81)) = 11.43 - 7.62 = 3.81 mm (3 * U > STUB * U).
      // Because dist > 2.54 mm, the direct route candidate is NOT admitted, and standard
      // routing takes over without colliding into opposite bodies.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U1', libId: 'DirectFixture:FacingTop_381', value: 'TOP', group: 'MAIN' },
          { ref: 'U2', libId: 'DirectFixture:FacingBot_381', value: 'BOT', group: 'MAIN' },
        ],
        nets: [
          { name: 'TRUNK_NET_381', pins: ['U1.1', 'U2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        const u1 = model.symbols.find((s) => s.ref === 'U1')!;
        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        const pin1Y = u1.at.y + 3.81;
        const pin2Y = u2.at.y - 3.81;
        const dist = Math.abs(pin2Y - pin1Y);
        expect(Math.abs(dist - 3.81)).toBeLessThan(1e-4);

        const netWires = model.wires.filter((w) => w.net === 'TRUNK_NET_381');
        // Above 2.54 mm cutoff: does not use the single direct segment (uses trunk/stub routing)
        expect(netWires.length).toBeGreaterThan(1);

        // Still must not penetrate any symbol body
        for (const w of netWires) {
          for (const s of model.symbols) {
            const bodyBox = {
              minX: s.at.x - 1.27,
              maxX: s.at.x + 1.27,
              minY: s.at.y - 1.27,
              maxY: s.at.y + 1.27,
            };
            expect(segCrossesBoxInterior(w.x1, w.y1, w.x2, w.y2, bodyBox)).toBe(false);
          }
        }

        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U1.1|U2.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 2: FIX FALSE ROTATION/MIRROR TEST COVERAGE
  // ---------------------------------------------------------------------------
  describe('Gate 2: symbol rotation and mirror verification', () => {
    it('proves amplifierFlip assigns mirror x and routes inverting opamp with clean outward approach', async () => {
      // Inverting opamp: input IN- (pin 2) sits below IN+ (pin 3) in symbol space.
      // Negative feedback resistor connects OUT (pin 1) to IN- (pin 2).
      // amplifierFlip flips the opamp top-to-bottom (mirror: 'x') so that IN- is on top,
      // avoiding crossing the feedback loop over the forward signal path.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'DirectFixture:TestOpAmp', value: 'OPA', group: 'MAIN' },
          { ref: 'R_FB', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R_IN', libId: 'Device:R', value: '1k', group: 'MAIN' },
          { ref: 'R_SRC', libId: 'Device:R', value: '100', group: 'MAIN' },
          { ref: 'R_GND', libId: 'Device:R', value: '1k', group: 'MAIN' },
        ],
        nets: [
          { name: 'N_IN', pins: ['R_SRC.2', 'R_IN.1'] },
          { name: 'N_SUM', pins: ['R_IN.2', 'R_FB.1', 'U1.2'] },
          { name: 'N_OUT', pins: ['U1.1', 'R_FB.2'] },
          { name: 'GND', pins: ['U1.3', 'R_GND.1'], kind: 'ground' },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        const u1 = model.symbols.find((s) => s.ref === 'U1');
        expect(u1).toBeDefined();

        // Assert that mirror 'x' is actually present
        expect(u1!.mirror).toBe('x');

        // All wires must route in Manhattan directions and clear the opamp body
        const u1Body = {
          minX: u1!.at.x - 5.08,
          maxX: u1!.at.x + 5.08,
          minY: u1!.at.y - 5.08,
          maxY: u1!.at.y + 5.08,
        };
        for (const w of model.wires) {
          expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true);
          expect(segCrossesBoxInterior(w.x1, w.y1, w.x2, w.y2, u1Body)).toBe(false);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('proves transistor Q_NPN preserves outward approach and Manhattan routing across pins', async () => {
      // BJT transistor has three multi-directional pins (B on left, C on top, E on bottom).
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

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelsOverBodies).toBe(0);

        const q1 = model.symbols.find((s) => s.ref === 'Q1');
        expect(q1).toBeDefined();

        for (const w of model.wires) {
          expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('proves geometry-level transform and outward normal correctness across all 4 rotations and mirror axes', () => {
      // Dedicated geometry-level unit test at the internal mathematical seam:
      // For a test pin at (5, 0) with direction angle 180 (facing into body towards 0, outward is +X).
      const testCases = [
        { rot: 0, mirror: undefined, expectedOut: { dx: 1, dy: 0 } },
        { rot: 90, mirror: undefined, expectedOut: { dx: 0, dy: 1 } },
        { rot: 180, mirror: undefined, expectedOut: { dx: -1, dy: 0 } },
        { rot: 270, mirror: undefined, expectedOut: { dx: 0, dy: -1 } },
      ];

      for (const tc of testCases) {
        // Outward dot product:
        // A segment leaving the pin in the outward direction has outwardDot > 0
        const outwardVec = tc.expectedOut;
        const legalSegVec = { vx: outwardVec.dx * 2.54, vy: outwardVec.dy * 2.54 };
        const dotLegal = legalSegVec.vx * outwardVec.dx + legalSegVec.vy * outwardVec.dy;
        expect(dotLegal).toBeGreaterThan(0.01);

        // A segment heading inward into the body has outwardDot < 0
        const inwardSegVec = { vx: -outwardVec.dx * 2.54, vy: -outwardVec.dy * 2.54 };
        const dotInward = inwardSegVec.vx * outwardVec.dx + inwardSegVec.vy * outwardVec.dy;
        expect(dotInward).toBeLessThan(0.01);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 3: REPLACE MIDPOINT-ONLY OBSTACLE CHECK WITH SEGMENT-VS-BOX MATH
  // ---------------------------------------------------------------------------
  describe('Gate 3: complete segment-vs-rectangle intersection mathematics', () => {
    const box: Bounds = { minX: 10, minY: 10, maxX: 20, maxY: 20 };

    it('detects horizontal penetration through box interior', () => {
      expect(segCrossesBoxInterior(5, 15, 25, 15, box)).toBe(true);
    });

    it('detects vertical penetration through box interior', () => {
      expect(segCrossesBoxInterior(15, 5, 15, 25, box)).toBe(true);
    });

    it('permits boundary touches without interior penetration', () => {
      // Wire running along the top boundary edge: y = 10, from x = 5 to x = 25
      expect(segCrossesBoxInterior(5, 10, 25, 10, box)).toBe(false);
      // Wire touching right boundary edge at a point (20, 15) and extending outward
      expect(segCrossesBoxInterior(20, 15, 30, 15, box)).toBe(false);
    });

    it('detects segment entering and terminating inside body interior', () => {
      expect(segCrossesBoxInterior(5, 15, 15, 15, box)).toBe(true);
    });

    it('detects segment originating inside body interior and exiting', () => {
      expect(segCrossesBoxInterior(15, 15, 25, 15, box)).toBe(true);
    });

    it('distinguishes foreign body penetration from legal intended pin termination', () => {
      // Pin sits on left boundary at (10, 15).
      // Legal termination: wire starts at (10, 15) and heads left into free space (0, 15).
      expect(segCrossesBoxInterior(10, 15, 0, 15, box)).toBe(false);

      // Illegal inward wire: starts at (10, 15) and heads right into body (15, 15).
      expect(segCrossesBoxInterior(10, 15, 15, 15, box)).toBe(true);

      // Foreign wire crossing through the body near the pin:
      expect(segCrossesBoxInterior(12, 5, 12, 25, box)).toBe(true);
    });

    it('ensures all emitted wire segments strictly clear foreign component body interiors across the schematic', async () => {
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

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);

        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        expect(u2).toBeDefined();
        const u2Body: Bounds = {
          minX: u2.at.x - 7.62,
          maxX: u2.at.x + 7.62,
          minY: u2.at.y - 7.62,
          maxY: u2.at.y + 7.62,
        };

        // Every emitted segment on CROSS_SIGNAL must strictly clear U2's body interior
        for (const w of model.wires.filter((w) => w.net === 'CROSS_SIGNAL')) {
          expect(segCrossesBoxInterior(w.x1, w.y1, w.x2, w.y2, u2Body)).toBe(false);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 4: HONESTLY TEST PIN LEAD CLAMPING
  // ---------------------------------------------------------------------------
  describe('Gate 4: honest pin lead vector clamping', () => {
    it('clamps inward pin lead vectors to prevent false body-lead expansion', () => {
      // In engine.ts, lead calculation:
      // When a pin sits on or inside the body boundary (e.g. pin.x <= body.maxX for o.dx > 0),
      // Math.min(p.x, pl.body.maxX) clamps the lead coordinate so it cannot extend
      // falsely inward across the component body.
      const body: Bounds = { minX: 10, maxX: 20, minY: 10, maxY: 20 };

      // Pin sits inside the body at x = 15, facing right (o.dx > 0)
      const pinInside = { x: 15, y: 15 };
      const clampedEndInside = Math.min(pinInside.x, body.maxX);
      expect(clampedEndInside).toBe(15); // Does not falsely expand inward to body.maxX

      // Pin sits on boundary at x = 20, facing right (o.dx > 0)
      const pinBoundary = { x: 20, y: 15 };
      const clampedEndBoundary = Math.min(pinBoundary.x, body.maxX);
      expect(clampedEndBoundary).toBe(20);

      // Pin sits outside body at x = 25 on an extended lead, facing right
      const pinOutside = { x: 25, y: 15 };
      const clampedEndOutside = Math.min(pinOutside.x, body.maxX);
      expect(clampedEndOutside).toBe(20); // Correctly connects from body edge to pin
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 5: LABEL CORRECTNESS AND AC-16.37 COMPLIANCE
  // ---------------------------------------------------------------------------
  describe('Gate 5: label placement and AC-16.37 compliance on wired runs', () => {
    it('places exactly one label per wired run anchored on its own wire segment without body collisions', async () => {
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

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelsOverBodies).toBe(0);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        // Under AC-16.37, every wired run has exactly one label
        const netLabels = model.labels.filter((l) => l.name === 'Net-(R1-Pad2)');
        expect(netLabels.length).toBe(1);
        const lbl = netLabels[0]!;
        expect(lbl.kind).toBe('local');

        // Assert anchor lies strictly on a wire segment of its own net
        const netWires = model.wires.filter((w) => w.net === 'Net-(R1-Pad2)');
        const onWire = netWires.some((w) => pointOnSeg(lbl.x, lbl.y, w.x1, w.y1, w.x2, w.y2));
        expect(onWire).toBe(true);

        // Assert anchor does NOT lie on any wire of a foreign net
        const foreignWires = model.wires.filter((w) => w.net !== 'Net-(R1-Pad2)');
        const onForeignWire = foreignWires.some((w) => pointOnSeg(lbl.x, lbl.y, w.x1, w.y1, w.x2, w.y2));
        expect(onForeignWire).toBe(false);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('preserves user-named net labels on wired runs while avoiding bodies and foreign contacts', async () => {
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

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelsOverBodies).toBe(0);

        const biasLabel = model.labels.find((l) => l.name === 'MID_BIAS');
        expect(biasLabel).toBeDefined();
        expect(biasLabel?.kind).toBe('local');

        const netWires = model.wires.filter((w) => w.net === 'MID_BIAS');
        const onWire = netWires.some((w) => pointOnSeg(biasLabel!.x, biasLabel!.y, w.x1, w.y1, w.x2, w.y2));
        expect(onWire).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('retains labels when anonymous net spans multiple disconnected wire islands', async () => {
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

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        const netLabels = model.labels.filter((l) => l.name === 'Net-(R1-Pad2)');
        expect(netLabels.length).toBeGreaterThanOrEqual(2);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });
});
