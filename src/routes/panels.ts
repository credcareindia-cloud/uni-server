import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Validation schemas
const createPanelSchema = z.object({
  name: z.string().min(1, 'Panel name is required'),
  tag: z.string().optional(),
  objectType: z.string().optional(),
  dimensions: z.string().optional(),
  location: z.string().optional(),
  material: z.string().optional(),
  weight: z.number().optional(),
  area: z.number().optional(),
  modelId: z.string().optional(),
  elementId: z.string().optional(),
  productionDate: z.string().datetime().optional(),
  shippingDate: z.string().datetime().optional(),
  installationDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const updatePanelSchema = createPanelSchema.partial();

// GET /api/panels/:projectId/filters - Get all unique filter values for panels
router.get('/:projectId/filters', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get all panels to extract unique values
    const panels = await prisma.panel.findMany({
      where: { projectId: parseInt(projectId) },
      select: {
        objectType: true,
        location: true,
        material: true,
        groups: {
          include: {
            group: true
          }
        }
      }
    });

    // Extract unique values
    const groupsMap = new Map();

    panels.forEach(p => {
      p.groups.forEach(pg => {
        groupsMap.set(pg.group.id, pg.group);
      });
    });

    const groups = Array.from(groupsMap.values());
    const objectTypes = [...new Set(panels.map(p => p.objectType).filter(Boolean))];
    const locations = [...new Set(panels.map(p => p.location).filter(Boolean))];
    const materials = [...new Set(panels.map(p => p.material).filter(Boolean))];

    res.json({
      objectTypes,
      locations,
      materials,
      groups,
      totalPanels: panels.length
    });
  } catch (error) {
    console.error('Error fetching panel filters:', error);
    res.status(500).json({ error: 'Failed to fetch panel filters' });
  }
});

// GET /api/panels/:projectId/filter-data - Get minimal panel data for IFC type filtering
// Returns only essential fields needed for filtering: id, elementId, ifcType, metadata.ifcElementId
router.get('/:projectId/filter-data', async (req, res) => {
  try {
    const { projectId } = req.params;

    const panels = await prisma.panel.findMany({
      where: { projectId: parseInt(projectId) },
      select: {
        id: true,
        elementId: true,
        metadata: true, // Contains ifcElementId
        element: {
          select: {
            id: true,
            ifcType: true,
            globalId: true,
          }
        }
      }
    });

    console.log(`✅ Fetched ${panels.length} panels (filter data only) for project ${projectId}`);

    res.json({
      panels,
      total: panels.length,
    });
  } catch (error) {
    console.error('Error fetching panel filter data:', error);
    res.status(500).json({ error: 'Failed to fetch panel filter data' });
  }
});

// GET /api/panels/:projectId/filter-by-type - Get panels filtered by IFC type with pagination
// Query params: ifcTypes (comma-separated), page, limit
// Returns: { panels, total, hasMore, page }
router.get('/:projectId/filter-by-type', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { ifcTypes, page = '1', limit = '50' } = req.query;

    if (!ifcTypes || typeof ifcTypes !== 'string') {
      return res.status(400).json({ error: 'ifcTypes parameter is required' });
    }

    // Parse comma-separated IFC types and trim whitespace
    const types = ifcTypes.split(',').map(t => t.trim()).filter(t => t.length > 0);

    if (types.length === 0) {
      return res.status(400).json({ error: 'At least one IFC type must be provided' });
    }

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    // Fetch panels matching the IFC types with pagination
    // Use OR with contains to match derived types (e.g. IFCBEAM matches IFCBEAMSTANDARDCASE)
    const whereCondition = {
      projectId: parseInt(projectId),
      element: {
        OR: types.map(t => ({
          ifcType: {
            contains: t,
            mode: 'insensitive'
          }
        }))
      }
    };

    const panels = await prisma.panel.findMany({
      where: whereCondition,
      select: {
        id: true,
        name: true,
        tag: true,
        metadata: true, // Contains ifcElementId (localId)
        element: {
          select: {
            ifcType: true,
            globalId: true
          }
        }
      },
      skip,
      take: limitNum,
      orderBy: {
        name: 'asc'
      }
    });

    // Get total count for pagination
    const total = await prisma.panel.count({
      where: whereCondition
    });

    console.log(`✅ Fetched ${panels.length} of ${total} panels filtered by types: ${types.join(', ')}`);

    res.json({
      panels,
      total,
      hasMore: skip + panels.length < total,
      page: pageNum
    });
  } catch (error) {
    console.error('Error fetching filtered panels:', error);
    res.status(500).json({ error: 'Failed to fetch filtered panels' });
  }
});

