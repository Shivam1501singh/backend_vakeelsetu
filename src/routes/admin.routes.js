import express from 'express';
import * as adminController from '../controllers/admin.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';
import rbacRoutes from './rbac.routes.js';

const router = express.Router();

// Admin Authentication (Public)
router.post('/login', generalLimiter, adminController.loginAdmin);

// Content Creator Staff Management
router.post('/content-creators', requireAuth, requirePermission('content_creators:create'), generalLimiter, adminController.createContentCreator);
router.get('/content-creators', requireAuth, requirePermission('content_creators:view'), generalLimiter, adminController.listContentCreators);

// Advocate Management (Protected by fine-grained RBAC permissions; Admin has full access)
router.get('/advocates/deletion-requests', requireAuth, requirePermission('advocates:view'), generalLimiter, adminController.listPendingAdvocateDeletionRequests);
router.get('/advocates/pending', requireAuth, requirePermission('advocates:view'), generalLimiter, adminController.listPendingAdvocates);
router.get('/advocates', requireAuth, requirePermission('advocates:view'), generalLimiter, adminController.listAdvocates);
router.get('/advocates/:advocateId', requireAuth, requirePermission('advocates:view'), generalLimiter, adminController.getAdvocateReviewProfile);
router.patch('/advocates/:advocateId/approve', requireAuth, requirePermission('advocates:approve'), generalLimiter, adminController.approveAdvocate);
router.patch('/advocates/:advocateId/reject', requireAuth, requirePermission('advocates:reject'), generalLimiter, adminController.rejectAdvocate);
router.patch('/advocates/:advocateId/status', requireAuth, requirePermission('advocates:update_status'), generalLimiter, adminController.updateAdvocateStatus);
router.patch('/advocates/:advocateId/call-availability', requireAuth, requirePermission('advocates:update_status'), generalLimiter, adminController.updateAdvocateCallAvailability);
router.patch('/advocates/:advocateId/cancel-deletion', requireAuth, requirePermission('advocates:delete'), generalLimiter, adminController.cancelAdvocateDeletion);
router.delete('/advocates/:advocateId/permanent', requireAuth, requirePermission('advocates:delete'), generalLimiter, adminController.permanentDeleteAdvocate);

// RBAC Management Routes (Roles, Permissions, User Role Assignments, Users List)
router.use('/', rbacRoutes);

export default router;
