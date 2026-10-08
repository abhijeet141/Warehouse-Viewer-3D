export type SegmentType = 'AISLE' | 'BAY' | 'LEVEL' | 'SPACE' | 'BLOCK' | 'LANE';

// Block-stack lane (FLD-69): how the lane is stacked and what governs it. A lane
// is a single-ended deep floor location worked only from its face; a tracked lane
// holds one stock class at a time under the stock-mix policy resolved for it.
export interface LaneConfig {
  block: string;          // the BLOCK (zone/area) this lane belongs to, e.g. "BSD"
  deep: number;           // pallet positions from face to back
  tiers: number;          // pallets stacked per position
  maxPods: number;        // FloWMS maximumPods for the lane (deep × tiers)
  faceDir: 1 | -1;        // which side (along coordinateY) the lane opens on
  trackStockMix: boolean; // segments.trackStockMix
  policy: string | null;  // resolved stock-mix policy code; null when untracked
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

// On-screen name of a segment type: the block-stack location is a segment to the user.
export const typeLabel = (t: string): string => (t === 'LANE' ? 'SEGMENT' : t);
