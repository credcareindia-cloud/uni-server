import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { emitModelUpdated } from './websocket.js';

export type CategoryKey = 'structure' | 'mep' | 'electrical' | 'other';

export const CATEGORY_MAP: Record<string, 'STRUCTURE' | 'MEP' | 'ELECTRICAL' | 'ARCHITECTURE' | 'OTHER'> = {
  structure: 'STRUCTURE',
  mep: 'MEP',
  electrical: 'ELECTRICAL',
  architecture: 'ARCHITECTURE',
  arch: 'ARCHITECTURE',
  other: 'OTHER',
};

export type IfcMetaElement = {
  id: string;
  name: string;
  type: string;
  material: string;
  globalId?: string;
  label?: string;
  tag?: string;
  color?: string;
};

export type IfcMetadata = {
  storeys?: Array<{
    name: string;
    elements?: IfcMetaElement[];
  }>;
};

export type RevitColorMap = {
  version?: number;
  byElementId?: Record<string, string>;
  byUniqueId?: Record<string, string>;
  byIfcGuid?: Record<string, string>;
  elements?: Array<{ elementId?: string; ifcGuid?: string; color?: string }>;
};

export type RevitBimsfMap = {
  version?: number;
  byElementId?: Record<string, string>;
  byUniqueId?: Record<string, string>;
  byIfcGuid?: Record<string, string>;
  byPanel?: Record<
    string,
    { displayName?: string; bimsf?: string; count?: number; elementIds?: string[] }
  >;
  panels?: Array<{ id: string; displayName?: string; bimsf?: string; count?: number }>;
  elements?: Array<{ elementId?: string; ifcGuid?: string; bimsf?: string }>;
};

function extractRevitElementId(element: IfcMetaElement): string | null {
  const tag = (element.tag || '').trim();
  if (/^\d+$/.test(tag)) return tag;
  const name = (element.name || '').trim();
  // Revit IFC export usually ends Name with ":ElementId" e.g. "Pipe Types:Standard:1473931"
  const m = name.match(/:(\d+)\s*$/);
  if (m) return m[1];
  return null;
}

function lookupRevitColor(element: IfcMetaElement, colorMap?: RevitColorMap | null): string | null {
  if (!colorMap) return element.color || null;
  if (element.color) return element.color;
  const gid = (element.globalId || '').trim();
  if (gid && colorMap.byIfcGuid?.[gid]) return colorMap.byIfcGuid[gid];
  const revitId = extractRevitElementId(element);
  if (revitId && colorMap.byElementId?.[revitId]) return colorMap.byElementId[revitId];
  const tag = (element.tag || '').trim();
  if (tag && colorMap.byElementId?.[tag]) return colorMap.byElementId[tag];
  return null;
}

function lookupBimsf(element: IfcMetaElement, bimsfMap?: RevitBimsfMap | null): string | null {
  if (!bimsfMap) return null;
  const gid = (element.globalId || '').trim();
  if (gid && bimsfMap.byIfcGuid?.[gid]) return bimsfMap.byIfcGuid[gid];
  const revitId = extractRevitElementId(element);
  if (revitId && bimsfMap.byElementId?.[revitId]) return bimsfMap.byElementId[revitId];
  const tag = (element.tag || '').trim();
  if (tag && bimsfMap.byElementId?.[tag]) return bimsfMap.byElementId[tag];
  return null;
}

function buildSpatialStructurePayload(opts: {
  colorMap?: RevitColorMap | null;
  bimsfMap?: RevitBimsfMap | null;
}): Record<string, unknown> | undefined {
  const payload: Record<string, unknown> = {};
  if (opts.colorMap) payload.colorMap = opts.colorMap;
  if (opts.bimsfMap) payload.bimsfMap = opts.bimsfMap;
  return Object.keys(payload).length ? payload : undefined;
}

export type RemapSummary = {
  remapped: number;
  orphaned: number;
  created: number;
  modelId: string;
  category: string;
  version: number;
};

function resolveGlobalId(modelId: string, element: IfcMetaElement): string {
  const gid = (element.globalId || '').trim();
  if (gid) return gid;
  return `${modelId}_${element.id}`;
}

