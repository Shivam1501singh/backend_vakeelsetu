import { Router } from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/session', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const secret = process.env.WEBSITE_AUTH_SECRET;
    const apiUrl = process.env.LEGAL_AI_API_URL;

    if (!secret || secret.length < 32 || !apiUrl) {
        return res.status(503).json({
            success: false,
            message: 'Chatbot configuration is incomplete.',
        });
    }

    const { id, type } = req.user;

    if (id == null || !type) {
        return res.status(401).json({
            success: false,
            message: 'Verified account identity is missing.',
        });
    }

    try {
        // Prevent collisions between user and advocate account IDs.
        const subject = `${String(type).toLowerCase()}:${String(id)}`;

        const assertion = jwt.sign({}, secret, {
            algorithm: 'HS256',
            subject,
            issuer: process.env.WEBSITE_AUTH_ISSUER || 'main-website',
            audience: process.env.WEBSITE_AUTH_AUDIENCE || 'legal-ai',
            expiresIn: '60s',
            jwtid: randomUUID(),
        });

        const response = await axios.post(
            new URL('/auth/website-token', apiUrl).href,
            { assertion },
            { timeout: 15000 }
        );

        return res.json({
            api_url: new URL(apiUrl).origin,
            access_token: response.data.access_token,
            expires_in: 300,
        });
    } catch (error) {
        // Log selected diagnostic fields only, never the full Axios error.
        console.error('Chatbot connection failed:', {
            code: error.code,
            status: error.response?.status,
            message:
                error.response?.data?.error?.message ||
                error.message,
        });

        return res.status(502).json({
            success: false,
            message: 'Chatbot session could not be opened. Please retry.',
        });
    }
});


export default router;