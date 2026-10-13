# Act Section Order Fix — Plan & Verification (`proceed.md`)

## 1. Root Cause Analysis

### Code Analysis
In `src/controllers/bearerAct.controller.js`, section retrieval and search queries currently sort by:
```javascript
orderBy: [
  { chapterNo: 'asc' },
  { sectionOrder: 'asc' }
]
```
This assumes that chapter numbers are strictly monotonically increasing across an entire act. In Indian statutes split into **Parts** (or Parts and Chapters), however, **chapter numbering restarts at 1 within each Part**.

### Database Confirmation
Testing the existing queries directly against the dev database reveals the following section order anomalies:

1. **Constitution of India (`c19a63d7-f0f4-46b7-8432-266bbfc8c867`):**
   - Articles 1–78 belong to Chapter 1 (Part V).
   - Under `{ chapterNo: 'asc' }, { sectionOrder: 'asc' }`, after Section 78, the query immediately jumps to:
     - `Section 152` (Part VI, Chapter 1)
     - `Section 238` (Part VII, Chapter 1)
     - `Section 239`, `Section 239AA`, etc.
   - `Section 79` (Part V, Chapter 2) is pushed down until all Chapter 1 sections from all subsequent parts are exhausted.
   - **Under statutory order (`sectionOrder: 'asc'`):** Section 78 is followed immediately by Section 79, 80, 81, etc.

2. **Arbitration and Conciliation Act, 1996 (`2be54269-7ad5-4a6c-bf71-057565598e76`):**
   - Current query returns: `Section 1` to `Section 6` (Part I, Chapter 1), followed immediately by `Section 43A` through `Section 43-I` (Part IA, Chapter 1).
   - `Section 7` (Part I, Chapter 2) is deferred.
   - **Under statutory order (`sectionOrder: 'asc'`):** Section 6 is followed immediately by Section 7, 8, 8A, 8B, 9, 10, etc.

3. **Insolvency and Bankruptcy Code, 2016 (`0a6607a7-7698-428c-819b-1a6aed86e99a`):**
   - Current query returns: `Section 1` to `Section 5` (Part I, Chapter 1), followed immediately by `Section 78`, `Section 79` (Part III, Chapter 1), and `Section 188` to `Section 195` (Part IV, Chapter 1).
   - `Section 6` (Part II, Chapter 2) is deferred.
   - **Under statutory order (`sectionOrder: 'asc'`):** Section 5 is followed immediately by Section 6, 7, 8, 9, 10, 10A, 11, etc.

---

## 2. Exact Changes Planned

### A. Controller Order Specification (`src/controllers/bearerAct.controller.js`)
Define a reusable ordering constant at the top of `src/controllers/bearerAct.controller.js`:
```javascript
const SECTION_ORDER_BY = [
  { sectionOrder: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' }
];
```
Replace the existing `{ chapterNo: 'asc' }, { sectionOrder: 'asc' }` in all 4 query locations:
1. `getSingleAct` (`GET /api/acts/:id`):
   ```javascript
   sections: {
     orderBy: SECTION_ORDER_BY
   }
   ```
2. `getSectionsByAct` (`GET /api/acts/:id/sections`):
   ```javascript
   prisma.actSection.findMany({
     where: { actId: id },
     skip,
     take: limit,
     orderBy: SECTION_ORDER_BY
   })
   ```
3. `searchGlobalBearerActs` (`GET /api/bearer-acts/search`):
   ```javascript
   prisma.actSection.findMany({
     where: sectionWhere,
     skip: currentSkip,
     take,
     orderBy: SECTION_ORDER_BY,
     include: { ... }
   })
   ```
4. `searchActSections` (`GET /api/acts/:actId/search`):
   ```javascript
   prisma.actSection.findMany({
     where,
     skip,
     take: limit,
     orderBy: SECTION_ORDER_BY
   })
   ```

*Note: A scan of the entire `src/` directory confirmed no other controllers or services query or order `ActSection`. IPC and BNS controllers already sort by `sectionOrder: 'asc'`.*

