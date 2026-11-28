import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { otpEmailTemplate } from '../src/templates/otpEmail.template.js';
import {
  bookingConfirmedUserTemplate,
  newAppointmentAdvocateTemplate,
  consultancyBookedUserTemplate
} from '../src/templates/bookingEmail.template.js';
import {
  profileUnderReviewTemplate,
  advocateTestResponseSheetTemplate
} from '../src/templates/advocateAccountEmail.template.js';

const outputDir = path.resolve(process.cwd(), 'tmp/email-previews');
fs.mkdirSync(outputDir, { recursive: true });

// 1. Dummy OTP Samples
const otpRegistration = otpEmailTemplate({
  otp: '482913',
  expiryMinutes: 5,
  recipientName: 'Rahul',
  purpose: 'REGISTRATION'
});

const otpLogin = otpEmailTemplate({
  otp: '739104',
  expiryMinutes: 5,
  recipientName: 'Priya',
  purpose: 'LOGIN'
});

const otpReset = otpEmailTemplate({
  otp: '519280',
  expiryMinutes: 10,
  recipientName: 'Adv. Priya Sharma',
  purpose: 'PASSWORD_RESET'
});

// 2. Dummy Advocate Booking Data
const dummyBooking = {
  id: 'b8918239-1122-4433-8899-aabbccddeeff',
  bookingId: 'VLB-2026K7Q4M2X',
  userId: 'user-uuid-1234',
  advocateId: 'adv-uuid-5678',
  mode: 'VIDEO_CALL',
  startAt: new Date('2026-11-07T10:45:00.000Z'), // 4:15 PM IST
  endAt: new Date('2026-11-07T11:00:00.000Z'),   // 4:30 PM IST
  durationMinutes: 15,
  feePaise: 51000,
  gstPercent: 18,
  gstPaise: 9180,
  platformFeePaise: 2500,
  totalPaise: 62680,
  userName: 'Rahul Verma',
  userPhone: '+91 9876543210',
  userEmail: 'client@example.com',
  advocateName: 'Adv. Priya Sharma',
  advocate: {
    officeAddress: 'Chamber 402, High Court Complex, New Delhi 110001',
    officeLatitude: 28.6139,
    officeLongitude: 77.2090
  }
};

const dummyPayment = {
  id: 'pay-uuid-9999',
  attempts: [
    {
      id: 'att-1',
      status: 'CAPTURED',
      razorpayPaymentId: 'pay_P1A8X7Y6Z5Q4M3'
    }
  ]
};

const bookingUser = bookingConfirmedUserTemplate({
  booking: dummyBooking,
  payment: dummyPayment
});

const bookingAdvocate = newAppointmentAdvocateTemplate({
  booking: dummyBooking
});

// 3. Dummy Consultancy Data (Demo A)
const dummyConsultancy = {
  id: 'c1234567-89ab-cdef-0123-456789abcdef',
  bookingId: 'VSB-2026K4H7Q2M',
  callType: 'VIDEO_CALL',
  duration: 30,
  phoneNumber: '+91 9876543210',
  email: 'client@example.com',
  createdAt: new Date('2026-11-03T09:15:00.000Z'),
  user: {
    fullName: 'Rahul Verma',
    email: 'client@example.com',
    phone: '+91 9876543210'
  }
};

const dummyConsultancyPayment = {
  id: 'pay-uuid-8888',
  amount: 89900,
  paidAt: new Date('2026-11-03T09:15:00.000Z'),
  refundEligibleAt: new Date('2026-11-12T00:00:00.000Z'),
  attempts: [
    {
      id: 'att-cons-1',
      status: 'CAPTURED',
      razorpayPaymentId: 'pay_P1A8X7Y6Z5Q4M3'
    }
  ]
};

const consultancyUser = consultancyBookedUserTemplate({
  consultancy: dummyConsultancy,
  payment: dummyConsultancyPayment,
  userName: 'Rahul Verma'
});

// 4. Dummy Advocate Profile Submission Data
const dummyAdvocateSubmission = {
  fullName: 'Adv. Priya Sharma',
  barCouncilId: 'D/1234/2018',
  email: 'advocate@example.com',
  phone: '+919876543221'
};

const profileUnderReview = profileUnderReviewTemplate({
  advocate: dummyAdvocateSubmission,
  submittedAt: new Date('2026-11-04T11:10:00.000Z') // 4:40 PM IST
});

