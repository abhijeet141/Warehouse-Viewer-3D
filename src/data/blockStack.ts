import type { LaneConfig, Segment } from '../types';
import { seededRng } from '../lib/rng';

// Block-stack floor storage for the Sundance model, modelled the FloWMS way
// (FLD-69): a BLOCK is the zone/area that owns a run of LANE segments; each lane
// is a single-ended deep lane that holds up to maximumPods pallets and is only
// ever worked from its face. Every lane is tracked (segments.trackStockMix = 1)
// and holds one stock class at a time — its stock-mix hash under the policy
// resolved for its zone.
//
// It stands on the bulk floor alongside the A-side of the rack block, floor the
// racking model leaves empty: six banks of lanes back to back, two zones per bank,
// facing drive aisles BS1–BS2 that run the full length of the block like the racking
// aisles do. Zone BSD holds the FLD-69 fixture the walk-through is scripted against.
//
// Pallets stack five or six high (per zone) and three positions deep. Data axes
// follow the rest of the model: X along the aisles, Y across (depth), Z up, mm.

export const BS = {
  LANE_W: 1400,     // one pallet wide plus 100 mm clearance each side
  LANE_D: 3500,     // three pallet positions at 1100 pitch + 100 back clearance
  DEEP: 3,          // pallet positions from face to back
  POD_W: 1200,
  POD_D: 1000,
  PALLET_H: 144,    // matches the shared pallet geometry
  LOAD_H: 1150,     // a full pallet's wrapped load
  LOAD_CAP: 1.03,   // the film cap on top of a load, as a fraction of its height
  STACK_GAP: 10,    // a pallet sits this far above the load beneath it
  TIER_PITCH: 1294, // nominal PALLET_H + LOAD_H (a full pallet's height)
  HEADROOM: 400,    // lane height above the tallest possible stack
  COL_PITCH: 1100,
  BACK_CLEAR: 100,
  AISLE_W: 5600,    // drive aisle between facing banks (counterbalance truck)
  AISLE_H: 4000,    // nothing overhead — sets the walk eye height, not a structure
} as const;

// Stock-mix policies in play (codes from the FLD-69 fixture).
export const POLICIES: Record<string, { keys: string[]; label: string }> = {
  'BS-PRODUCT-BATCH': { keys: ['account-id', 'product-id', 'batch-type-id', 'batch-value'], label: 'product + batch' },
  'BS-PRODUCT-ONLY':  { keys: ['account-id', 'product-id'], label: 'product only' },
};

export interface BlockZone {
  code: string;            // BLOCK segment name and lane prefix, e.g. "BSD"
  policy: string;          // stock-mix policy resolved for the zone's lanes
  lanes: number;
  tiers: number;           // pallets stacked per position in this zone (5 or 6)
  x0: number;              // first lane's coordinateX
  y0: number;              // lanes' coordinateY (the lane's low-Y edge)
  faceDir: 1 | -1;         // +1: the face is on the high-Y side
  aisle: string;           // the drive aisle the faces open onto
}

export interface DriveAisle { name: string; x: number; y: number; w: number; d: number }

// Drive aisles: named like aisles so the walkthrough rail and the floor arrows
// pick them up; flagged floorStorage so the tour and the building shell ignore
// them. BS1–BS2 run the full block length through the bulk floor, their mouths on
// the same front cross-aisle as F–V.
export const DRIVE_AISLES: DriveAisle[] = [
  { name: 'BS3', x: 0, y: -13600, w: 107400, d: BS.AISLE_W },
  { name: 'BS2', x: 0, y: -26200, w: 107400, d: BS.AISLE_W },
  { name: 'BS1', x: 0, y: -38800, w: 107400, d: BS.AISLE_W },
];

