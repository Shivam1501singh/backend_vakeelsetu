import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  testLogin,
  startTest,
  saveAnswers,
  submitTest,
  requestReschedule
} from '../controllers/advocateTest.controller.js';
import { verifyTestSessionToken } from '../services/advocateTest.service.js';

const router = Router();

/**
 * Rate limiter: 5 failed attempts per 15 min per token + IP -> 429.
 */
export const testLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => {
    const rawToken = req.body && req.body.token ? String(req.body.token).trim() : 'notoken';
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    return `${ip}_${rawToken}`;
  },
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many failed attempts for this test link. Please try again after 15 minutes.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Middleware: Enforces valid test session JWT.
 */
export const requireTestSession = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Missing test session token.'
    });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyTestSessionToken(token);

  if (!decoded) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_SESSION',
      message: 'Invalid or expired test session. Please log in again.'
    });
  }

  req.testSession = decoded;
  next();
};

/**
 * Middleware: Optional test session (for reschedule which accepts either JWT or credentials).
 */
export const optionalTestSession = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const decoded = verifyTestSessionToken(token);
    if (decoded) {
      req.testSession = decoded;
    }
  }
  next();
};

// 1. Advocate test login (Token + Bar Council ID + Phone)
router.post('/login', testLoginLimiter, testLogin);

// 2. Start test (fetches or initializes randomized question snapshot)
router.post('/start', requireTestSession, startTest);

// 3. Autosave answers (progress recovery)
router.put('/answers', requireTestSession, saveAnswers);

// 4. Submit test answers (final scoring)
router.post('/submit', requireTestSession, submitTest);

// 5. Request reschedule (after fail or link expiry)
router.post('/request-reschedule', optionalTestSession, requestReschedule);

export default router;