// GET /api/panels/:projectId/all - Get ALL panels for a project (no pagination)
router.get('/:projectId/all', async (req, res) => {
  try {
    const { projectId } = req.params;

    const panels = await prisma.panel.findMany({
      where: { projectId: parseInt(projectId) },
      select: {
        id: true,
        projectId: true,
        modelId: true,
        elementId: true,
        name: true,
        tag: true,
        objectType: true,
        dimensions: true,
        location: true,
        material: true,
        weight: true,
        area: true,
        productionDate: true,
        shippingDate: true,
        installationDate: true,
        notes: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        groups: {
          include: {
            group: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        statuses: {
          include: {
            status: {
              select: {
                id: true,
                name: true,
                color: true,
                icon: true,
                description: true,
                order: true,
              },
            },
          },
        },
        model: {
          select: {
            id: true,
            originalFilename: true,
          },
        },
        element: {
          select: {
            id: true,
            ifcType: true,
            globalId: true,
          },
        },
      },
      orderBy: [
        { location: 'asc' },
        { name: 'asc' },
      ],
    });

    console.log(`✅ Fetched ${panels.length} panels for project ${projectId} (no pagination)`);

    res.json({
      panels,
      total: panels.length,
    });
  } catch (error) {
    console.error('Error fetching all panels:', error);
    res.status(500).json({ error: 'Failed to fetch panels' });
  }
});

// GET /api/panels/:projectId/hierarchy - Get model/storey hierarchy
router.get('/:projectId/hierarchy', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get all panels with just model and storey info to build hierarchy
    // This is much lighter than fetching all panel data
    const panels = await prisma.panel.findMany({
      where: { projectId: parseInt(projectId) },
      select: {
        modelId: true,
        metadata: true,
        model: {
          select: {
            originalFilename: true
          }
        }
      }
    });

    const hierarchyMap = new Map();

    panels.forEach(p => {
      const modelId = p.modelId || 'unknown';
      const modelName = p.model?.originalFilename || 'Unknown Model';
      const storeyName = (p.metadata as any)?.storeyName || 'Unknown Storey';

      if (!hierarchyMap.has(modelId)) {
        hierarchyMap.set(modelId, {
          modelId,
          modelName,
          storeys: new Map()
        });
      }

      const model = hierarchyMap.get(modelId);
      if (!model.storeys.has(storeyName)) {
        model.storeys.set(storeyName, {
          name: storeyName,
          elementCount: 0
        });
      }

      model.storeys.get(storeyName).elementCount++;
    });

    // Convert to array structure
    const hierarchy = Array.from(hierarchyMap.values()).map((m: any) => ({
      modelId: m.modelId,
      modelName: m.modelName,
      storeys: Array.from(m.storeys.values()).sort((a: any, b: any) => a.name.localeCompare(b.name))
    }));

    res.json({ hierarchy });
  } catch (error) {
    console.error('Error fetching hierarchy:', error);
    res.status(500).json({ error: 'Failed to fetch hierarchy' });
  }
});