// Bulk floor: banks of 3.5 m deep lanes, two 36-lane zones per bank along X,
// between a 4.5 m cross-aisle at the A-row face (Y −4500..0) and the wall.
// Letters follow the warehouse's own aisle lettering (no I, O, Q, U).
const BANK_LANES = 36;
const BANK_X = [2500, 54400]; // two zones per bank, 1.5 m apart
const BANKS: {
  y0: number; faceDir: 1 | -1; aisle: string;
  zones: [string, string]; policies: [string, string]; tiers: [number, number];
}[] = [
  { y0: -8000,  faceDir: -1, aisle: 'BS3', zones: ['BSD', 'BSE'], policies: ['BS-PRODUCT-BATCH', 'BS-PRODUCT-ONLY'],  tiers: [6, 5] },
  { y0: -17100, faceDir: 1,  aisle: 'BS3', zones: ['BSF', 'BSG'], policies: ['BS-PRODUCT-BATCH', 'BS-PRODUCT-BATCH'], tiers: [5, 6] },
  { y0: -20600, faceDir: -1, aisle: 'BS2', zones: ['BSH', 'BSJ'], policies: ['BS-PRODUCT-ONLY', 'BS-PRODUCT-BATCH'],  tiers: [6, 6] },
  { y0: -29700, faceDir: 1,  aisle: 'BS2', zones: ['BSK', 'BSL'], policies: ['BS-PRODUCT-BATCH', 'BS-PRODUCT-ONLY'],  tiers: [5, 6] },
  { y0: -33200, faceDir: -1, aisle: 'BS1', zones: ['BSM', 'BSN'], policies: ['BS-PRODUCT-BATCH', 'BS-PRODUCT-BATCH'], tiers: [6, 5] },
  { y0: -42300, faceDir: 1,  aisle: 'BS1', zones: ['BSP', 'BSR'], policies: ['BS-PRODUCT-ONLY', 'BS-PRODUCT-BATCH'],  tiers: [6, 6] },
];

export const BLOCK_ZONES: BlockZone[] = [
  ...BANKS.flatMap((b) =>
    b.zones.map((code, i): BlockZone => ({
      code, policy: b.policies[i], lanes: BANK_LANES, tiers: b.tiers[i],
      x0: BANK_X[i], y0: b.y0, faceDir: b.faceDir, aisle: b.aisle,
    })),
  ),
];

export const laneName = (zone: BlockZone, i: number): string => `${zone.code}${String(i + 1).padStart(2, '0')}`;

// Lane (and zone) height: the tallest possible stack plus headroom.
const laneHeight = (tiers: number): number => tiers * BS.TIER_PITCH + BS.HEADROOM;

// Drive aisles as AISLE segments (walkable, flagged floorStorage); a caller may pass
// its own list to pack the bulk floor for a different lane depth.
export function driveAisleSegments(aisles: DriveAisle[] = DRIVE_AISLES): Segment[] {
  return aisles.map((a) => ({
    fullName: a.name, type: 'AISLE' as const,
    coordinateX: a.x, coordinateY: a.y, coordinateZ: 0,
    dimensionX: a.w, dimensionY: a.d, dimensionZ: BS.AISLE_H,
    offsetX: 0, offsetY: 0, offsetZ: 0,
    floorStorage: true,
  }));
}

function buildSegments(): Segment[] {
  const out: Segment[] = driveAisleSegments();
  for (const z of BLOCK_ZONES) {
    const h = laneHeight(z.tiers);
    out.push({
      fullName: z.code, type: 'BLOCK',
      coordinateX: z.x0, coordinateY: z.y0, coordinateZ: 0,
      dimensionX: z.lanes * BS.LANE_W, dimensionY: BS.LANE_D, dimensionZ: h,
      offsetX: 0, offsetY: 0, offsetZ: 0,
      floorStorage: true,
    });
    for (let i = 0; i < z.lanes; i++) {
      const lane: LaneConfig = {
        block: z.code, deep: BS.DEEP, tiers: z.tiers, maxPods: BS.DEEP * z.tiers,
        faceDir: z.faceDir, trackStockMix: true, policy: z.policy,
      };
      out.push({
        fullName: laneName(z, i), type: 'LANE',
        coordinateX: z.x0 + i * BS.LANE_W, coordinateY: z.y0, coordinateZ: 0,
        dimensionX: BS.LANE_W, dimensionY: BS.LANE_D, dimensionZ: h,
        offsetX: 0, offsetY: 0, offsetZ: 0,
        floorStorage: true,
        lane,
      });
    }
  }
  return out;
}

