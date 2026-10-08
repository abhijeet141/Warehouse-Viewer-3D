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
// follows Task/FLD-69 (HLD, how-it-decides) and the FLD-68 Part 3 change list.

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
    scenarios: [], totals: [], totalsZone: 'BSD',
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
const ZONE = 'BSD';
const AISLE = 'BS3';
const GOODS_IN_X = -10000;   // on the front cross-aisle, just outside the BS3 mouth
const STANDOFF = 1600;       // truck waits this far outside a lane's face line
const SPEED = { drive: 5500, creep: 1500, insert: 700, lift: 1300, liftSlow: 350 };
const READ_MS = 5200;        // auto-play dwell per step at 1×
const NEW_POD = { product: '4471', batch: 'B7', cases: 40 };
const ORDER = { id: 'ORD-1001', qty: 40, job: 'J-501', rule: 'R-12 · consumer orders · oldest first · pod substitution on' };

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
      if (t.kind === 'other') { this.notice('deny', 'Not a block-stack segment', 'Pick one of the segments on the floor in zone BSD.'); return; }
      this.chooseLane(t.lane.fullName);
    } else if (this.stepId === 'pick-scan') {
      if (t.kind !== 'pod') { this.notice('deny', 'Nothing to scan', 'Scan a pod — the pods you can reach are lit green.'); return; }
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
        job.rule = 'R-40 · pharma line · pod-directed';
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
      ({ id, label, hint: target ? hint : 'no matching pod in this stock', enabled: !!target });
    return [
      mk('caseA', 'Case A · free pod', `Scan ${t.free?.face.code}: a free pod of the same class — the booking simply moves to it`, t.free),
      mk('caseB', 'Case B · booked pod', `Scan ${t.caseB?.face.code}: booked to ${t.caseB?.face.allocation?.order}, not started yet — that order is moved onto ${this.X?.code}`, t.caseB),
      mk('hash', 'Other class', `Scan ${t.hash?.face.code}: a different class — not in the permitted set (2814)`, t.hash),
      mk('deep', 'Buried pod', `Scan ${t.deep?.face.code}: the allocated pod itself, under the stack — not reachable`, t.deep),
      mk('reserved', 'Reserved by a picker', `Scan ${t.reserved?.face.code}: another picker already holds its job — it is never moved (2818)`, t.reserved),
      mk('directed', 'Substitution off', `A rule without pod substitution (R-40), then scan ${t.free?.face.code} — refused (2815)`, t.free),
      mk('short', 'Part pod', `Scan ${t.short?.face.code}: only ${t.short ? podAvailable(t.short.face) : 0} cases free for a ${qtyText(this.job)} job — refused (2818)`, t.short),
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
    const zones = ['BSD', 'BSE', 'BSF'].map((c) => this.host.segment(c)).filter((s): s is Segment => !!s);
    for (const z of zones) this.host.glow(`zone:${z.fullName}`, segBox(z), COLORS.zone, 0.1, 0.8);
    this.host.focus(zones.map((z) => segBox(z)), { dir: [-0.35, 0.62, -0.55], duration: 1500 });
    this.set({
      title: 'Block stack: one class of stock per segment',
      body: 'Block-stack segments are deep and worked from one end, so whatever shares a segment must be interchangeable. Each zone carries one stock-mix policy — the attributes a pod must match to count as the same stock — and every segment holds one such class at a time.',
      facts: [
        `BSD — ${this.zonePolicy('BSD')}: ${POLICIES[this.zonePolicy('BSD')!].label} (keys ${POLICIES[this.zonePolicy('BSD')!].keys.join(', ')})`,
        `BSE — ${this.zonePolicy('BSE')}: ${POLICIES[this.zonePolicy('BSE')!].label} (keys ${POLICIES[this.zonePolicy('BSE')!].keys.join(', ')})`,
        `BSF — ${this.zonePolicy('BSF')}`,
        'A segment uses its own policy if it has one, otherwise its zone\'s — per account, so one segment can follow a different policy for each client.',
        'Segments with stock-mix tracking switched off are never checked (segments.trackStockMix).',
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
      title: 'Same stock or not: the class fingerprint',
      body: `Every pod is fingerprinted on the policy's attributes. Under ${policy} (zone BSD) a Cola pod of batch B7 and one of batch B9 are two classes and can never share a segment; under BS-PRODUCT-ONLY (zone BSE) they are one class and may. Same pods, different fingerprints — the policy sets the balance between purity and density.`,
      table: { head: ['Segment', 'Pods', 'Class', 'Hash'], rows },
      facts: [
        'The fingerprint is a SHA-256 of the pod\'s values for the policy\'s keys; magma-pods computes one per policy in play.',
        'A pod carrying two batches is its own class — BSD04 can only ever share with an identical mixed pod.',
        'An empty segment has no class (hash NULL): it takes the class of the first pod put into it and keeps it until it is empty again.',
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
      title: 'Putaway: a pod arrives',
      body: `Goods-in has receipted pod GI-2041: ${NEW_POD.cases} cases of ${product.code} ${product.name}, batch ${NEW_POD.batch}. Before any segment is considered, putaway fingerprints the pod once per policy in play for this warehouse and account, and the fingerprints travel with the reservation request.`,
      facts: [
        `Under BS-PRODUCT-BATCH → ${this.classText('BS-PRODUCT-BATCH', keyBatch)}`,
        `Under BS-PRODUCT-ONLY → ${this.classText('BS-PRODUCT-ONLY', keyProd)}`,
        'The pod carries fingerprints, not a destination: the putaway rule\'s zones decide where it may go, exactly as before.',
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
    // Survivors are taken in the zone's putaway order (lane number here) and the first
    // suitable one wins; the engine has no preference for a part-filled lane (Q3).
    this.engineLane = this.candidates.find((c) => c.verdict.startsWith('ok'))?.lane ?? null;
    this.putawayLane = null;
    const policy = this.zonePolicy(ZONE);
    const verdictText: Record<PutawayCandidate['verdict'], string> = {
      'ok-empty': 'OK · empty (hash NULL)', 'ok-same': 'OK · same class', 'drop-class': 'dropped · class differs', 'drop-full': 'dropped · segment full',
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
      title: 'The rule says zone BSD; the stock-mix gate filters its segments',
      body: `The putaway rule routes the pod to zone BSD, as it always has. Each candidate segment is then checked on its own: tracking off → accept; empty → accept; same class under the segment's policy → accept; a different class → dropped. The segments that pass are taken in the zone's putaway order and the first one wins — ${this.engineLane?.fullName ?? 'none'}${this.candidates.find((c) => c.lane === this.engineLane)?.verdict === 'ok-same' ? ', which already holds this class' : ''}.`,
      table: { head: ['Segment', 'Pods', 'Holds', 'Verdict'], rows, mark: this.candidates.map((c, i) => (c.lane === this.engineLane ? i : -1)).filter((i) => i >= 0) },
      facts: [
        `GI-2041's class under ${policy}: ${this.classText(policy, pod.classKey)}.`,
        'Capacity is checked as well: the segment\'s pod count + 1 must not exceed its maximum.',
        'The engine does not prefer a part-filled segment over an empty one: purity is guaranteed, density is a configuration choice (putaway order, home locations).',
      ],
      prompt: `Click a segment in BSD to put GI-2041 there — the engine's own choice is outlined. Try a red segment to see the refusal.`,
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
      this.notice('deny', 'Outside the rule\'s zones', `${name} is in zone ${zone}. The putaway rule for this pod names zone BSD only; segments elsewhere are never candidates, whatever they hold.`);
      return;
    }
    if (c.verdict === 'drop-full') {
      this.notice('deny', 'Segment full', `${name} holds ${c.stock.pods.length} of ${c.lane.lane!.maxPods} pods. One more would exceed its maximum, so it is not a suitable segment.`);
      return;
    }
    if (c.verdict === 'drop-class') {
      const policy = this.zonePolicy(ZONE);
      this.notice('deny', 'Refused — stock-mix policy (error 1942)',
        `${name} holds ${this.classText(policy, c.stock.classKey!)}; GI-2041 is ${this.classText(policy, pod.classKey)}. Two classes cannot share a tracked segment: the reservation engine drops the segment, and even a forced move would be refused by the stock write itself — "Segment may only hold stock matching on [product, batch]".`);
      return;
    }
    this.putawayLane = c.lane;
    this.notice('ok', c.verdict === 'ok-empty' ? `${name} accepted — empty segment` : `${name} accepted — same class`,
      c.verdict === 'ok-empty'
        ? `${name} has no class yet. Any class may open it; on confirm the segment is stamped with ${hashLabel(this.zonePolicy(ZONE), pod.classKey)}.`
        : `${name} already holds ${describeClassKey(c.stock.classKey!)} — the same class as GI-2041, so the segment stays pure.`);
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
      body: `${lane.fullName} is reserved for GI-2041, the putaway job is created and the truck takes the pod out. A block-stack segment fills from the back and stacks each position to the top before the next is started — a truck cannot reach over a stack — so the pod goes to position ${pod.index} of ${cfg.maxPods}: ${column === 0 ? 'back row' : column === cfg.deep - 1 ? 'front row' : `row ${cfg.deep - column}`}, level ${tier + 1}.`,
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
      { subject: pod.lane, before: plural(stock.pods.length - 1, 'pod'), after: `${plural(stock.pods.length, 'pod')} · ${pod.code} at position ${pod.index}` },
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
      body: 'The confirm writes the pod into the segment, and every stock write passes one gate in magma-pods that recomputes the segment\'s classes. One class → the segment\'s hash is stamped or left unchanged; two → the write is refused (1942); none → the hash is cleared. Putaway, moves and stock edits all pass the same gate, so nothing else needs to know the rule.',
      ledger: this.putawayLedger,
      facts: [
        `Pod count ${stock.pods.length - 1} → ${stock.pods.length} of ${lane.lane!.maxPods}.`,
        'A tracked segment whose policy cannot be resolved is reported, never filled by guessing.',
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
    const lanesWith = new Set(cands.map((c) => c.pod.lane)).size;
    this.set({
      title: 'Allocation: an order arrives',
      body: `${ORDER.id} wants ${ORDER.qty} cases of 4471 Cola. Rule ${ORDER.rule.split(' · ')[0]} (consumer orders) allocates from zone BSD, oldest stock first, and allows pod substitution. Allocation books stock on one named pod — AVAILABLE becomes ALLOCATED — it creates nothing and moves nothing.`,
      facts: [
        `${cands.length} AVAILABLE Cola pods in ${lanesWith} segments of BSD are eligible — batches B7, B9, B11 and the mixed pod alike; the order line does not pin a batch.`,
        'The rule\'s "allow pod substitution" flag is copied onto the pick job it creates, so the job keeps that permission even if the rule changes later.',
        'Allocation itself is unchanged by block stack.',
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
    const above = stock.pods.filter((p) => p.column === X.column && p.tier > X.tier).length;
    const inFront = stock.pods.filter((p) => p.column > X.column).length;
    this.host.glow(`pod:${X.code}`, podBounds(X, lane), COLORS.pick, 0.32, 1, true);
    this.host.focus([laneBox(stock)], { dir: [-0.6, 0.45, lane.lane!.faceDir * 0.65], duration: 1500, aisle: this.host.segment(AISLE) });
    const lines: LedgerLine[] = [
      { subject: X.code, before, after: allocText(X.allocation, X.cases) },
      { subject: ORDER.job, before: '—', after: `fromPod ${X.code} · fromSegment ${X.lane} · fromZone ${ZONE} · allowPodSubstitution = true · AVAILABLE` },
    ];
    this.ledgerAll.push(...lines);
    const toppedUp = this.putawayLane?.fullName === X.lane;
    const buried = `${plural(above, 'pod')} stacked on it${inFront ? ` and ${plural(inFront, 'pod')} in front of it` : ''}`;
    this.set({
      title: `The engine names ${X.code} — it has no depth model`,
      body: `Oldest first lands on ${X.code}: the first pod put into ${X.lane}, so it stands at the back of the segment on the floor with ${buried}${toppedUp ? ` (GI-2041, now ${this.newPod!.code}, among them)` : ''}. The engine cannot know that — allocation has no notion of depth. Pick job ${ORDER.job} is created against ${X.code} with substitution allowed, and the picker is now owed a pod nobody can reach.`,
      ledger: lines,
      facts: [
        `Zone totals for class ${describeClassKey(X.classKey)}: AVAILABLE −${ORDER.qty}, ALLOCATED +${ORDER.qty}; the physical total does not change.`,
        'Block stack does not change allocation; it makes the depth problem harmless at the point of pick.',
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
      if (s.lane.fullName === X.lane && s.pods.length < 2) continue; // the own lane only for its other pallets
      out.push({ lane: s.lane, stock: s, face: s.pods[s.pods.length - 1] });
    }
    // The job's own lane first, then the fewest pallets, then the nearest; never more than the cap.
    const own = laneNumber(X.lane);
    out.sort((a, b) =>
      (b.lane.fullName === X.lane ? 1 : 0) - (a.lane.fullName === X.lane ? 1 : 0) ||
      a.stock.pods.length - b.stock.pods.length ||
      Math.abs(laneNumber(a.lane.fullName) - own) - Math.abs(laneNumber(b.lane.fullName) - own) ||
      laneNumber(a.lane.fullName) - laneNumber(b.lane.fullName));
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
      title: 'Picking: start-pick lists the segments the picker may use',
      body: `The picker takes ${job.id}: it is reserved to them, and the pick list now carries the substitutable set — the segments of zone BSD holding the same class under the same policy, in a pickable status. The job's own segment comes first, then the segment with the fewest pods, then the nearest; never more than the policy's cap of 10.`,
      table: {
        head: ['Segment', 'Pods', 'Face pod', 'Face status'],
        rows: this.subSet.map((e) => [
          e.lane.fullName, String(e.stock.pods.length), e.face.code,
          e.face.allocation ? `BOOKED ${e.face.allocation.order} (${e.face.allocation.jobStatus === 'RESERVED' ? 'picker on it' : 'not started'})` : 'FREE',
        ]),
      },
      facts: [
        `BSD03 is not in the set: it holds ${describeClassKey('4471|B9')}, a different class. The set is pure by construction, which is what makes substitution safe.`,
        'Scope is set per policy: this segment only, this zone, or the whole warehouse (new) — the job\'s zone first, other zones after, up to the cap.',
        'The list is advisory: the handheld validates scans against it, and every check is run again at confirm.',
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
    const above = stockX.pods.filter((p) => p.column === X.column && p.tier > X.tier).length;
    this.verdict = null;
    this.Y = null;
    this.host.glow(`pod:${X.code}`, podBounds(X, laneX), COLORS.pick, 0.3, 1, true);
    for (const e of this.subSet) {
      if (e.face.code === X.code) continue;
      this.host.glow(`cand:${e.face.code}`, podBounds(e.face, e.lane), e.face.allocation ? COLORS.pick : COLORS.ok, 0.26, 0.95, true);
    }
    this.set({
      title: 'At the segment: pick what you can reach',
      body: `${X.code} sits under ${stockX.pods.slice(X.index).map((p) => p.code.slice(-2)).join(', ')} — level ${X.tier + 1}, ${plural(above, 'pod')} above — so the picker can reach only the face pod. The handheld now accepts any pod in the set, so they scan the one in front of them. On confirm the scanned pod goes to SwapAllocation, which settles on Case A, Case B or a refusal before anything is written.`,
      facts: [
        `Case A: the scanned pod has enough free stock — it takes the booking and ${X.code} is released.`,
        `Case B: the scanned pod is booked to another order nobody has started — that order is moved onto ${X.code}, provided its own rule accepts it. One move, no chain reaction.`,
        'Checks, in order: the job may swap (rule flag) → the pod is in the permitted set → same class, fingerprinted again → enough stock, Case A or B → both order lines accept their new pods (allocation\'s own check).',
      ],
      prompt: `Click a face pod — green = free, amber = booked to another order — or pick a scenario below and the flow scans the right pod for you.`,
      scenarios: this.computeScenarios(),
      needsChoice: true,
      nextLabel: 'Scan the suggested pod',
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
      return { kind: 'deny', reason: 'buried, not reachable', text: `${Y.code} is position ${Y.index} of ${cfgY.maxPods} in ${Y.lane} with ${plural(after, 'pod')} stacked after it. Only the face pod${face ? ` (${face.code})` : ''} can be scanned — the system has no depth model; the picker's hands do.` };
    }
    if (Y.code === X.code) return { kind: 'proposed', text: `${X.code} is itself the face pod of ${X.lane}: pick it as allocated — no swap needed.` };
    if (!job.podSubstitution) return { kind: 'deny', reason: 'substitution off (2815)', text: `Job ${job.id} was allocated under ${job.rule}: pod substitution is off, so only ${X.code} may be picked. The handheld offers no alternatives for such a job.` };
    if (cfgY.block !== job.zone) return { kind: 'deny', reason: 'outside the permitted set (2814)', text: `${Y.code} stands in zone ${cfgY.block}. The policy's scope is the job's zone (${job.zone}), so segments elsewhere are never offered; with warehouse scope they would be, up to the cap.` };
    if (!cfgY.trackStockMix) return { kind: 'deny', reason: 'untracked segment (2814)', text: `${Y.lane} is not stock-mix tracked, so it has no class to compare and is never in the set.` };
    if (Y.classKey !== X.classKey) return { kind: 'deny', reason: 'different class (2814)', text: `${Y.lane} holds ${this.classText(cfgY.policy, Y.classKey)}; the job's class is ${this.classText(cfgY.policy, X.classKey)}. The segment is not in the permitted set, so the scan is refused — and at confirm both pods are fingerprinted again (2816 if they differ).` };
    if (job.requiredBatch && !Y.batches.includes(job.requiredBatch)) return { kind: 'deny', reason: 'the order line does not accept it (2817)', text: `The order line requires batch ${job.requiredBatch}; ${Y.code} carries ${Y.batches.join('+')}.` };
    const avail = podAvailable(Y);
    if (avail >= job.qty) return { kind: 'caseA', text: `Case A — ${Y.code} has ${avail} free and the job needs ${job.qty}. On confirm: ${Y.code} AVAILABLE → ALLOCATED {${job.order} · ${job.id}}, ${X.code} ALLOCATED → AVAILABLE, and ${job.id} is re-pointed to ${Y.code} in ${Y.lane}. No pod moves, so the segment-mixing check never fires.` };
    const a = Y.allocation;
    if (a) {
      if (a.jobStatus === 'RESERVED') return { kind: 'deny', reason: 'booked to a job already in progress (2818)', text: `${Y.code} is booked to ${a.order} and its job ${a.job} is reserved by another picker. A job someone is already working on is never moved.` };
      if (a.jobStatus === 'COMPLETE') return { kind: 'deny', reason: 'already picked', text: `${Y.code}'s booking ${a.job} is complete.` };
      if (avail + a.qty >= job.qty && X.cases >= a.qty) return { kind: 'caseB', displaced: a, text: `Case B — ${Y.code} is booked to ${a.order} (${a.qty} cases, job ${a.job} not started). On confirm ${a.order} is moved onto ${X.code} — same class, ${X.cases} cases, and its rule accepts it — and ${Y.code} is booked to ${job.order} instead. Had ${a.order} not accepted ${X.code}, the whole swap would be refused; nothing is ever half-done.` };
      return { kind: 'deny', reason: 'not enough stock, even after moving the other order (2818)', text: `${Y.code} offers ${avail} free + ${a.qty} that could be moved = ${avail + a.qty}, below the ${job.qty} needed.` };
    }
    return { kind: 'deny', reason: 'not enough stock on the pod (2818)', text: `${Y.code} has only ${avail} cases free; the job needs ${job.qty} and there is no booking on it that could be moved.` };
  }

  private choosePallet(Y: LanePod, laneY: Segment) {
    const v = this.evaluatePick(Y, laneY);
    this.verdict = v;
    this.Y = Y;
    this.host.clearGlows('scan:');
    if (v.kind === 'deny') {
      this.host.glow(`scan:${Y.code}`, podBounds(Y, laneY), COLORS.drop, 0.35, 1);
      this.notice('deny', `Refused — ${v.reason}`, v.text);
      this.set({ needsChoice: true, nextLabel: 'Scan the suggested pod', status: `Scan of ${Y.code} refused before any write.` });
      if (get(flowState).auto) this.scheduleAuto();
      return;
    }
    this.host.glow(`scan:${Y.code}`, podBounds(Y, laneY), COLORS.chosen, 0.32, 1);
    const title = v.kind === 'proposed' ? 'The named pod scanned' : v.kind === 'caseA' ? 'Case A — the booking moves to this pod' : 'Case B — the other order is moved';
    this.notice('ok', title, v.text);
    this.set({
      needsChoice: false, nextLabel: 'Confirm pick',
      prompt: 'Confirm to run the swap — or scan a different pod to change your mind.',
      status: `${Y.code} scanned — confirm to run the swap.`,
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
      lines.push({ subject: job.id, before: `RESERVED against ${X.code}`, after: 'confirmed against the allocated pod — no swap' });
      return lines;
    }
    const beforeY = allocText(Y.allocation, Y.cases);
    const beforeX = allocText(X.allocation, X.cases);
    const ours: Allocation = { order: job.order, job: job.id, qty: job.qty, jobStatus: 'RESERVED' };
    if (v.kind === 'caseB') {
      const displaced: Allocation = { ...v.displaced };
      X.allocation = displaced;
      lines.push({ subject: `${displaced.job} (${displaced.order})`, before: `fromPod ${Y.code} · ${Y.lane}`, after: `fromPod ${X.code} · ${X.lane} (moved by the swap, job ${displaced.jobStatus === 'AVAILABLE' ? 'not started' : displaced.jobStatus})` });
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
    if (v.kind === 'proposed') body = 'The scanned pod is the allocated one, so confirm is the ordinary pick: ALLOCATED → PICKED on that pod and the stock leaves the segment.';
    else if (v.kind === 'caseA') body = `The swap commits in one transaction: ${Y.code} AVAILABLE → ALLOCATED for ${ORDER.job}, ${X.code} ALLOCATED → AVAILABLE, and the job is re-pointed (pod, line, segment, zone, job format). The journal records the two moves as an exchange (operation types 40 and 39), not as a de-allocation and a fresh allocation. The pods never move, so the segment-mixing check does not fire. Then the normal pick runs: ALLOCATED → PICKED and the stock leaves the segment.`;
    else if (v.kind === 'caseB') body = `The swap commits in one transaction: ${v.displaced.order}'s booking moves from ${Y.code} onto ${X.code} (job ${v.displaced.job} re-pointed, still not started), ${Y.code} is booked to ${ORDER.job} and ${ORDER.job} is re-pointed to it — journalled as an exchange (operation types 40 and 39). Every check passed before this write; nothing is half-done. Then the normal pick runs on ${Y.code}.`;
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
      { subject: Y.lane, before: plural(stock.pods.length + 1, 'pod'), after: `${plural(stock.pods.length, 'pod')} · hash ${stock.classKey ? hashLabel(policy, stock.classKey) + ' (unchanged)' : 'NULL (cleared — empty segment)'}` },
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
    if (v.kind === 'proposed') outcome = `${this.job!.id} completed against its allocated pod.`;
    else if (v.kind === 'caseA') outcome = `${this.job!.id} completed against ${Y.code}; ${X.code} is free again for the next order — nobody dug it out.`;
    else if (v.kind === 'caseB') outcome = `${this.job!.id} completed against ${Y.code}; ${v.displaced.order} now holds ${X.code}, and its picker gets the same face-pod freedom when their turn comes.`;
    else outcome = '';
    this.set({
      title: 'Pick complete',
      body: `${outcome} Allocation decided the class; the picker took any pod of that class; the swap made the records agree with the picker's hands and refused only where another order would have been left worse off. Segments stayed pure throughout — substitution re-labels stock, it never moves a pod between segments.`,
      table: { head: ['Segment', 'Pods', 'Class', 'Booked'], rows },
      ledger: this.ledgerAll,
      facts: [
        'Invariant: allocation and the swap never change AVAILABLE + ALLOCATED per class; only the pick reduces it.',
        'Also covered: a job allocated from HELD or RECEIPTED stock swaps only onto free stock of the same kind, and a whole-pod job may take a bigger pod when that pod may be broken (the job becomes a case pick).',
        'Outside this release: replenishment picks from block stack (movement jobs).',
      ],
      nextLabel: 'Restart',
      status: 'Truck back at the marshalling bay.',
    });
  }
}
