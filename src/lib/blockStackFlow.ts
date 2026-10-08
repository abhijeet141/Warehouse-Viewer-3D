import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import type { Segment } from '../types';
import {
  BS, BLOCK_ZONES, POLICIES, PRODUCTS, classKeyFor, describeClassKey, podAvailable, podHeight, podHSL,
  type Allocation, type LanePod, type LaneStock,
} from '../data/blockStack';
import { hashString } from './rng';
import { podBounds, type PodBox } from './blockStackBuilder';
import type { DriveStep, ForkliftDriver } from './forklift';

// The guided FLD-69 walk-through: policies → putaway → allocation → picking with
// pallet substitution → pick complete. This module owns the story (step order,
// copy, rules, ledger) and mutates the demo stock; the scene supplies the 3D side
// through FlowHost (glow boxes, camera, forklift, stock rebuild). Every rule shown
// is the one in Task/FLD-69 (HLD §4–§6, block-stack-how-it-decides.md).

export type FlowStage = 'Policies' | 'Putaway' | 'Allocation' | 'Picking' | 'Complete';
export const FLOW_STAGES: FlowStage[] = ['Policies', 'Putaway', 'Allocation', 'Picking', 'Complete'];

export interface LedgerLine { subject: string; before: string; after: string }
export interface FlowTable { head: string[]; rows: string[][]; mark?: number[] } // mark = row indices to emphasise
export interface FlowNotice { kind: 'ok' | 'deny' | 'info'; title: string; text: string }
// One-click set-ups for the scan step (each is a pallet the flow scans for you).
export interface FlowScenario { id: string; label: string; hint: string; enabled: boolean }
// Live stock ledger for the story zone, one row per class (cases).
export interface ZoneTotal { label: string; hash: string; pallets: number; available: number; allocated: number; story: boolean }

export interface FlowState {
  active: boolean;
  stepIndex: number;
  stepCount: number;
  stage: FlowStage;
  title: string;
  body: string;
  facts: string[];
  table: FlowTable | null;
  ledger: LedgerLine[];
  notice: FlowNotice | null;
  prompt: string | null;     // what the audience is asked to click
  status: string;            // truck / progress line
  busy: boolean;             // an animation is running → Next waits
  paused: boolean;           // the truck is frozen mid-motion (Pause/Resume, Space)
  needsChoice: boolean;      // a click is expected
  nextLabel: string;
  isLast: boolean;
  auto: boolean;
  follow: boolean;           // camera rides with the truck
  speed: number;
  scenarios: FlowScenario[];
  totals: ZoneTotal[];
  totalsZone: string;
}

function initialState(): FlowState {
  return {
    active: false, stepIndex: 0, stepCount: 0, stage: 'Policies',
    title: '', body: '', facts: [], table: null, ledger: [], notice: null, prompt: null,
    status: '', busy: false, paused: false, needsChoice: false, nextLabel: 'Next', isLast: false,
    auto: false, follow: true, speed: 1,
    scenarios: [], totals: [], totalsZone: 'BSA',
  };
}

export const flowState = writable<FlowState>(initialState());

// What the scene provides. Boxes are data mm (x, y depth, z height).
export interface FlowHost {
  laneStock(): Map<string, LaneStock>;
  segment(name: string): Segment | undefined;
  hasStock(): boolean;
  requireStock(): void;
  glow(key: string, box: PodBox, color: number, fill: number, edge: number, pulse?: boolean): void;
  clearGlows(prefix?: string): void;
  // aisle: keep the camera inside this drive aisle (never inside a bank of stacks)
  focus(boxes: PodBox[], opts?: { dist?: number; dir?: [number, number, number]; duration?: number; aisle?: Segment }): void;
  chase(duration?: number, aisle?: Segment): void;
  ensureTruck(): ForkliftDriver;
  truckVisible(visible: boolean): void;
  carry(pod: LanePod | null): void;
  hidePod(pod: LanePod): void;
  rebuildStock(): void;
  resetStock(): void;
}

export type ClickTarget =
  | { kind: 'pod'; pod: LanePod; lane: Segment }
  | { kind: 'lane'; lane: Segment }
  | { kind: 'other' };

// ---- scenario constants (the FLD-69 worked example) ---------------------------
const ZONE = 'BSA';
const AISLE = 'BS1';
const GOODS_IN_X = -10000;   // on the front cross-aisle, just outside the BS1 mouth
const STANDOFF = 1600;       // truck waits this far outside a lane's face line
const SPEED = { drive: 5500, creep: 1500, insert: 700, lift: 1300, liftSlow: 350 };
const READ_MS = 5200;        // auto-play dwell per step at 1×
const NEW_POD = { product: '4471', batch: 'B7', cases: 40 };
const ORDER = { id: 'ORD-1001', qty: 40, job: 'J-501', rule: 'R-12 · consumer orders · FEFO · podSubstitution = true' };

const COLORS = {
  zone: 0x6366f1, ok: 0x22c55e, drop: 0xef4444, pick: 0xf59e0b, chosen: 0x38bdf8, candidate: 0x38bdf8, empty: 0x94a3b8,
};

// Eight hex characters standing in for the SHA-256 the services store.
export const hashLabel = (policy: string | null, classKey: string): string =>
  hashString(`${policy ?? 'none'}|${classKey}`).toString(16).padStart(8, '0');

interface PutawayCandidate {
  lane: Segment;
  stock: LaneStock;
  verdict: 'ok-empty' | 'ok-same' | 'drop-class' | 'drop-full';
}

interface PickJob {
  id: string; order: string; qty: number;
  podCode: string; lane: string; zone: string;
  rule: string; podSubstitution: boolean; requiredBatch: string | null;
  status: 'AVAILABLE' | 'RESERVED' | 'COMPLETE';
}

interface SubLane { lane: Segment; stock: LaneStock; face: LanePod }

type Verdict =
  | { kind: 'proposed'; text: string }
  | { kind: 'caseA'; text: string }
  | { kind: 'caseB'; displaced: Allocation; text: string }
  | { kind: 'deny'; reason: string; text: string };

interface StepDef { id: string; stage: FlowStage; enter: () => void }

const laneCentreX = (lane: Segment) => lane.coordinateX + lane.dimensionX / 2;
const laneFaceY = (lane: Segment) => (lane.lane!.faceDir > 0 ? lane.coordinateY + lane.dimensionY : lane.coordinateY);
const aisleCentreY = (a: Segment) => a.coordinateY + a.dimensionY / 2;
const podFrontY = (pod: LanePod, lane: Segment) => {
  const b = podBounds(pod, lane);
  return lane.lane!.faceDir > 0 ? b.y1 : b.y0;
};
const laneNumber = (name: string) => parseInt(name.slice(3), 10) || 0;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const qtyText = (job: { qty: number } | null) => `${job?.qty ?? 0}-case`;

function segBox(seg: Segment, height?: number): PodBox {
  return {
    x0: seg.coordinateX, x1: seg.coordinateX + seg.dimensionX,
    y0: seg.coordinateY, y1: seg.coordinateY + seg.dimensionY,
    z0: 0, z1: height ?? seg.dimensionZ,
  };
}
function laneBox(stock: LaneStock): PodBox {
  const top = stock.pods.reduce((m, p) => Math.max(m, p.z0 + podHeight(p)), 0);
  return segBox(stock.lane, Math.max(700, top + 150));
}
const hslHex = (pod: LanePod) => {
  const { h, s, l } = podHSL(pod);
  return new THREE.Color().setHSL(h, s, l).getHex();
};
const allocText = (a: Allocation | null, cases: number) =>
  a ? `ALLOCATED ${a.qty} {${a.order} · ${a.job}}${a.qty < cases ? ` + AVAILABLE ${cases - a.qty}` : ''}` : `AVAILABLE ${cases}`;