export const SEGMENTS_BLOCK_STACK: Segment[] = buildSegments();

// ---- demo pallets ---------------------------------------------------------

export interface Product {
  code: string;
  name: string;
  casesPerPallet: number;
  hue: number; // load colour hue (degrees) — the product reads as a colour family
}

// Six products with well-separated hues; Cola is the teal of the reference photo.
export const PRODUCTS: Product[] = [
  { code: '4471', name: 'Cola 330ml ×24',        casesPerPallet: 40, hue: 172 },
  { code: '4472', name: 'Lemonade 330ml ×24',    casesPerPallet: 40, hue: 42 },
  { code: '5120', name: 'Water 500ml ×12',       casesPerPallet: 48, hue: 208 },
  { code: '6003', name: 'Crisps 150g ×12',       casesPerPallet: 60, hue: 18 },
  { code: '7210', name: 'Apple Juice 1L ×12',    casesPerPallet: 36, hue: 105 },
  { code: '8305', name: 'Detergent 2L ×6',       casesPerPallet: 30, hue: 275 },
];
const productByCode = new Map(PRODUCTS.map((p) => [p.code, p]));

export const BATCHES = ['B7', 'B9', 'B11'] as const;
// Batch → lightness of the load colour, so one product's batches read as shades
// of the same hue: a product-only lane mixes shades, a product+batch lane is flat.
export const BATCH_SHADE: Record<string, number> = { B7: 0.5, B9: 0.65, B11: 0.37, B8: 0.76 };
const LOAD_SATURATION = 0.45;

export type PodStatus = 'AVAILABLE' | 'ALLOCATED';
export type JobStatus = 'AVAILABLE' | 'RESERVED' | 'COMPLETE';

// The ALLOCATED row on a pallet's stock: which order/job it is booked to, how many
// cases, and whether a picker currently holds that job (RESERVED) — the thing the
// FLD-69 displacement test looks at.
export interface Allocation {
  order: string;
  job: string;
  qty: number;
  jobStatus: JobStatus;
}

export interface LanePod {
  code: string;      // e.g. "BSD03-05"
  lane: string;      // owning LANE segment
  index: number;     // 1-based fill order; the highest index is the face pallet
  column: number;    // depth position, 0 = deepest
  tier: number;      // 0 = on the floor
  z0: number;        // base of the pallet (data mm): the top of whatever it stands on
  product: Product;
  batches: string[]; // one batch, or two on an internally mixed pallet
  cases: number;
  classKey: string;  // stock-mix class under the lane's policy
  allocation: Allocation | null; // at most one booking per pallet in this demo
  loadFraction?: number; // load height as a fraction of a full pallet, instead of cases
  shade?: number;        // explicit load lightness, instead of the batch shade
}

export interface LaneStock {
  lane: Segment;
  pods: LanePod[];
  classKey: string | null; // the class the lane currently holds (null when empty)
}

export const podStatus = (pod: LanePod): PodStatus => (pod.allocation ? 'ALLOCATED' : 'AVAILABLE');
export const podAvailable = (pod: LanePod): number => Math.max(0, pod.cases - (pod.allocation?.qty ?? 0));

// A partially picked pallet carries fewer cases, so its load is shorter.
export function loadHeight(pod: Pick<LanePod, 'cases' | 'product' | 'loadFraction'>): number {
  const f = pod.loadFraction ?? pod.cases / pod.product.casesPerPallet;
  return BS.LOAD_H * Math.max(0.3, Math.min(1, f));
}

// Height of a pallet plus its load (film cap included) — what the next pallet in
// the stack rests on.
export function podHeight(pod: Pick<LanePod, 'cases' | 'product' | 'loadFraction'>): number {
  return BS.PALLET_H + loadHeight(pod) * BS.LOAD_CAP;
}

