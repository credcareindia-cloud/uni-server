import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

// Apply authentication middleware to all routes
router.use(authenticateToken);

/**
 * Custom Status Management Routes
 * These allow creating custom statuses beyond the default enum values
 */

// Assign status to panels 
router.post('/assign-to-panels', async (req, res) => {
  try {
    const { panelIds, statusId, projectId, reporterName } = req.body;

    // Add status to panels (many-to-many, don't overwrite existing)
    const assignmentsToCreate = [];

    for (const panelId of panelIds) {
      // Check if this panel already has this status
      const existing = await prisma.panelStatus.findUnique({
        where: {
          panelId_statusId: {
            panelId: panelId,
            statusId: statusId
          }
        }
      });

      // Only create if it doesn't exist
      if (!existing) {
        assignmentsToCreate.push({
          panelId: panelId,
          statusId: statusId
        });
      }
    }

    // Bulk create assignments
    if (assignmentsToCreate.length > 0) {
      await prisma.$transaction(async (tx) => {
        // 1. Create PanelStatus assignments
        await tx.panelStatus.createMany({
          data: assignmentsToCreate,
          skipDuplicates: true
        });

        // 2. Fetch updated statuses for all affected panels to create snapshots
        const panelStatuses = await tx.panelStatus.findMany({
          where: {
            panelId: { in: panelIds }
          },
          select: {
            panelId: true,
            statusId: true
          }
        });

        // Group statuses by panelId
        const statusMap = new Map<string, string[]>();
        panelStatuses.forEach(ps => {
          if (!statusMap.has(ps.panelId)) {
            statusMap.set(ps.panelId, []);
          }
          statusMap.get(ps.panelId)?.push(ps.statusId);
        });

        // 3. Create StatusHistory entries
        // We need to create one history entry for each panel being updated
        // Format notes to include reporter name if provided
        let formattedNotes = req.body.note || '';
        if (reporterName) {
          formattedNotes = `Reporter: ${reporterName}${formattedNotes ? '\n' + formattedNotes : ''}`;
        }

        const historyEntries = panelIds.map((pId: string) => {
          // Append snapshot to notes
          const snapshot = statusMap.get(pId) || [];
          const noteWithSnapshot = `${formattedNotes}\n\n---\nSNAPSHOT:${JSON.stringify(snapshot)}`;

          return {
            panelId: pId,
            statusId: statusId,
            action: 'ASSIGNED',
            notes: noteWithSnapshot,
            changedBy: (req as any).user?.userId // Track user if available
          };
        });

        await tx.statusHistory.createMany({
          data: historyEntries
        });
      });
    }

    res.json({
      success: true,
      updatedCount: assignmentsToCreate.length,
      skipped: panelIds.length - assignmentsToCreate.length
    });
  } catch (error) {
    console.error('Error assigning status to panels:', error);
    res.status(500).json({ error: 'Failed to assign status to panels' });
  }
});

// Remove custom status from panels (bulk operation)
router.post('/remove-from-panels', async (req, res) => {
  try {
    const { panelIds, statusId, projectId, reporterName } = req.body;

    // Use transaction to ensure both operations succeed or fail together
    await prisma.$transaction(async (tx) => {
      // 1. Remove status assignments from PanelStatus junction table
      await tx.panelStatus.deleteMany({
        where: {
          panelId: { in: panelIds },
          statusId: statusId,
          panel: {
            projectId: parseInt(projectId)
          }
        }
      });

      // 2. Fetch updated statuses for all affected panels to create snapshots
      const panelStatuses = await tx.panelStatus.findMany({
        where: {
          panelId: { in: panelIds }
        },
        select: {
          panelId: true,
          statusId: true
        }
      });

      // Group statuses by panelId
      const statusMap = new Map<string, string[]>();
      panelStatuses.forEach(ps => {
        if (!statusMap.has(ps.panelId)) {
          statusMap.set(ps.panelId, []);
        }
        statusMap.get(ps.panelId)?.push(ps.statusId);
      });

      // 3. Create StatusHistory entries for removal tracking
      // Format notes to include reporter name if provided
      let formattedNotes = req.body.note || '';
      if (reporterName) {
        formattedNotes = `Reporter: ${reporterName}${formattedNotes ? '\n' + formattedNotes : ''}`;
      }

      const historyEntries = panelIds.map((pId: string) => {
        // Append snapshot to notes
        const snapshot = statusMap.get(pId) || [];
        const noteWithSnapshot = `${formattedNotes}\n\n---\nSNAPSHOT:${JSON.stringify(snapshot)}`;

        return {
          panelId: pId,
          statusId: statusId,
          action: 'REMOVED',
          notes: noteWithSnapshot,
          changedBy: (req as any).user?.userId
        };
      });

      await tx.statusHistory.createMany({
        data: historyEntries
      });
    });

    res.json({ success: true, updatedCount: panelIds.length });
  } catch (error) {
    console.error('Error removing status from panels:', error);
    res.status(500).json({ error: 'Failed to remove status from panels' });
  }
});