// Drive from wherever the truck is (on its aisle's centreline, or nosed into a
// lane) to a standoff just outside the given lane's face, squared up to it.
function routeToLane(from: { x: number; y: number }, lane: Segment, aisle: Segment, chase: () => void): DriveStep[] {
  const yc = aisleCentreY(aisle);
  const f = lane.lane!.faceDir;
  const cx = laneCentreX(lane);
  const steps: DriveStep[] = [];
  if (Math.abs(from.y - yc) > 1) steps.push({ kind: 'move', x: from.x, y: yc, speed: SPEED.creep });
  if (Math.abs(from.x - cx) > 1) {
    steps.push(
      { kind: 'turn', heading: [cx >= from.x ? 1 : -1, 0], duration: 0.8 },
      { kind: 'call', fn: chase }, { kind: 'wait', duration: 0.9 },
      { kind: 'move', x: cx, y: yc, speed: SPEED.drive },
    );
  }
  steps.push(
    { kind: 'turn', heading: [0, -f], duration: 0.8 },
    { kind: 'call', fn: chase }, { kind: 'wait', duration: 0.9 },
    { kind: 'move', x: cx, y: laneFaceY(lane) + f * STANDOFF, speed: SPEED.creep },
  );
  return steps;
}

export class BlockStackFlow {
  private steps: StepDef[];
  private i = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // scenario state
  private newPod: LanePod | null = null;
  private candidates: PutawayCandidate[] = [];
  private engineLane: Segment | null = null;
  private putawayLane: Segment | null = null;
  private putawayLedger: LedgerLine[] = [];
  private job: PickJob | null = null;
  private X: LanePod | null = null;
  private Y: LanePod | null = null;
  private subSet: SubLane[] = [];
  private verdict: Verdict | null = null;
  private swapLedger: LedgerLine[] = [];
  private ledgerAll: LedgerLine[] = [];

  constructor(private host: FlowHost) {
    this.steps = [
      { id: 'policies-zones', stage: 'Policies', enter: () => this.enterPoliciesZones() },
      { id: 'policies-classes', stage: 'Policies', enter: () => this.enterPoliciesClasses() },
      { id: 'putaway-arrive', stage: 'Putaway', enter: () => this.enterPutawayArrive() },
      { id: 'putaway-candidates', stage: 'Putaway', enter: () => this.enterPutawayCandidates() },
      { id: 'putaway-drive', stage: 'Putaway', enter: () => this.enterPutawayDrive() },
      { id: 'putaway-done', stage: 'Putaway', enter: () => this.enterPutawayDone() },
      { id: 'alloc-order', stage: 'Allocation', enter: () => this.enterAllocOrder() },
      { id: 'alloc-job', stage: 'Allocation', enter: () => this.enterAllocJob() },
      { id: 'pick-start', stage: 'Picking', enter: () => this.enterPickStart() },
      { id: 'pick-scan', stage: 'Picking', enter: () => this.enterPickScan() },
      { id: 'pick-run', stage: 'Picking', enter: () => this.enterPickRun() },
      { id: 'complete', stage: 'Complete', enter: () => this.enterComplete() },
    ];
    flowState.update((s) => ({ ...s, stepCount: this.steps.length }));
  }

  // ---- public API ------------------------------------------------------------

  get active(): boolean { return get(flowState).active; }
  get stepId(): string { return this.steps[this.i].id; }
  // The scene routes canvas clicks here on the two decision steps — including
  // after a first valid scan, so the picker can change their mind before confirm.
  get acceptsClicks(): boolean {
    const s = get(flowState);
    return s.active && !s.busy && (this.stepId === 'putaway-candidates' || this.stepId === 'pick-scan');
  }

  start() {
    this.host.requireStock();
    this.resetScenario();
    flowState.update((s) => ({ ...s, active: true, auto: false }));
    this.goto(0);
  }

  stop() {
    this.clearTimer();
    this.host.ensureTruck().clear();
    this.host.truckVisible(false);
    this.host.carry(null);
    this.host.clearGlows();
    flowState.update((s) => ({ ...s, active: false, busy: false, paused: false, needsChoice: false }));
  }

  restart() {
    this.clearTimer();
    this.host.ensureTruck().clear();
    this.host.truckVisible(false);
    this.host.carry(null);
    this.host.clearGlows();
    this.host.resetStock();
    this.resetScenario();
    this.goto(0);
  }

  // Next: advance — or, on a choice step, take the system's own choice.
  next() {
    const st = get(flowState);
    if (st.busy) return;
    this.clearTimer();
    if (this.stepId === 'putaway-candidates') {
      if (this.putawayLane) this.goto(this.i + 1);
      else if (this.engineLane) this.chooseLane(this.engineLane.fullName);
      return;
    }
    if (this.stepId === 'pick-scan') {
      if (this.verdict && this.verdict.kind !== 'deny') { this.goto(this.i + 1); return; }
      const d = this.defaultPickChoice();
      if (d) this.choosePallet(d.pod, d.lane);
      return;
    }
    if (this.i < this.steps.length - 1) this.goto(this.i + 1);
  }

  toggleAuto() {
    const auto = !get(flowState).auto;
    flowState.update((s) => ({ ...s, auto }));
    if (auto) this.scheduleAuto(); else this.clearTimer();
  }

  setSpeed(speed: number) { flowState.update((s) => ({ ...s, speed })); }
  toggleFollow() { flowState.update((s) => ({ ...s, follow: !s.follow })); }
  // Freeze / release the truck mid-motion; only meaningful while a drive is running.
  togglePause() { flowState.update((s) => (s.busy ? { ...s, paused: !s.paused } : s)); }

  // A click in the scene while a choice is expected.
  handleClick(t: ClickTarget) {
    if (!this.acceptsClicks) return;
    if (this.stepId === 'putaway-candidates') {
      if (t.kind === 'other') { this.notice('deny', 'Not a block-stack lane', 'Pick one of the lanes on the floor in zone BSA.'); return; }
      this.chooseLane(t.lane.fullName);
    } else if (this.stepId === 'pick-scan') {
      if (t.kind !== 'pod') { this.notice('deny', 'Nothing to scan', 'Scan a pallet — the pallets you can reach are lit green.'); return; }
      this.choosePallet(t.pod, t.lane);
    }
  }

  // Scenario strip on the scan step: the flow finds the pallet that produces the
  // outcome and scans it for the presenter. 'directed' flips the job to a
  // pallet-directed rule for the scan, then restores it so the demo can go on.
  runScenario(id: string) {
    if (this.stepId !== 'pick-scan' || get(flowState).busy) return;
    const t = this.scenarioTargets();
    const go = (e: { face: LanePod; lane: Segment } | null | undefined) => { if (e) this.choosePallet(e.face, e.lane); };
    switch (id) {
      case 'caseA': go(t.free); break;
      case 'caseB': go(t.caseB); break;
      case 'hash': go(t.hash); break;
      case 'deep': go(t.deep); break;
      case 'reserved': go(t.reserved); break;
      case 'short': go(t.short); break;
      case 'directed': {
        const job = this.job!;
        const keep = { sub: job.podSubstitution, rule: job.rule };
        job.podSubstitution = false;
        job.rule = 'R-40 · pharma line · pallet-directed';
        go(t.free);
        job.podSubstitution = keep.sub;
        job.rule = keep.rule;
        break;
      }
    }
  }