// HSL for a pallet's load: hue from the product, lightness from the batch (an
// internally mixed pallet averages its batches' shades).
export function podHSL(pod: LanePod): { h: number; s: number; l: number } {
  const shades = pod.batches.map((b) => BATCH_SHADE[b] ?? 0.55);
  const l = pod.shade ?? (shades.length ? shades.reduce((a, b) => a + b, 0) / shades.length : 0.55);
  return { h: pod.product.hue / 360, s: LOAD_SATURATION, l };
}

// The fingerprint a policy sees on a pallet: product + batch, or product only.
// A pallet carrying two batches is its own class under a batch policy.
export function classKeyFor(product: string, batches: string[], policy: string | null): string {
  if (policy === 'BS-PRODUCT-ONLY') return product;
  return `${product}|${batches.join('+')}`;
}

// The walk-through's lanes, first in the zone's putaway order: BSD01 top-up + allocation,
// BSD02 Case B face, BSD03 other class, BSD04 mixed pallet, BSD05 reserved face, BSD06 part pallet.
interface Fixture {
  product: string;
  batches: string[][];
  cases?: Record<number, number>; // part pallets, by position
  allocated?: Record<number, { order: string; job: string; jobStatus?: JobStatus }>;
}
const FIXTURE: Record<string, Fixture> = {
  BSD01: { product: '4471', batches: [['B7'], ['B7']] },
  BSD02: {
    product: '4471',
    batches: [['B7'], ['B7'], ['B7'], ['B7'], ['B7']],
    allocated: { 5: { order: 'ORD-1002', job: 'J-502' } },
  },
  BSD03: { product: '4471', batches: [['B9'], ['B9'], ['B9'], ['B9']] },
  BSD04: { product: '4471', batches: [['B7', 'B8']] },
  BSD05: { product: '4471', batches: [['B7'], ['B7'], ['B7']], allocated: { 3: { order: 'ORD-1017', job: 'J-517', jobStatus: 'RESERVED' } } },
  BSD06: { product: '4471', batches: [['B7'], ['B7'], ['B7']], cases: { 3: 12 } },
};

const pick = <T,>(arr: readonly T[], r: () => number): T => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];

