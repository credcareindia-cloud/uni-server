import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Middleware to check if user is admin
const requireAdmin = async (req: AuthenticatedRequest, res: Response, next: any) => {
  try {
    // req.user is already populated by authenticateToken middleware
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Apply admin check to all routes
router.use(requireAdmin);

// Get all users in the admin's organization
router.get('/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        organizationId: req.user.organizationId
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            projects: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Transform data to match frontend interface
    const transformedUsers = users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.toLowerCase(),
      status: 'active',
      projects: user._count.projects,
      createdAt: user.createdAt
    }));

    res.json(transformedUsers);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create new user (only MANAGER or VIEWER roles allowed)
router.post('/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    // Only allow MANAGER or VIEWER roles
    const userRole = role ? role.toUpperCase() : 'VIEWER';
    if (!['MANAGER', 'VIEWER'].includes(userRole)) {
      return res.status(400).json({ error: 'Only MANAGER or VIEWER roles can be created' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user in the same organization as the admin who created them
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashedPassword,
        role: userRole as 'MANAGER' | 'VIEWER',
        organizationId: req.user!.organizationId,
        createdBy: req.user!.id
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    res.status(201).json({
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role.toLowerCase(),
      status: 'active',
      projects: 0,
      createdAt: newUser.createdAt
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Delete user
router.delete('/users/:userId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId } = req.params;

    // Prevent deleting yourself
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Check if user exists and belongs to same organization
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Ensure user belongs to same organization
    if (user.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot delete users from other organizations' });
    }

    // Cannot delete users created by other admins
    if (user.role === 'ADMIN' && user.createdBy !== req.user!.id) {
      return res.status(403).json({ error: 'Cannot delete admins created by other admins' });
    }

    // Delete user (this will cascade delete related data based on your schema)
    await prisma.user.delete({
      where: { id: userId }
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Update user (name, email, role)
router.patch('/users/:userId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId } = req.params;
    const { name, email, role } = req.body;

    // Get user to verify ownership
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Ensure user belongs to same organization
    if (user.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot update users from other organizations' });
    }

    // Prevent changing your own role
    if (userId === req.user!.id && role) {
      if (user.role !== role.toUpperCase()) {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }
    }

    // Check if email is already taken by another user
    if (email) {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser && existingUser.id !== userId) {
        return res.status(400).json({ error: 'Email is already taken' });
      }
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    
    // Prevent promoting to ADMIN role
    if (role) {
      const newRole = role.toUpperCase();
      if (newRole === 'ADMIN') {
        return res.status(400).json({ error: 'Cannot promote users to ADMIN role' });
      }
      updateData.role = newRole as 'MANAGER' | 'VIEWER';
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            projects: true
          }
        }
      }
    });

    res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role.toLowerCase(),
      status: 'active',
      projects: updatedUser._count.projects,
      createdAt: updatedUser.createdAt
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Update user role only (legacy endpoint)
router.patch('/users/:userId/role', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    // Prevent changing your own role
    if (userId === req.user!.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    // Get user to verify ownership
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Ensure user belongs to same organization
    if (user.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot update users from other organizations' });
    }

    const userRole = role.toUpperCase();

    // Prevent promoting to ADMIN role
    if (userRole === 'ADMIN') {
      return res.status(400).json({ error: 'Cannot promote users to ADMIN role' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role: userRole as 'MANAGER' | 'VIEWER' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role.toLowerCase(),
      status: 'active',
      createdAt: updatedUser.createdAt
    });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Project membership management endpoints

/**
 * GET /api/admin/projects/:projectId/members
 * Get all members of a project
 */
router.get('/projects/:projectId/members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const projectIdNum = parseInt(projectId);

    if (isNaN(projectIdNum)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    // Check if project exists and belongs to admin's organization
    const project = await prisma.project.findUnique({
      where: { id: projectIdNum },
      select: { id: true, name: true, organizationId: true }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot access projects from other organizations' });
    }

    // Get all project members (excluding ADMIN users)
    const members = await prisma.projectMember.findMany({
      where: { projectId: projectIdNum },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            createdAt: true
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    const transformedMembers = members
      .filter(member => member.user.role !== 'ADMIN')
      .map(member => ({
        id: member.id,
        userId: member.user.id,
        role: member.role,
        user: {
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
          role: member.user.role
        },
        createdAt: member.createdAt
      }));

    res.json({
      project: {
        id: String(project.id),
        name: project.name
      },
      members: transformedMembers,
      total: transformedMembers.length
    });
  } catch (error) {
    console.error('Error fetching project members:', error);
    res.status(500).json({ error: 'Failed to fetch project members' });
  }
});

/**
 * POST /api/admin/projects/:projectId/members
 * Add a member to a project
 */
router.post('/projects/:projectId/members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { userId, role } = req.body;
    const projectIdNum = parseInt(projectId);

    if (isNaN(projectIdNum)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    if (!userId || !role) {
      return res.status(400).json({ error: 'User ID and role are required' });
    }

    const validRoles = ['OWNER', 'MANAGER', 'VIEWER'];
    if (!validRoles.includes(role.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid role. Must be OWNER, MANAGER, or VIEWER' });
    }

    // Check if project exists and belongs to admin's organization
    const project = await prisma.project.findUnique({
      where: { id: projectIdNum },
      select: { id: true, organizationId: true }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot assign users to projects from other organizations' });
    }

    // Check if user exists and belongs to same organization
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot assign users from other organizations to projects' });
    }

    // Only allow assigning MANAGER or VIEWER roles (not ADMIN)
    if (user.role === 'ADMIN') {
      return res.status(400).json({ error: 'Admin users cannot be assigned to projects' });
    }

    // Check if user is already a member
    const existingMember = await prisma.projectMember.findFirst({
      where: { projectId: projectIdNum, userId }
    });

    if (existingMember) {
      return res.status(400).json({ error: 'User is already assigned to this project' });
    }

    // Create membership
    const member = await prisma.projectMember.create({
      data: {
        projectId: projectIdNum,
        userId,
        role: role.toUpperCase() as 'OWNER' | 'MANAGER' | 'VIEWER'
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            createdAt: true
          }
        }
      }
    });

    res.status(201).json({
      id: member.id,
      userId: member.user.id,
      name: member.user.name,
      email: member.user.email,
      globalRole: member.user.role.toLowerCase(),
      projectRole: member.role.toLowerCase(),
      joinedAt: member.createdAt,
      userCreatedAt: member.user.createdAt
    });
  } catch (error) {
    console.error('Error adding project member:', error);
    res.status(500).json({ error: 'Failed to add project member' });
  }
});

/**
 * PATCH /api/admin/projects/:projectId/members/:userId
 * Update a member's role in a project
 */
router.patch('/projects/:projectId/members/:userId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, userId } = req.params;
    const { role } = req.body;
    const projectIdNum = parseInt(projectId);

    if (isNaN(projectIdNum)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    const validRoles = ['OWNER', 'MANAGER', 'VIEWER'];
    if (!validRoles.includes(role.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid role. Must be OWNER, MANAGER, or VIEWER' });
    }

    // Check if project belongs to admin's organization
    const project = await prisma.project.findUnique({
      where: { id: projectIdNum },
      select: { organizationId: true }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot update members in projects from other organizations' });
    }

    // Check if membership exists
    const existingMember = await prisma.projectMember.findFirst({
      where: { projectId: projectIdNum, userId }
    });

    if (!existingMember) {
      return res.status(404).json({ error: 'User is not assigned to this project' });
    }

    // Check if this would remove the last OWNER
    if (existingMember.role === 'OWNER' && role.toUpperCase() !== 'OWNER') {
      const ownerCount = await prisma.projectMember.count({
        where: { projectId: projectIdNum, role: 'OWNER' }
      });

      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner of the project' });
      }
    }

    // Update membership
    const updatedMember = await prisma.projectMember.update({
      where: { id: existingMember.id },
      data: { role: role.toUpperCase() as 'OWNER' | 'MANAGER' | 'VIEWER' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            createdAt: true
          }
        }
      }
    });

    res.json({
      id: updatedMember.id,
      userId: updatedMember.user.id,
      name: updatedMember.user.name,
      email: updatedMember.user.email,
      globalRole: updatedMember.user.role.toLowerCase(),
      projectRole: updatedMember.role.toLowerCase(),
      joinedAt: updatedMember.createdAt,
      userCreatedAt: updatedMember.user.createdAt
    });
  } catch (error) {
    console.error('Error updating project member:', error);
    res.status(500).json({ error: 'Failed to update project member' });
  }
});

/**
 * DELETE /api/admin/projects/:projectId/members/:userId
 * Remove a member from a project
 */
router.delete('/projects/:projectId/members/:userId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, userId } = req.params;
    const projectIdNum = parseInt(projectId);

    if (isNaN(projectIdNum)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    // Check if project belongs to admin's organization
    const project = await prisma.project.findUnique({
      where: { id: projectIdNum },
      select: { organizationId: true }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot remove members from projects in other organizations' });
    }

    // Check if membership exists
    const existingMember = await prisma.projectMember.findFirst({
      where: { projectId: projectIdNum, userId }
    });

    if (!existingMember) {
      return res.status(404).json({ error: 'User is not assigned to this project' });
    }

    // Check if this would remove the last OWNER
    if (existingMember.role === 'OWNER') {
      const ownerCount = await prisma.projectMember.count({
        where: { projectId: projectIdNum, role: 'OWNER' }
      });

      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner of the project' });
      }
    }

    // Remove membership
    await prisma.projectMember.delete({
      where: { id: existingMember.id }
    });

    res.json({ message: 'User unassigned from project successfully' });
  } catch (error) {
    console.error('Error removing project member:', error);
    res.status(500).json({ error: 'Failed to remove user from project' });
  }
});

/**
 * GET /api/admin/projects
 * Get all projects for admin management
 */
router.get('/projects', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      where: {
        organizationId: req.user!.organizationId
      },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        owner: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        _count: {
          select: {
            members: true,
            panels: true,
            modelHistory: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const transformedProjects = projects.map(project => ({
      id: String(project.id),
      name: project.name,
      description: project.description,
      status: project.status.toLowerCase().replace('_', '-'),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      owner: project.owner,
      memberCount: project._count.members,
      panelCount: project._count.panels,
      modelCount: project._count.modelHistory
    }));

    res.json({
      projects: transformedProjects,
      total: transformedProjects.length
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

/**
 * GET /api/admin/projects/:projectId/assignable-users
 * Get users (managers and users only) that can be assigned to a project
 */
router.get('/projects/:projectId/assignable-users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const projectIdNum = parseInt(projectId);

    if (isNaN(projectIdNum)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    // Check if project belongs to admin's organization
    const project = await prisma.project.findUnique({
      where: { id: projectIdNum },
      select: { id: true, organizationId: true }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.organizationId !== req.user!.organizationId) {
      return res.status(403).json({ error: 'Cannot access projects from other organizations' });
    }

    // Get users (MANAGER or VIEWER roles only, exclude ADMIN) that are not already assigned to this project
    const assignableUsers = await prisma.user.findMany({
      where: {
        organizationId: req.user!.organizationId,
        role: {
          in: ['MANAGER', 'VIEWER']
        }
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        projectMemberships: {
          where: { projectId: projectIdNum },
          select: { id: true }
        }
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }]
    });

    // Transform response - mark which users are already assigned
    const transformedUsers = assignableUsers.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.toLowerCase(),
      assigned: user.projectMemberships.length > 0
    }));

    res.json({
      users: transformedUsers,
      total: transformedUsers.length,
      unassignedCount: transformedUsers.filter(u => !u.assigned).length
    });
  } catch (error) {
    console.error('Error fetching assignable users:', error);
    res.status(500).json({ error: 'Failed to fetch assignable users' });
  }
});

export default router;
