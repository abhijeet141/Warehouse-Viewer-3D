export type SegmentType = 'AISLE' | 'BAY' | 'LEVEL' | 'SPACE' | 'BLOCK' | 'LANE';

// Block-stack lane (FLD-69): how the lane is stacked and what governs it. A lane
// is a single-ended deep floor location worked only from its face; a tracked lane
// holds one stock class at a time under the stock-mix policy resolved for it.
export interface LaneConfig {
  block: string;          // the BLOCK (zone/area) this lane belongs to, e.g. "BSA"
  deep: number;           // pallet positions from face to back
  tiers: number;          // pallets stacked per position
  maxPods: number;        // FloWMS maximumPods for the lane (deep × tiers)
  faceDir: 1 | -1;        // which side (along coordinateY) the lane opens on
  trackStockMix: boolean; // segments.trackStockMix
  policy: string | null;  // resolved stock-mix policy code; null when untracked
  db?: LaneDbInfo;        // DB mode: what location_service says about this lane
}

// DB mode: the real lane's record in location_service, for the tooltip and the
// summary. Absent on the seeded demo lanes.
export interface LaneDbInfo {
  segmentId: number;
  zoneId: number | null;
  zoneCode: string | null;             // e.g. SAX1-ZONE-BLOCK-STACK-A
  zoneName: string | null;             // e.g. Block Stack A
  accountId: number | null;
  zonePreference: number | null;
  putawayPreference: number | null;
  allocationPreference: number | null;
  pickSequence: number | null;
  policyId: number | null;
  policyName: string | null;
  policyKeys: string[];                // stock hash keys, sorted
  policySource: 'segment' | 'zone' | null;
  hash: string | null;                 // segments.currentStockMixHash
  currentPodCount: number;             // segments.currentPodCount
  status: string;                      // segment status name
  podTypeName: string | null;          // currentPodType
  mixedClasses: boolean;               // pallets found in the lane disagree on class
  role?: 'lane' | 'pick-location';  // a block-stack lane, or a slot on a pick location pad
  useTypes?: string[];                 // the segment's use types (pick locations)
}

export interface Segment {
  fullName: string;
  type: SegmentType;

  // Optional backend metadata (absent for the hardcoded demo data). id is used
  // when real stock occupancy is available; isLeaf marks non-rack floor
  // locations (goods-in/packing) the goods builder also fills.
  id?: number;
  isLeaf?: boolean;

  // Viewer metadata. lane: present on LANE segments. floorStorage: block-stack
  // BLOCK/LANE segments and their drive aisles — they live on the slab the
  // racking leaves free, so the building shell is not sized from them and the
  // virtual tour does not route through them (drive aisles stay walkable by hand).
  lane?: LaneConfig;
  floorStorage?: boolean;

  coordinateX: number;
  coordinateY: number;
  coordinateZ: number;

  dimensionX: number;
  dimensionY: number;
  dimensionZ: number;

  offsetX: number;
  offsetY: number;
  offsetZ: number;
}
