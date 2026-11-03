import * as feedbackService from '../services/feedback.service.js';
import {
  createFeedbackSchema,
  adminFeedbackQuerySchema
} from '../validators/feedback.validator.js';

/**
 * User / Advocate: Submit feedback
 * POST /api/user/feedback, POST /api/advocate/feedback or POST /api/feedback
 */
export const submitFeedback = async (req, res, next) => {
  try {
    const validated = createFeedbackSchema.parse(req.body);

    const rawRole = (req.user?.role || req.user?.type || 'USER').toUpperCase();
    const userType = rawRole === 'ADVOCATE' ? 'ADVOCATE' : 'USER';

    const data = await feedbackService.submitFeedback({
      accountId: req.user.id,
      userType,
      description: validated.description
    });

    return res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully',
      data
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: List all submitted feedback (latest first with pagination)
 * GET /api/admin/feedback
 */
export const adminListFeedbacks = async (req, res, next) => {
  try {
    const query = adminFeedbackQuerySchema.parse(req.query);

    const result = await feedbackService.listFeedbacksAdmin({
      page: query.page,
      limit: query.limit,
      userType: query.userType
    });

    return res.status(200).json({
      success: true,
      data: result.feedbacks,
      pagination: result.pagination
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Delete feedback by ID
 * DELETE /api/admin/feedback/:id
 */
export const adminDeleteFeedback = async (req, res, next) => {
  try {
    const { id } = req.params;

    const data = await feedbackService.deleteFeedbackAdmin(id);

    return res.status(200).json({
      success: true,
      message: 'Feedback deleted successfully',
      data
    });
  } catch (error) {
    next(error);
  }
};
