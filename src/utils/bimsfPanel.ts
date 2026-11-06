import { PrismaClient, type ComponentType } from '@prisma/client';

export type BimsfLookup = {
  byIfcGuid: Record<string, string>;
  byElementId: Record<string, string>;
};

export function normalizeBimsf(raw: string): string {
  return String(raw || '')
    .replace(/^\*/, '')
    .trim();
}

function isFoundationStyle(name: string): boolean {
  return /\bfoundations?\b|\bfootings?\b|\bfooting\s*walls?\b|\bwall\s*foundations?\b|\bbearing\s*footings?\b/i.test(
    name
  );
}

/** Rollformed LGS marks: load/non-load bearing walls, cold-formed decks, floor and roof trusses. */
const LGS_MARK_PREFIXES = ['NLB', 'ELB', 'ILB', 'LB', 'CD', 'FT', 'RT'] as const;

/** Cast or factory-built unit marks: precast walls, hollow core, tie beams, footings, pads, pods. */
const PRECAST_MARK_PREFIXES = ['PCW', 'HCS', 'TB', 'PF', 'LP', 'POD'] as const;

const EMBEDDED_MARK_RE = new RegExp(
  `\\b((?:${[...PRECAST_MARK_PREFIXES, ...LGS_MARK_PREFIXES].join('|')})[-_]?\\d{1,8}(?:-\\d+)?)\\b`,
  'i'
);

/** Canonical panel label, or null for IFC member names. Covers LGS and precast marks. */
export function canonicalBimsfMark(raw: string | null | undefined): string | null {
  const name = normalizeBimsf(raw || '');
  if (!name) return null;

  // An explicit mark always wins over the generic category names below. Precast
  // footings are individually cast, shipped and installed, so PF-003 must stay
  // its own panel instead of collapsing into the shared "Foundation" group.
  if (/^[A-Za-z]{1,4}[-_]?\d{1,8}(?:-\d+)?$/.test(name)) return name;
  const embedded = name.match(EMBEDDED_MARK_RE);
  if (embedded) return embedded[1].toUpperCase();

  if (isFoundationStyle(name)) return 'Foundation';
  if (/^anchor\s*bolts?$/i.test(name)) return 'Anchor Bolt';
  if (/^connectors?$/i.test(name)) return 'Connectors';
  return null;
}

const COMPONENT_TYPE_BY_PREFIX: Record<string, ComponentType> = {
  LB: 'LGS_WALL_LB',
  ELB: 'LGS_WALL_LB',
  ILB: 'LGS_WALL_LB',
  NLB: 'LGS_WALL_NLB',
  FT: 'LGS_FLOOR_TRUSS',
  RT: 'LGS_ROOF_TRUSS',
  PCW: 'PRECAST_WALL',
  PF: 'PRECAST_FOOTING',
  HCS: 'HOLLOWCORE_SLAB',
  TB: 'TIE_BEAM',
  LP: 'LEVELING_PAD',
  POD: 'POD',
};

/** Infer the fabrication route from a panel mark prefix. Null when the mark carries no prefix. */
export function componentTypeFromMark(mark: string | null | undefined): ComponentType | null {
  const canonical = canonicalBimsfMark(mark);
  if (!canonical) return null;
  if (/^connectors?$/i.test(canonical)) return 'CONNECTOR';
  const prefix = canonical.match(/^([A-Za-z]{1,4})/)?.[1]?.toUpperCase();
  return (prefix && COMPONENT_TYPE_BY_PREFIX[prefix]) || null;
}

/** Precast and pod units are cast whole, so their members must never be collapsed into one panel. */
export function isMonolithicComponent(type: ComponentType | null | undefined): boolean {
  return (
    type === 'PRECAST_WALL' ||
    type === 'PRECAST_FOOTING' ||
    type === 'HOLLOWCORE_SLAB' ||
    type === 'TIE_BEAM' ||
    type === 'LEVELING_PAD' ||
    type === 'POD'
  );
}

/** Real BIMSF marks only — not IFC member names or invented "Wall Panel" labels. */
export function isRealBimsfMark(raw: string | null | undefined): boolean {
  return canonicalBimsfMark(raw) !== null;
}

export function revitIdFromPanelName(name?: string | null, tag?: string | null): string | null {
  if (tag && /^\d+$/.test(tag)) return tag;
  const fromName = String(name || '').match(/:(\d+)\s*$/)?.[1];
  return fromName || null;
}

export async function loadBimsfLookups(
  prisma: PrismaClient,
  projectId: number
): Promise<Map<string, BimsfLookup>> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { buildSystem: true },
  });

  // Pure precast has no member assemblies to collapse: one cast unit is one panel.
  // HYBRID still collapses, so LGS infill walls group while precast marks pass through singly.
  if (project?.buildSystem === 'PRECAST') return new Map();

  const models = await prisma.model.findMany({
    where: { projectId, isActive: true },
    select: { id: true, spatialStructure: true },
  });
  const out = new Map<string, BimsfLookup>();
  for (const model of models) {
    const map = (model.spatialStructure as { bimsfMap?: BimsfLookup } | null)?.bimsfMap;
    out.set(model.id, {
      byIfcGuid: map?.byIfcGuid || {},
      byElementId: map?.byElementId || {},
    });
  }
  return out;
}