// GET /api/panels/:projectId/panel-location - Find panel location by localId (query param)
router.get('/:projectId/panel-location', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { localId } = req.query;

    if (!localId) {
      return res.status(400).json({ error: 'localId query parameter is required' });
    }

    // Find panel by metadata.ifcElementId
    // Note: metadata is a JSON field, so we need to query it carefully
    // Prisma's JSON filtering capabilities depend on the DB, but for simple equality it works
    const panel = await prisma.panel.findFirst({
      where: {
        projectId: parseInt(projectId),
        metadata: {
          path: ['ifcElementId'],
          equals: localId.toString() // Store as string in JSON
        }
      },
      select: {
        id: true,
        modelId: true,
        metadata: true,
        createdAt: true
      }
    });

    if (!panel) {
      return res.status(404).json({ error: 'Panel not found' });
    }

    const modelId = panel.modelId || 'unknown';
    const storeyName = (panel.metadata as any)?.storeyName || 'Unknown Storey';

    // Calculate page number
    const countBefore = await prisma.panel.count({
      where: {
        projectId: parseInt(projectId),
        modelId: modelId === 'unknown' ? null : modelId,
        metadata: {
          path: ['storeyName'],
          equals: storeyName
        },
        OR: [
          { createdAt: { gt: panel.createdAt } },
          {
            createdAt: panel.createdAt,
            id: { lt: panel.id }
          }
        ]
      }
    });

    const limit = 50;
    const page = Math.floor(countBefore / limit) + 1;

    res.json({
      panelId: panel.id,
      modelId,
      storey: storeyName,
      page
    });

  } catch (error) {
    console.error('Error fetching panel location by localId:', error);
    res.status(500).json({ error: 'Failed to fetch panel location' });
  }
});

// GET /api/panels/:projectId/panel-location/:panelId - Find panel location in tree
router.get('/:projectId/panel-location/:panelId', async (req, res) => {
  try {
    const { projectId, panelId } = req.params;

    const panel = await prisma.panel.findFirst({
      where: {
        id: panelId,
        projectId: parseInt(projectId)
      },
      select: {
        id: true,
        modelId: true,
        metadata: true
      }
    });

    if (!panel) {
      return res.status(404).json({ error: 'Panel not found' });
    }

    const modelId = panel.modelId || 'unknown';
    const storeyName = (panel.metadata as any)?.storeyName || 'Unknown Storey';

    // Calculate page number (approximate)
    // We need to know how many panels are before this one in the same storey
    // assuming default sort order (createdAt desc)
    const countBefore = await prisma.panel.count({
      where: {
        projectId: parseInt(projectId),
        modelId: modelId === 'unknown' ? null : modelId,
        metadata: {
          path: ['storeyName'],
          equals: storeyName
        },
        createdAt: {
          gt: (await prisma.panel.findUnique({ where: { id: panelId }, select: { createdAt: true } }))?.createdAt
        }
      }
    });

    const limit = 50; // Default limit
    const page = Math.floor(countBefore / limit) + 1;

    res.json({
      modelId,
      storey: storeyName,
      page
    });

  } catch (error) {
    console.error('Error fetching panel location:', error);
    res.status(500).json({ error: 'Failed to fetch panel location' });
  }
});