  private scenarioTargets() {
    const X = this.X!;
    const qty = this.job!.qty;
    const set = this.subSet;
    const stock = this.host.laneStock();
    const notX = (e: SubLane) => e.face.code !== X.code;
    const free = set.find((e) => notX(e) && !e.face.allocation && podAvailable(e.face) >= qty) ?? null;
    const caseB = set.find((e) => notX(e) && e.face.allocation?.jobStatus === 'AVAILABLE') ?? null;
    const reserved = set.find((e) => notX(e) && e.face.allocation?.jobStatus === 'RESERVED') ?? null;
    const short = set.find((e) => notX(e) && !e.face.allocation && podAvailable(e.face) < qty) ?? null;
    const other = this.zoneLanes(ZONE).find((s) => s.pods.length > 0 && s.classKey !== X.classKey);
    const hash = other ? { face: other.pods[other.pods.length - 1], lane: other.lane } : null;
    const stockX = stock.get(X.lane)!;
    const deep = X.index < stockX.pods.length ? { face: X, lane: stockX.lane } : null;
    return { free, caseB, reserved, short, hash, deep };
  }

  private computeScenarios(): FlowScenario[] {
    const t = this.scenarioTargets();
    const mk = (id: string, label: string, hint: string, target: unknown): FlowScenario =>
      ({ id, label, hint: target ? hint : 'no matching pallet in this stock', enabled: !!target });
    return [
      mk('caseA', 'Case A', `Scan ${t.free?.face.code}: a free pallet of the class — plain swap`, t.free),
      mk('caseB', 'Case B', `Scan ${t.caseB?.face.code}: booked to ${t.caseB?.face.allocation?.order}, whose job is still AVAILABLE — displaced onto ${this.X?.code}`, t.caseB),
      mk('hash', 'Hash mismatch', `Scan ${t.hash?.face.code}: a different class — Q3 denies`, t.hash),
      mk('deep', 'Deep pallet', `Scan ${t.deep?.face.code}: the allocated pallet itself, under the stack — not reachable`, t.deep),
      mk('reserved', 'Reserved elsewhere', `Scan ${t.reserved?.face.code}: another picker holds its job — no displacement across a reserved job`, t.reserved),
      mk('directed', 'Pallet-directed job', `Rule R-40 (podSubstitution off), then scan ${t.free?.face.code} — Q2 denies`, t.free),
      mk('short', 'Part pallet', `Scan ${t.short?.face.code}: only ${t.short ? podAvailable(t.short.face) : 0} cases for a ${qtyText(this.job)} job — Q5 denies`, t.short),
    ];
  }

  // Cases per class in the story zone: what allocation and the swap re-label and
  // what only the pick reduces (T = A + L).
  private computeTotals(): ZoneTotal[] {
    const policy = this.zonePolicy(ZONE);
    const storyKey = this.newPod?.classKey ?? classKeyFor(NEW_POD.product, [NEW_POD.batch], policy);
    const acc = new Map<string, ZoneTotal>();
    for (const s of this.zoneLanes(ZONE)) {
      for (const p of s.pods) {
        let t = acc.get(p.classKey);
        if (!t) {
          t = { label: describeClassKey(p.classKey), hash: hashLabel(policy, p.classKey), pallets: 0, available: 0, allocated: 0, story: p.classKey === storyKey };
          acc.set(p.classKey, t);
        }
        t.pallets++;
        t.available += podAvailable(p);
        t.allocated += p.allocation?.qty ?? 0;
      }
    }
    return [...acc.values()].sort((a, b) => (a.story === b.story ? b.pallets - a.pallets : a.story ? -1 : 1));
  }

  // Dev hook: a lane name or a pallet code.
  chooseByName(name: string) {
    const stock = this.host.laneStock();
    if (stock.has(name)) { this.handleClick({ kind: 'lane', lane: stock.get(name)!.lane }); return; }
    const laneName = name.slice(0, name.indexOf('-'));
    const pod = stock.get(laneName)?.pods.find((p) => p.code === name);
    if (pod) this.handleClick({ kind: 'pod', pod, lane: stock.get(laneName)!.lane });
  }

  // ---- state helpers -----------------------------------------------------------

  private set(patch: Partial<FlowState>) { flowState.update((s) => ({ ...s, ...patch, totals: this.computeTotals(), totalsZone: ZONE })); }
  private notice(kind: FlowNotice['kind'], title: string, text: string) { this.set({ notice: { kind, title, text } }); }
  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  private resetScenario() {
    this.newPod = null; this.candidates = []; this.engineLane = null; this.putawayLane = null; this.putawayLedger = [];
    this.job = null; this.X = null; this.Y = null; this.subSet = []; this.verdict = null; this.swapLedger = []; this.ledgerAll = [];
  }

  private goto(i: number) {
    this.clearTimer();
    this.i = i;
    const step = this.steps[i];
    this.host.clearGlows();
    this.set({
      stepIndex: i, stage: step.stage, facts: [], table: null, ledger: [], notice: null, prompt: null,
      status: '', busy: false, paused: false, needsChoice: false, nextLabel: 'Next', isLast: i === this.steps.length - 1,
      scenarios: [],
    });
    step.enter();
    this.scheduleAuto();
  }

  // Auto-play: dwell, then take the step's natural next action.
  private scheduleAuto() {
    this.clearTimer();
    const st = get(flowState);
    if (!st.auto || !st.active || st.busy || st.isLast) return;
    const dwell = READ_MS / st.speed;
    this.timer = setTimeout(() => {
      this.timer = null;
      const s = get(flowState);
      if (!s.auto || !s.active || s.busy) return;
      this.next();
    }, dwell);
  }

  // A truck sequence: Next waits until the truck is idle, then `then` runs.
  private runTruck(steps: DriveStep[], then: () => void) {
    const d = this.host.ensureTruck();
    this.set({ busy: true });
    d.onIdle = () => {
      d.onIdle = null;
      this.set({ busy: false });
      then();
    };
    d.enqueue(...steps);
  }

  private zoneLanes(zone: string): LaneStock[] {
    return [...this.host.laneStock().values()]
      .filter((s) => s.lane.lane?.block === zone)
      .sort((a, b) => laneNumber(a.lane.fullName) - laneNumber(b.lane.fullName));
  }
  private zonePolicy(zone: string): string | null {
    return BLOCK_ZONES.find((z) => z.code === zone)?.policy ?? null;
  }
  private classText(policy: string | null, key: string) {
    return `${describeClassKey(key)} · ${hashLabel(policy, key)}`;
  }

  // ---- POLICIES -----------------------------------------------------------------

  private enterPoliciesZones() {
    const zones = ['BSA', 'BSB', 'BSC'].map((c) => this.host.segment(c)).filter((s): s is Segment => !!s);
    for (const z of zones) this.host.glow(`zone:${z.fullName}`, segBox(z), COLORS.zone, 0.1, 0.8);
    this.host.focus(zones.map((z) => segBox(z)), { dir: [-0.35, 0.62, -0.55], duration: 1500 });
    this.set({
      title: 'Zones and stock-mix policies',
      body: 'Block stack is floor storage in deep lanes worked from one end, so what shares a lane matters. FLD-69 gives each zone one stock-mix policy — a named subset of the stock hash keys — and each lane a single class hash (segments.currentStockMixHash). A tracked lane holds one class at a time.',
      facts: [
        `BSA — ${this.zonePolicy('BSA')} · keys ${POLICIES[this.zonePolicy('BSA')!].keys.join(', ')}`,
        `BSB — ${this.zonePolicy('BSB')} · keys ${POLICIES[this.zonePolicy('BSB')!].keys.join(', ')}`,
        `BSC — ${this.zonePolicy('BSC')}`,
        'Policy resolves most-specific-wins: a segment override, else the zone-account row (one zone ↔ one policy, per account).',
        'trackStockMix = 1 on every block-stack lane; a lane with the flag off is never hash-checked.',
      ],
    });
  }