// 5. Dummy Test Response Sheet Data (20 Questions Snapshot)
const dummyTestQuestions = [
  { questionId: 'q-1', question: 'Under which Article can a person directly approach the Supreme Court for enforcement of Fundamental Rights?', options: ['Article 226', 'Article 32', 'Article 136', 'Article 142'], correctIndex: 1 },
  { questionId: 'q-2', question: 'Condonation of delay on showing sufficient cause is provided in which Section of the Limitation Act, 1963?', options: ['Section 3', 'Section 4', 'Section 5', 'Section 6'], correctIndex: 2 },
  { questionId: 'q-3', question: 'Mutual consent divorce is provided in which Section of the Hindu Marriage Act, 1955?', options: ['Section 13', 'Section 13A', 'Section 13B', 'Section 14'], correctIndex: 2 },
  { questionId: 'q-4', question: 'Which Article of the Constitution of India guarantees the right to life and personal liberty?', options: ['Article 19', 'Article 20', 'Article 21', 'Article 22'], correctIndex: 2 },
  { questionId: 'q-5', question: 'Dishonour of a cheque for insufficiency of funds is an offence under which Section of the NI Act, 1881?', options: ['Section 137', 'Section 138', 'Section 139', 'Section 140'], correctIndex: 1 },
  { questionId: 'q-6', question: 'What is the limitation period for filing a suit for recovery of money from the date the cause of action arises?', options: ['1 year', '2 years', '3 years', '5 years'], correctIndex: 2 },
  { questionId: 'q-7', question: 'Under CPC, an application for temporary injunction is filed under which Order?', options: ['Order 37', 'Order 38', 'Order 39', 'Order 40'], correctIndex: 2 },
  { questionId: 'q-8', question: 'Under Section 438 of the Code of Criminal Procedure, 1973, direction for grant of bail may be issued by:', options: ['High Court or Court of Session', 'Chief Judicial Magistrate', 'Judicial Magistrate First Class', 'Any Magistrate'], correctIndex: 0 },
  { questionId: 'q-9', question: 'The Indian Evidence Act, 1872 defines "Admissions" under which Section?', options: ['Section 17', 'Section 24', 'Section 32', 'Section 45'], correctIndex: 0 },
  { questionId: 'q-10', question: 'A contract without consideration is void under which Section of the Indian Contract Act, 1872?', options: ['Section 23', 'Section 24', 'Section 25', 'Section 26'], correctIndex: 2 },
  { questionId: 'q-11', question: 'Doctrine of Res Judicata is incorporated in which Section of the Code of Civil Procedure, 1908?', options: ['Section 9', 'Section 10', 'Section 11', 'Section 12'], correctIndex: 2 },
  { questionId: 'q-12', question: 'Dying declaration is admissible in evidence under which Section of the Indian Evidence Act, 1872?', options: ['Section 27', 'Section 32(1)', 'Section 45', 'Section 114A'], correctIndex: 1 },
  { questionId: 'q-13', question: 'Right to private defence of body extending to causing death is dealt with under which Section of IPC?', options: ['Section 99', 'Section 100', 'Section 103', 'Section 106'], correctIndex: 1 },
  { questionId: 'q-14', question: 'The doctrine of Frustration of contract is covered under which Section of the Indian Contract Act?', options: ['Section 56', 'Section 65', 'Section 73', 'Section 74'], correctIndex: 0 },
  { questionId: 'q-15', question: 'Under the Hindu Succession Act, 1956, daughter is given equal coparcenary rights by amendment in which year?', options: ['2000', '2005', '2010', '2015'], correctIndex: 1 },
  { questionId: 'q-16', question: 'FIR is registered under which Section of the Code of Criminal Procedure, 1973?', options: ['Section 154', 'Section 156', 'Section 161', 'Section 173'], correctIndex: 0 },
  { questionId: 'q-17', question: 'Specific performance of a contract is granted under which Act?', options: ['Transfer of Property Act, 1882', 'Specific Relief Act, 1963', 'Sale of Goods Act, 1930', 'Indian Contract Act, 1872'], correctIndex: 1 },
  { questionId: 'q-18', question: 'Under Arbitration and Conciliation Act, 1996, challenge to an arbitral award is filed under Section:', options: ['Section 9', 'Section 11', 'Section 34', 'Section 37'], correctIndex: 2 },
  { questionId: 'q-19', question: 'Under Consumer Protection Act, 2019, District Commission can entertain complaints where value does not exceed:', options: ['50 Lakhs', '1 Crore', '2 Crores', '10 Crores'], correctIndex: 0 },
  { questionId: 'q-20', question: 'Transfer of Property Act, 1882 defines "Sale" in which Section?', options: ['Section 52', 'Section 54', 'Section 58', 'Section 105'], correctIndex: 1 }
];