### B. Backfill Script & NPM Script (`scripts/backfill-act-section-order.js` & `package.json`)
- Add script `scripts/backfill-act-section-order.js` that:
  - Iterates over all `ActSection` records in cursor-based batches of 1,000.
  - Computes `expected = calculateSectionOrder(section)`.
  - Flags mismatches (`Math.abs(row.sectionOrder - expected) > 1e-9`).
  - Reports count of `999999` fallbacks and duplicate section names per act.
  - Supports `--apply` to update rows in `$transaction` batches of 500.
- Add npm script in `package.json`:
  ```json
  "backfill:section-order": "node scripts/backfill-act-section-order.js"
  ```

### C. Documentation Updates (`README.md`)
In `## 4. Public Read APIs` and `## 5. Bearer Acts Search API`:
- Document that sections are always returned in statutory order (`sectionOrder`), e.g. 1, 2, 2A, 3 ... 51, 51A, 52 ... 243, 243A ... 243ZT, 244.
- Explain that `chapterNo` and `chapterName` are informational and restart across Parts; frontend clients should not sort or group by `chapterNo`, but rather render chapter headings dynamically when `chapterName` changes relative to the prior section.
- Document `npm run backfill:section-order` (dry run) and `npm run backfill:section-order -- --apply`.

---

## 3. Backfill Plan & Dev Database Dry Run Results

### Dev Database Dry Run Output
The dry run was executed on the current database with the following output:

```text
=====================================================
   VakeelSetu: Backfill ActSection sectionOrder      
   Mode: DRY RUN (READ ONLY)
=====================================================

Total ActSection records checked: 9778
Total mismatches detected: 0

No sectionOrder mismatches found.

Sections with expected sectionOrder = 999999 (no leading number, placed at end): 0

[WARNING] Duplicate section identifiers detected per act (1 duplicate entries):
  1. [eece6059-bb9d-4db9-a175-ef90bc89b6a2] (THE RECOVERY OF DEBTS AND BANKRUPTCY ACT, 1993) Section: "Section 19A" appears 2 times

Dry run complete. Database is already fully consistent.
```

### Observations
- All 9,778 existing `ActSection` records in the dev database already have accurate `sectionOrder` values matching `calculateSectionOrder(section)`.
- No sections have fallback values of `999999`.
- Act `eece6059-bb9d-4db9-a175-ef90bc89b6a2` has a duplicate "Section 19A". The proposed tie-breaker `{ createdAt: 'asc' }, { id: 'asc' }` guarantees deterministic and stable pagination ordering.
- For production, running `npm run backfill:section-order` will verify if any older production records require updating, and `npm run backfill:section-order -- --apply` will update them in transactions if approved.

---

## 4. Risks & Mitigations

1. **Pagination Boundary Stability:**
   - *Risk:* If multiple sections share the same `sectionOrder` (e.g. duplicate section names like "Section 19A"), paginated queries (`limit`, `skip`) could intermittently duplicate or omit rows across page boundaries if the database sort is non-deterministic.
   - *Mitigation:* We include `{ createdAt: 'asc' }, { id: 'asc' }` as secondary and tertiary tie-breakers. Because `id` is the primary key (UUID), the total order is strictly unique and fully deterministic.

2. **Query Performance:**
   - *Risk:* Sorting by multiple columns.
   - *Mitigation:* `ActSection` already has an index on `sectionOrder` (`@@index([sectionOrder])`) and `actId` (`@@index([actId])`). Queries for a specific act filter by `actId`, which narrows the working set to typically 20–500 rows per act where in-memory sorting is trivial and instantaneous.

3. **API Contract Compatibility:**
   - *Risk:* Breaking frontend assumptions.
   - *Mitigation:* No schema changes, no migrations, no alterations to response payloads or pagination metadata. Only the sort sequence of the sections array changes to the expected statutory order.

4. **IPC / BNS Consistency:**
   - *Risk:* Accidentally changing or regressing IPC or BNS sections.
   - *Mitigation:* IPC and BNS endpoints use distinct controllers (`ipc.controller.js`, `bns.controller.js`) which already sort by `{ sectionOrder: 'asc' }`. No edits are made to those files.

---

## Next Steps
Awaiting your approval before executing the changes in `src/controllers/bearerAct.controller.js`, updating `package.json`, updating `README.md`, and running full end-to-end verification.