  private enterPoliciesClasses() {
    const lanes = this.zoneLanes(ZONE);
    const policy = this.zonePolicy(ZONE);
    const rows = lanes.map((s) => {
      const face = s.pods[s.pods.length - 1];
      if (face) this.host.glow(`lane:${s.lane.fullName}`, laneBox(s), hslHex(face), 0.22, 0.85);
      else this.host.glow(`lane:${s.lane.fullName}`, laneBox(s), COLORS.empty, 0.06, 0.4);
      return [s.lane.fullName, String(s.pods.length), s.classKey ? describeClassKey(s.classKey) : '— (empty)', s.classKey ? hashLabel(policy, s.classKey) : 'NULL'];
    });
    const bank = this.host.segment(ZONE);
    if (bank) this.host.focus([segBox(bank)], { dir: [-0.2, 0.75, 0.75], duration: 1400 });
    this.set({
      title: 'What counts as the same stock',
      body: `Under ${policy} (zone BSA) a Cola pallet of batch B7 and one of batch B9 are two classes and can never share a lane; under BS-PRODUCT-ONLY (zone BSB) they are one class and may. Same pallets, different fingerprints — the policy is the dial between purity and density.`,
      table: { head: ['Lane', 'Pods', 'Class', 'Hash'], rows },
      facts: [
        'Hash = SHA-256 over the pallet\'s values for the policy\'s keys (magma-pods GetPodMixHashes), one per policy in play.',
        'A pallet carrying two batches is its own class — BSA06 can only ever share with an identical mixed pallet.',
        'Empty lane ⇒ hash NULL: it takes the class of the first pallet put into it.',
      ],
    });
  }

  // ---- PUTAWAY ------------------------------------------------------------------

  private enterPutawayArrive() {
    const aisle = this.host.segment(AISLE)!;
    const product = PRODUCTS.find((p) => p.code === NEW_POD.product)!;
    // The arriving pallet, not yet in any lane.
    this.newPod = {
      code: 'GI-2041', lane: '', index: 0, column: 0, tier: 0, z0: 0,
      product, batches: [NEW_POD.batch], cases: NEW_POD.cases,
      classKey: classKeyFor(product.code, [NEW_POD.batch], this.zonePolicy(ZONE)), allocation: null,
    };
    const d = this.host.ensureTruck();
    d.clear();
    d.forkH = 300;
    d.place(aisle.coordinateX + GOODS_IN_X, aisleCentreY(aisle), [1, 0]);
    this.host.truckVisible(true);
    this.host.carry(this.newPod);
    this.host.chase(1500, aisle);
    const keyBatch = classKeyFor(product.code, [NEW_POD.batch], 'BS-PRODUCT-BATCH');
    const keyProd = classKeyFor(product.code, [NEW_POD.batch], 'BS-PRODUCT-ONLY');
    this.set({
      title: 'Putaway — a pallet arrives',
      body: `Goods-in has receipted pallet GI-2041: ${NEW_POD.cases} cases of ${product.code} ${product.name}, batch ${NEW_POD.batch}. Before any lane is looked at, magma-putaway fingerprints it once per policy in play for this warehouse and account (GetStockMixPoliciesInPlay → GetPodMixHashes) and the hashes ride on the reservation request.`,
      facts: [
        `Under BS-PRODUCT-BATCH → ${this.classText('BS-PRODUCT-BATCH', keyBatch)}`,
        `Under BS-PRODUCT-ONLY → ${this.classText('BS-PRODUCT-ONLY', keyProd)}`,
        'The pallet carries fingerprints, never an intent: the putaway RULE\'s zone list decides where it may go.',
      ],
      status: 'Truck at goods-in with GI-2041 on the forks.',
    });
  }

  private enterPutawayCandidates() {
    const pod = this.newPod!;
    const lanes = this.zoneLanes(ZONE);
    this.candidates = lanes.map((s) => {
      const cfg = s.lane.lane!;
      let verdict: PutawayCandidate['verdict'];
      if (s.pods.length >= cfg.maxPods) verdict = 'drop-full';
      else if (!s.classKey) verdict = 'ok-empty';
      else if (s.classKey === pod.classKey) verdict = 'ok-same';
      else verdict = 'drop-class';
      return { lane: s.lane, stock: s, verdict };
    });
    // The engine has no preference of its own for the lane already holding the
    // class (how-it-decides Q3): survivors run in putawayPreference order and the
    // first suitable wins. This warehouse ranks its part-filled lanes first, fewest
    // pallets first, so a pallet tops up an open stack instead of opening a lane.
    const same = this.candidates.filter((c) => c.verdict === 'ok-same').sort((a, b) => a.stock.pods.length - b.stock.pods.length);
    this.engineLane = same[0]?.lane ?? this.candidates.find((c) => c.verdict === 'ok-empty')?.lane ?? null;
    this.putawayLane = null;
    const policy = this.zonePolicy(ZONE);
    const verdictText: Record<PutawayCandidate['verdict'], string> = {
      'ok-empty': 'OK · empty (hash NULL)', 'ok-same': 'OK · same class', 'drop-class': 'dropped · class differs', 'drop-full': 'dropped · lane full',
    };
    const rows = this.candidates.map((c) => [
      c.lane.fullName, `${c.stock.pods.length}/${c.lane.lane!.maxPods}`,
      c.stock.classKey ? describeClassKey(c.stock.classKey) : '—',
      verdictText[c.verdict] + (c.lane === this.engineLane ? ' · engine\'s choice' : ''),
    ]);
    for (const c of this.candidates) {
      const ok = c.verdict.startsWith('ok');
      const strong = c.lane === this.engineLane;
      this.host.glow(`lane:${c.lane.fullName}`, laneBox(c.stock), ok ? COLORS.ok : COLORS.drop, ok ? (strong ? 0.3 : 0.14) : 0.12, strong ? 1 : 0.6, strong);
    }
    const bank = this.host.segment(ZONE);
    if (bank) this.host.focus([segBox(bank)], { dir: [-0.15, 0.7, 0.8], duration: 1300 });
    this.set({
      title: 'The rule points at zone BSA; the engine filters its lanes',
      body: `The putaway rule's zones narrow the candidates to BSA — routing is untouched by FLD-69. Then every candidate lane is asked individually (isStockMixCompatible): untracked → accept; tracked and empty → accept; same hash for this lane's policy → accept; a different hash → dropped. The SQL pre-filter is a superset; the exact per-policy match is the Go gate.`,
      table: { head: ['Lane', 'Pods', 'Holds', 'Verdict'], rows, mark: this.candidates.map((c, i) => (c.lane === this.engineLane ? i : -1)).filter((i) => i >= 0) },
      facts: [
        `Pallet class under ${policy}: ${this.classText(policy, pod.classKey)}.`,
        `The engine itself has no preference for the lane already holding the class (how-it-decides Q3): survivors run in putawayPreference order and the first suitable wins. This warehouse ranks its part-filled lanes first, so the pallet tops up ${this.engineLane?.fullName ?? 'a lane'} instead of opening an empty one.`,
        'Capacity is checked too: currentPodCount + 1 ≤ maximumPods.',
      ],
      prompt: `Click a lane in BSA to put GI-2041 away — the engine's own choice is outlined. Try a red lane to see the refusal.`,
      needsChoice: true,
      nextLabel: 'Use the engine\'s choice',
    });
  }

