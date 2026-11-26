# Implementation Plan: VPS Local Image Storage with AVIF Dual-Resolution Processing & Cloudinary Migration

## 1. Executive Summary & Objective

Migrate all media storage away from **Cloudinary** to **Hostinger VPS Local NVMe Disk Storage**.
- **Root Storage Location:** `/uploads/images/<image_id>/`
- **Output Format:** Modern **`.avif`** (AV1 Image Format) for superior compression and reduced bandwidth.
- **Dual-Resolution Generation:** For every uploaded image, generate and store **two** distinct `.avif` files:
  1. `small.avif` (Low-bandwidth listing/card/thumbnail view)
  2. `medium.avif` (Detailed profile, article, or verification view)
- **Zero Downtime & Zero Data Loss:** A one-time migration script will pull all existing Cloudinary assets, convert them to `.avif` dual variants, store them locally, and update database records.

---

## 2. Image Processing & Compression Specifications

| Category | Input Formats | Max Upload | Variant | Target Dimensions | Target File Size | Storage Path | Use Case |
|---|---|:---:|---|---|:---:|---|---|
| **Advocate Profile Photo & User Avatar** | `JPEG, JPG, PNG, WEBP` | 5 MB | `small.avif` | ~150x150 px | **4 – 5 KB** | `uploads/images/<id>/small.avif` | Search lists, cards, navbars, booking slots |
| | | | `medium.avif` | ~400x400 px | **10 – 15 KB** | `uploads/images/<id>/medium.avif` | Full advocate profile page, modals |
| **Advocate Office Photo** | `JPEG, JPG, PNG, WEBP` | 5 MB | `small.avif` | ~200x150 px | **5 – 8 KB** | `uploads/images/<id>/small.avif` | Admin verification tables, quick preview |
| | | | `medium.avif` | ~600x400 px | **20 – 30 KB** | `uploads/images/<id>/medium.avif` | Admin review modal, public office view |
| **Admin Blogs & Legal Rights Banners** | `JPEG, JPG, PNG, WEBP` | 5 MB | `small.avif` | ~450x250 px | **12 – 15 KB** | `uploads/images/<id>/small.avif` | Blog feed cards, legal rights grid |
| | | | `medium.avif` | ~900x500 px | **25 – 30 KB** | `uploads/images/<id>/medium.avif` | Full article banner, header visual |

---

## 3. Directory Hierarchy

```text
vakeelsetu_backend/
├── uploads/
│   ├── acts/                         # Existing Bare Act PDFs
│   └── images/                       # New root image directory
│       ├── img_adv_1732620000_a1b2/  # Unique image directory (by nanoid/timestamp)
│       │   ├── small.avif            # ~4-5 KB thumbnail
│       │   └── medium.avif           # ~10-15 KB full view
│       └── img_blog_1732620100_c3d4/
│           ├── small.avif            # ~15 KB card thumbnail
│           └── medium.avif           # ~30 KB article banner
```

---

## 4. Serving Static Images (Express & Nginx)

### A. Backend Express Static Route (`src/server.js`)
Serve `/uploads` with caching and CORS headers:
```javascript
import path from 'path';
import express from 'express';

// Expose /uploads statically
app.use(
  '/uploads',
  express.static(path.resolve(process.cwd(), 'uploads'), {
    maxAge: '30d',
    immutable: true
  })
);
```

### B. Production Hostinger VPS (Nginx Reverse Proxy)
In production, Nginx bypasses Node.js and serves `/uploads/` directly off the NVMe SSD for sub-millisecond response times:
```nginx
location /uploads/ {
    alias /var/www/vakeelsetu_backend/uploads/;
    expires 30d;
    add_header Cache-Control "public, no-transform";
    try_files $uri =404;
}
```

---

## 5. Architecture & Component Changes

### A. New Image Storage Service: `src/services/imageStorage.service.js`
A modular replacement for `src/services/cloudinary.service.js` powered by `sharp`:
1. **`processAndSaveImage({ buffer, category, imageId })`**:
   - `category`: `'AVATAR' | 'OFFICE' | 'CONTENT'`
   - Generates unique `imageId` (e.g. `img_${category.toLowerCase()}_${Date.now()}_${random}`).
   - Creates directory `uploads/images/<imageId>/`.
   - Uses `sharp(buffer)` to generate:
     - `small.avif`: Resizes with `fit: 'cover'`, compresses targeting specified KB range.
     - `medium.avif`: Resizes with `fit: 'inside'` or `'cover'`, compresses targeting specified KB range.
   - Returns structured URLs and local identifiers:
     ```javascript
     {
       imageId: "img_avatar_1732620000_xyz",
       url: "/uploads/images/img_avatar_1732620000_xyz/medium.avif",
       smallUrl: "/uploads/images/img_avatar_1732620000_xyz/small.avif",
       mediumUrl: "/uploads/images/img_avatar_1732620000_xyz/medium.avif"
     }
     ```
