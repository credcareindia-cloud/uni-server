import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * Group Management Routes
 * Create, update, delete groups and manage panel assignments
 */

// Create a new group
router.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name, description, type, status } = req.body;
    
    const newGroup = await prisma.group.create({
      data: {
        projectId: parseInt(projectId),
        name,
        description,
        metadata: {
          type: type || 'CUSTOM',
          panelCount: 0
        },
        status: status || 'PENDING'
      }
    });
    
    res.json({ group: newGroup });
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Update a group
router.put('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, description, status, type } = req.body;
    
    // Get current group to preserve metadata
    const currentGroup = await prisma.group.findUnique({
      where: { id: groupId }
    });
    
    if (!currentGroup) {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    const metadata = currentGroup.metadata as any || {};
    
    const updatedGroup = await prisma.group.update({
      where: { id: groupId },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(status && { status }),
        ...(type && { 
          metadata: {
            ...metadata,
            type
          }
        })
      }
    });
    
    res.json({ group: updatedGroup });
  } catch (error) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Delete a group
router.delete('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    
    // First, remove group assignment from all panels
    await prisma.panel.updateMany({
      where: { groupId },
      data: { groupId: null }
    });
    
    // Then delete the group
    await prisma.group.delete({
      where: { id: groupId }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

// Assign panels to a group (bulk operation)
router.post('/assign-panels', async (req, res) => {
  try {
    const { panelIds, groupId } = req.body;
    
    await prisma.panel.updateMany({
      where: { id: { in: panelIds } },
      data: { groupId }
    });
    
    // Update group panel count
    const panelCount = await prisma.panel.count({
      where: { groupId }
    });
    
    const group = await prisma.group.findUnique({
      where: { id: groupId }
    });
    
    if (group) {
      const metadata = group.metadata as any || {};
      await prisma.group.update({
        where: { id: groupId },
        data: {
          metadata: {
            ...metadata,
            panelCount
          }
        }
      });
    }
    
    res.json({ success: true, updatedCount: panelIds.length });
  } catch (error) {
    console.error('Error assigning panels to group:', error);
    res.status(500).json({ error: 'Failed to assign panels to group' });
  }
});

// Remove panels from a group (bulk operation)
router.post('/remove-panels', async (req, res) => {
  try {
    const { panelIds, groupId } = req.body;
    
    await prisma.panel.updateMany({
      where: { id: { in: panelIds } },
      data: { groupId: null }
    });
    
    // Update group panel count
    if (groupId) {
      const panelCount = await prisma.panel.count({
        where: { groupId }
      });
      
      const group = await prisma.group.findUnique({
        where: { id: groupId }
      });
      
      if (group) {
        const metadata = group.metadata as any || {};
        await prisma.group.update({
          where: { id: groupId },
          data: {
            metadata: {
              ...metadata,
              panelCount
            }
          }
        });
      }
    }
    
    res.json({ success: true, updatedCount: panelIds.length });
  } catch (error) {
    console.error('Error removing panels from group:', error);
    res.status(500).json({ error: 'Failed to remove panels from group' });
  }
});

// Get panels in a specific group
router.get('/:groupId/panels', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { page = '1', limit = '50' } = req.query;
    
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    const [panels, totalCount] = await Promise.all([
      prisma.panel.findMany({
        where: { groupId },
        skip,
        take: parseInt(limit as string),
        orderBy: { name: 'asc' }
      }),
      prisma.panel.count({
        where: { groupId }
      })
    ]);
    
    res.json({
      panels,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit as string))
      }
    });
  } catch (error) {
    console.error('Error fetching group panels:', error);
    res.status(500).json({ error: 'Failed to fetch group panels' });
  }
});

export default router;