  private chooseLane(name: string) {
    const pod = this.newPod!;
    const c = this.candidates.find((x) => x.lane.fullName === name);
    if (!c) {
      const s = this.host.laneStock().get(name);
      const zone = s?.lane.lane?.block ?? '?';
      this.notice('deny', 'Outside the rule\'s zones', `${name} is in zone ${zone}. The putaway rule for this pallet names zone BSA only; lanes elsewhere are never candidates, whatever they hold.`);
      return;
    }
    if (c.verdict === 'drop-full') {
      this.notice('deny', 'Lane full', `${name} holds ${c.stock.pods.length} of maximumPods ${c.lane.lane!.maxPods}. currentPodCount + 1 would exceed the limit, so it is not a suitable segment.`);
      return;
    }
    if (c.verdict === 'drop-class') {
      const policy = this.zonePolicy(ZONE);
      this.notice('deny', 'Refused — stock mix policy violation (1942)',
        `${name} holds ${this.classText(policy, c.stock.classKey!)}; GI-2041 is ${this.classText(policy, pod.classKey)}. Two classes in one tracked lane: the reservation engine drops the lane, and if an operator forced the move the upsert trigger in magma-pods would refuse the write with 1942.`);
      return;
    }
    this.putawayLane = c.lane;
    this.notice('ok', c.verdict === 'ok-empty' ? `${name} accepted — empty lane` : `${name} accepted — same class`,
      c.verdict === 'ok-empty'
        ? `${name} has no hash yet (NULL). Any class may open it; on confirm the trigger stamps it with ${hashLabel(this.zonePolicy(ZONE), pod.classKey)}.`
        : `${name} already holds ${describeClassKey(c.stock.classKey!)} — the same hash as GI-2041, so the write will leave the lane pure.`);
    this.set({ needsChoice: false, nextLabel: 'Reserve and move' });
    if (get(flowState).auto) this.scheduleAuto();
    else this.goto(this.i + 1);
  }

  private enterPutawayDrive() {
    const lane = this.putawayLane!;
    const stock = this.host.laneStock().get(lane.fullName)!;
    const aisle = this.host.segment(AISLE)!;
    const cfg = lane.lane!;
    const pod = this.newPod!;
    // Next fill position: the current position stacked to the top, or the base of
    // the next one; its base is the top of whatever is already there.
    const n = stock.pods.length;
    const column = Math.floor(n / cfg.tiers);
    const tier = n % cfg.tiers;
    const below = tier > 0 ? stock.pods[n - 1] : null;
    pod.lane = lane.fullName;
    pod.index = n + 1;
    pod.column = column;
    pod.tier = tier;
    pod.z0 = below ? below.z0 + podHeight(below) + BS.STACK_GAP : 0;
    pod.code = `${lane.fullName}-${String(n + 1).padStart(2, '0')}`;
    const f = cfg.faceDir;
    const cx = laneCentreX(lane);
    const frontY = podFrontY(pod, lane);
    const yc = aisleCentreY(aisle);
    const d = this.host.ensureTruck();
    this.host.glow(`lane:${lane.fullName}`, laneBox(stock), COLORS.ok, 0.16, 0.9);
    this.set({
      title: 'Reserve → move → confirm',
      body: `${lane.fullName} is reserved for GI-2041 (segment_reservation_matrix), the putaway job is created and the truck takes the pallet out. Block stack fills the back position first and stacks it before the next position is started — a truck cannot reach over a stack — so the pallet goes to position ${pod.index} of ${cfg.maxPods}: ${column === 0 ? 'back row' : column === cfg.deep - 1 ? 'front row' : `row ${cfg.deep - column}`}, level ${tier + 1}.`,
      status: `Driving GI-2041 to ${lane.fullName}…`,
    });
    const steps: DriveStep[] = [
      ...routeToLane(d.pos, lane, aisle, () => this.host.chase(900, aisle)),
      { kind: 'call', fn: () => this.set({ status: `At ${lane.fullName} — lifting to level ${tier + 1}.` }) },
      { kind: 'lift', height: pod.z0 + 200, speed: SPEED.lift },
      { kind: 'move', x: cx, y: frontY + f * 1300, speed: SPEED.creep },
      { kind: 'move', x: cx, y: frontY, speed: SPEED.insert },
      { kind: 'lift', height: pod.z0, speed: SPEED.liftSlow },
      { kind: 'call', fn: () => this.putDown() },
      { kind: 'wait', duration: 0.4 },
      { kind: 'move', x: cx, y: laneFaceY(lane) + f * STANDOFF, speed: SPEED.creep },
      { kind: 'lift', height: 300, speed: SPEED.lift },
      { kind: 'move', x: cx, y: yc, speed: SPEED.creep },
      { kind: 'turn', heading: [-1, 0], duration: 0.9 },
      { kind: 'call', fn: () => this.host.chase(900, aisle) }, { kind: 'wait', duration: 0.9 },
      { kind: 'call', fn: () => this.set({ status: 'Putaway confirmed — returning to goods-in.' }) },
      { kind: 'move', x: aisle.coordinateX + GOODS_IN_X, y: yc, speed: SPEED.drive },
    ];
    this.runTruck(steps, () => this.goto(this.i + 1));
  }

  // The pallet is on the stack: it joins the lane's stock and the meshes rebuild
  // (the write-side gate recomputes the lane's classes as part of the same write).
  private putDown() {
    const pod = this.newPod!;
    const stock = this.host.laneStock().get(pod.lane)!;
    const before = stock.classKey;
    stock.pods.push(pod);
    stock.classKey = stock.pods[0].classKey;
    this.host.carry(null);
    this.host.rebuildStock();
    const policy = this.zonePolicy(ZONE);
    this.putawayLedger = [
      { subject: pod.lane, before: plural(stock.pods.length - 1, 'pallet'), after: `${plural(stock.pods.length, 'pallet')} · ${pod.code} at position ${pod.index}` },
      { subject: `${pod.lane} currentStockMixHash`, before: before ? hashLabel(policy, before) : 'NULL', after: `${hashLabel(policy, stock.classKey!)} ${before ? '(unchanged)' : '(stamped)'}` },
      { subject: pod.code, before: 'in transit from goods-in', after: `${pod.lane} · AVAILABLE ${pod.cases}` },
    ];
    this.ledgerAll.push(...this.putawayLedger);
    this.set({ ledger: this.putawayLedger, status: `${pod.code} set down in ${pod.lane}.` });
  }

  private enterPutawayDone() {
    const lane = this.putawayLane!;
    const stock = this.host.laneStock().get(lane.fullName)!;
    const pod = this.newPod!;
    this.host.glow(`pod:${pod.code}`, podBounds(pod, lane), COLORS.ok, 0.28, 1);
    this.host.focus([laneBox(stock)], { dir: [-0.55, 0.5, lane.lane!.faceDir * 0.65], duration: 1400, aisle: this.host.segment(AISLE) });
    this.set({
      title: 'Putaway confirmed',
      body: 'Every pod write goes through one choke point: the upsert trigger in magma-pods recomputes the destination lane\'s classes. One class → the hash is stamped or left unchanged; two → the write is refused with 1942; none → the hash is cleared. Putaway, moves and attribute edits all pass the same gate, which is why nothing else needs to know the rule.',
      ledger: this.putawayLedger,
      facts: [
        `currentPodCount ${stock.pods.length - 1} → ${stock.pods.length} ≤ maximumPods ${lane.lane!.maxPods}.`,
        'A tracked lane with no policy resolved is reported (logUnpoliciedSegments) but never filled by guessing.',
      ],
    });
  }

  // ---- ALLOCATION ---------------------------------------------------------------

  private enterAllocOrder() {
    const lanes = this.zoneLanes(ZONE);
    const cands: { pod: LanePod; lane: Segment }[] = [];
    for (const s of lanes) for (const p of s.pods) if (p.product.code === ORDER.qty.toString() ? false : p.product.code === NEW_POD.product && !p.allocation) cands.push({ pod: p, lane: s.lane });
    for (const c of cands) this.host.glow(`pod:${c.pod.code}`, podBounds(c.pod, c.lane), COLORS.candidate, 0.16, 0.7, true);
    const bank = this.host.segment(ZONE);
    if (bank) this.host.focus([segBox(bank)], { dir: [-0.3, 0.6, 0.75], duration: 1300 });
    this.set({
      title: 'Allocation — an order arrives',
      body: `${ORDER.id} wants ${ORDER.qty} cases of 4471 Cola. Rule ${ORDER.rule.split(' · ')[0]} (consumer orders) allocates from zone BSA with FEFO, minimum shelf life 60 days. Allocation converts AVAILABLE into ALLOCATED on a pallet it names; it creates nothing and moves nothing — T = A + L is unchanged.`,
      table: {
        head: ['Pallet', 'Lane', 'Batch', 'Position'],
        rows: cands.map((c) => {
          const s = this.host.laneStock().get(c.pod.lane)!;
          return [c.pod.code, c.pod.lane, c.pod.batches.join('+'), c.pod.index === s.pods.length ? 'face' : `${c.pod.index} of ${s.pods.length}`];
        }),
      },
      facts: [
        `${cands.length} AVAILABLE Cola pallets in BSA are eligible (batches B7, B9 and the mixed B7+B8 alike — the order line does not pin a batch).`,
        `New in Part 3: the rule's podSubstitution flag is copied onto the pick job it creates.`,
      ],
    });
  }