// Batch update panels (add and remove statuses in one go)
router.post('/batch-update-panels', async (req, res) => {
  try {
    const { panelIds, addedStatusIds, removedStatusIds, projectId, reporterName, note } = req.body;

    if (!panelIds || panelIds.length === 0) {
      return res.status(400).json({ error: 'No panel IDs provided' });
    }

    await prisma.$transaction(async (tx) => {
      // 1. Handle Removed Statuses
      if (removedStatusIds && removedStatusIds.length > 0) {
        await tx.panelStatus.deleteMany({
          where: {
            panelId: { in: panelIds },
            statusId: { in: removedStatusIds },
            panel: {
              projectId: parseInt(projectId)
            }
          }
        });
      }

      // 2. Handle Added Statuses
      if (addedStatusIds && addedStatusIds.length > 0) {
        const assignmentsToCreate = [];
        for (const panelId of panelIds) {
          for (const statusId of addedStatusIds) {
            assignmentsToCreate.push({
              panelId: panelId,
              statusId: statusId
            });
          }
        }

        if (assignmentsToCreate.length > 0) {
          await tx.panelStatus.createMany({
            data: assignmentsToCreate,
            skipDuplicates: true
          });
        }
      }

      // 3. Create Snapshot
      const panelStatuses = await tx.panelStatus.findMany({
        where: {
          panelId: { in: panelIds }
        },
        select: {
          panelId: true,
          statusId: true
        }
      });

      const statusMap = new Map<string, string[]>();
      panelStatuses.forEach(ps => {
        if (!statusMap.has(ps.panelId)) {
          statusMap.set(ps.panelId, []);
        }
        statusMap.get(ps.panelId)?.push(ps.statusId);
      });

      // 4. Create History Entry
      let formattedNotes = note || '';
      if (reporterName) {
        formattedNotes = `Reporter: ${reporterName}${formattedNotes ? '\n' + formattedNotes : ''}`;
      }

      // Determine Action Type and Primary Status ID
      let action = 'UPDATED';
      let primaryStatusId = '';

      if (addedStatusIds?.length > 0 && (!removedStatusIds || removedStatusIds.length === 0)) {
        action = 'ASSIGNED';
        primaryStatusId = addedStatusIds[0];
      } else if (removedStatusIds?.length > 0 && (!addedStatusIds || addedStatusIds.length === 0)) {
        action = 'REMOVED';
        primaryStatusId = removedStatusIds[0];
      } else {
        action = 'UPDATED';
        if (addedStatusIds?.length > 0) primaryStatusId = addedStatusIds[0];
        else if (removedStatusIds?.length > 0) primaryStatusId = removedStatusIds[0];
      }

      const historyEntries = [];
      for (const pId of panelIds) {
        const snapshot = statusMap.get(pId) || [];
        const noteWithSnapshot = `${formattedNotes}\n\n---\nSNAPSHOT:${JSON.stringify(snapshot)}`;

        let pStatusId = primaryStatusId;
        if (!pStatusId && snapshot.length > 0) {
          pStatusId = snapshot[0];
        }

        if (pStatusId) {
          historyEntries.push({
            panelId: pId,
            statusId: pStatusId,
            action: action,
            notes: noteWithSnapshot,
            changedBy: (req as any).user?.userId
          });
        }
      }

      if (historyEntries.length > 0) {
        await tx.statusHistory.createMany({
          data: historyEntries
        });
      }
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Error in batch update:', error);
    res.status(500).json({ error: 'Failed to batch update panels' });
  }
});

// Get all custom statuses for a project with panel counts
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    const statuses = await prisma.status.findMany({
      where: { projectId: parseInt(projectId) },
      orderBy: { order: 'asc' },
      include: {
        _count: {
          select: { panelStatuses: true }
        },
        panelStatuses: {
          include: {
            panel: {
              select: {
                id: true,
                name: true,
                tag: true,
                objectType: true,
                elementId: true,
                metadata: true,
                element: {
                  select: {
                    id: true,
                    globalId: true,
                    ifcType: true,
                  },
                },
              },
            },
          },
        },
      }
    });

    // Format response to include panel count
    const statusesWithCount = statuses.map(status => ({
      ...status,
      panelCount: status._count.panelStatuses
    }));

    res.json({ statuses: statusesWithCount });
  } catch (error) {
    console.error('Error fetching custom statuses:', error);
    res.status(500).json({ error: 'Failed to fetch custom statuses' });
  }
});