/**
 * Create ModelElement + Panel rows from IFC metadata (first publish / new GlobalIds).
 */
export async function createElementsAndPanelsFromMetadata(opts: {
  projectId: number;
  modelId: string;
  metadata: IfcMetadata | null | undefined;
  /** When true, only create panels for GlobalIds not in this set. */
  onlyNewPanels?: boolean;
  existingGlobalIdsWithPanels?: Set<string>;
  /** When true, create ModelElements but no Panels. */
  skipPanelCreation?: boolean;
  /** Revit system/material colour map from publish sidecar. */
  colorMap?: RevitColorMap | null;
  /** Revit BIMSF_Container map (panel ids) from publish sidecar. */
  bimsfMap?: RevitBimsfMap | null;
}): Promise<{ elementCount: number; panelsCreated: number }> {
  const meta = opts.metadata;
  if (!meta || !Array.isArray(meta.storeys)) {
    return { elementCount: 0, panelsCreated: 0 };
  }

  const elementsToCreate: Array<{
    modelId: string;
    expressId: number;
    globalId: string;
    ifcType: string;
    storey: string;
    properties: Record<string, unknown>;
  }> = [];

  for (const storey of meta.storeys) {
    if (!storey.elements?.length) continue;
    for (const element of storey.elements) {
      const color = lookupRevitColor(element, opts.colorMap);
      const bimsf = lookupBimsf(element, opts.bimsfMap);
      elementsToCreate.push({
        modelId: opts.modelId,
        expressId: parseInt(element.id, 10) || 0,
        globalId: resolveGlobalId(opts.modelId, element),
        ifcType: element.type || 'IfcBuildingElement',
        storey: storey.name,
        properties: {
          Name: element.name,
          Material: element.material,
          Storey: storey.name,
          IfcGlobalId: element.globalId || null,
          Tag: element.tag || null,
          Color: color,
          BIMSF_Container: bimsf,
        },
      });
    }
  }

  if (elementsToCreate.length > 0) {
    await prisma.modelElement.createMany({
      data: elementsToCreate,
      skipDuplicates: true,
    });
    logger.info(`Created ${elementsToCreate.length} ModelElement records for model ${opts.modelId}`);
  }

  if (opts.skipPanelCreation) {
    return { elementCount: elementsToCreate.length, panelsCreated: 0 };
  }

  const panelsToCreate: Array<{
    projectId: number;
    modelId: string;
    elementId: string | undefined;
    name: string;
    tag: string;
    objectType: string;
    location: string;
    material: string | null;
    metadata: Record<string, unknown>;
  }> = [];

  for (const storey of meta.storeys) {
    if (!storey.elements?.length) continue;
    for (const element of storey.elements) {
      const globalId = resolveGlobalId(opts.modelId, element);
      if (opts.onlyNewPanels && opts.existingGlobalIdsWithPanels?.has(globalId)) {
        continue;
      }

      const modelElement = await prisma.modelElement.findFirst({
        where: {
          modelId: opts.modelId,
          expressId: parseInt(element.id, 10) || 0,
        },
      });

      panelsToCreate.push({
        projectId: opts.projectId,
        modelId: opts.modelId,
        elementId: modelElement?.id,
        name: element.name,
        // Prefer Revit Label (e.g. SH1) when extracted from IFC properties
        tag: (element as any).label || element.name,
        objectType: element.type,
        location: storey.name,
        material: element.material && element.material !== 'N/A' ? element.material : null,
        metadata: {
          extractedFromIFC: true,
          storeyName: storey.name,
          elementType: element.type,
          ifcElementId: element.id,
          ifcGlobalId: element.globalId || null,
          material: element.material,
          Label: (element as any).label || null,
          label: (element as any).label || null,
          color: lookupRevitColor(element, opts.colorMap),
          BIMSF_Container: lookupBimsf(element, opts.bimsfMap),
        },
      });
    }
  }

  if (panelsToCreate.length > 0) {
    await prisma.panel.createMany({
      data: panelsToCreate,
      skipDuplicates: true,
    });
    logger.info(`Created ${panelsToCreate.length} Panel records for model ${opts.modelId}`);
  }

  return {
    elementCount: elementsToCreate.length,
    panelsCreated: panelsToCreate.length,
  };
}