  private enterAllocJob() {
    // The engine's choice: the BOTTOM pallet of the stack the putaway just topped up
    // (or of the fullest lane of the class if that lane holds a single pallet) — a
    // pallet with others standing on it, which the engine cannot know.
    const topped = this.putawayLane ? this.host.laneStock().get(this.putawayLane.fullName) : undefined;
    const fullest = this.zoneLanes(ZONE)
      .filter((s) => s.classKey === this.newPod!.classKey && s.pods.length >= 2)
      .sort((a, b) => b.pods.length - a.pods.length)[0];
    const stock = topped && topped.pods.length >= 2 ? topped : (fullest ?? topped!);
    const X = stock.pods[0];
    const lane = stock.lane;
    const before = allocText(X.allocation, X.cases);
    X.allocation = { order: ORDER.id, job: ORDER.job, qty: ORDER.qty, jobStatus: 'AVAILABLE' };
    this.X = X;
    this.job = {
      id: ORDER.job, order: ORDER.id, qty: ORDER.qty, podCode: X.code, lane: X.lane, zone: ZONE,
      rule: ORDER.rule, podSubstitution: true, requiredBatch: null, status: 'AVAILABLE',
    };
    this.host.rebuildStock();
    const above = stock.pods.length - X.index;
    this.host.glow(`pod:${X.code}`, podBounds(X, lane), COLORS.pick, 0.32, 1, true);
    this.host.focus([laneBox(stock)], { dir: [-0.6, 0.45, lane.lane!.faceDir * 0.65], duration: 1500, aisle: this.host.segment(AISLE) });
    const lines: LedgerLine[] = [
      { subject: X.code, before, after: allocText(X.allocation, X.cases) },
      { subject: ORDER.job, before: '—', after: `fromPod ${X.code} · fromSegment ${X.lane} · fromZone ${ZONE} · podSubstitution = true · AVAILABLE` },
    ];
    this.ledgerAll.push(...lines);
    const toppedUp = this.putawayLane?.fullName === X.lane;
    this.set({
      title: `The engine names ${X.code} — it has no depth model`,
      body: `The rule's sort lands on ${X.code}: the bottom pallet of ${X.lane}${toppedUp ? ', the stack the putaway just topped up' : ''} — level ${X.tier + 1}, with ${plural(above, 'pallet')} standing on it${toppedUp ? ` (GI-2041, now ${this.newPod!.code}, among them)` : ''}. The engine cannot know: select_stock.go has no notion of depth. Pick job ${ORDER.job} is created against ${X.code} with podSubstitution = true, and the warehouse now owes the picker a pallet nobody can reach.`,
      ledger: lines,
      facts: [
        `Zone totals for class ${describeClassKey(X.classKey)}: AVAILABLE shrinks by ${ORDER.qty}, ALLOCATED grows by ${ORDER.qty} — the physical total T does not change.`,
        'Part 3 does not change allocation at all; it makes the depth problem harmless at the point of pick.',
      ],
    });
  }

  // ---- PICKING ------------------------------------------------------------------

  private computeSet(): SubLane[] {
    const X = this.X!;
    const out: SubLane[] = [];
    for (const s of this.host.laneStock().values()) {
      const cfg = s.lane.lane;
      if (!cfg || cfg.block !== ZONE || !cfg.trackStockMix || s.pods.length === 0) continue;
      if (s.classKey !== X.classKey) continue;
      out.push({ lane: s.lane, stock: s, face: s.pods[s.pods.length - 1] });
    }
    out.sort((a, b) => a.stock.pods.length - b.stock.pods.length || laneNumber(a.lane.fullName) - laneNumber(b.lane.fullName));
    return out.slice(0, 10);
  }

  private enterPickStart() {
    const job = this.job!;
    const X = this.X!;
    job.status = 'RESERVED';
    X.allocation!.jobStatus = 'RESERVED';
    this.subSet = this.computeSet();
    const laneX = this.host.segment(X.lane)!;
    const aisle = this.host.segment(AISLE)!;
    const d = this.host.ensureTruck();
    d.clear();
    d.forkH = 300;
    d.place(aisle.coordinateX + GOODS_IN_X, aisleCentreY(aisle), [1, 0]);
    this.host.truckVisible(true);
    this.host.carry(null);
    this.host.glow(`pod:${X.code}`, podBounds(X, laneX), COLORS.pick, 0.3, 1, true);
    this.host.chase(1500, aisle);
    this.set({
      title: 'Picking — start-pick',
      body: `The picker takes ${job.id}: /start-pick-job marks it RESERVED and the response now carries the substitutable set — every lane in zone BSA with the same hash and policy, in a pickable status, ORDER BY currentPodCount ASC and limited to 10. The emptier lane lists first, so honeycombing clears itself.`,
      table: {
        head: ['Lane', 'Pods', 'Face pallet', 'Face status'],
        rows: this.subSet.map((e) => [
          e.lane.fullName, String(e.stock.pods.length), e.face.code,
          e.face.allocation ? `ALLOCATED ${e.face.allocation.order} (job ${e.face.allocation.jobStatus})` : 'AVAILABLE',
        ]),
      },
      facts: [
        `BSA05 is not in the set: its lane hash is ${describeClassKey('4471|B9')}, a different class. Purity of the set is what makes substitution safe.`,
        'The handheld can validate scans locally against this set — no server round trip until confirm.',
      ],
      status: `Truck leaving goods-in for ${X.lane}…`,
    });
    this.runTruck(
      [
        { kind: 'wait', duration: 1.2 },
        ...routeToLane(d.pos, laneX, aisle, () => this.host.chase(900, aisle)),
      ],
      () => this.goto(this.i + 1),
    );
  }

  private enterPickScan() {
    const X = this.X!;
    const laneX = this.host.segment(X.lane)!;
    const stockX = this.host.laneStock().get(X.lane)!;
    const above = stockX.pods.length - X.index;
    this.verdict = null;
    this.Y = null;
    this.host.glow(`pod:${X.code}`, podBounds(X, laneX), COLORS.pick, 0.3, 1, true);
    for (const e of this.subSet) {
      if (e.face.code === X.code) continue;
      this.host.glow(`cand:${e.face.code}`, podBounds(e.face, e.lane), e.face.allocation ? COLORS.pick : COLORS.ok, 0.26, 0.95, true);
    }
    this.set({
      title: 'At the lane: pick what you can reach',
      body: `${X.code} sits under ${stockX.pods.slice(X.index).map((p) => p.code.slice(-2)).join(', ')} — level ${X.tier + 1}, ${plural(above, 'pallet')} above. The handheld's location and pallet gates now accept any member of the set, so the picker scans the pallet in front of them. On confirm, pickedFromPod = Y goes to magma-allocations, which runs SwapAllocation: Q1 scope, Q2 flag, Q3 hash, Q4 order line, Q5 quantity — Case A, Case B, or a denial before anything is written.`,
      facts: [
        `Case A: the scanned pallet has enough AVAILABLE — it takes the allocation, ${X.code} is released.`,
        `Case B: the scanned pallet is booked to another order whose job is still AVAILABLE — that order is displaced onto ${X.code}; it must accept ${X.code}, or the whole thing is denied. No cascade.`,
      ],
      prompt: `Click a face pallet — green = free, amber = booked to another order — or pick a scenario below and the flow scans the right pallet for you.`,
      scenarios: this.computeScenarios(),
      needsChoice: true,
      nextLabel: 'Scan the suggested pallet',
      status: `Truck at ${X.lane}, forks empty.`,
    });
  }

