import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateSectionOrder } from '../src/utils/sectionOrder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const part1Path = path.join(__dirname, 'rbi_part1.json');
const part2Path = path.join(__dirname, 'rbi_part2.json');
const part3Path = path.join(__dirname, 'rbi_part3.json');
const destPath = path.join(__dirname, '../prisma/reserve_Bank_of_India_act__1934.json');

const part1 = JSON.parse(fs.readFileSync(part1Path, 'utf8'));
const part2 = JSON.parse(fs.readFileSync(part2Path, 'utf8'));
const part3 = JSON.parse(fs.readFileSync(part3Path, 'utf8'));

const allSections = [...part1, ...part2, ...part3];

console.log(`Part 1 sections: ${part1.length}`);
console.log(`Part 2 sections: ${part2.length}`);
console.log(`Part 3 sections: ${part3.length}`);
console.log(`Total merged sections: ${allSections.length}`);

// Validation
const seenSections = new Set();
const chapters = new Map();

allSections.forEach((s, idx) => {
  if (!s.section) throw new Error(`Missing section name at index ${idx}`);
  if (!s.sectionNo) throw new Error(`Missing sectionNo at index ${idx}`);
  if (s.chapterNo === undefined || s.chapterNo === null) throw new Error(`Missing chapterNo at index ${idx}`);
  if (!s.chapterName) throw new Error(`Missing chapterName at index ${idx}`);
  if (!s.title) throw new Error(`Missing title at index ${idx}`);
  if (s.description === undefined || s.description === null) throw new Error(`Missing description at index ${idx}`);
  if (!s.metaData) throw new Error(`Missing metaData at index ${idx}`);
  if (!s.metaDescription) throw new Error(`Missing metaDescription at index ${idx}`);
  if (!s.metaTitle) throw new Error(`Missing metaTitle at index ${idx}`);

  if (seenSections.has(s.section)) {
    throw new Error(`Duplicate section found: ${s.section}`);
  }
  seenSections.add(s.section);

  const chKey = `${s.chapterNo} - ${s.chapterName}`;
  if (!chapters.has(chKey)) {
    chapters.set(chKey, 0);
  }
  chapters.set(chKey, chapters.get(chKey) + 1);

  // Validate sectionOrder calculation
  const order = calculateSectionOrder(s.sectionNo);
  if (isNaN(order) || order <= 0) {
    throw new Error(`Invalid section order ${order} for sectionNo "${s.sectionNo}"`);
  }
});

console.log(`\nChapters summary (${chapters.size} distinct chapters):`);
for (const [ch, count] of chapters.entries()) {
  console.log(`  ${ch}: ${count} sections`);
}

// Write to destination
fs.writeFileSync(destPath, JSON.stringify(allSections, null, 2), 'utf8');
console.log(`\nSuccessfully written to ${destPath}`);
