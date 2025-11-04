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
    const { panelIds, statusId, projectId } = req.body;
    
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
      await prisma.panelStatus.createMany({
        data: assignmentsToCreate,
        skipDuplicates: true
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
    const { panelIds, projectId } = req.body;
    
    // Remove status assignments from PanelStatus junction table
    await prisma.panelStatus.deleteMany({
      where: { 
        panelId: { in: panelIds },
        panel: {
          projectId: parseInt(projectId)
        }
      }
    });
    
    res.json({ success: true, updatedCount: panelIds.length });
  } catch (error) {
    console.error('Error removing status from panels:', error);
    res.status(500).json({ error: 'Failed to remove status from panels' });
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

export default router;