  private defaultPickChoice(): { pod: LanePod; lane: Segment } | null {
    const X = this.X!;
    const free = this.subSet.find((e) => e.face.code !== X.code && !e.face.allocation);
    if (free) return { pod: free.face, lane: free.lane };
    const displaceable = this.subSet.find((e) => e.face.code !== X.code && e.face.allocation?.jobStatus === 'AVAILABLE');
    if (displaceable) return { pod: displaceable.face, lane: displaceable.lane };
    const own = this.subSet.find((e) => e.face.code === X.code);
    return own ? { pod: own.face, lane: own.lane } : null;
  }

  private evaluatePick(Y: LanePod, laneY: Segment): Verdict {
    const job = this.job!;
    const X = this.X!;
    const cfgY = laneY.lane!;
    const stockY = this.host.laneStock().get(Y.lane)!;
    const face = stockY.pods[stockY.pods.length - 1];
    if (!face || face.code !== Y.code) {
      const after = stockY.pods.length - Y.index;
      return { kind: 'deny', reason: 'not reachable', text: `${Y.code} is position ${Y.index} of ${cfgY.maxPods} in ${Y.lane} with ${plural(after, 'pallet')} stacked after it. Only the face pallet${face ? ` (${face.code})` : ''} can be scanned — the system has no depth model, the picker's hands do.` };
    }
    if (Y.code === X.code) return { kind: 'proposed', text: `${X.code} is itself the face pallet of ${X.lane}: pick it as allocated — no swap needed.` };
    if (!job.podSubstitution) return { kind: 'deny', reason: 'pallet-directed', text: `Job ${job.id} is pallet-directed (${job.rule}): podSubstitution is off, so only ${X.code} may be picked.` };
    if (cfgY.block !== job.zone) return { kind: 'deny', reason: 'outside the substitution scope', text: `${Y.code} stands in zone ${cfgY.block}; the substitution scope is the job's zone ${job.zone} (lanes sharing its policy). Cross-zone pallets are never offered, whatever they hold.` };
    if (!cfgY.trackStockMix) return { kind: 'deny', reason: 'untracked lane', text: `${Y.lane} is not stock-mix tracked, so it carries no class hash to compare.` };
    if (Y.classKey !== X.classKey) return { kind: 'deny', reason: 'stock class mismatch', text: `Q3 fails — hashes differ: ${X.code} is ${this.classText(cfgY.policy, X.classKey)}, ${Y.code} is ${this.classText(cfgY.policy, Y.classKey)}. Hash equality is the definition of substitutable under ${cfgY.policy}.` };
    if (job.requiredBatch && !Y.batches.includes(job.requiredBatch)) return { kind: 'deny', reason: 'order line rejects the pallet', text: `Q4 fails — the order line requires batch ${job.requiredBatch}; ${Y.code} carries ${Y.batches.join('+')}.` };
    const avail = podAvailable(Y);
    if (avail >= job.qty) return { kind: 'caseA', text: `Case A — ${Y.code} has ${avail} AVAILABLE and the job needs ${job.qty}. On confirm: ${Y.code} AVAILABLE → ALLOCATED {${job.order} · ${job.id}}, ${X.code} ALLOCATED → AVAILABLE, and ${job.id} is re-pointed to ${Y.code} in ${Y.lane}. No pallet moves, so the mixing check does not fire.` };
    const a = Y.allocation;
    if (a) {
      if (a.jobStatus === 'RESERVED') return { kind: 'deny', reason: 'committed elsewhere', text: `${Y.code} is allocated to ${a.order} and its job ${a.job} is RESERVED — another picker holds it. Displacement never crosses a reserved job.` };
      if (a.jobStatus === 'COMPLETE') return { kind: 'deny', reason: 'already picked', text: `${Y.code}'s allocation ${a.job} is complete.` };
      if (avail + a.qty >= job.qty && X.cases >= a.qty) return { kind: 'caseB', displaced: a, text: `Case B — ${Y.code} holds ${a.order}'s allocation (${a.qty}, job ${a.job} AVAILABLE). On confirm ${a.order} is displaced onto ${X.code} — same class, ${X.cases} cases, so it accepts — and ${Y.code} is allocated to ${job.order} instead. Every displaced order must accept X or the swap is denied; there is no second-level cascade.` };
      return { kind: 'deny', reason: 'not enough stock even after displacement', text: `${Y.code} offers ${avail} AVAILABLE + ${a.qty} displaceable = ${avail + a.qty} < ${job.qty} needed.` };
    }
    return { kind: 'deny', reason: 'not enough stock on the pallet', text: `${Y.code} has only ${avail} cases AVAILABLE; the job needs ${job.qty}. A part pallet cannot cover a whole-pallet demand.` };
  }

  private choosePallet(Y: LanePod, laneY: Segment) {
    const v = this.evaluatePick(Y, laneY);
    this.verdict = v;
    this.Y = Y;
    this.host.clearGlows('scan:');
    if (v.kind === 'deny') {
      this.host.glow(`scan:${Y.code}`, podBounds(Y, laneY), COLORS.drop, 0.35, 1);
      this.notice('deny', `Denied — ${v.reason}`, v.text);
      this.set({ needsChoice: true, nextLabel: 'Scan the suggested pallet', status: `Scan of ${Y.code} refused before any write.` });
      if (get(flowState).auto) this.scheduleAuto();
      return;
    }
    this.host.glow(`scan:${Y.code}`, podBounds(Y, laneY), COLORS.chosen, 0.32, 1);
    const title = v.kind === 'proposed' ? 'Proposed pallet scanned' : v.kind === 'caseA' ? 'Case A — plain swap' : 'Case B — displacement';
    this.notice('ok', title, v.text);
    this.set({
      needsChoice: false, nextLabel: 'Confirm pick',
      prompt: 'Confirm to run SwapAllocation — or scan a different pallet to change your mind.',
      status: `${Y.code} scanned — confirm to run SwapAllocation.`,
    });
    if (get(flowState).auto) this.scheduleAuto();
  }

  private applyVerdict(): LedgerLine[] {
    const job = this.job!;
    const X = this.X!;
    const Y = this.Y!;
    const v = this.verdict!;
    const lines: LedgerLine[] = [];
    if (v.kind === 'deny') return lines;
    if (v.kind === 'proposed') {
      lines.push({ subject: job.id, before: `RESERVED against ${X.code}`, after: 'confirmed against the allocated pallet — no swap' });
      return lines;
    }
    const beforeY = allocText(Y.allocation, Y.cases);
    const beforeX = allocText(X.allocation, X.cases);
    const ours: Allocation = { order: job.order, job: job.id, qty: job.qty, jobStatus: 'RESERVED' };
    if (v.kind === 'caseB') {
      const displaced: Allocation = { ...v.displaced };
      X.allocation = displaced;
      lines.push({ subject: `${displaced.job} (${displaced.order})`, before: `fromPod ${Y.code} · ${Y.lane}`, after: `fromPod ${X.code} · ${X.lane} (displaced, status ${displaced.jobStatus})` });
    } else {
      X.allocation = null;
    }
    Y.allocation = ours;
    lines.unshift(
      { subject: Y.code, before: beforeY, after: allocText(Y.allocation, Y.cases) },
      { subject: X.code, before: beforeX, after: allocText(X.allocation, X.cases) },
      { subject: `${job.id} (${job.order})`, before: `fromPod ${X.code} · fromSegment ${X.lane}`, after: `fromPod ${Y.code} · fromSegment ${Y.lane} · fromZone ${ZONE}` },
    );
    job.podCode = Y.code;
    job.lane = Y.lane;
    return lines;
  }