// GET /api/panels/:projectId - Get all panels for a project with pagination
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { status, groupId, customStatusId, search, page = '1', limit = '50', modelId, storey } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = Math.min(parseInt(limit as string), 100); // Max 100 per page
    const skip = (pageNum - 1) * limitNum;

    const where: any = {
      projectId: parseInt(projectId),
    };

    // Filter by Model ID
    if (modelId) {
      where.modelId = modelId as string;
    }

    // Filter by Storey (in metadata)
    if (storey) {
      where.metadata = {
        path: ['storeyName'],
        equals: storey as string
      };
    }

    // Filter by status ID (many-to-many relationship)
    if (status) {
      where.statuses = {
        some: {
          statusId: status as string
        }
      };
    }

    // Filter by group ID (many-to-many relationship)
    if (groupId) {
      where.groups = {
        some: {
          groupId: groupId as string
        }
      };
    }

    // Filter by custom status ID (many-to-many relationship) - legacy support
    if (customStatusId) {
      where.statuses = {
        some: {
          statusId: customStatusId as string
        }
      };
    }

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { tag: { contains: search as string, mode: 'insensitive' } },
        { objectType: { contains: search as string, mode: 'insensitive' } },
        {
          element: {
            ifcType: { contains: search as string, mode: 'insensitive' }
          }
        }
      ];
    }

    // Get total count for pagination (database count)
    const totalCount = await prisma.panel.count({ where });

    // Get total panels from model metadata (actual FRAG file count)
    let totalPanelsFromMetadata = totalCount;
    try {
      const project = await prisma.project.findUnique({
        where: { id: parseInt(projectId) },
        include: {
          currentModel: {
            select: { spatialStructure: true }
          }
        }
      });

      if (project?.currentModel?.spatialStructure) {
        // Prisma automatically parses JSON fields, no need to JSON.parse()
        const spatialData = project.currentModel.spatialStructure as any;
        totalPanelsFromMetadata = spatialData.totalPanels || totalCount;
      }
    } catch (error) {
      console.error('Error parsing spatial structure:', error);
    }

    const panels = await prisma.panel.findMany({
      where,
      select: {
        id: true,
        projectId: true,
        modelId: true,
        elementId: true,
        name: true,
        tag: true,
        objectType: true,
        dimensions: true,
        location: true,
        material: true,
        weight: true,
        area: true,
        productionDate: true,
        shippingDate: true,
        installationDate: true,
        notes: true,
        metadata: true, // ✅ Now explicitly returning metadata with ifcElementId
        createdAt: true,
        updatedAt: true,
        groups: {
          include: {
            group: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        statuses: {
          include: {
            status: {
              select: {
                id: true,
                name: true,
                color: true,
                icon: true,
                description: true,
                order: true,
              },
            },
          },
        },
        model: {
          select: {
            id: true,
            originalFilename: true,
          },
        },
        element: {
          select: {
            id: true,
            ifcType: true,
            globalId: true,
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'asc' }
      ],
      skip,
      take: limitNum,
    });

    res.json({
      panels,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount, // Panels in database (displayed)
        totalFromMetadata: totalPanelsFromMetadata, // Total panels from FRAG file
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching panels:', error);
    res.status(500).json({ error: 'Failed to fetch panels' });
  }
});

// GET /api/panels/:projectId/health - Get panel health statistics for a project
// IMPORTANT: This must come BEFORE /:projectId/:panelId to avoid route conflicts
router.get('/:projectId/health', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get total panels count
    const totalPanels = await prisma.panel.count({
      where: { projectId: parseInt(projectId) },
    });

    // Count panels without any groups
    const panelsWithoutGroups = await prisma.panel.count({
      where: {
        projectId: parseInt(projectId),
        groups: {
          none: {}
        }
      }
    });

    // Count panels without any statuses
    const panelsWithoutStatus = await prisma.panel.count({
      where: {
        projectId: parseInt(projectId),
        statuses: {
          none: {}
        }
      }
    });

    res.json({
      totalPanels,
      panelsWithoutGroups,
      panelsWithoutStatus,
      panelsWithGroups: totalPanels - panelsWithoutGroups,
      panelsWithStatus: totalPanels - panelsWithoutStatus
    });
  } catch (error) {
    console.error('Error fetching panel health statistics:', error);
    res.status(500).json({ error: 'Failed to fetch panel health statistics' });
  }
});

// GET /api/panels/:projectId/statistics - Get panel statistics for a project
// IMPORTANT: This must come BEFORE /:projectId/:panelId to avoid route conflicts
router.get('/:projectId/statistics', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get total panels count
    const totalPanels = await prisma.panel.count({
      where: { projectId: parseInt(projectId) },
    });

    // Get status distribution (from many-to-many PanelStatus table)
    const statusCounts = await prisma.panelStatus.groupBy({
      by: ['statusId'],
      where: {
        panel: {
          projectId: parseInt(projectId),
        },
      },
      _count: { statusId: true },
    });

    // Get all statuses for this project to map IDs to names
    const statuses = await prisma.status.findMany({
      where: { projectId: parseInt(projectId) },
      select: { id: true, name: true },
    });

    const statusMap = new Map(statuses.map(s => [s.id, s.name]));

    // Get group distribution (from many-to-many PanelGroup table)
    const groupCounts = await prisma.panelGroup.groupBy({
      by: ['groupId'],
      where: {
        panel: {
          projectId: parseInt(projectId),
        },
      },
      _count: { groupId: true },
    });

    // Get all groups for this project to map IDs to names
    const groups = await prisma.group.findMany({
      where: { projectId: parseInt(projectId) },
      select: { id: true, name: true },
    });

    const groupMap = new Map(groups.map(g => [g.id, g.name]));

    const statistics = {
      totalPanels,
      statusDistribution: statusCounts.reduce((acc, item) => {
        const statusName = statusMap.get(item.statusId) || item.statusId;
        acc[statusName] = item._count.statusId;
        return acc;
      }, {} as Record<string, number>),
      groupDistribution: groupCounts.map(item => ({
        groupId: item.groupId,
        groupName: groupMap.get(item.groupId) || 'Unknown',
        count: item._count.groupId,
      })),
    };

    res.json(statistics);
  } catch (error) {
    console.error('Error fetching panel statistics:', error);
    res.status(500).json({ error: 'Failed to fetch panel statistics' });
  }
});