2. **`deleteImageFolder(imageId)`**:
   - Deletes `uploads/images/<imageId>/` safely from disk when an asset is replaced or user account is deleted.
   - Ignores if directory does not exist.

### B. Backward Compatibility for Frontend
To ensure mobile apps and web frontends do not break:
- `profilePhotoUrl` / `officePhotoUrl` / `imageUrl` will continue to return a full, valid image URL pointing to `medium.avif` (e.g., `https://api.vakeelsetu.com/uploads/images/<id>/medium.avif`).
- New optional fields `smallPhotoUrl` or `thumbnailUrl` can be provided in API responses for high-performance listing views.
- `publicId` fields (`profilePhotoPublicId`, `officePhotoPublicId`, `imagePublicId`) in the database will now store the local `imageId`.

---

## 6. Controllers & Services to be Updated

1. **`src/services/auth.service.js`**:
   - Advocate registration: replace Cloudinary call with `imageStorageService.processAndSaveImage(file.buffer, 'AVATAR')`.
   - Office photo upload: replace Cloudinary call with `imageStorageService.processAndSaveImage(file.buffer, 'OFFICE')`.
2. **`src/controllers/advocate.auth.controller.js`**:
   - `uploadProfilePhoto`: use new service.
   - `completeProfile`: handle office photo with new service.
3. **`src/controllers/advocate.profile.controller.js`**:
   - Profile photo updates and draft changes: use new service and delete old local folder on replacement.
4. **`src/controllers/blog.controller.js`**:
   - `createBlog` & `updateBlog`: use new service (`'CONTENT'`), delete old folder on update/deletion.
5. **`src/controllers/userRight.controller.js`**:
   - `createUserRight` & `updateUserRight`: use new service (`'CONTENT'`), delete old folder on update/deletion.
6. **`src/services/advocateDeletion.service.js`**:
   - Account deletion job: replace `deleteFromCloudinary` with `deleteImageFolder`.

---

## 7. Migration Script: `scripts/migrateCloudinaryToLocal.js`

A safe, idempotent Node.js script:
1. Connects to database via Prisma.
2. Scans for existing records with Cloudinary URLs in:
   - `Advocate.profilePhotoUrl` & `Advocate.officePhotoUrl`
   - `AdvocateRegistrationSession.profilePhotoUrl` & `officePhotoUrl`
   - `User.photo`
   - `Blog.imageUrl`
   - `UserRight.imageUrl`
3. For each asset:
   - Fetches image buffer over HTTPS from Cloudinary.
   - Passes buffer to `imageStorage.service.js`.
   - Generates `small.avif` and `medium.avif` locally.
   - Updates record in Prisma with the new local path and new local `imageId`.
4. Produces a detailed report:
   - Total scanned
   - Total successfully migrated
   - Failed items (if any) with reasons.

---

## 8. Step-by-Step Implementation Sequence

1. **Phase 1: Dependencies & Base Setup**
   - Install `sharp` dependency in `package.json`.
   - Ensure `uploads/images/` directory is created and `.gitkeep` added.
   - Add `/uploads` static route in `src/server.js`.

2. **Phase 2: Core Image Service Implementation**
   - Create `src/services/imageStorage.service.js` with AVIF dual-variant generation and folder deletion logic.
   - Add unit test verification for dimension, compression, and file size limits (~4-5KB for small, ~10-15KB for medium).

3. **Phase 3: Controller & Service Refactoring**
   - Update Advocate registration & office photo routes.
   - Update Advocate profile photo edit & draft routes.
   - Update Blog and User Right controllers.
   - Update Account Deletion cleanup routine.

4. **Phase 4: Migration Script Creation & Verification**
   - Create `scripts/migrateCloudinaryToLocal.js`.
   - Test script on isolated records.

5. **Phase 5: Validation & Deployment Guide**
   - Test image upload via API endpoints.
   - Document Nginx configuration snippet for Hostinger VPS deployment.

---

## 9. Safety & Rollback Plan

- **Non-destructive:** Cloudinary files are NOT deleted during the migration script run until verified.
- **Rollback:** If any issue occurs, the database backup and Cloudinary assets remain intact; changing the static URL base or reverting the controller calls restores Cloudinary instantly.