const passAnswers = [
  { index: 0, selected: 'A' }, // Wrong: selected Article 226, correct is Article 32
  { index: 1, selected: 'A' }, // Wrong: selected Section 3, correct is Section 5
  { index: 2, selected: null }, // Not answered
  { index: 3, selected: 'C' }, // Correct: Article 21
  { index: 4, selected: 'B' }, // Correct: Section 138
  { index: 5, selected: 'A' }, // Wrong: selected 1 year, correct is 3 years
  { index: 6, selected: 'C' }, // Correct: Order 39
  { index: 7, selected: 'A' }, // Correct: High Court or Court of Session
  { index: 8, selected: 'A' }, // Correct: Section 17
  { index: 9, selected: 'C' }, // Correct: Section 25
  { index: 10, selected: 'C' }, // Correct: Section 11
  { index: 11, selected: 'B' }, // Correct: Section 32(1)
  { index: 12, selected: 'B' }, // Correct: Section 100
  { index: 13, selected: 'A' }, // Correct: Section 56
  { index: 14, selected: 'B' }, // Correct: 2005
  { index: 15, selected: 'A' }, // Correct: Section 154
  { index: 16, selected: 'B' }, // Correct: Specific Relief Act, 1963
  { index: 17, selected: 'C' }, // Correct: Section 34
  { index: 18, selected: 'A' }, // Correct: 50 Lakhs
  { index: 19, selected: 'B' }  // Correct: Section 54
];

const testSheetPass = advocateTestResponseSheetTemplate({
  attempt: {
    id: 'att-pass-uuid',
    advocateId: 'adv-uuid-5678',
    questions: dummyTestQuestions,
    answers: passAnswers,
    startedAt: new Date('2026-11-28T05:10:00.000Z'), // 10:40 AM IST
    submittedAt: new Date('2026-11-28T05:24:32.000Z'), // 10:54:32 AM IST (14 min 32 sec)
    autoSubmitted: false,
    totalQuestions: 20,
    correctCount: 16,
    wrongCount: 4,
    passed: true
  },
  advocate: dummyAdvocateSubmission,
  attemptNumber: 2,
  durationMinutes: 20
});

const failAnswers = [
  { index: 0, selected: 'A' }, // Wrong
  { index: 1, selected: 'A' }, // Wrong
  { index: 2, selected: null }, // Not answered
  { index: 3, selected: 'A' }, // Wrong
  { index: 4, selected: null }, // Not answered
  { index: 5, selected: 'A' }, // Wrong
  { index: 6, selected: 'A' }, // Wrong
  { index: 7, selected: null }, // Not answered
  { index: 8, selected: 'A' }, // Correct
  { index: 9, selected: 'C' }, // Correct
  { index: 10, selected: 'C' }, // Correct
  { index: 11, selected: 'B' }, // Correct
  { index: 12, selected: 'B' }, // Correct
  { index: 13, selected: 'A' }, // Correct
  { index: 14, selected: 'B' }, // Correct
  { index: 15, selected: 'A' }, // Correct
  { index: 16, selected: 'B' }, // Correct
  { index: 17, selected: 'C' }, // Correct
  { index: 18, selected: 'A' }, // Correct
  { index: 19, selected: 'B' }  // Correct
];

const testSheetFail = advocateTestResponseSheetTemplate({
  attempt: {
    id: 'att-fail-uuid',
    advocateId: 'adv-uuid-5678',
    questions: dummyTestQuestions,
    answers: failAnswers,
    startedAt: new Date('2026-11-28T05:30:00.000Z'), // 11:00 AM IST
    submittedAt: new Date('2026-11-28T05:50:00.000Z'), // 11:20 AM IST (20 min 0 sec)
    autoSubmitted: true,
    totalQuestions: 20,
    correctCount: 12,
    wrongCount: 8,
    passed: false
  },
  advocate: dummyAdvocateSubmission,
  attemptNumber: 1,
  durationMinutes: 20
});

// Write all preview files
const previews = [
  { filename: 'otp-registration.html', content: otpRegistration.html },
  { filename: 'otp-login.html', content: otpLogin.html },
  { filename: 'otp-reset.html', content: otpReset.html },
  { filename: 'booking-user.html', content: bookingUser.html },
  { filename: 'booking-advocate.html', content: bookingAdvocate.html },
  { filename: 'consultancy-user.html', content: consultancyUser.html },
  { filename: 'profile-under-review.html', content: profileUnderReview.html },
  { filename: 'test-sheet-pass.html', content: testSheetPass.html },
  { filename: 'test-sheet-fail.html', content: testSheetFail.html }
];

console.log('Generating branded email preview HTML files...\n');
for (const p of previews) {
  const filePath = path.join(outputDir, p.filename);
  fs.writeFileSync(filePath, p.content, 'utf8');
  console.log(`✓ Created: ${filePath}`);
}

console.log(`\nAll ${previews.length} email previews written to ${outputDir}/`);