export function projectHasBimsfMaps(lookups: Map<string, BimsfLookup>): boolean {
  for (const lookup of lookups.values()) {
    if (Object.keys(lookup.byElementId).length || Object.keys(lookup.byIfcGuid).length) {
      return true;
    }
  }
  return false;
}

export function resolveBimsfMark(
  panel: {
    name?: string | null;
    tag?: string | null;
    metadata?: unknown;
    modelId?: string | null;
    element?: { globalId?: string | null; properties?: unknown } | null;
  },
  lookups: Map<string, BimsfLookup>
): string | null {
  const meta = (panel.metadata && typeof panel.metadata === 'object' ? panel.metadata : {}) as Record<
    string,
    unknown
  >;
  for (const raw of [meta.BIMSF_Container, meta.bimsf, meta.mark, meta.Mark]) {
    const mark = canonicalBimsfMark(typeof raw === 'string' ? raw : '');
    if (mark) return mark;
  }

  const props = (panel.element?.properties && typeof panel.element.properties === 'object'
    ? panel.element.properties
    : {}) as Record<string, unknown>;
  const fromProp = canonicalBimsfMark(typeof props.BIMSF_Container === 'string' ? props.BIMSF_Container : '');
  if (fromProp) return fromProp;

  const lookupList = panel.modelId && lookups.has(panel.modelId)
    ? [lookups.get(panel.modelId)!]
    : [...lookups.values()];
  const gid = panel.element?.globalId;
  const revitId = revitIdFromPanelName(panel.name, panel.tag);
  for (const lookup of lookupList) {
    if (gid) {
      const fromGuid = canonicalBimsfMark(lookup.byIfcGuid[gid]);
      if (fromGuid) return fromGuid;
    }
    if (revitId) {
      const fromId = canonicalBimsfMark(lookup.byElementId[revitId]);
      if (fromId) return fromId;
    }
  }

  return canonicalBimsfMark(panel.tag || panel.name || '');
}

export function decorateBimsfPanel<T extends { id: string; metadata?: unknown }>(
  row: T & { panelMark: string; memberIds: string[]; memberCount: number }
) {
  return {
    ...row,
    name: row.panelMark,
    tag: row.panelMark,
    objectType: 'BIMSF Panel',
    memberIds: row.memberIds,
    memberCount: row.memberCount,
    metadata: {
      ...((row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as object),
      BIMSF_Container: row.panelMark,
      memberIds: row.memberIds,
    },
  };
}

export function groupRelatedPanels<T extends { panel?: { id: string } | null }>(
  relations: T[],
  lookups: Map<string, BimsfLookup>
): T[] {
  if (!projectHasBimsfMaps(lookups)) return relations;
  const members = relations.map((rel) => rel.panel).filter(Boolean) as Array<{ id: string }>;
  const grouped = groupRowsByBimsf(members, (panel) => resolveBimsfMark(panel, lookups));
  const byId = new Map(relations.map((rel) => [rel.panel?.id, rel]));
  return grouped
    .map((row) => {
      const first = byId.get(row.id);
      if (!first?.panel) return null;
      return {
        ...first,
        panel: decorateBimsfPanel(row),
      };
    })
    .filter(Boolean) as T[];
}

export function collectBimsfSets(
  rows: Array<{
    name?: string | null;
    tag?: string | null;
    metadata?: unknown;
    modelId?: string | null;
    element?: { globalId?: string | null; properties?: unknown } | null;
    groups?: { groupId: string }[];
    statuses?: { statusId: string }[];
  }>,
  lookups: Map<string, BimsfLookup>
): Map<string, { mark: string; groupIds: Set<string>; statusIds: Set<string> }> {
  const sets = new Map<string, { mark: string; groupIds: Set<string>; statusIds: Set<string> }>();
  for (const row of rows) {
    const mark = resolveBimsfMark(row, lookups);
    if (!mark) continue;
    const key = mark.toLowerCase();
    let entry = sets.get(key);
    if (!entry) {
      entry = { mark, groupIds: new Set(), statusIds: new Set() };
      sets.set(key, entry);
    }
    for (const group of row.groups || []) entry.groupIds.add(group.groupId);
    for (const status of row.statuses || []) entry.statusIds.add(status.statusId);
  }
  return sets;
}

export function groupRowsByBimsf<T extends { id: string }>(
  rows: T[],
  markOf: (row: T) => string | null
): Array<T & { panelMark: string; memberIds: string[]; memberCount: number }> {
  const groups = new Map<string, T & { panelMark: string; memberIds: string[]; memberCount: number }>();
  for (const row of rows) {
    const mark = markOf(row);
    if (!mark) continue;
    const key = mark.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.memberIds.push(row.id);
      existing.memberCount += 1;
    } else {
      groups.set(key, {
        ...row,
        panelMark: mark,
        memberIds: [row.id],
        memberCount: 1,
      });
    }
  }
  return [...groups.values()];
}
