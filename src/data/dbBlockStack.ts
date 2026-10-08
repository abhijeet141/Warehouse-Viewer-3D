import type { LaneConfig, LaneDbInfo, Segment } from '../types';
import { getAll, getByIds, type DbCredentials } from './dbApi';
import {
  BS, DRIVE_AISLES, driveAisleSegments, podHeight,
  type Allocation, type DriveAisle, type LanePod, type LaneStock, type PodLineInfo, type PodQuantity, type Product,
} from './blockStack';
import { hashString } from '../lib/rng';

// DB mode: the real block stack of the local location_service — its segment
// definition, areas (zones) and lanes, the stock-mix policy each zone resolves to,
// the lanes' live hashes and counts, and the pallets (pods + pod lines) standing in
// them — read through the services' GET endpoints only (see dbApi.ts) and laid out
// on the same floor the seeded demo uses. The DB holds no coordinates for these
// segments (every one is 0,0,0), so the layout is synthesised: zones are placed in
// order of zonePreference into the rows either side of the drive aisles, and a
// lane's shape follows its maximumPods (5 → a single stack five high).

export const DB_DEFINITION_CODE = 'SAX1-SD-BLOCK-STACK';

// ---- what we read from the services -------------------------------------------

interface ApiDefinition { id: number; code: string; name: string; warehouse_id: number }
interface ApiDst { id: number; segmentDefinition_id: number; segmentType_id: number; parentSegmentType_id: number | null; sequence: number }
interface ApiSegmentType { id: number; name: string; code: string }
interface ApiZoneLink {
  zoneAccount_id: number; zone_id: number; zoneCode: string; account_id: number;
  zonePreference: number | null; putawayPreference: number | null; allocationPreference: number | null; pickSequence: number | null;
}
interface ApiSegment {
  id: number; name: string; fullName: string; warehouse_id: number; parentSegment_id: number | null;
  definitionSegmentType_id: number; currentPodType_id: number | null; currentPodCount: number;
  trackStockMix: boolean; stockMixPolicy_id: number | null; currentStockMixHash: string | null;
  segmentStatus?: { name: string } | null;
  segmentMaxPodTypes?: { podType_id: number; maximumPods: number }[] | null;
  zones?: ApiZoneLink[] | null;
}
interface ApiZone { id: number; code: string; name: string }
interface ApiZoneStockMix { zoneAccountMatrix_id: number; stockMixPolicy_id: number }
interface ApiPolicy { id: number; code: string; name: string; substitutionScope: string; maxSubstitutionCandidates: number }
interface ApiPolicyKey { stockMixPolicy_id: number; stockHashKeyCode: string }
interface ApiQuantity { quantity: number; order_id: number | null; orderLine_id: number | null; job_id: number | null }
type ApiQtyBucket = { totalQuantity: number; quantities?: ApiQuantity[] | null } | null;
type QtyField = 'quantityAvailable' | 'quantityAllocated' | 'quantityHeld' | 'quantityPicked' | 'quantityReceipted'
  | 'quantityAwaitingMovement' | 'quantityKitted' | 'quantityPacked' | 'quantitySorted';
interface ApiPodLine extends Partial<Record<QtyField, ApiQtyBucket>> {
  uuid: string; product_id: number; uom_id: number; totalQuantity: number; inboundOrderLine_id: number | null;
  batches?: { value: string }[] | null;
}
// Quantity types as pod-and-lines groups them, in the order their tags stack on the
// pallet face: the booking first, then free stock, then the rest.
const QUANTITY_TYPES: [QtyField, string][] = [
  ['quantityAllocated', 'ALLOCATED'], ['quantityAvailable', 'AVAILABLE'], ['quantityHeld', 'HELD'],
  ['quantityPicked', 'PICKED'], ['quantityReceipted', 'RECEIPTED'], ['quantityAwaitingMovement', 'AWAITING MOVEMENT'],
  ['quantityKitted', 'KITTED'], ['quantityPacked', 'PACKED'], ['quantitySorted', 'SORTED'],
];
interface ApiPod {
  uuid: string; segment_id: number | null; bucket_uuid?: string | null; account_id: number; podType_id: number; dateCreated: string;
  isEmpty: boolean; actualised: boolean;
  podLines?: ApiPodLine[] | null;
  podType?: { name: string; code: string } | null;
}
interface ApiProduct { id: number; sku: string; title: string }
interface ApiUom { id: number; code: string; name: string }
interface ApiPodType { id: number; name: string }
interface ApiPickJob {
  id: number; job_id: number; fromSegment_id: number | null; toSegment_id: number | null;
  fromPod_uuid: string | null; order_id: number | null; orderLine_id: number | null; quantityAllocated: number;
}
interface ApiJob { id: number; jobStatus_id: number; reservedByUser_id: number | null; dateUpdated: string }
interface ApiQuantityType { id: number; name: string }
interface ApiPodLineQuantity { podLine_uuid: string; job_id: number | null; order_id: number | null; quantity: number }
interface ApiPodLineRef { uuid: string; pod_uuid: string }
interface ApiJobStatus { id: number; name: string; code: string }
interface ApiProcess { id: number; code: string }
interface ApiUseType { id: number; code: string; name: string }
interface ApiUseTypeProcess { useType_id: number; process_id: number }
interface ApiSegmentUseType { segment_id: number; useType_id: number }

// ---- result -------------------------------------------------------------------

