import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { deleteFromCloudinary } from './cloudinary.service.js';

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const IMAGES_DIR = path.join(UPLOADS_ROOT, 'images');

// Ensure base directories exist
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

/**
 * Returns backend base URL for building full URLs.
 * Priority: req host -> process.env.BACKEND_URL -> process.env.API_URL -> localhost:PORT
 */
export const getBaseUrl = (req = null) => {
  if (req && typeof req.get === 'function') {
    const protocol = req.protocol || 'http';
    const host = req.get('host');
    if (host) return `${protocol}://${host}`;
  }
  const envUrl = process.env.BACKEND_URL || process.env.API_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  const port = process.env.PORT || 5000;
  return `http://localhost:${port}`;
};

/**
 * Resolves an image URL so relative /uploads paths get prefixed with full baseUrl,
 * while leaving full URLs (e.g. legacy Cloudinary) intact.
 */
export const resolveImageUrl = (url, req = null) => {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  const normalized = url.startsWith('/') ? url : `/${url}`;
  return `${getBaseUrl(req)}${normalized}`;
};

/**
 * Returns the small.avif variant URL given a medium.avif URL.
 * Falls back to original URL if not an AVIF variant.
 */
export const getSmallVariantUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  if (url.endsWith('/medium.avif')) {
    return url.replace(/\/medium\.avif$/, '/small.avif');
  }
  return url;
};

/**
 * Configuration presets for dimensions and AVIF qualities based on image category.
 */
const CATEGORY_PRESETS = {
  AVATAR: {
    // Advocate / User profile photo
    prefix: 'avatar',
    small: { width: 160, height: 160, quality: 55, fit: 'cover' }, // target: ~4-5 KB
    medium: { width: 450, height: 450, quality: 70, fit: 'cover' } // target: ~10-15 KB
  },
  OFFICE: {
    // Advocate office verification photo
    prefix: 'office',
    small: { width: 260, height: 190, quality: 55, fit: 'cover' }, // target: ~5-8 KB
    medium: { width: 700, height: 480, quality: 70, fit: 'cover' } // target: ~20-30 KB
  },
  CONTENT: {
    // Blogs & User Rights banners
    prefix: 'content',
    small: { width: 450, height: 260, quality: 60, fit: 'cover' }, // target: ~12-15 KB
    medium: { width: 950, height: 540, quality: 75, fit: 'cover' } // target: ~25-30 KB
  }
};

/**
 * Generates a unique, collision-resistant image ID.
 */
export const generateImageId = (prefix = 'img') => {
  const timestamp = Date.now();
  const randomStr = crypto.randomBytes(4).toString('hex');
  return `img_${prefix}_${timestamp}_${randomStr}`;
};

/**
 * Processes an input image buffer, converts it to two AVIF variants (small & medium),
 * and stores them in uploads/images/<imageId>/.
 *
 * @param {object} params
 * @param {Buffer} params.buffer - Raw image file buffer from Multer
 * @param {'AVATAR'|'OFFICE'|'CONTENT'} [params.category='AVATAR'] - Image category preset
 * @param {string} [params.customId] - Optional existing ID for overwrite/update
 * @param {object} [params.req] - Express request object for URL building
 * @returns {Promise<{ imageId: string, publicId: string, url: string, smallUrl: string, mediumUrl: string, relativeUrl: string, relativeSmallUrl: string, relativeMediumUrl: string }>}
 */
export const processAndSaveImage = async ({
  buffer,
  category = 'AVATAR',
  customId = null,
  req = null
}) => {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Valid image file buffer is required for processing.');
  }

  const preset = CATEGORY_PRESETS[category] || CATEGORY_PRESETS.AVATAR;
  const imageId = customId && typeof customId === 'string' && customId.startsWith('img_')
    ? customId
    : generateImageId(preset.prefix);

  const folderPath = path.join(IMAGES_DIR, imageId);
  if (!fs.existsSync(folderPath)) {
    await fs.promises.mkdir(folderPath, { recursive: true });
  }

  const smallFilePath = path.join(folderPath, 'small.avif');
  const mediumFilePath = path.join(folderPath, 'medium.avif');

  // Process small variant
  await sharp(buffer)
    .rotate() // Auto-orient based on EXIF
    .resize(preset.small.width, preset.small.height, {
      fit: preset.small.fit,
      withoutEnlargement: false
    })
    .avif({ quality: preset.small.quality, effort: 4 })
    .toFile(smallFilePath);

  // Process medium variant
  await sharp(buffer)
    .rotate()
    .resize(preset.medium.width, preset.medium.height, {
      fit: preset.medium.fit,
      withoutEnlargement: true
    })
    .avif({ quality: preset.medium.quality, effort: 4 })
    .toFile(mediumFilePath);

  const baseUrl = getBaseUrl(req);
  const relativeSmall = `/uploads/images/${imageId}/small.avif`;
  const relativeMedium = `/uploads/images/${imageId}/medium.avif`;

  return {
    imageId,
    publicId: imageId, // Drop-in compatible with existing database column
    url: `${baseUrl}${relativeMedium}`,
    smallUrl: `${baseUrl}${relativeSmall}`,
    mediumUrl: `${baseUrl}${relativeMedium}`,
    relativeUrl: relativeMedium,
    relativeSmallUrl: relativeSmall,
    relativeMediumUrl: relativeMedium
  };
};

/**
 * Safely deletes the image folder uploads/images/<imageId>/ and all variants.
 * If publicId is from legacy Cloudinary (e.g. contains '/'), it skips without crashing.
 *
 * @param {string} imageId - Unique local image ID or legacy publicId
 */
export const deleteImageFolder = async (imageId) => {
  if (!imageId || typeof imageId !== 'string') return;

  const trimmed = imageId.trim();

  // If it's a legacy Cloudinary public ID, cleanly remove from Cloudinary
  if (trimmed.includes('/') || !trimmed.startsWith('img_')) {
    try {
      await deleteFromCloudinary(trimmed).catch(() => {});
    } catch {}
    return;
  }

  // Sanitize path against directory traversal
  const safeId = path.basename(trimmed);
  if (!safeId || safeId.includes('..') || safeId.includes('/') || safeId.includes('\\')) {
    return;
  }

  const targetPath = path.join(IMAGES_DIR, safeId);

  try {
    if (fs.existsSync(targetPath)) {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`[ImageStorage] Failed to delete image directory ${targetPath}:`, error.message);
  }
};

export default {
  processAndSaveImage,
  deleteImageFolder,
  resolveImageUrl,
  getBaseUrl
};
