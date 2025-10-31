import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * Custom Status Management Routes
 * These allow creating custom statuses beyond the default enum values
 */

// Assign custom status to panels (bulk operation) - MUST BE BEFORE /:projectId routes
router.post('/assign-to-panels', async (req, res) => {
  try {
    const { panelIds, statusId, projectId } = req.body;
    
    // Check if it's a default status or custom status
    const validPanelStatuses = ['READY_FOR_PRODUCTION', 'PRODUCED', 'PRE_FABRICATED', 'READY_FOR_TRUCK_LOAD', 'SHIPPED', 'EDIT'];
    const isCustomStatus = !validPanelStatuses.includes(statusId);
    
    if (isCustomStatus) {
      // Add custom status to panels (many-to-many, don't overwrite existing)
      const assignmentsToCreate = [];
      
      for (const panelId of panelIds) {
        // Check if this panel already has this status
        const existing = await prisma.panelCustomStatus.findUnique({
          where: {
            panelId_customStatusId: {
              panelId: panelId,
              customStatusId: statusId
            }
          }
        });
        
        // Only create if it doesn't exist
        if (!existing) {
          assignmentsToCreate.push({
            panelId: panelId,
            customStatusId: statusId
          });
        }
      }
      
      // Bulk create assignments
      if (assignmentsToCreate.length > 0) {
        await prisma.panelCustomStatus.createMany({
          data: assignmentsToCreate,
          skipDuplicates: true
        });
      }
      
      res.json({ 
        success: true, 
        updatedCount: assignmentsToCreate.length,
        skipped: panelIds.length - assignmentsToCreate.length 
      });
    } else {
      // Assign default status (replaces existing default status)
      await prisma.panel.updateMany({
        where: { 
          id: { in: panelIds },
          projectId: parseInt(projectId)
        },
        data: { 
          status: statusId as any
        }
      });
      
      res.json({ success: true, updatedCount: panelIds.length });
    }
  } catch (error) {
    console.error('Error assigning status to panels:', error);
    res.status(500).json({ error: 'Failed to assign status to panels' });
  }
});

// Remove custom status from panels (bulk operation)
router.post('/remove-from-panels', async (req, res) => {
  try {
    const { panelIds, projectId } = req.body;
    
    await prisma.panel.updateMany({
      where: { 
        id: { in: panelIds },
        projectId: parseInt(projectId)
      },
      data: { customStatusId: null }
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
    
    const customStatuses = await prisma.customStatus.findMany({
      where: { projectId: parseInt(projectId) },
      orderBy: { order: 'asc' },
      include: {
        _count: {
          select: { panelStatuses: true }
        }
      }
    });
    
    // Format response to include panel count
    const statusesWithCount = customStatuses.map(status => ({
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
    const { name, icon, color, description } = req.body;
    
    // Get the highest order number
    const maxOrder = await prisma.customStatus.findFirst({
      where: { projectId: parseInt(projectId) },
      orderBy: { order: 'desc' },
      select: { order: true }
    });
    
    const newStatus = await prisma.customStatus.create({
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
    
    const updatedStatus = await prisma.customStatus.update({
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
    
    // First, remove this status from all panels
    await prisma.panel.updateMany({
      where: { customStatusId: statusId },
      data: { customStatusId: null }
    });
    
    // Then delete the status
    await prisma.customStatus.delete({
      where: { id: statusId }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting custom status:', error);
    res.status(500).json({ error: 'Failed to delete custom status' });
  }
});

export default router;