export interface DbPolicySummary { code: string; name: string; keys: string[]; scope: string; candidates: number; zones: string[] }
export interface DbSummary {
  definition: { id: number; code: string; name: string };
  warehouseId: number;
  areaType: string;
  laneType: string;
  zones: number;
  lanes: number;
  lanesUsed: number;
  pallets: number;
  podLines: number;
  policies: DbPolicySummary[];
  emptyZones: string[];      // zones (area codes) with no stock at all
  overfullLanes: string[];   // lanes holding more pods than maximumPods
  driftLanes: string[];      // lanes whose currentPodCount disagrees with the pods found
  pickTrail: {
    jobs: { status: string; count: number }[];                          // pick jobs on block-stack pallets
    inBucket: number;                                                   // picked, not yet dropped
    locations: { name: string; pallets: number; useTypes: string[] }[]; // pick location pads
  };
  fetchedAt: Date;
}
export interface DbLoadResult {
  segments: Segment[];             // drive aisles + BLOCK areas + LANE segments
  stock: Map<string, LaneStock>;   // by lane fullName
  summary: DbSummary;
}

// ---- layout -------------------------------------------------------------------

const MAX_TIERS = 6;       // never stack higher than the demo does
const FRONT_CLEAR = 400;   // slab left free at the face inside the lane outline
const ZONE_GAP = 1500;     // between neighbouring zones in one row
const DEFAULT_MAX_PODS = 5;
const PAD_X0 = -14500;     // pick location pads stand left of the banks, on the slab
const PAD_COLS = 7;        // slots per pad row
const PAD_GAP = 3200;      // between pads, room for the stencilled name

// How a lane is stacked for a given capacity: as high as allowed first, then deep.
export function laneShape(maxPods: number): { deep: number; tiers: number; laneD: number } {
  const tiers = Math.max(1, Math.min(MAX_TIERS, maxPods));
  const deep = Math.max(1, Math.ceil(maxPods / tiers));
  return { deep, tiers, laneD: deep * BS.COL_PITCH + BS.BACK_CLEAR + FRONT_CLEAR };
}

// Rows the zones are dealt into, in order: the corner slab either side of BS1, then
// both sides of BS2, BS3 and BS4. The corner aisle is the demo's; the bulk-floor
// aisles are packed for the lane depth actually drawn, so each bank is a row, its
// drive aisle and a second row standing back to back with the next bank — the demo's
// geometry at 3.5 m, and no empty slab behind the stacks at any other depth.
interface Slot { aisle: DriveAisle; faceDir: 1 | -1; x0: number; x1: number }
const CROSS_AISLE_Y = -4500;                 // the A-row cross-aisle stays clear down to here
const CORNER_X = { x0: 2000, x1: 37000 };
const BANK_X = { x0: 2500, x1: 104800 };
const BANK_AISLES = ['BS2', 'BS3', 'BS4'];

function buildFloor(rowD: number): { aisles: DriveAisle[]; slots: Slot[] } {
  const bs1 = DRIVE_AISLES.find((a) => a.name === 'BS1')!;
  const aisles: DriveAisle[] = [bs1];
  const slots: Slot[] = [
    { aisle: bs1, faceDir: 1, ...CORNER_X },
    { aisle: bs1, faceDir: -1, ...CORNER_X },
  ];
  let top = CROSS_AISLE_Y;
  for (const name of BANK_AISLES) {
    const aisle: DriveAisle = { name, x: 0, y: top - rowD - BS.AISLE_W, w: 107400, d: BS.AISLE_W };
    aisles.push(aisle);
    slots.push({ aisle, faceDir: -1, ...BANK_X }, { aisle, faceDir: 1, ...BANK_X });
    top = aisle.y - rowD;
  }
  return { aisles, slots };
}

const laneHeight = (tiers: number): number => tiers * BS.TIER_PITCH + BS.HEADROOM;

// Load colours: hue per product (in id order, so it is stable between loads),
// lightness per batch value — or per UOM when that is what the policy keys on.
const HUES = [172, 42, 208, 18, 105, 275, 330, 62, 240, 140, 300, 80];
const SHADES = [0.42, 0.66, 0.34, 0.74, 0.5, 0.58];
const UOM_SHADE: Record<string, number> = { UNIT: 0.5, EACH: 0.62, CASE: 0.4, PALLET: 0.3 };

interface Area {
  seg: ApiSegment;
  lanes: ApiSegment[];
  link: ApiZoneLink | null;
  zone: ApiZone | null;
  policy: ApiPolicy | null;
  keys: string[];
  source: 'segment' | 'zone' | null;
}

const byNum = (a: number | null | undefined, b: number | null | undefined): number =>
  (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);