  private enterPickRun() {
    const X = this.X!;
    const Y = this.Y!;
    const v = this.verdict!;
    const laneY = this.host.segment(Y.lane)!;
    const aisle = this.host.segment(AISLE)!;
    this.swapLedger = this.applyVerdict();
    this.ledgerAll.push(...this.swapLedger);
    this.host.rebuildStock();
    this.host.glow(`pod:${Y.code}`, podBounds(Y, laneY), COLORS.pick, 0.32, 1, true);
    if (v.kind === 'caseB') this.host.glow(`pod:${X.code}`, podBounds(X, this.host.segment(X.lane)!), COLORS.pick, 0.16, 0.7);
    let body: string;
    if (v.kind === 'proposed') body = 'The scanned pallet is the allocated one, so confirm is the ordinary pick: ALLOCATED → PICKED on that pallet and the stock leaves the lane.';
    else if (v.kind === 'caseA') body = `SwapAllocation commits in one transaction: ${Y.code} AVAILABLE → ALLOCATED for ${ORDER.job}, ${X.code} ALLOCATED → AVAILABLE, and the job is re-pointed (pod, pod line, segment, zone). The pallets never move, so the mixing check does not fire. Then the normal pick runs: ALLOCATED → PICKED and the stock leaves the lane.`;
    else if (v.kind === 'caseB') body = `SwapAllocation commits in one transaction: ${v.displaced.order}'s allocation moves from ${Y.code} onto ${X.code} (its job ${v.displaced.job} is re-pointed, still AVAILABLE), ${Y.code} is allocated to ${ORDER.job} and the job is re-pointed to it. Every denial was checked before this write; nothing is half-done. Then the normal pick runs on ${Y.code}.`;
    else body = '';
    const f = laneY.lane!.faceDir;
    const cx = laneCentreX(laneY);
    const frontY = podFrontY(Y, laneY);
    const yc = aisleCentreY(aisle);
    const d = this.host.ensureTruck();
    const steps: DriveStep[] = [];
    if (Y.lane !== X.lane || Math.abs(d.pos.x - cx) > 1) steps.push(...routeToLane(d.pos, laneY, aisle, () => this.host.chase(900, aisle)));
    steps.push(
      { kind: 'call', fn: () => this.set({ status: `Lifting to ${Y.code} (level ${Y.tier + 1}).` }) },
      { kind: 'lift', height: Y.z0 + 30, speed: SPEED.lift },
      { kind: 'move', x: cx, y: frontY + f * 1300, speed: SPEED.creep },
      { kind: 'move', x: cx, y: frontY, speed: SPEED.insert },
      { kind: 'lift', height: Y.z0 + 180, speed: SPEED.liftSlow },
      { kind: 'call', fn: () => this.liftPallet() },
      { kind: 'wait', duration: 0.4 },
      { kind: 'move', x: cx, y: laneFaceY(laneY) + f * STANDOFF, speed: SPEED.creep },
      { kind: 'lift', height: 300, speed: SPEED.lift },
      { kind: 'move', x: cx, y: yc, speed: SPEED.creep },
      { kind: 'turn', heading: [-1, 0], duration: 0.9 },
      { kind: 'call', fn: () => this.host.chase(900, aisle) }, { kind: 'wait', duration: 0.9 },
      { kind: 'call', fn: () => this.set({ status: `${Y.code} picked — driving to the marshalling bay.` }) },
      { kind: 'move', x: aisle.coordinateX + GOODS_IN_X, y: yc, speed: SPEED.drive },
    );
    this.set({
      title: v.kind === 'proposed' ? 'Confirm — pick' : 'Confirm — swap, then pick',
      body,
      ledger: this.swapLedger,
      status: `Swap committed. Truck picking ${Y.code} from ${Y.lane}…`,
    });
    this.runTruck(steps, () => this.finishPick());
  }

  private liftPallet() {
    const Y = this.Y!;
    this.host.hidePod(Y);
    this.host.clearGlows(`pod:${Y.code}`);
    this.host.carry(Y);
    this.set({ status: `${Y.code} on the forks — backing out of ${Y.lane}.` });
  }

  private finishPick() {
    const job = this.job!;
    const Y = this.Y!;
    const stock = this.host.laneStock().get(Y.lane)!;
    const before = allocText(Y.allocation, Y.cases);
    const idx = stock.pods.indexOf(Y);
    if (idx >= 0) stock.pods.splice(idx, 1);
    stock.classKey = stock.pods.length ? stock.pods[0].classKey : null;
    job.status = 'COMPLETE';
    Y.allocation = null;
    const policy = this.zonePolicy(ZONE);
    const lines: LedgerLine[] = [
      { subject: Y.code, before, after: `PICKED ${job.qty} · left ${Y.lane}` },
      { subject: Y.lane, before: plural(stock.pods.length + 1, 'pallet'), after: `${plural(stock.pods.length, 'pallet')} · hash ${stock.classKey ? hashLabel(policy, stock.classKey) + ' (unchanged)' : 'NULL (cleared — empty lane)'}` },
      { subject: job.id, before: 'RESERVED', after: `COMPLETE · picked ${Y.code}` },
    ];
    this.ledgerAll.push(...lines);
    this.host.rebuildStock();
    this.goto(this.i + 1);
  }

  // ---- COMPLETE -----------------------------------------------------------------

  private enterComplete() {
    const X = this.X!;
    const Y = this.Y!;
    const v = this.verdict!;
    const stock = this.host.laneStock();
    const lanesOfInterest = [...new Set([this.putawayLane?.fullName, X.lane, Y.lane].filter((n): n is string => !!n))];
    const rows = lanesOfInterest.map((n) => {
      const s = stock.get(n)!;
      const booked = s.pods.filter((p) => p.allocation).map((p) => `${p.code}→${p.allocation!.order}`).join(', ');
      return [n, String(s.pods.length), s.classKey ? describeClassKey(s.classKey) : '— (empty)', booked || '—'];
    });
    for (const n of lanesOfInterest) this.host.glow(`lane:${n}`, laneBox(stock.get(n)!), COLORS.ok, 0.12, 0.8);
    const bank = this.host.segment(ZONE);
    if (bank) this.host.focus([segBox(bank)], { dir: [-0.35, 0.6, 0.7], duration: 1600 });
    let outcome: string;
    if (v.kind === 'proposed') outcome = `${this.job!.id} completed against its allocated pallet.`;
    else if (v.kind === 'caseA') outcome = `${this.job!.id} completed against ${Y.code}; ${X.code} is AVAILABLE again for the next order — no one dug it out.`;
    else if (v.kind === 'caseB') outcome = `${this.job!.id} completed against ${Y.code}; ${v.displaced.order} now holds ${X.code} and its picker will meet the same face-pallet logic when their turn comes.`;
    else outcome = '';
    this.set({
      title: 'Pick complete',
      body: `${outcome} Allocation decided the class; the picker picked any pallet of that class; the swap made the ledger agree with the picker's hands and refused only where another order would have been left worse off. Lanes stayed pure throughout — substitution re-labels stock, it never moves a pallet between lanes.`,
      table: { head: ['Lane', 'Pods', 'Class', 'Booked'], rows },
      ledger: this.ledgerAll,
      facts: [
        'Invariant: allocation and swap never change T = AVAILABLE + ALLOCATED per class; only the pick reduces it.',
        'Still open in the design: replenishment picks from block stack (movement jobs, not pick jobs) are outside Part 3.',
      ],
      nextLabel: 'Restart',
      status: 'Truck back at the marshalling bay.',
    });
  }
}
