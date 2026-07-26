declare module 'd3-force-3d' {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<NodeDatum extends SimulationNodeDatum> {
    source: NodeDatum | string | number;
    target: NodeDatum | string | number;
    index?: number;
  }

  export interface Simulation<NodeDatum extends SimulationNodeDatum> {
    randomSource(source: () => number): this;
    force(name: string, force: unknown): this;
    stop(): this;
    tick(iterations?: number): this;
  }

  export interface LinkForce<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>
  > {
    id(accessor: (node: NodeDatum) => string | number): this;
    distance(distance: number | ((link: LinkDatum) => number)): this;
    strength(strength: number | ((link: LinkDatum) => number)): this;
  }

  export interface ManyBodyForce {
    strength(strength: number): this;
    distanceMax(distance: number): this;
  }

  export interface CollisionForce {
    strength(strength: number): this;
  }

  export function forceSimulation<NodeDatum extends SimulationNodeDatum>(
    nodes?: NodeDatum[],
    dimensions?: 1 | 2 | 3
  ): Simulation<NodeDatum>;

  export function forceLink<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>
  >(links?: LinkDatum[]): LinkForce<NodeDatum, LinkDatum>;

  export function forceManyBody(): ManyBodyForce;
  export function forceCenter(x?: number, y?: number, z?: number): unknown;
  export function forceCollide(radius?: number): CollisionForce;
}
