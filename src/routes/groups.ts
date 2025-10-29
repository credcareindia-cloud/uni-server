import { Router } from 'express';
import { PrismaClient, GroupStatus } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

// Validation schemas
const createGroupSchema = z.object({
  name: z.string().min(1, 'Group name is required'),
  description: z.string().optional(),
  status: z.nativeEnum(GroupStatus).default(GroupStatus.PENDING),
  elementIds: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
});

const updateGroupSchema = createGroupSchema.partial();

const assignPanelsSchema = z.object({
  panelIds: z.array(z.string()).min(1, 'At least one panel ID is required'),
});

// GET /api/groups/:projectId - Get all groups for a project with pagination
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { status, search, page = '1', limit = '50' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = Math.min(parseInt(limit as string), 100); // Max 100 per page
    const skip = (pageNum - 1) * limitNum;

    const where: any = {
      projectId: parseInt(projectId),
    };

    if (status) {
      where.status = status as GroupStatus;
    }

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    // Get total count for pagination
    const totalCount = await prisma.group.count({ where });

    const groups = await prisma.group.findMany({
      where,
      include: {
        panels: {
          select: {
            id: true,
            name: true,
            tag: true,
            status: true,
            objectType: true,
          },
        },
        _count: {
          select: {
            panels: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
    });

    res.json({
      groups,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// GET /api/groups/:projectId/:groupId - Get a specific group
router.get('/:projectId/:groupId', async (req, res) => {
  try {
    const { projectId, groupId } = req.params;

    const group = await prisma.group.findFirst({
      where: {
        id: groupId,
        projectId: parseInt(projectId),
      },
      include: {
        panels: {
          include: {
            model: {
              select: {
                id: true,
                name: true,
              },
            },
            element: {
              select: {
                id: true,
                ifcType: true,
                name: true,
              },
            },
          },
        },
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json(group);
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// POST /api/groups/:projectId - Create a new group
router.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const validatedData = createGroupSchema.parse(req.body);

    const group = await prisma.group.create({
      data: {
        ...validatedData,
        projectId: parseInt(projectId),
      },
      include: {
        panels: {
          select: {
            id: true,
            name: true,
            tag: true,
            status: true,
            objectType: true,
          },
        },
        _count: {
          select: {
            panels: true,
          },
        },
      },
    });

    res.status(201).json(group);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// PUT /api/groups/:projectId/:groupId - Update a group
router.put('/:projectId/:groupId', async (req, res) => {
  try {
    const { projectId, groupId } = req.params;
    const validatedData = updateGroupSchema.parse(req.body);

    const group = await prisma.group.update({
      where: {
        id: groupId,
        projectId: parseInt(projectId),
      },
      data: validatedData,
      include: {
        panels: {
          select: {
            id: true,
            name: true,
            tag: true,
            status: true,
            objectType: true,
          },
        },
        _count: {
          select: {
            panels: true,
          },
        },
      },
    });

    res.json(group);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// POST /api/groups/:projectId/:groupId/panels - Assign panels to a group
router.post('/:projectId/:groupId/panels', async (req, res) => {
  try {
    const { projectId, groupId } = req.params;
    const { panelIds } = assignPanelsSchema.parse(req.body);

    // Verify all panels belong to the project
    const panelsCount = await prisma.panel.count({
      where: {
        id: { in: panelIds },
        projectId: parseInt(projectId),
      },
    });

    if (panelsCount !== panelIds.length) {
      return res.status(400).json({ error: 'Some panels do not belong to this project' });
    }

    // Update panels to assign them to the group
    await prisma.panel.updateMany({
      where: {
        id: { in: panelIds },
        projectId: parseInt(projectId),
      },
      data: {
        groupId: groupId,
      },
    });

    // Return updated group with panels
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        panels: {
          select: {
            id: true,
            name: true,
            tag: true,
            status: true,
            objectType: true,
          },
        },
        _count: {
          select: {
            panels: true,
          },
        },
      },
    });

    res.json(group);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error assigning panels to group:', error);
    res.status(500).json({ error: 'Failed to assign panels to group' });
  }
});

// DELETE /api/groups/:projectId/:groupId/panels - Remove panels from a group
router.delete('/:projectId/:groupId/panels', async (req, res) => {
  try {
    const { projectId, groupId } = req.params;
    const { panelIds } = assignPanelsSchema.parse(req.body);

    // Update panels to remove them from the group
    await prisma.panel.updateMany({
      where: {
        id: { in: panelIds },
        projectId: parseInt(projectId),
        groupId: groupId,
      },
      data: {
        groupId: null,
      },
    });

    // Return updated group with panels
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        panels: {
          select: {
            id: true,
            name: true,
            tag: true,
            status: true,
            objectType: true,
          },
        },
        _count: {
          select: {
            panels: true,
          },
        },
      },
    });

    res.json(group);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error removing panels from group:', error);
    res.status(500).json({ error: 'Failed to remove panels from group' });
  }
});

// DELETE /api/groups/:projectId/:groupId - Delete a group
router.delete('/:projectId/:groupId', async (req, res) => {
  try {
    const { projectId, groupId } = req.params;

    // First, remove group assignment from all panels
    await prisma.panel.updateMany({
      where: {
        groupId: groupId,
        projectId: parseInt(projectId),
      },
      data: {
        groupId: null,
      },
    });

    // Then delete the group
    await prisma.group.delete({
      where: {
        id: groupId,
        projectId: parseInt(projectId),
      },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

// GET /api/groups/:projectId/statistics - Get group statistics for a project
router.get('/:projectId/statistics', async (req, res) => {
  try {
    const { projectId } = req.params;

    const [totalGroups, statusCounts, groupsWithPanelCounts] = await Promise.all([
      // Total groups count
      prisma.group.count({
        where: { projectId: parseInt(projectId) },
      }),

      // Count by status
      prisma.group.groupBy({
        by: ['status'],
        where: { projectId: parseInt(projectId) },
        _count: { status: true },
      }),

      // Groups with panel counts
      prisma.group.findMany({
        where: { projectId: parseInt(projectId) },
        select: {
          id: true,
          name: true,
          status: true,
          _count: {
            select: {
              panels: true,
            },
          },
        },
      }),
    ]);

    const statistics = {
      totalGroups,
      statusDistribution: statusCounts.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {} as Record<string, number>),
      groupsWithPanels: groupsWithPanelCounts.map(group => ({
        id: group.id,
        name: group.name,
        status: group.status,
        panelCount: group._count.panels,
      })),
      totalPanelsInGroups: groupsWithPanelCounts.reduce((sum, group) => sum + group._count.panels, 0),
    };

    res.json(statistics);
  } catch (error) {
    console.error('Error fetching group statistics:', error);
    res.status(500).json({ error: 'Failed to fetch group statistics' });
  }
});

export default router;