/**
 * Remap existing project panels from an old model onto a new model version by IFC GlobalId.
 */
export async function remapPanelsByGlobalId(opts: {
  projectId: number;
  oldModelId: string;
  newModelId: string;
  newMetadata: IfcMetadata | null | undefined;
}): Promise<RemapSummary> {
  const newElements = await prisma.modelElement.findMany({
    where: { modelId: opts.newModelId },
    select: { id: true, globalId: true },
  });

  // Ensure elements exist (create from metadata if finalize created model without elements yet)
  if (newElements.length === 0 && opts.newMetadata) {
    await createElementsAndPanelsFromMetadata({
      projectId: opts.projectId,
      modelId: opts.newModelId,
      metadata: opts.newMetadata,
      onlyNewPanels: true,
      existingGlobalIdsWithPanels: new Set(),
    });
  }

  const freshElements = await prisma.modelElement.findMany({
    where: { modelId: opts.newModelId },
    select: { id: true, globalId: true },
  });

  const byGlobalId = new Map<string, string>();
  for (const el of freshElements) {
    if (el.globalId) byGlobalId.set(el.globalId, el.id);
  }

  const panels = await prisma.panel.findMany({
    where: {
      projectId: opts.projectId,
      modelId: opts.oldModelId,
    },
    include: {
      element: { select: { id: true, globalId: true } },
    },
  });

  let remapped = 0;
  let orphaned = 0;
  const matchedGlobalIds = new Set<string>();

  for (const panel of panels) {
    // Prefer GlobalId from linked element; fall back to metadata
    const metaGid =
      panel.metadata && typeof panel.metadata === 'object' && !Array.isArray(panel.metadata)
        ? String((panel.metadata as any).ifcGlobalId || '').trim()
        : '';
    const oldGid = (panel.element?.globalId || metaGid || '').trim();

    if (!oldGid || oldGid.startsWith(`${opts.oldModelId}_`)) {
      // Synthetic / missing GlobalId — cannot remap reliably
      const nextMeta = {
        ...(typeof panel.metadata === 'object' && panel.metadata && !Array.isArray(panel.metadata)
          ? (panel.metadata as Record<string, unknown>)
          : {}),
        orphaned: true,
        orphanedAt: new Date().toISOString(),
        orphanReason: 'missing_or_synthetic_global_id',
      };
      await prisma.panel.update({
        where: { id: panel.id },
        data: {
          elementId: null,
          modelId: opts.newModelId,
          metadata: nextMeta,
        },
      });
      orphaned += 1;
      continue;
    }

    const newElementId = byGlobalId.get(oldGid);
    if (newElementId) {
      matchedGlobalIds.add(oldGid);
      const nextMeta = {
        ...(typeof panel.metadata === 'object' && panel.metadata && !Array.isArray(panel.metadata)
          ? (panel.metadata as Record<string, unknown>)
          : {}),
        orphaned: false,
        remappedAt: new Date().toISOString(),
        ifcGlobalId: oldGid,
      };
      delete (nextMeta as any).orphanedAt;
      delete (nextMeta as any).orphanReason;
      await prisma.panel.update({
        where: { id: panel.id },
        data: {
          elementId: newElementId,
          modelId: opts.newModelId,
          metadata: nextMeta,
        },
      });
      remapped += 1;
    } else {
      const nextMeta = {
        ...(typeof panel.metadata === 'object' && panel.metadata && !Array.isArray(panel.metadata)
          ? (panel.metadata as Record<string, unknown>)
          : {}),
        orphaned: true,
        orphanedAt: new Date().toISOString(),
        orphanReason: 'global_id_not_in_new_model',
        ifcGlobalId: oldGid,
      };
      await prisma.panel.update({
        where: { id: panel.id },
        data: {
          elementId: null,
          modelId: opts.newModelId,
          metadata: nextMeta,
        },
      });
      orphaned += 1;
    }
  }

  // Create panels for brand-new GlobalIds (not already represented by any project panel)
  const allPanelGids = new Set<string>(matchedGlobalIds);
  for (const panel of panels) {
    const metaGid =
      panel.metadata && typeof panel.metadata === 'object' && !Array.isArray(panel.metadata)
        ? String((panel.metadata as any).ifcGlobalId || '').trim()
        : '';
    const gid = (panel.element?.globalId || metaGid || '').trim();
    if (gid) allPanelGids.add(gid);
  }

  const createResult = await createElementsAndPanelsFromMetadata({
    projectId: opts.projectId,
    modelId: opts.newModelId,
    metadata: opts.newMetadata,
    onlyNewPanels: true,
    existingGlobalIdsWithPanels: allPanelGids,
  });

  const oldModel = await prisma.model.findUnique({
    where: { id: opts.oldModelId },
    select: { version: true, category: true },
  });

  return {
    remapped,
    orphaned,
    created: createResult.panelsCreated,
    modelId: opts.newModelId,
    category: oldModel?.category || 'OTHER',
    version: (oldModel?.version || 1) + 1,
  };
}

