import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { otpEmailTemplate } from '../src/templates/otpEmail.template.js';
import {
  bookingConfirmedUserTemplate,
  newAppointmentAdvocateTemplate,
  consultancyBookedUserTemplate
} from '../src/templates/bookingEmail.template.js';

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

// Write all preview files
const previews = [
  { filename: 'otp-registration.html', content: otpRegistration.html },
  { filename: 'otp-login.html', content: otpLogin.html },
  { filename: 'otp-reset.html', content: otpReset.html },
  { filename: 'booking-user.html', content: bookingUser.html },
  { filename: 'booking-advocate.html', content: bookingAdvocate.html },
  { filename: 'consultancy-user.html', content: consultancyUser.html }
];

console.log('Generating branded email preview HTML files...\n');
for (const p of previews) {
  const filePath = path.join(outputDir, p.filename);
  fs.writeFileSync(filePath, p.content, 'utf8');
  console.log(`✓ Created: ${filePath}`);
}

console.log(`\nAll 6 email previews written to ${outputDir}/`);