export async function loadDbBlockStack(
  creds: DbCredentials | null,
  onProgress: (msg: string) => void = () => {},
): Promise<DbLoadResult> {
  // 1. The definition and its two segment types (area → lane).
  onProgress(`Reading segment definition ${DB_DEFINITION_CODE}…`);
  const defs = await getAll<ApiDefinition>('locations', 'segment-definitions', { code: DB_DEFINITION_CODE }, creds);
  const def = defs[0];
  if (!def) throw new Error(`Segment definition ${DB_DEFINITION_CODE} was not found in location_service.`);
  const dsts = (await getAll<ApiDst>('locations', 'definition-segment-type-matrix', { segmentDefinition_id: def.id }, creds))
    .sort((a, b) => a.sequence - b.sequence);
  if (dsts.length === 0) throw new Error(`Definition ${def.code} has no segment types.`);
  const types = await getByIds<ApiSegmentType>('locations', 'segment-types', 'id', dsts.map((d) => d.segmentType_id), creds);
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const areaDst = dsts.find((d) => d.parentSegmentType_id === null) ?? dsts[0];
  const laneDst = dsts.find((d) => d.id !== areaDst.id) ?? areaDst;

  // 2. Every segment of the definition: areas and their lanes.
  onProgress('Reading segments…');
  const segs = await getByIds<ApiSegment>('locations', 'segments', 'definitionSegmentType_id', dsts.map((d) => d.id), creds);
  const areaSegs = segs.filter((s) => s.definitionSegmentType_id === areaDst.id);
  const laneSegs = segs.filter((s) => s.definitionSegmentType_id === laneDst.id);
  onProgress(`Read ${areaSegs.length} areas and ${laneSegs.length} lanes…`);
  if (laneSegs.length === 0) throw new Error(`Definition ${def.code} has no lanes.`);

  // 3. Zones and the stock-mix policy each zone (or lane) resolves to.
  onProgress('Reading zones and stock-mix policies…');
  const links = laneSegs.flatMap((s) => s.zones ?? []);
  const zones = await getByIds<ApiZone>('locations', 'zones', 'id', links.map((l) => l.zone_id), creds);
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const zoneMix = await getByIds<ApiZoneStockMix>('locations', 'zone-account-stock-mix-matrix', 'zoneAccountMatrix_id', links.map((l) => l.zoneAccount_id), creds);
  const policyByZam = new Map(zoneMix.map((m) => [m.zoneAccountMatrix_id, m.stockMixPolicy_id]));
  const policyIds = [...zoneMix.map((m) => m.stockMixPolicy_id), ...laneSegs.map((s) => s.stockMixPolicy_id).filter((id): id is number => id !== null)];
  const policies = policyIds.length ? await getByIds<ApiPolicy>('locations', 'stock-mix-policies', 'id', policyIds, creds) : [];
  const policyById = new Map(policies.map((p) => [p.id, p]));
  const keyRows = policyIds.length ? await getByIds<ApiPolicyKey>('locations', 'stock-mix-policy-keys', 'stockMixPolicy_id', policyIds, creds) : [];
  const keysByPolicy = new Map<number, string[]>();
  for (const k of keyRows) (keysByPolicy.get(k.stockMixPolicy_id) ?? keysByPolicy.set(k.stockMixPolicy_id, []).get(k.stockMixPolicy_id)!).push(k.stockHashKeyCode);
  for (const list of keysByPolicy.values()) list.sort();

  // 4. The pallets standing in the lanes, with their lines.
  onProgress('Reading pallets…');
  const pods = (await getByIds<ApiPod>('pods', 'pod-and-lines', 'segment_id', laneSegs.map((s) => s.id), creds))
    .filter((p) => !p.isEmpty || (p.podLines?.length ?? 0) > 0);
  const lines = pods.flatMap((p) => p.podLines ?? []);
  onProgress(`Read ${pods.length} pallets with ${lines.length} pod lines…`);

  // 5. The pick trail. A confirmed pick lifts the pallet out of its lane into the
  //    picker's bucket (segment NULL) and completes the job; the drop moves it to the
  //    job's toSegment and deletes the job. So: jobs from the lanes tell the stage,
  //    the pick locations — use types that pack or despatch and never receive or put
  //    away, plus any job destination — show what stands there, and the pallets on
  //    completed jobs that are nowhere yet are still in a bucket.
  onProgress('Reading pick jobs and pick locations…');
  const pickJobs = await getByIds<ApiPickJob>('jobs', 'pick-jobs', 'fromSegment_id', laneSegs.map((s) => s.id), creds);
  const jobRows = pickJobs.length ? await getByIds<ApiJob>('jobs', 'jobs', 'id', pickJobs.map((j) => j.job_id), creds) : [];
  const jobStatuses = pickJobs.length ? await getAll<ApiJobStatus>('jobs', 'job-statuses', {}, creds) : [];
  const statusName = new Map(jobStatuses.map((s) => [s.id, (s.code || s.name).toUpperCase()]));
  const jobById = new Map(jobRows.map((j) => [j.id, j]));
  const statusOf = (pj: ApiPickJob) => statusName.get(jobById.get(pj.job_id)?.jobStatus_id ?? -1) ?? 'UNKNOWN';
  const pickByPod = new Map<string, { job: ApiPickJob; status: string }>();
  for (const pj of pickJobs) if (pj.fromPod_uuid) pickByPod.set(pj.fromPod_uuid, { job: pj, status: statusOf(pj) });
  // A confirmed pick usually splits the picked quantity into a NEW pod in the picker's
  // bucket (the source pallet stays in the lane, lighter); only that pod's PICKED
  // quantity rows carry the job id, so the picked pods are found through them.
  const jobByJobId = new Map(pickJobs.map((j) => [j.job_id, j]));
  const qTypes = pickJobs.length ? await getAll<ApiQuantityType>('pods', 'quantity-types', {}, creds) : [];
  const pickedTypeId = qTypes.find((t) => t.name.toLowerCase() === 'picked')?.id ?? null;
  const pickedRows = pickJobs.length && pickedTypeId !== null
    ? await getByIds<ApiPodLineQuantity>('pods', 'pod-line-quantities', 'job_id', pickJobs.map((j) => j.job_id), creds, { quantityType_id: pickedTypeId })
    : [];
  const pickedLineRefs = pickedRows.length ? await getByIds<ApiPodLineRef>('pods', 'pod-lines', 'uuid', pickedRows.map((r) => r.podLine_uuid), creds) : [];
  const jobByLine = new Map(pickedRows.map((r) => [r.podLine_uuid, r.job_id]));
  const pickedPodUuids = new Set<string>();
  for (const ref of pickedLineRefs) {
    const job = jobByJobId.get(jobByLine.get(ref.uuid) ?? -1);
    if (!job) continue;
    pickedPodUuids.add(ref.pod_uuid);
    if (!pickByPod.has(ref.pod_uuid)) pickByPod.set(ref.pod_uuid, { job, status: statusOf(job) });
  }
  const processes = await getAll<ApiProcess>('locations', 'processes', {}, creds);
  const procId = (code: string) => processes.find((p) => p.code === code)?.id ?? -1;
  const utp = await getAll<ApiUseTypeProcess>('locations', 'use-type-process-matrix', {}, creds);
  const procsByUt = new Map<number, Set<number>>();
  for (const r of utp) (procsByUt.get(r.useType_id) ?? procsByUt.set(r.useType_id, new Set()).get(r.useType_id)!).add(r.process_id);
  const outTypes = [...procsByUt.entries()]
    .filter(([, ps]) => (ps.has(procId('PACK-FROM')) || ps.has(procId('DESPATCH-FROM'))) && !ps.has(procId('RECEIPT-TO')) && !ps.has(procId('PUTAWAY-TO')))
    .map(([id]) => id);
  const useTypes = outTypes.length ? await getByIds<ApiUseType>('locations', 'use-types', 'id', outTypes, creds) : [];
  const useTypeCode = new Map(useTypes.map((u) => [u.id, u.code || u.name]));
  const sutm = outTypes.length ? await getByIds<ApiSegmentUseType>('locations', 'segment-use-type-matrix', 'useType_id', outTypes, creds) : [];
  const pickSegIds = new Set<number>(sutm.map((r) => r.segment_id));
  for (const pj of pickJobs) if (pj.toSegment_id !== null) pickSegIds.add(pj.toSegment_id);
  const pickSegs = pickSegIds.size
    ? (await getByIds<ApiSegment>('locations', 'segments', 'id', [...pickSegIds], creds)).filter((s) => s.warehouse_id === def.warehouse_id)
    : [];
  const utBySeg = new Map<number, string[]>();
  for (const r of sutm) (utBySeg.get(r.segment_id) ?? utBySeg.set(r.segment_id, []).get(r.segment_id)!).push(useTypeCode.get(r.useType_id) ?? `use type ${r.useType_id}`);
  const dropPods = pickSegs.length
    ? (await getByIds<ApiPod>('pods', 'pod-and-lines', 'segment_id', pickSegs.map((s) => s.id), creds)).filter((p) => (p.podLines?.length ?? 0) > 0)
    : [];
  const knownPods = new Set([...pods, ...dropPods].map((p) => p.uuid));
  const goneUuids = [...new Set([...pickByPod.keys(), ...pickedPodUuids])].filter((u) => !knownPods.has(u));
  const bucketPods = goneUuids.length
    ? (await getByIds<ApiPod>('pods', 'pod-and-lines', 'uuid', goneUuids, creds)).filter((p) => p.segment_id === null)
    : [];
  onProgress(`Read ${pickJobs.length} pick jobs, ${dropPods.length} pallets on ${pickSegs.length} pick locations, ${bucketPods.length} in buckets…`);

  const allPods = [...pods, ...dropPods, ...bucketPods];
  const allLines = allPods.flatMap((p) => p.podLines ?? []);
  const productIds = [...new Set(allLines.map((l) => l.product_id))].sort((a, b) => a - b);
  const uomIds = [...new Set(allLines.map((l) => l.uom_id))];
  const podTypeIds = [...new Set(allPods.map((p) => p.podType_id))];
  const [products, uoms, podTypes] = await Promise.all([
    productIds.length ? getByIds<ApiProduct>('products', 'products', 'id', productIds, creds) : Promise.resolve([] as ApiProduct[]),
    uomIds.length ? getByIds<ApiUom>('products', 'units-of-measures', 'id', uomIds, creds) : Promise.resolve([] as ApiUom[]),
    podTypeIds.length ? getByIds<ApiPodType>('pods', 'pod-types', 'id', podTypeIds, creds) : Promise.resolve([] as ApiPodType[]),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const uomCode = new Map(uoms.map((u) => [u.id, u.code || u.name]));
  const podTypeName = new Map(podTypes.map((t) => [t.id, t.name]));

  onProgress('Laying out the floor…');

  // ---- areas → zones -------------------------------------------------------------
  const lanesByArea = new Map<number, ApiSegment[]>();
  for (const l of laneSegs) {
    const pid = l.parentSegment_id ?? -1;
    (lanesByArea.get(pid) ?? lanesByArea.set(pid, []).get(pid)!).push(l);
  }
  const areas: Area[] = areaSegs.map((seg) => {
    const lanes = (lanesByArea.get(seg.id) ?? []).sort((a, b) => byNum(a.zones?.[0]?.putawayPreference, b.zones?.[0]?.putawayPreference) || a.fullName.localeCompare(b.fullName));
    // The zone most of the area's lanes belong to (they should all agree).
    const tally = new Map<number, { n: number; link: ApiZoneLink }>();
    for (const l of lanes) for (const z of l.zones ?? []) {
      const t = tally.get(z.zone_id) ?? tally.set(z.zone_id, { n: 0, link: z }).get(z.zone_id)!;
      t.n++;
    }
    const link = [...tally.values()].sort((a, b) => b.n - a.n)[0]?.link ?? null;
    const zonePolicyId = link ? policyByZam.get(link.zoneAccount_id) ?? null : null;
    const policy = zonePolicyId !== null ? policyById.get(zonePolicyId) ?? null : null;
    return {
      seg, lanes, link, zone: link ? zoneById.get(link.zone_id) ?? null : null,
      policy, keys: policy ? keysByPolicy.get(policy.id) ?? [] : [], source: policy ? 'zone' : null,
    };
  });
  // Lanes whose parent is not an area of this definition are still shown, under a
  // synthetic area named after their prefix.
  for (const [pid, lanes] of lanesByArea) {
    if (areaSegs.some((a) => a.id === pid)) continue;
    const name = lanes[0].fullName.replace(/\d+$/, '') || `AREA-${pid}`;
    areas.push({ seg: { ...lanes[0], id: pid, fullName: name, name, parentSegment_id: null, currentPodCount: 0 }, lanes, link: null, zone: null, policy: null, keys: [], source: null });
  }
  areas.sort((a, b) => byNum(a.link?.zonePreference, b.link?.zonePreference) || a.seg.fullName.localeCompare(b.seg.fullName));

  // ---- placement -----------------------------------------------------------------
  // A lane's capacity: the row for its current pod type, else the smallest declared.
  const maxPodsOf = (l: ApiSegment): number => {
    const rows = l.segmentMaxPodTypes ?? [];
    const cur = rows.find((r) => r.podType_id === l.currentPodType_id)?.maximumPods;
    const min = rows.length ? Math.min(...rows.map((r) => r.maximumPods)) : DEFAULT_MAX_PODS;
    return Math.max(1, cur ?? min);
  };
  // One shape per area (the widest capacity its lanes declare); the deepest shape
  // sets the row pitch of the bulk floor.
  const shapeByArea = new Map(areas.filter((a) => a.lanes.length > 0).map((a) => [a.seg.id, laneShape(Math.max(...a.lanes.map(maxPodsOf)))]));
  const rowD = Math.max(laneShape(DEFAULT_MAX_PODS).laneD, ...[...shapeByArea.values()].map((s) => s.laneD));
  const { aisles, slots: SLOTS } = buildFloor(rowD);
  const cursor = SLOTS.map((s) => s.x0);
  const segments: Segment[] = driveAisleSegments(aisles);
  const laneSegments: Segment[] = [];
  const podsByLane = new Map<number, ApiPod[]>();
  for (const p of pods) if (p.segment_id !== null) (podsByLane.get(p.segment_id) ?? podsByLane.set(p.segment_id, []).get(p.segment_id)!).push(p);

  for (const area of areas) {
    if (area.lanes.length === 0) continue;
    const width = area.lanes.length * BS.LANE_W;
    let si = SLOTS.findIndex((s, i) => cursor[i] + width <= s.x1);
    if (si < 0) {
      // Nothing has room: take the emptiest row and let it overhang.
      si = SLOTS.map((s, i) => s.x1 - cursor[i]).reduce((best, room, i, arr) => (room > arr[best] ? i : best), 0);
      console.warn(`[db mode] zone ${area.seg.fullName} (${area.lanes.length} lanes) does not fit a row; overhanging.`);
    }
    const slot = SLOTS[si];
    const aisle = slot.aisle;
    const x0 = cursor[si];
    cursor[si] += width + ZONE_GAP;

    const shape = shapeByArea.get(area.seg.id) ?? laneShape(DEFAULT_MAX_PODS);
    // The face always sits on the aisle edge; a shallower zone leaves its gap at the back.
    const y0 = slot.faceDir > 0 ? aisle.y - shape.laneD : aisle.y + aisle.d;
    const h = laneHeight(shape.tiers);

    segments.push({
      fullName: area.seg.fullName, type: 'BLOCK', id: area.seg.id,
      coordinateX: x0, coordinateY: y0, coordinateZ: 0,
      dimensionX: width, dimensionY: shape.laneD, dimensionZ: h,
      offsetX: 0, offsetY: 0, offsetZ: 0,
      floorStorage: true,
    });

    area.lanes.forEach((l, i) => {
      const link = l.zones?.[0] ?? area.link;
      const lanePolicy = l.stockMixPolicy_id !== null ? policyById.get(l.stockMixPolicy_id) ?? null : null;
      const policy = lanePolicy ?? area.policy;
      const keys = policy ? keysByPolicy.get(policy.id) ?? [] : [];
      const maxPods = maxPodsOf(l);
      const own = laneShape(maxPods);
      const db: LaneDbInfo = {
        segmentId: l.id,
        zoneId: link?.zone_id ?? null,
        zoneCode: link ? (zoneById.get(link.zone_id)?.code ?? link.zoneCode) : null,
        zoneName: link ? (zoneById.get(link.zone_id)?.name ?? null) : null,
        accountId: link?.account_id ?? null,
        zonePreference: link?.zonePreference ?? null,
        putawayPreference: link?.putawayPreference ?? null,
        allocationPreference: link?.allocationPreference ?? null,
        pickSequence: link?.pickSequence ?? null,
        policyId: policy?.id ?? null,
        policyName: policy?.name ?? null,
        policyKeys: keys,
        policySource: lanePolicy ? 'segment' : policy ? 'zone' : null,
        hash: l.currentStockMixHash,
        currentPodCount: l.currentPodCount,
        status: l.segmentStatus?.name ?? '—',
        podTypeName: l.currentPodType_id !== null ? podTypeName.get(l.currentPodType_id) ?? `pod type ${l.currentPodType_id}` : null,
        mixedClasses: false,
      };
      const cfg: LaneConfig = {
        block: area.seg.fullName,
        deep: Math.min(own.deep, shape.deep), tiers: Math.min(own.tiers, shape.tiers), maxPods,
        faceDir: slot.faceDir, trackStockMix: l.trackStockMix, policy: policy?.code ?? null, db,
      };
      const seg: Segment = {
        fullName: l.fullName, type: 'LANE', id: l.id,
        coordinateX: x0 + i * BS.LANE_W, coordinateY: y0, coordinateZ: 0,
        dimensionX: BS.LANE_W, dimensionY: shape.laneD, dimensionZ: h,
        offsetX: 0, offsetY: 0, offsetZ: 0,
        floorStorage: true,
        lane: cfg,
      };
      segments.push(seg);
      laneSegments.push(seg);
    });
  }

  // ---- pick locations → pads --------------------------------------------------------
  // One pad per pick location that holds something or is a job's destination: slots in
  // rows of PAD_COLS, one pallet each, newest pallets first, then the pallets still in
  // a bucket on their way here.
  const segNameById = new Map<number, string>([...laneSegs, ...pickSegs].map((s) => [s.id, s.fullName]));
  const padShape = laneShape(1);
  const padItems: { seg: Segment; pod: ApiPod; place: 'drop' | 'bucket' }[] = [];
  const padSummary: { name: string; pallets: number; useTypes: string[] }[] = [];
  const byDate = (a: ApiPod, b: ApiPod) => b.dateCreated.localeCompare(a.dateCreated) || a.uuid.localeCompare(b.uuid);
  let padTop = CROSS_AISLE_Y - 2000;
  for (const ps of [...pickSegs].sort((a, b) => a.fullName.localeCompare(b.fullName))) {
    const dropped = dropPods.filter((p) => p.segment_id === ps.id).sort(byDate);
    const coming = bucketPods.filter((p) => pickByPod.get(p.uuid)?.job.toSegment_id === ps.id).sort(byDate);
    const isTarget = pickJobs.some((j) => j.toSegment_id === ps.id);
    if (dropped.length + coming.length === 0 && !isTarget) continue;
    const items = [...dropped.map((pod) => ({ pod, place: 'drop' as const })), ...coming.map((pod) => ({ pod, place: 'bucket' as const }))];
    const n = Math.max(1, items.length);
    const rows = Math.ceil(n / PAD_COLS);
    const cols = Math.min(PAD_COLS, n);
    const y0 = padTop - rows * padShape.laneD;
    segments.push({
      fullName: ps.fullName, type: 'BLOCK', id: ps.id,
      coordinateX: PAD_X0, coordinateY: y0, coordinateZ: 0,
      dimensionX: cols * BS.LANE_W, dimensionY: rows * padShape.laneD, dimensionZ: laneHeight(1),
      offsetX: 0, offsetY: 0, offsetZ: 0,
      floorStorage: true,
    });
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / PAD_COLS);
      const c = i % PAD_COLS;
      const db: LaneDbInfo = {
        segmentId: ps.id, zoneId: null, zoneCode: null, zoneName: null, accountId: null,
        zonePreference: null, putawayPreference: null, allocationPreference: null, pickSequence: null,
        policyId: null, policyName: null, policyKeys: [], policySource: null, hash: null,
        currentPodCount: ps.currentPodCount, status: ps.segmentStatus?.name ?? '—', podTypeName: null, mixedClasses: false,
        role: 'pick-location', useTypes: utBySeg.get(ps.id) ?? [],
      };
      const cfg: LaneConfig = { block: ps.fullName, deep: 1, tiers: 1, maxPods: 1, faceDir: -1, trackStockMix: false, policy: null, db };
      const seg: Segment = {
        fullName: `${ps.fullName}-${String(i + 1).padStart(2, '0')}`, type: 'LANE', id: ps.id,
        coordinateX: PAD_X0 + c * BS.LANE_W, coordinateY: padTop - (r + 1) * padShape.laneD, coordinateZ: 0,
        dimensionX: BS.LANE_W, dimensionY: padShape.laneD, dimensionZ: laneHeight(1),
        offsetX: 0, offsetY: 0, offsetZ: 0,
        floorStorage: true,
        lane: cfg,
      };
      segments.push(seg);
      if (items[i]) padItems.push({ seg, ...items[i] });
    }
    padSummary.push({ name: ps.fullName, pallets: items.length, useTypes: utBySeg.get(ps.id) ?? [] });
    padTop = y0 - PAD_GAP;
  }

  // ---- pallets → LanePods ----------------------------------------------------------
  const productHue = new Map(productIds.map((id, i) => [id, HUES[i % HUES.length]]));
  const productObj = new Map<number, Product>();
  const maxQtyByProduct = new Map<number, number>();
  for (const p of allPods) {
    const byProduct = new Map<number, number>();
    for (const l of p.podLines ?? []) byProduct.set(l.product_id, (byProduct.get(l.product_id) ?? 0) + l.totalQuantity);
    for (const [id, q] of byProduct) maxQtyByProduct.set(id, Math.max(maxQtyByProduct.get(id) ?? 0, q));
  }
  const product = (id: number): Product => {
    let p = productObj.get(id);
    if (!p) {
      const api = productById.get(id);
      p = { code: api?.sku ?? `#${id}`, name: api?.title ?? `product ${id}`, casesPerPallet: Math.max(1, maxQtyByProduct.get(id) ?? 1), hue: productHue.get(id) ?? 0 };
      productObj.set(id, p);
    }
    return p;
  };
  const batchShade = new Map<string, number>();
  const shadeOfBatch = (b: string): number => batchShade.get(b) ?? batchShade.set(b, SHADES[batchShade.size % SHADES.length]).get(b)!;

  const stock = new Map<string, LaneStock>();
  const overfullLanes: string[] = [];
  const driftLanes: string[] = [];
  let pallets = 0;
  let podLines = 0;
  const usedZones = new Set<string>();

  // One pallet as the viewer draws it: in a lane (stacked, i = its position), or on
  // a pick-location pad (one per slot), or queued on a pad while still in a bucket.
  const buildPod = (p: ApiPod, lane: Segment, i: number, columnTop: number[], place: 'lane' | 'drop' | 'bucket'): LanePod => {
      const cfg = lane.lane!;
      const db = cfg.db!;
      const ls = (p.podLines ?? []).slice().sort((a, b) => byNum(a.inboundOrderLine_id, b.inboundOrderLine_id) || a.uuid.localeCompare(b.uuid));
      podLines += ls.length;
      const skus = [...new Set(ls.map((l) => product(l.product_id).code))].sort();
      const batches = [...new Set(ls.flatMap((l) => (l.batches ?? []).map((b) => b.value)))].sort();
      const uomsOnPod = [...new Set(ls.map((l) => uomCode.get(l.uom_id) ?? `uom ${l.uom_id}`))].sort();
      const qty = ls.reduce((s, l) => s + l.totalQuantity, 0);
      const productIdsOnPod = [...new Set(ls.map((l) => l.product_id))];
      const prod: Product = productIdsOnPod.length === 1
        ? product(productIdsOnPod[0])
        : { code: skus.join(' + ') || '(empty)', name: productIdsOnPod.length ? 'Mixed pallet' : 'No pod lines', casesPerPallet: Math.max(1, qty), hue: hashString(skus.join('|')) % 360 };

      // The class the lane's policy sees on this pallet, as a label.
      const parts: string[] = [];
      if (db.policyKeys.includes('product-id')) parts.push(skus.join(' + ') || 'no product');
      if (db.policyKeys.includes('batch-value')) parts.push(batches.length ? batches.join(' + ') : 'no batch');
      if (db.policyKeys.includes('unit-of-measure-id')) parts.push(uomsOnPod.join(' + '));
      if (parts.length === 0) {
        parts.push(db.policyKeys.length
          ? `any product · account ${p.account_id}`
          : `${skus.join(' + ')}${batches.length ? ' · ' + batches.join(' + ') : ''}`);
      }
      const classKey = parts.join(' · ');

      // Allocations booked against the pallet (none after a plain putaway, shown when present).
      const allocQ = ls.flatMap((l) => l.quantityAllocated?.quantities ?? []).filter((q) => q.quantity > 0);
      const allocQty = allocQ.reduce((s, q) => s + q.quantity, 0);
      const allocation: Allocation | null = allocQty > 0
        ? {
            order: allocQ[0].order_id !== null ? `order ${allocQ[0].order_id}` : 'allocated',
            job: allocQ[0].job_id !== null ? `job ${allocQ[0].job_id}` : '—',
            qty: allocQty, jobStatus: 'AVAILABLE',
          }
        : null;

      const lineInfo: PodLineInfo[] = ls.map((l) => ({
        product: product(l.product_id).code,
        productName: product(l.product_id).name,
        qty: l.totalQuantity,
        uom: uomCode.get(l.uom_id) ?? `uom ${l.uom_id}`,
        batches: (l.batches ?? []).map((b) => b.value),
        available: l.quantityAvailable?.totalQuantity ?? 0,
        allocated: l.quantityAllocated?.totalQuantity ?? 0,
      }));

      // Every quantity type on the pallet, summed per UOM: the face tags and the tooltip.
      const quantities: PodQuantity[] = [];
      for (const [field, type] of QUANTITY_TYPES) {
        const byUom = new Map<string, number>();
        for (const l of ls) {
          const q = l[field]?.totalQuantity ?? 0;
          if (q > 0) {
            const u = uomCode.get(l.uom_id) ?? `uom ${l.uom_id}`;
            byUom.set(u, (byUom.get(u) ?? 0) + q);
          }
        }
        if (byUom.size === 0) continue;
        const parts = [...byUom.entries()].sort((a, b) => b[1] - a[1]).map(([uom, q]) => ({ uom, qty: q }));
        quantities.push({
          type, byUom: parts,
          total: parts.reduce((s, p) => s + p.qty, 0),
          label: `${type} ${parts.map((p) => `${p.qty} ${p.uom}`).join(' + ')}`,
        });
      }

      const shade = batches.length
        ? batches.map(shadeOfBatch).reduce((a, b) => a + b, 0) / batches.length
        : db.policyKeys.includes('unit-of-measure-id')
          ? uomsOnPod.map((u) => UOM_SHADE[u] ?? 0.55).reduce((a, b) => a + b, 0) / Math.max(1, uomsOnPod.length)
          : 0.5;

      // The pick job on this pallet, and where it is on its way out.
      const pk = pickByPod.get(p.uuid) ?? null;
      const pickJob = pk
        ? {
            id: pk.job.job_id, status: pk.status, order: pk.job.order_id,
            to: pk.job.toSegment_id !== null ? segNameById.get(pk.job.toSegment_id) ?? `segment ${pk.job.toSegment_id}` : null,
            from: pk.job.fromSegment_id !== null ? segNameById.get(pk.job.fromSegment_id) ?? `segment ${pk.job.fromSegment_id}` : null,
          }
        : null;
      const tags = quantities.map((q) => ({ text: q.label, kind: q.type }));
      if (place === 'lane' && pickJob && pickJob.status !== 'COMPLETE') tags.push({ text: `PICKING${pickJob.to ? ' → ' + pickJob.to : ''}`, kind: 'PICKING' });
      if (place === 'bucket') tags.unshift({ text: 'IN BUCKET', kind: 'IN TRANSIT' });

      const index = i + 1;
      const column = Math.floor(i / cfg.tiers);
      const tier = i % cfg.tiers;
      const z0 = columnTop[column] ?? 0;
      const pod: LanePod = {
        code: `${lane.fullName}-${String(index).padStart(2, '0')}`,
        lane: lane.fullName,
        index, column, tier, z0,
        product: prod,
        batches,
        cases: qty,
        classKey,
        allocation,
        uuid: p.uuid,
        lines: lineInfo,
        loadFraction: 1,
        shade: place === 'bucket' ? 0.82 : shade, // a pallet still on the truck is drawn washed out
        podType: p.podType?.name ?? podTypeName.get(p.podType_id) ?? null,
        quantities,
        tags,
        place,
        bucket: p.bucket_uuid ?? null,
        pickJob,
      };
      columnTop[column] = z0 + podHeight(pod) + BS.STACK_GAP;
      return pod;
  };

  for (const lane of laneSegments) {
    const cfg = lane.lane!;
    const db = cfg.db!;
    // Stack order = the order the pallets arrived (receipt order stands in for the
    // putaway order the pods service does not keep).
    const apiPods = (podsByLane.get(lane.id!) ?? []).sort((a, b) => a.dateCreated.localeCompare(b.dateCreated) || a.uuid.localeCompare(b.uuid));
    if (apiPods.length !== db.currentPodCount) driftLanes.push(`${lane.fullName} (${db.currentPodCount} counted, ${apiPods.length} found)`);
    if (apiPods.length > cfg.maxPods) overfullLanes.push(lane.fullName);
    if (apiPods.length) usedZones.add(cfg.block);
    pallets += apiPods.length;
    const columnTop: number[] = [];
    const lanePods = apiPods.map((p, i) => buildPod(p, lane, i, columnTop, 'lane'));
    db.mixedClasses = new Set(lanePods.map((p) => p.classKey)).size > 1;
    stock.set(lane.fullName, { lane, pods: lanePods, classKey: lanePods.length ? lanePods[0].classKey : null });
  }
  for (const it of padItems) {
    const pod = buildPod(it.pod, it.seg, 0, [], it.place);
    stock.set(it.seg.fullName, { lane: it.seg, pods: [pod], classKey: null });
  }

  // ---- summary ---------------------------------------------------------------------
  const policySummary = new Map<number, DbPolicySummary>();
  for (const a of areas) {
    if (!a.policy) continue;
    const s = policySummary.get(a.policy.id) ?? policySummary.set(a.policy.id, {
      code: a.policy.code, name: a.policy.name, keys: keysByPolicy.get(a.policy.id) ?? [],
      scope: a.policy.substitutionScope, candidates: a.policy.maxSubstitutionCandidates, zones: [],
    }).get(a.policy.id)!;
    s.zones.push(a.seg.fullName);
  }
  const summary: DbSummary = {
    definition: { id: def.id, code: def.code, name: def.name },
    warehouseId: def.warehouse_id,
    areaType: typeName.get(areaDst.segmentType_id) ?? 'area',
    laneType: typeName.get(laneDst.segmentType_id) ?? 'lane',
    zones: areas.filter((a) => a.lanes.length > 0).length,
    lanes: laneSegments.length,
    lanesUsed: [...stock.values()].filter((s) => s.pods.length > 0 && s.lane.lane?.db?.role !== 'pick-location').length,
    pallets,
    podLines,
    policies: [...policySummary.values()],
    emptyZones: areas.filter((a) => a.lanes.length > 0 && !usedZones.has(a.seg.fullName)).map((a) => a.seg.fullName),
    overfullLanes,
    driftLanes,
    pickTrail: {
      jobs: [...pickByPod.values()].reduce((acc, { status }) => {
        const row = acc.find((r) => r.status === status) ?? (acc.push({ status, count: 0 }), acc[acc.length - 1]);
        row.count++;
        return acc;
      }, [] as { status: string; count: number }[]),
      inBucket: bucketPods.length,
      locations: padSummary,
    },
    fetchedAt: new Date(),
  };
  return { segments, stock, summary };
}