// Each zone stocks a couple of products (the story zones BSD/BSE only Cola, as in
// the fixture); which ones is seeded by the zone code so it never changes.
function zoneProducts(block: string): Product[] {
  if (block === 'BSD' || block === 'BSE') return [productByCode.get('4471')!];
  const r = seededRng('bszone:' + block);
  const n = 2 + Math.floor(r() * 2); // 2–3 products per zone
  const pool = [...PRODUCTS];
  const out: Product[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}
const zoneProductCache = new Map<string, Product[]>();

interface PodPlan {
  product: Product;
  batches: string[];
  cases: number;
  alloc: Allocation | null;
}

// Seeded demo fill for every lane: which pallets stand in it, in fill order (the
// back position first, stacked to the top before the next position is started —
// a truck cannot reach over a stack), what they carry, and which are already
// allocated. Same names → same pallets on every reload.
export function buildDemoLaneStock(lanes: Segment[]): Map<string, LaneStock> {
  const out = new Map<string, LaneStock>();
  let orderSeq = 1010;
  for (const lane of lanes) {
    const cfg = lane.lane;
    if (!cfg) continue;
    const r = seededRng('bs:' + lane.fullName);
    const fx = FIXTURE[lane.fullName];
    let plan: PodPlan[] = [];

    if (fx) {
      const product = productByCode.get(fx.product)!;
      plan = fx.batches.map((b, i) => {
        const a = fx.allocated?.[i + 1];
        const cases = fx.cases?.[i + 1] ?? product.casesPerPallet;
        return {
          product, batches: b, cases,
          alloc: a ? { order: a.order, job: a.job, qty: cases, jobStatus: a.jobStatus ?? 'AVAILABLE' } : null,
        };
      });
    } else if (r() < 0.82) {
      // Fill counts skew toward full lanes; a few stay nearly empty.
      const count = Math.min(cfg.maxPods, 1 + Math.floor(Math.pow(r(), 0.7) * cfg.maxPods));
      const products = zoneProductCache.get(cfg.block) ?? zoneProductCache.set(cfg.block, zoneProducts(cfg.block)).get(cfg.block)!;
      // One product per lane under either policy (the class always includes it);
      // a batch policy pins the lane to one batch, product-only lets them mix.
      const laneProduct = pick(products, r);
      const laneBatch = pick(BATCHES, r);
      for (let i = 0; i < count; i++) {
        const batches = cfg.policy === 'BS-PRODUCT-ONLY' ? [pick(BATCHES, r)] : [laneBatch];
        // Only the face pallet can be part-picked: it is the only one anyone can
        // reach, and nothing may be stacked on a short load.
        const partial = i === count - 1 && r() < 0.25;
        const cases = partial ? Math.max(4, Math.round(laneProduct.casesPerPallet * (0.25 + r() * 0.5))) : laneProduct.casesPerPallet;
        // About one pallet in ten is booked to an order; a few of those jobs are
        // already in a picker's hands (RESERVED), which blocks displacement.
        let alloc: Allocation | null = null;
        if (r() < 0.1) {
          alloc = { order: `ORD-${orderSeq}`, job: `J-${500 + (orderSeq % 900)}`, qty: cases, jobStatus: r() < 0.15 ? 'RESERVED' : 'AVAILABLE' };
          orderSeq++;
        }
        plan.push({ product: laneProduct, batches, cases, alloc });
      }
    }

    // Stack heights are cumulative per position: each pallet's base is the top of
    // the pallet (and load) beneath it, so a short load never leaves the pallet
    // above it hanging in the air.
    const columnTop: number[] = [];
    const pods: LanePod[] = plan.map((p, i) => {
      const index = i + 1;
      const column = Math.floor(i / cfg.tiers);
      const tier = i % cfg.tiers;
      const z0 = columnTop[column] ?? 0;
      columnTop[column] = z0 + podHeight(p) + BS.STACK_GAP;
      return {
        code: `${lane.fullName}-${String(index).padStart(2, '0')}`,
        lane: lane.fullName,
        index,
        column,
        tier,
        z0,
        product: p.product,
        batches: p.batches,
        cases: p.cases,
        classKey: classKeyFor(p.product.code, p.batches, cfg.policy),
        allocation: p.alloc,
      };
    });
    out.set(lane.fullName, { lane, pods, classKey: pods.length > 0 ? pods[0].classKey : null });
  }
  return out;
}

// The face pallet: last in, first reachable.
export const facePod = (stock: LaneStock): LanePod | null =>
  stock.pods.length ? stock.pods[stock.pods.length - 1] : null;

// "4471 · B7" / "4471" / "4471 · B7+B8" — a class key for people.
export const describeClassKey = (key: string): string => {
  const [product, batch] = key.split('|');
  return batch ? `${product} · ${batch}` : product;
};

// The class the lane is holding, or null when it is empty.
export function describeClass(stock: LaneStock): string | null {
  return stock.classKey ? describeClassKey(stock.classKey) : null;
}

// What is physically in the lane: "4471 · B7, B9".
export function describeContents(stock: LaneStock): string | null {
  if (stock.pods.length === 0) return null;
  const products = [...new Set(stock.pods.map((p) => p.product.code))];
  const batches = [...new Set(stock.pods.flatMap((p) => p.batches))];
  return `${products.join(', ')} · ${batches.join(', ')}`;
}

// "Face pallet · position 17 of 18 · front row, level 5 of 6"
export function describePodPosition(pod: LanePod, cfg: LaneConfig, podCount: number): string {
  const row = cfg.deep - pod.column; // 1 = nearest the face
  const rowWord = row === 1 ? 'front row' : row === cfg.deep ? 'back row' : `row ${row}`;
  // A single-column lane is just a stack: the last pallet in is the top one.
  if (cfg.deep === 1) {
    const top = pod.index === podCount ? 'Top pod · ' : '';
    return `${top}position ${pod.index} of ${cfg.maxPods} · level ${pod.tier + 1} of ${cfg.tiers}`;
  }
  const face = pod.index === podCount ? 'Face pod · ' : '';
  return `${face}position ${pod.index} of ${cfg.maxPods} · ${rowWord}, level ${pod.tier + 1} of ${cfg.tiers}`;
}