// GET /api/panels/:projectId/:panelId - Get a specific panel
router.get('/:projectId/:panelId', async (req, res) => {
  try {
    const { projectId, panelId } = req.params;

    const panel = await prisma.panel.findFirst({
      where: {
        id: panelId,
        projectId: parseInt(projectId),
      },
      include: {
        groups: {
          include: {
            group: {
              select: {
                id: true,
                name: true,
                status: true, // Include status field
              },
            },
          },
        },
        statuses: {
          include: {
            status: {
              select: {
                id: true,
                name: true,
                color: true,
                icon: true,
              },
            },
          },
        },
        model: true,
        element: true,
        // Removed statusHistory to prevent 500 errors
      },
    });

    if (!panel) {
      return res.status(404).json({ error: 'Panel not found' });
    }

    // Convert BigInt fields to strings for JSON serialization
    const panelResponse = {
      ...panel,
      model: panel.model ? {
        ...panel.model,
        sizeBytes: panel.model.sizeBytes?.toString()
      } : null
    };

    res.json(panelResponse);
  } catch (error) {
    console.error('Error fetching panel:', error);
    console.error('Panel ID:', req.params.panelId);
    console.error('Project ID:', req.params.projectId);
    res.status(500).json({ error: 'Failed to fetch panel', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});



// POST /api/panels/:projectId - Create a new panel
router.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const validatedData = createPanelSchema.parse(req.body);

    // Convert date strings to Date objects
    const panelData: any = {
      ...validatedData,
      projectId: parseInt(projectId),
    };

    if (validatedData.productionDate) {
      panelData.productionDate = new Date(validatedData.productionDate);
    }
    if (validatedData.shippingDate) {
      panelData.shippingDate = new Date(validatedData.shippingDate);
    }
    if (validatedData.installationDate) {
      panelData.installationDate = new Date(validatedData.installationDate);
    }

    const panel = await prisma.panel.create({
      data: panelData,
      include: {
        groups: {
          include: {
            group: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        statuses: {
          include: {
            status: {
              select: {
                id: true,
                name: true,
                color: true,
                icon: true,
              },
            },
          },
        },
        model: {
          select: {
            id: true,
            originalFilename: true,
          },
        },
        element: {
          select: {
            id: true,
            ifcType: true,
            globalId: true,
          },
        },
      },
    });

    // Note: Status history is now tracked via StatusHistory model when statuses are assigned
    // via the status-management endpoints, not during panel creation

    res.status(201).json(panel);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error creating panel:', error);
    res.status(500).json({ error: 'Failed to create panel' });
  }
});

// PUT /api/panels/:projectId/:panelId - Update a panel
router.put('/:projectId/:panelId', async (req, res) => {
  try {
    const { projectId, panelId } = req.params;
    const validatedData = updatePanelSchema.parse(req.body);

    // Convert date strings to Date objects
    const updateData: any = { ...validatedData };

    if (validatedData.productionDate) {
      updateData.productionDate = new Date(validatedData.productionDate);
    }
    if (validatedData.shippingDate) {
      updateData.shippingDate = new Date(validatedData.shippingDate);
    }
    if (validatedData.installationDate) {
      updateData.installationDate = new Date(validatedData.installationDate);
    }

    const panel = await prisma.panel.update({
      where: {
        id: panelId,
        projectId: parseInt(projectId),
      },
      data: updateData,
      include: {
        groups: {
          include: {
            group: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        statuses: {
          include: {
            status: {
              select: {
                id: true,
                name: true,
                color: true,
                icon: true,
              },
            },
          },
        },
        model: {
          select: {
            id: true,
            originalFilename: true,
          },
        },
        element: {
          select: {
            id: true,
            ifcType: true,
            globalId: true,
          },
        },
      },
    });

    res.json(panel);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error updating panel:', error);
    res.status(500).json({ error: 'Failed to update panel' });
  }
});

// PATCH /api/panels/:projectId/:panelId/status - Update panel status
router.patch('/:projectId/:panelId/status', async (req, res) => {
  try {
    const { projectId, panelId } = req.params;
    const { status, notes } = updateStatusSchema.parse(req.body);

    // Update panel status
    const panel = await prisma.panel.update({
      where: {
        id: panelId,
        projectId: parseInt(projectId),
      },
      data: { status },
      include: {
        groups: {
          include: {
            group: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        statuses: {
          include: {
            status: {
              select: {
                id: true,
                name: true,
                color: true,
                icon: true,
              },
            },
          },
        },
      },
    });

    // Create status history entry
    await prisma.panelStatusHistory.create({
      data: {
        panelId: panel.id,
        status,
        notes,
        // TODO: Add user ID from authentication
      },
    });

    res.json(panel);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error updating panel status:', error);
    res.status(500).json({ error: 'Failed to update panel status' });
  }
});

// DELETE /api/panels/:projectId/:panelId - Delete a panel
// PATCH /api/panels/:panelId - Update panel with statuses and groups
router.patch('/:panelId', async (req, res) => {
  try {
    const { panelId } = req.params;
    const { notes, statusIds, groupIds } = req.body;

    // Start a transaction to update panel, statuses, and groups
    const panel = await prisma.$transaction(async (tx) => {
      // Update panel notes if provided
      // const updateData: any = {};
      // if (notes !== undefined) {
      //   updateData.notes = notes;
      // }

      // Update the panel
      // const updatedPanel = await tx.panel.update({
      //   where: { id: panelId },
      //   data: updateData,
      // });

      // Update statuses if provided
      if (statusIds !== undefined && Array.isArray(statusIds)) {
        // Delete existing status relationships
        await tx.panelStatus.deleteMany({
          where: { panelId },
        });

        // Create new status relationships
        if (statusIds.length > 0) {
          await tx.panelStatus.createMany({
            data: statusIds.map((statusId: string) => ({
              panelId,
              statusId,
            })),
          });
        }
      }

      // Update groups if provided
      if (groupIds !== undefined && Array.isArray(groupIds)) {
        // Delete existing group relationships
        await tx.panelGroup.deleteMany({
          where: { panelId },
        });

        // Create new group relationships
        if (groupIds.length > 0) {
          await tx.panelGroup.createMany({
            data: groupIds.map((groupId: string) => ({
              panelId,
              groupId,
            })),
          });
        }
      }

      // Fetch the updated panel with all relationships
      return await tx.panel.findUnique({
        where: { id: panelId },
        include: {
          groups: {
            include: {
              group: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          statuses: {
            include: {
              status: {
                select: {
                  id: true,
                  name: true,
                  color: true,
                  icon: true,
                },
              },
            },
          },
        },
      });
    });

    res.json(panel);
  } catch (error) {
    console.error('Error updating panel:', error);
    res.status(500).json({ error: 'Failed to update panel' });
  }
});

router.delete('/:projectId/:panelId', async (req, res) => {
  try {
    const { projectId, panelId } = req.params;

    await prisma.panel.delete({
      where: {
        id: panelId,
        projectId: parseInt(projectId),
      },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting panel:', error);
    res.status(500).json({ error: 'Failed to delete panel' });
  }
});

export default router;
