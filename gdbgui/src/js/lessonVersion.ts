export type LessonBundle = {
  version: string;
  fullname_to_render: string;
  source_code: string;
  breakpoints?: any[];
  program_input?: string;
  [key: string]: any;
};

export type VersionSummary = {
  version: number;
  parentVersion: number | null;
  createdAt: string;
};

export type LessonSnapshot = VersionSummary & {
  title: string;
  bundle: LessonBundle;
};

export type VersionGraphNode = VersionSummary & {
  lane: number;
  isHead: boolean;
};

export type VersionGraphEdge = {
  from: number;
  to: number;
};

export type VersionGraph = {
  nodes: VersionGraphNode[];
  edges: VersionGraphEdge[];
  laneCount: number;
};

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) || "null";
}

export function hasSnapshotChanges(
  baseline: LessonSnapshot,
  candidate: { title: string; bundle: LessonBundle }
): boolean {
  return (
    stableJson({ title: baseline.title, bundle: baseline.bundle }) !==
    stableJson({ title: candidate.title, bundle: candidate.bundle })
  );
}

const isVersion = (value: any): value is number =>
  typeof value === "number" &&
  isFinite(value) &&
  Math.floor(value) === value &&
  value > 0;

export function layoutVersionGraph(
  versions: VersionSummary[],
  headVersion: number
): VersionGraph {
  const byVersion = new Map<number, VersionSummary>();
  versions.forEach(summary => {
    if (isVersion(summary.version)) byVersion.set(summary.version, summary);
  });

  const children = new Map<number, number[]>();
  const edges: VersionGraphEdge[] = [];
  byVersion.forEach(summary => {
    if (
      !isVersion(summary.parentVersion) ||
      summary.parentVersion === summary.version ||
      !byVersion.has(summary.parentVersion)
    )
      return;
    const siblings = children.get(summary.parentVersion) || [];
    siblings.push(summary.version);
    children.set(summary.parentVersion, siblings);
    edges.push({ from: summary.version, to: summary.parentVersion });
  });
  children.forEach(siblings => siblings.sort((a, b) => b - a));

  const laneByVersion = new Map<number, number>();
  const visiting = new Set<number>();
  let nextLane = 0;
  const visit = (version: number): number => {
    const assigned = laneByVersion.get(version);
    if (assigned !== undefined) return assigned;
    visiting.add(version);
    const descendants = (children.get(version) || []).filter(
      child => !visiting.has(child)
    );
    const lane = descendants.length ? visit(descendants[0]) : nextLane++;
    descendants.slice(1).forEach(visit);
    laneByVersion.set(version, lane);
    visiting.delete(version);
    return lane;
  };

  const orderedVersions = Array.from(byVersion.keys()).sort((a, b) => a - b);
  const roots = orderedVersions.filter(version => {
    const parent = byVersion.get(version)!.parentVersion;
    return !isVersion(parent) || parent === version || !byVersion.has(parent);
  });
  roots.forEach(visit);
  orderedVersions.forEach(visit);

  return {
    nodes: Array.from(byVersion.values())
      .sort((a, b) => b.version - a.version)
      .map(summary => ({
        ...summary,
        lane: laneByVersion.get(summary.version)!,
        isHead: summary.version === headVersion
      })),
    edges: edges.sort((a, b) => b.from - a.from),
    laneCount: nextLane
  };
}
