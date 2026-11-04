import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let firebaseApp = null;
let messagingInstance = null;

/**
 * Resolves Firebase service account credentials from env or file.
 * Priority:
 * 1. FIREBASE_SERVICE_ACCOUNT_KEY (raw JSON or base64 JSON string)
 * 2. FIREBASE_SERVICE_ACCOUNT_PATH (custom path from env)
 * 3. Default relative path: ./firebase-service-account.json
 */
const loadServiceAccount = () => {
  // Option 1: Inline JSON or base64 JSON string
  const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
    try {
      const trimmed = rawKey.trim();
      const jsonString = trimmed.startsWith('{')
        ? trimmed
        : Buffer.from(trimmed, 'base64').toString('utf8');
      return JSON.parse(jsonString);
    } catch (err) {
      console.error('[Firebase Config] Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', err.message);
    }
  }

  // Option 2: Path from env
  const customPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (customPath) {
    const resolvedPath = path.isAbsolute(customPath)
      ? customPath
      : path.resolve(process.cwd(), customPath);
    if (fs.existsSync(resolvedPath)) {
      try {
        return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      } catch (err) {
        console.error(`[Firebase Config] Failed to read service account from ${resolvedPath}:`, err.message);
      }
    }
  }

  // Option 3: Default config file in src/config/firebase-service-account.json
  const defaultPath = path.resolve(__dirname, 'firebase-service-account.json');
  if (fs.existsSync(defaultPath)) {
    try {
      return JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
    } catch (err) {
      console.error(`[Firebase Config] Failed to read default service account at ${defaultPath}:`, err.message);
    }
  }

  return null;
};

/**
 * Initializes and returns the Firebase Admin App instance (singleton).
 */
export const getFirebaseApp = () => {
  if (firebaseApp) return firebaseApp;

  const existingApps = getApps();
  if (existingApps.length > 0) {
    firebaseApp = getApp();
    return firebaseApp;
  }

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    console.warn('[Firebase Config] No valid Firebase service account found. Push notifications will operate in fallback/simulation mode.');
    return null;
  }

  try {
    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID || 'vakeel-setu-4c34c'
    });
    console.log(`[Firebase Config] Firebase Admin initialized for project: ${serviceAccount.project_id || 'vakeel-setu-4c34c'}`);
    return firebaseApp;
  } catch (error) {
    console.error('[Firebase Config] Error initializing Firebase Admin SDK:', error.message);
    return null;
  }
};

/**
 * Returns the Firebase Messaging singleton or null if uninitialized.
 */
export const getFirebaseMessaging = () => {
  if (messagingInstance) return messagingInstance;
  const app = getFirebaseApp();
  if (!app) return null;
  try {
    messagingInstance = getMessaging(app);
    return messagingInstance;
  } catch (error) {
    console.error('[Firebase Config] Error obtaining Firebase Messaging instance:', error.message);
    return null;
  }
};

/**
 * Checks if Firebase Admin is initialized and ready.
 */
export const isFirebaseInitialized = () => {
  return !!getFirebaseMessaging();
};

export default {
  getFirebaseApp,
  getFirebaseMessaging,
  isFirebaseInitialized
};