// Create a new custom status
router.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    console.log('📥 Received request body:', req.body);
    const { name, icon, color, description } = req.body;
    console.log('📝 Extracted name:', name, 'icon:', icon, 'color:', color);

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Status name is required' });
    }

    // Get the highest order number
    const maxOrder = await prisma.status.findFirst({
      where: { projectId: parseInt(projectId) },
      orderBy: { order: 'desc' },
      select: { order: true }
    });

    const newStatus = await prisma.status.create({
      data: {
        projectId: parseInt(projectId),
        name,
        icon: icon || 'circle',
        color: color || '#3B82F6',
        description,
        order: (maxOrder?.order || 0) + 1
      }
    });

    res.json({ status: newStatus });
  } catch (error) {
    console.error('Error creating custom status:', error);
    res.status(500).json({ error: 'Failed to create custom status' });
  }
});

// Update a custom status
router.put('/:statusId', async (req, res) => {
  try {
    const { statusId } = req.params;
    const { name, icon, color, description, order } = req.body;

    const updatedStatus = await prisma.status.update({
      where: { id: statusId },
      data: {
        ...(name && { name }),
        ...(icon && { icon }),
        ...(color && { color }),
        ...(description !== undefined && { description }),
        ...(order !== undefined && { order })
      }
    });

    res.json({ status: updatedStatus });
  } catch (error) {
    console.error('Error updating custom status:', error);
    res.status(500).json({ error: 'Failed to update custom status' });
  }
});

// Delete a custom status
router.delete('/:statusId', async (req, res) => {
  try {
    const { statusId } = req.params;

    // First, remove this status from all panel assignments
    await prisma.panelStatus.deleteMany({
      where: { statusId: statusId }
    });

    // Then delete the status
    await prisma.status.delete({
      where: { id: statusId }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting custom status:', error);
    res.status(500).json({ error: 'Failed to delete custom status' });
  }
});

// Get status history for a panel
router.get('/history/:panelId', async (req, res) => {
  try {
    const { panelId } = req.params;

    const history = await prisma.statusHistory.findMany({
      where: { panelId: panelId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Manually fetch status data for each history entry
    const historyWithStatus = await Promise.all(
      history.map(async (entry) => {
        const status = await prisma.status.findUnique({
          where: { id: entry.statusId },
          select: {
            id: true,
            name: true,
            color: true,
            icon: true
          }
        });

        return {
          ...entry,
          status
        };
      })
    );

    // Fetch all statuses to allow frontend to resolve snapshots
    // We need the project ID to fetch relevant statuses. 
    // We can get it from the panel.
    const panel = await prisma.panel.findUnique({
      where: { id: panelId },
      select: { projectId: true }
    });

    let allStatuses: any[] = [];
    if (panel) {
      allStatuses = await prisma.status.findMany({
        where: { projectId: panel.projectId },
        select: {
          id: true,
          name: true,
          color: true,
          icon: true
        }
      });
    }

    res.json({ history: historyWithStatus, allStatuses });
  } catch (error) {
    console.error('Error fetching status history:', error);
    res.status(500).json({ error: 'Failed to fetch status history' });
  }
});

export default router;


