import {
  formatId,
  validateTemplate,
  getBookingIdFormat,
  getHelpReferenceFormat,
  getTimezoneDateParts
} from '../src/utils/idFormat.js';

console.log('====================================================');
console.log('   Verification 1: Valid Templates (5 IDs each)    ');
console.log('====================================================\n');

const validTemplates = [
  'VSB-{YYYY}{MONTH_LETTER}{RAND6}',
  'VKLS-BKC-{YYYY}-{RAND6}',
  'HLP-{YY}{MM}-{RAND5}'
];

for (const tmpl of validTemplates) {
  const validation = validateTemplate(tmpl);
  console.log(`Template: "${tmpl}" (valid: ${validation.isValid}, maxLen: ${validation.maxExpandedLength})`);
  for (let i = 1; i <= 5; i++) {
    console.log(`  #${i}: ${formatId(tmpl)}`);
  }
  console.log('');
}

console.log('====================================================');
console.log('   Verification 2: Invalid Templates & Fallback     ');
console.log('====================================================\n');

const invalidTemplates = [
  'VSB-{YYYY}', // no random
  '{RAND2}',     // random length < 4
  'VSB_{FOO}'    // invalid token and underscore
];

for (const tmpl of invalidTemplates) {
  const validation = validateTemplate(tmpl);
  console.log(`Testing invalid template: "${tmpl}"`);
  console.log(`  Validation result: isValid = ${validation.isValid}, error = "${validation.error}"`);

  // Test fallback using environment override simulation
  process.env.BOOKING_ID_FORMAT = tmpl;
  const resolved = getBookingIdFormat();
  console.log(`  Resolved format (fallback): "${resolved}"`);
  console.log(`  Generated with fallback: ${formatId(resolved)}\n`);
}
delete process.env.BOOKING_ID_FORMAT;

console.log('====================================================');
console.log('   Verification 3: Timezone Boundary Test (IST)     ');
console.log('====================================================\n');

// 2026-01-31T19:00:00Z is 2026-02-01 00:30:00 in Asia/Kolkata (IST)
const testDate = new Date('2026-01-31T19:00:00Z');
const parts = getTimezoneDateParts(testDate, 'Asia/Kolkata');
const istId = formatId('VSB-{YYYY}{MONTH_LETTER}{RAND6}', { date: testDate, timeZone: 'Asia/Kolkata' });

console.log(`Input Date (UTC):  ${testDate.toISOString()}`);
console.log(`Timezone:          Asia/Kolkata (IST)`);
console.log(`Extracted Date:    ${parts.yearStr}-${parts.mmStr}-${parts.ddStr}`);
console.log(`Month Letter:      ${parts.monthLetter} (Expected: B for February)`);
console.log(`Generated ID:      ${istId}`);

if (parts.monthLetter === 'B') {
  console.log(' SUCCESS: Timezone boundary test passed (Month letter is "B")!\n');
} else {
  console.error(` FAILED: Expected month letter "B", got "${parts.monthLetter}"\n`);
  process.exit(1);
}

console.log('====================================================');
console.log('   All verification tests completed successfully!   ');
console.log('====================================================');
