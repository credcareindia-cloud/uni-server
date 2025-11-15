import { Router, Response } from 'express';
import { prisma } from '../config/database.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Get user profile
router.get('/profile', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        phone: true,
        location: true,
        company: true,
        userRole: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            projects: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ...user,
      projects: user._count.projects
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Update user profile
router.put('/profile', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, phone, location, company, role: userRole } = req.body;

    // Build update data object
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone;
    if (location !== undefined) updateData.location = location;
    if (company !== undefined) updateData.company = company;
    if (userRole !== undefined) updateData.userRole = userRole;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        phone: true,
        location: true,
        company: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            projects: true
          }
        }
      }
    });

    res.json({
      ...updatedUser,
      projects: updatedUser._count.projects
    });
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

// Get user statistics
router.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    // Get project count
    const projectCount = await prisma.project.count({
      where: { createdBy: userId }
    });

    // Get total groups across all user projects
    const userProjects = await prisma.project.findMany({
      where: { createdBy: userId },
      select: { id: true }
    });

    const projectIds = userProjects.map(p => p.id);

    const groupCount = await prisma.group.count({
      where: { projectId: { in: projectIds } }
    });

    // Get total panels across all user projects
    const panelCount = await prisma.panel.count({
      where: { projectId: { in: projectIds } }
    });

    // Get recent activity (last 10 projects updated)
    const recentProjects = await prisma.project.findMany({
      where: { createdBy: userId },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        name: true,
        updatedAt: true
      }
    });

    res.json({
      activeProjects: projectCount,
      totalGroups: groupCount,
      totalPanels: panelCount,
      recentActivity: recentProjects
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ error: 'Failed to fetch user statistics' });
  }
});

export default router;