/**
 * Upload FRAG, create new model version for a category, deactivate previous, remap panels.
 */
export async function replaceCategoryModelVersion(opts: {
  projectId: number;
  category: 'STRUCTURE' | 'MEP' | 'ELECTRICAL' | 'ARCHITECTURE' | 'OTHER';
  displayName: string;
  finalFragName: string;
  tempFragPath: string;
  metadata: IfcMetadata | null | undefined;
  notifyUserId?: string;
  /** Shared id for all models in one Revit publish (revision grouping). */
  publishBatchId?: string;
  /** Revit system/material colour map from publish. */
  colorMap?: RevitColorMap | null;
  /** Revit BIMSF_Container map from publish. */
  bimsfMap?: RevitBimsfMap | null;
}): Promise<RemapSummary> {
  const fs = await import('fs');
  const fragBuffer = await fs.promises.readFile(opts.tempFragPath);

  const previous = await prisma.model.findFirst({
    where: {
      projectId: opts.projectId,
      category: opts.category,
      isActive: true,
    },
    orderBy: { version: 'desc' },
  });

  const nextVersion = (previous?.version || 0) + 1;

  const newModel = await prisma.model.create({
    data: {
      projectId: opts.projectId,
      type: 'FRAG',
      originalFilename: opts.finalFragName,
      storageKey: 'temp_key',
      sizeBytes: BigInt(0),
      status: 'READY',
      processingProgress: 100,
      version: nextVersion,
      isActive: true,
      category: opts.category,
      displayName: opts.displayName,
      isMultiFile: true,
      multiFileJobId: opts.publishBatchId || null,
    },
  });

  const finalStorageKey = storageService.generateStorageKey(
    String(opts.projectId),
    newModel.id,
    opts.finalFragName
  );
  await storageService.uploadFile(finalStorageKey, fragBuffer, 'application/octet-stream');

  await prisma.model.update({
    where: { id: newModel.id },
    data: {
      storageKey: finalStorageKey,
      sizeBytes: BigInt(fragBuffer.length),
      spatialStructure: buildSpatialStructurePayload({
        colorMap: opts.colorMap,
        bimsfMap: opts.bimsfMap,
      }) as any,
    },
  });

  let summary: RemapSummary;

  if (previous) {
    await createElementsAndPanelsFromMetadata({
      projectId: opts.projectId,
      modelId: newModel.id,
      metadata: opts.metadata,
      skipPanelCreation: true,
      colorMap: opts.colorMap || null,
      bimsfMap: opts.bimsfMap || null,
    });

    summary = await remapPanelsByGlobalId({
      projectId: opts.projectId,
      oldModelId: previous.id,
      newModelId: newModel.id,
      newMetadata: opts.metadata,
    });

    await prisma.model.update({
      where: { id: previous.id },
      data: {
        isActive: false,
        replacedById: newModel.id,
      },
    });

    const elementCount = await prisma.modelElement.count({ where: { modelId: newModel.id } });
    await prisma.model.update({
      where: { id: newModel.id },
      data: { elementCount },
    });
  } else {
    const created = await createElementsAndPanelsFromMetadata({
      projectId: opts.projectId,
      modelId: newModel.id,
      metadata: opts.metadata,
      colorMap: opts.colorMap || null,
      bimsfMap: opts.bimsfMap || null,
    });
    summary = {
      remapped: 0,
      orphaned: 0,
      created: created.panelsCreated,
      modelId: newModel.id,
      category: opts.category,
      version: nextVersion,
    };
    await prisma.model.update({
      where: { id: newModel.id },
      data: { elementCount: created.elementCount },
    });
  }

  // Prefer STRUCTURE as currentModelId when present
  const structureActive = await prisma.model.findFirst({
    where: { projectId: opts.projectId, category: 'STRUCTURE', isActive: true },
    select: { id: true },
  });
  await prisma.project.update({
    where: { id: opts.projectId },
    data: { currentModelId: structureActive?.id || newModel.id },
  });

  try {
    await fs.promises.unlink(opts.tempFragPath);
  } catch {
    /* ignore */
  }

  if (opts.notifyUserId) {
    try {
      emitModelUpdated(opts.notifyUserId, {
        projectId: opts.projectId,
        modelId: newModel.id,
        category: opts.category,
        version: nextVersion,
        remapped: summary.remapped,
        orphaned: summary.orphaned,
        created: summary.created,
      });
    } catch (err) {
      logger.warn('Failed to emit model_updated:', err);
    }
  }

  return { ...summary, version: nextVersion, modelId: newModel.id, category: opts.category };
}

