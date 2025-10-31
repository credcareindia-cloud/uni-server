import { Router } from 'express';
import { PrismaClient, PanelStatus } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

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
  groupId: z.string().optional(),
  status: z.nativeEnum(PanelStatus).default(PanelStatus.PLANNING),
  productionDate: z.string().datetime().optional(),
  shippingDate: z.string().datetime().optional(),
  installationDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const updatePanelSchema = createPanelSchema.partial();

const updateStatusSchema = z.object({
  status: z.nativeEnum(PanelStatus),
  notes: z.string().optional(),
});

// GET /api/panels/:projectId/filters - Get all unique filter values for panels
router.get('/:projectId/filters', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get all panels to extract unique values
    const panels = await prisma.panel.findMany({
      where: { projectId: parseInt(projectId) },
      select: {
        status: true,
        objectType: true,
        location: true,
        material: true,
        groupId: true,
        group: {
          select: {
            id: true,
            name: true,
          }
        }
      }
    });

    // Extract unique values
    const statuses = [...new Set(panels.map(p => p.status))];
    const objectTypes = [...new Set(panels.map(p => p.objectType).filter(Boolean))];
    const locations = [...new Set(panels.map(p => p.location).filter(Boolean))];
    const materials = [...new Set(panels.map(p => p.material).filter(Boolean))];
    
    // Get unique groups
    const groupsMap = new Map();
    panels.forEach(p => {
      if (p.group) {
        groupsMap.set(p.group.id, p.group);
      }
    });
    const groups = Array.from(groupsMap.values());

    res.json({
      statuses,
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

// GET /api/panels/:projectId - Get all panels for a project with pagination
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { status, groupId, customStatusId, search, page = '1', limit = '50' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = Math.min(parseInt(limit as string), 100); // Max 100 per page
    const skip = (pageNum - 1) * limitNum;

    const where: any = {
      projectId: parseInt(projectId),
    };

    if (status) {
      where.status = status as PanelStatus;
    }

    if (groupId) {
      where.groupId = groupId as string;
    }

    // Filter by custom status ID (many-to-many relationship)
    if (customStatusId) {
      where.customStatuses = {
        some: {
          customStatusId: customStatusId as string
        }
      };
    }

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { tag: { contains: search as string, mode: 'insensitive' } },
        { location: { contains: search as string, mode: 'insensitive' } },
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
        const spatialData = JSON.parse(project.currentModel.spatialStructure as string);
        totalPanelsFromMetadata = spatialData.totalPanels || totalCount;
      }
    } catch (error) {
      console.error('Error parsing spatial structure:', error);
    }

    const panels = await prisma.panel.findMany({
      where,
      include: {
        group: {
          select: {
            id: true,
            name: true,
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
        customStatuses: {
          include: {
            customStatus: {
              select: {
                id: true,
                name: true,
                color: true,
                icon: true,
              },
            },
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
      orderBy: { createdAt: 'desc' },
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

// GET /api/panels/:projectId/statistics - Get panel statistics for a project
// IMPORTANT: This must come BEFORE /:projectId/:panelId to avoid route conflicts
router.get('/:projectId/statistics', async (req, res) => {
  try {
    const { projectId } = req.params;

    const [totalPanels, statusCounts, groupCounts] = await Promise.all([
      // Total panels count
      prisma.panel.count({
        where: { projectId: parseInt(projectId) },
      }),

      // Count by status
      prisma.panel.groupBy({
        by: ['status'],
        where: { projectId: parseInt(projectId) },
        _count: { status: true },
      }),

      // Count by group
      prisma.panel.groupBy({
        by: ['groupId'],
        where: { 
          projectId: parseInt(projectId),
          groupId: { not: null },
        },
        _count: { groupId: true },
      }),
    ]);

    const statistics = {
      totalPanels,
      statusDistribution: statusCounts.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {} as Record<string, number>),
      groupDistribution: groupCounts.map(item => ({
        groupId: item.groupId,
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
        group: true,
        model: true,
        element: true,
        statusHistory: {
          orderBy: { createdAt: 'desc' },
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
    });

    if (!panel) {
      return res.status(404).json({ error: 'Panel not found' });
    }

    res.json(panel);
  } catch (error) {
    console.error('Error fetching panel:', error);
    res.status(500).json({ error: 'Failed to fetch panel' });
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
        group: {
          select: {
            id: true,
            name: true,
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

    // Create initial status history entry
    await prisma.panelStatusHistory.create({
      data: {
        panelId: panel.id,
        status: panel.status,
        notes: 'Panel created',
        // TODO: Add user ID from authentication
      },
    });

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
        group: {
          select: {
            id: true,
            name: true,
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
        group: {
          select: {
            id: true,
            name: true,
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
