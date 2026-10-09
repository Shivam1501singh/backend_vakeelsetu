import express from 'express';
import multer from 'multer';
import * as blogController from '../controllers/blog.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Blog Admin Endpoints (Protected by RBAC permissions)
router.post('/api/admin/blogs', requireAuth, requirePermission('blogs:create'), generalLimiter, upload.single('image'), blogController.createBlog);
router.put('/api/admin/blogs/:id', requireAuth, requirePermission('blogs:update'), generalLimiter, upload.single('image'), blogController.updateBlog);
router.delete('/api/admin/blogs/:id', requireAuth, requirePermission('blogs:delete'), generalLimiter, blogController.deleteBlog);

// Public Blog Reads
router.get('/api/blogs', generalLimiter, blogController.getBlogs);
router.get('/api/blogs/:id', generalLimiter, blogController.getSingleBlog);

export default router;