/**
 * After a Revit publish that only includes some categories (e.g. link removed),
 * deactivate any active models whose category was not in this publish.
 */
export async function deactivateCategoriesNotInPublish(opts: {
  projectId: number;
  keepCategories: Array<'STRUCTURE' | 'MEP' | 'ELECTRICAL' | 'ARCHITECTURE' | 'OTHER'>;
}): Promise<{ deactivated: string[]; orphanedPanels: number }> {
  const keep = new Set(opts.keepCategories);
  const extras = await prisma.model.findMany({
    where: {
      projectId: opts.projectId,
      isActive: true,
      NOT: { category: { in: Array.from(keep) } },
    },
    select: { id: true, category: true },
  });

  if (extras.length === 0) {
    return { deactivated: [], orphanedPanels: 0 };
  }

  const ids = extras.map((m) => m.id);
  await prisma.model.updateMany({
    where: { id: { in: ids } },
    data: { isActive: false },
  });

  // Mark panels for removed categories as orphaned (keep history, unlink geometry)
  const panels = await prisma.panel.findMany({
    where: { projectId: opts.projectId, modelId: { in: ids } },
    select: { id: true, metadata: true },
  });

  for (const panel of panels) {
    const nextMeta = {
      ...(typeof panel.metadata === 'object' && panel.metadata && !Array.isArray(panel.metadata)
        ? (panel.metadata as Record<string, unknown>)
        : {}),
      orphaned: true,
      orphanedAt: new Date().toISOString(),
      orphanReason: 'category_removed_from_publish',
    };
    await prisma.panel.update({
      where: { id: panel.id },
      data: {
        elementId: null,
        metadata: nextMeta,
      },
    });
  }

  // Point currentModel at remaining active STRUCTURE or any active
  const structureActive = await prisma.model.findFirst({
    where: { projectId: opts.projectId, category: 'STRUCTURE', isActive: true },
    select: { id: true },
  });
  const anyActive = structureActive || (await prisma.model.findFirst({
    where: { projectId: opts.projectId, isActive: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  }));

  await prisma.project.update({
    where: { id: opts.projectId },
    data: { currentModelId: anyActive?.id || null },
  });

  logger.info(
    `Deactivated ${ids.length} model(s) not in publish set for project ${opts.projectId}: ${extras.map((e) => e.category).join(', ')}`
  );

  return { deactivated: ids, orphanedPanels: panels.length };
}

