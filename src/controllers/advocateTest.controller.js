import {
  loginAdvocateTest,
  startAdvocateTest,
  saveAdvocateTestAnswers,
  submitAdvocateTest,
  requestAdvocateTestReschedule
} from '../services/advocateTest.service.js';

/**
 * Advocate test login with Token + Bar Council ID + Phone.
 * POST /api/advocate-test/login
 */
export const testLogin = async (req, res, next) => {
  try {
    const { token, barCouncilId, phone } = req.body || {};
    const result = await loginAdvocateTest({ token, barCouncilId, phone });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'ERROR',
        message: error.message,
        ...(error.canRequestReschedule !== undefined ? { canRequestReschedule: error.canRequestReschedule } : {})
      });
    }
    next(error);
  }
};

/**
 * Starts or resumes advocate test attempt.
 * POST /api/advocate-test/start
 */
export const startTest = async (req, res, next) => {
  try {
    const { inviteId, advocateId } = req.testSession;
    const result = await startAdvocateTest({ inviteId, advocateId });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'ERROR',
        message: error.message,
        ...(error.canRequestReschedule !== undefined ? { canRequestReschedule: error.canRequestReschedule } : {})
      });
    }
    next(error);
  }
};

/**
 * Autosaves answers for in-progress test attempt.
 * PUT /api/advocate-test/answers
 */
export const saveAnswers = async (req, res, next) => {
  try {
    const { inviteId, advocateId } = req.testSession;
    const { answers } = req.body || {};

    const result = await saveAdvocateTestAnswers({ inviteId, advocateId, answers });

    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'ERROR',
        message: error.message
      });
    }
    next(error);
  }
};

/**
 * Submits final answers and scores the attempt. Idempotent.
 * POST /api/advocate-test/submit
 */
export const submitTest = async (req, res, next) => {
  try {
    const { inviteId, advocateId } = req.testSession;
    const { answers } = req.body || {};

    const result = await submitAdvocateTest({ inviteId, advocateId, answers });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'ERROR',
        message: error.message
      });
    }
    next(error);
  }
};

/**
 * Requests test reschedule.
 * Accepts either session JWT or credentials { token, barCouncilId, phone }.
 * POST /api/advocate-test/request-reschedule
 */
export const requestReschedule = async (req, res, next) => {
  try {
    const inviteId = req.testSession?.inviteId;
    const advocateId = req.testSession?.advocateId;
    const { token, barCouncilId, phone } = req.body || {};

    const result = await requestAdvocateTestReschedule({
      inviteId,
      advocateId,
      token,
      barCouncilId,
      phone
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'ERROR',
        message: error.message
      });
    }
    next(error);
  }
};

