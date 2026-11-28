import test, { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  escapeHtml,
  renderDetailRows,
  renderButton,
  renderNote,
  renderEmailLayout,
  getLogoAttachment,
  BRAND,
  COLORS
} from '../src/templates/emailLayout.template.js';
import { otpEmailTemplate } from '../src/templates/otpEmail.template.js';
import {
  bookingConfirmedUserTemplate,
  newAppointmentAdvocateTemplate,
  consultancyBookedUserTemplate,
  formatRupees,
  formatBookingDateTimeIst,
  formatDateTimeIst,
  formatDateOnlyIst,
  getConsultancyCallTypeLabel
} from '../src/templates/bookingEmail.template.js';
import {
  advocateTestResponseSheetTemplate
} from '../src/templates/advocateAccountEmail.template.js';
import {
  helpRequestEmailTemplate,
  maskPhone,
  truncateConcern
} from '../src/templates/helpRequestEmail.template.js';
import {
  sendEmailOtp,
  sendBrandedMail,
  sendAdvocateBookingConfirmationEmails,
  sendConsultancyConfirmationEmail,
  sendTestResponseSheetEmail,
  parseAdvocateTestSheetBcc,
  resetBccWarningState,
  sendHelpRequestAcknowledgementEmail,
  parseHelpRequestBcc,
  resetHelpRequestBccWarningState,
  setTransporter,
  maskEmail
} from '../src/services/email.service.js';
import { createRequest } from '../src/controllers/help.controller.js';
import { reconcilePaymentsCron } from '../src/controllers/paymentCron.controller.js';
import prisma from '../src/lib/prisma.js';

describe('1. Email Layout & Helpers', () => {
  it('escapeHtml escapes dangerous HTML characters and handles nil values', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.equal(escapeHtml("Tom's & Jerry's"), 'Tom&#39;s &amp; Jerry&#39;s');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('renderDetailRows skips rows where value is empty, null, or undefined', () => {
    const details = [
      { label: 'Advocate', value: 'Adv. Priya' },
      { label: 'Empty Field', value: '' },
      { label: 'Null Field', value: null },
      { label: 'Whitespace Field', value: '   ' },
      { label: 'Total', value: '₹500.00', isHighlighted: true }
    ];
    const html = renderDetailRows(details);
    assert.ok(html.includes('Adv. Priya'));
    assert.ok(html.includes('₹500.00'));
    assert.ok(!html.includes('Empty Field'));
    assert.ok(!html.includes('Null Field'));
    assert.ok(!html.includes('Whitespace Field'));
  });

  it('renderButton returns empty string if label or url is missing', () => {
    assert.equal(renderButton({ label: '', url: 'http://example.com' }), '');
    assert.equal(renderButton({ label: 'Click', url: '' }), '');
    assert.equal(renderButton({}), '');

    const btnHtml = renderButton({ label: 'View Bookings', url: 'https://vakeelsetu.com/my-bookings' });
    assert.ok(btnHtml.includes('View Bookings'));
    assert.ok(btnHtml.includes('https://vakeelsetu.com/my-bookings'));
  });

  it('renderNote returns empty string if text is empty', () => {
    assert.equal(renderNote(''), '');
    assert.equal(renderNote('   '), '');
    const noteHtml = renderNote('Important note here');
    assert.ok(noteHtml.includes('Important note here'));
    assert.ok(noteHtml.includes(COLORS.accent));
  });

  it('empty BRAND values hide sections and never output placeholder strings', () => {
    const prevEnv = { ...process.env };
    delete process.env.BRAND_WEBSITE_URL;
    delete process.env.BRAND_TERMS_URL;
    delete process.env.BRAND_CONTACT_URL;
    delete process.env.BRAND_SUPPORT_PHONE;
    delete process.env.BRAND_SUPPORT_EMAIL;
    delete process.env.BRAND_ADDRESS;

    const { html } = renderEmailLayout({
      title: 'Test Email',
      preheader: 'Testing preheader',
      bodyHtml: '<p>Content</p>',
      showSupport: true
    });

    assert.ok(!html.includes('[BRAND_ADDRESS'));
    assert.ok(!html.includes('[BRAND_SUPPORT'));
    assert.ok(!html.includes('undefined'));
    assert.ok(!html.includes('null'));
    assert.ok(!html.includes('<!-- SUPPORT -->'));

    process.env = prevEnv;
  });

  it('populated BRAND values show sections cleanly', () => {
    process.env.BRAND_WEBSITE_URL = 'https://example.com';
    process.env.BRAND_TERMS_URL = 'https://example.com/terms';
    process.env.BRAND_CONTACT_URL = 'https://example.com/contact';
    process.env.BRAND_SUPPORT_PHONE = '+91 99999 88888';
    process.env.BRAND_SUPPORT_EMAIL = 'support@example.com';
    process.env.BRAND_ADDRESS = '123 Legal Complex, Connaught Place, New Delhi';

    const { html } = renderEmailLayout({
      title: 'Test Email',
      preheader: 'Testing preheader',
      bodyHtml: '<p>Content</p>',
      showSupport: true
    });

    assert.ok(html.includes('example.com'));
    assert.ok(html.includes('https://example.com/terms'));
    assert.ok(html.includes('https://example.com/contact'));
    assert.ok(html.includes('+91 99999 88888'));
    assert.ok(html.includes('support@example.com'));
    assert.ok(html.includes('123 Legal Complex'));
    assert.ok(html.includes('<!-- SUPPORT -->'));

    // Clean up
    delete process.env.BRAND_WEBSITE_URL;
    delete process.env.BRAND_TERMS_URL;
    delete process.env.BRAND_CONTACT_URL;
    delete process.env.BRAND_SUPPORT_PHONE;
    delete process.env.BRAND_SUPPORT_EMAIL;
    delete process.env.BRAND_ADDRESS;
  });

  it('validateUrl only accepts http:// and https://', () => {
    assert.equal(BRAND.websiteUrl, ''); // empty when not set
    process.env.BRAND_WEBSITE_URL = 'javascript:alert(1)';
    assert.equal(BRAND.websiteUrl, ''); // suppressed

    process.env.BRAND_WEBSITE_URL = 'https://vakeelsetu.com';
    assert.equal(BRAND.websiteUrl, 'https://vakeelsetu.com');
    delete process.env.BRAND_WEBSITE_URL;
  });

  it('validateEmail only accepts valid email format', () => {
    process.env.BRAND_SUPPORT_EMAIL = 'not-an-email';
    assert.equal(BRAND.supportEmail, '');

    process.env.BRAND_SUPPORT_EMAIL = 'help@vakeelsetu.com';
    assert.equal(BRAND.supportEmail, 'help@vakeelsetu.com');
    delete process.env.BRAND_SUPPORT_EMAIL;
  });

  it('fallback when logo.png is missing vs present', () => {
    const logoPath = path.resolve(process.cwd(), 'src/assets/email/logo.png');
    const originalExists = fs.existsSync(logoPath);

    if (originalExists) {
      const att = getLogoAttachment();
      assert.ok(att !== null);
      assert.equal(att.cid, 'vakeelsetu-logo');
    } else {
      const att = getLogoAttachment();
      assert.equal(att, null);
      const { html, attachments } = renderEmailLayout({ bodyHtml: '<p>Hi</p>' });
      assert.equal(attachments.length, 0);
      assert.ok(html.includes('&#9878;')); // unicode scales of justice fallback
    }
  });

  it('maskEmail correctly obfuscates email address', () => {
    assert.equal(maskEmail('rahul.verma@gmail.com'), 'ra***@gmail.com');
    assert.equal(maskEmail('a@b.com'), 'a***@b.com');
    assert.equal(maskEmail(''), '***');
  });
});

describe('2. OTP Email Template', () => {
  it('generates correct subject and content per purpose', () => {
    const reg = otpEmailTemplate({ otp: '123456', purpose: 'REGISTRATION', recipientName: '<script>Hack</script>' });
    assert.equal(reg.subject, 'Your VakeelSetu verification code');
    assert.ok(!reg.html.includes('<script>'));
    assert.ok(reg.html.includes('&lt;script&gt;Hack&lt;/script&gt;'));
    assert.ok(reg.html.includes('123456'));

    const login = otpEmailTemplate({ otp: '654321', purpose: 'LOGIN' });
    assert.equal(login.subject, 'Your VakeelSetu login code');
    assert.ok(login.html.includes('Log in to VakeelSetu'));

    const reset = otpEmailTemplate({ otp: '998877', purpose: 'PASSWORD_RESET', expiryMinutes: 10 });
    assert.equal(reset.subject, 'Reset your VakeelSetu password');
    assert.ok(reset.html.includes('10 minutes'));
  });
});

describe('3. Booking Email Templates', () => {
  const dummyBooking = {
    bookingId: 'VLB-2026K7Q4M2X',
    userName: 'Rahul Verma',
    userPhone: '+91 9876543210',
    userEmail: 'client@example.com',
    advocateName: 'Adv. Priya Sharma',
    mode: 'VIDEO_CALL',
    durationMinutes: 15,
    feePaise: 51000,
    gstPercent: 18,
    gstPaise: 9180,
    platformFeePaise: 2500,
    totalPaise: 62680,
    startAt: new Date('2026-11-07T10:45:00.000Z'),
    endAt: new Date('2026-11-07T11:00:00.000Z'),
    advocate: {
      officeAddress: 'Chamber 402, High Court',
      officeLatitude: 28.6139,
      officeLongitude: 77.2090
    }
  };

  it('formats paise into Indian Rupee format without recalculating', () => {
    assert.equal(formatRupees(51000), '₹510.00');
    assert.equal(formatRupees(9180), '₹91.80');
    assert.equal(formatRupees(62680), '₹626.80');
    assert.equal(formatRupees(150000), '₹1,500.00');
  });

  it('formats booking dates and times in Asia/Kolkata timezone', () => {
    const { dateStr, timeRangeStr } = formatBookingDateTimeIst(
      '2026-11-07T10:45:00.000Z',
      '2026-11-07T11:00:00.000Z'
    );
    assert.ok(dateStr.includes('7 Nov 2026'));
    assert.ok(timeRangeStr.includes('4:15'));
    assert.ok(timeRangeStr.includes('4:30'));
  });

  it('renders user booking confirmation with stored snapshot and payment ID', () => {
    const { subject, html } = bookingConfirmedUserTemplate({
      booking: dummyBooking,
      payment: { id: 'p-1', attempts: [{ status: 'CAPTURED', razorpayPaymentId: 'pay_TEST123' }] }
    });

    assert.ok(subject.includes('Booking confirmed'));
    assert.ok(subject.includes('Adv. Priya Sharma'));
    assert.ok(html.includes('VLB-2026K7Q4M2X'));
    assert.ok(html.includes('₹626.80'));
    assert.ok(html.includes('pay_TEST123'));
    assert.ok(html.includes('View My Bookings'));
  });

  it('renders advocate appointment email with net consultation fee only', () => {
    const { subject, html } = newAppointmentAdvocateTemplate({
      booking: dummyBooking
    });

    assert.ok(subject.includes('New appointment'));
    assert.ok(html.includes('Rahul Verma'));
    assert.ok(html.includes('client@example.com'));
    assert.ok(html.includes('₹510.00'));
    assert.ok(!html.includes('Platform fee')); // net fee only
    assert.ok(html.includes('Open My Appointments'));
  });

  it('renders consultancy confirmation user email with package, booking ID and details', () => {
    const dummyConsultancy = {
      id: 'c1234567-89ab-cdef-0123-456789abcdef',
      bookingId: 'VSB-2026K4H7Q2M',
      callType: 'VIDEO_CALL',
      duration: 30,
      phoneNumber: '+91 9876543210',
      email: 'client@example.com',
      createdAt: new Date('2026-11-03T09:15:00.000Z'),
      user: { fullName: 'Rahul Verma', email: 'client@example.com' }
    };
    const dummyPayment = {
      id: 'pay-uuid-8888',
      amount: 89900,
      paidAt: new Date('2026-11-03T09:15:00.000Z'),
      refundEligibleAt: new Date('2026-11-12T00:00:00.000Z'),
      attempts: [{ razorpayPaymentId: 'pay_P1A8X7Y6Z5Q4M3' }]
    };

    const { subject, html, text } = consultancyBookedUserTemplate({
      consultancy: dummyConsultancy,
      payment: dummyPayment
    });

    assert.equal(subject, 'Consultancy booked – Video Call • 30 min');
    assert.ok(html.includes('Consultancy booked'));
    assert.ok(html.includes('Your expert consultation is booked'));
    assert.ok(html.includes('Rahul Verma'));
    assert.ok(html.includes('VSB-2026K4H7Q2M'));
    assert.ok(html.includes('Video Call'));
    assert.ok(html.includes('30 min'));
    assert.ok(html.includes('+91 9876543210'));
    assert.ok(html.includes('client@example.com'));
    assert.ok(html.includes('pay_P1A8X7Y6Z5Q4M3'));
    assert.ok(html.includes('₹899.00'));
    assert.ok(html.includes('View My Bookings'));
    assert.ok(!html.includes('eligible for a refund'));
    assert.ok(!html.includes('What happens next')); // Demo A does NOT have "what happens next"
  });

  it('never renders refund eligibility note even if payment.refundEligibleAt is set', () => {
    const dummyConsultancy = {
      bookingId: 'VSB-2026K4H7Q2M',
      callType: 'CALL',
      duration: 15,
      user: { fullName: 'Sunil' }
    };
    const dummyPayment = {
      amount: 49900,
      refundEligibleAt: new Date('2026-11-12T00:00:00.000Z')
    };

    const { html, text } = consultancyBookedUserTemplate({
      consultancy: dummyConsultancy,
      payment: dummyPayment
    });

    assert.ok(!html.includes('eligible for a refund'));
    assert.ok(!text.includes('eligible for a refund'));
  });

  it('escapes dynamic user inputs to prevent injection in consultancy email', () => {
    const maliciousConsultancy = {
      bookingId: '<script>alert("xss")</script>',
      callType: 'CALL',
      duration: 15,
      phoneNumber: '"><img src=x onerror=alert(1)>',
      email: 'hacker@example.com',
      user: { fullName: '<b>Hacker</b>' }
    };
    const payment = { amount: 10000 };

    const { html } = consultancyBookedUserTemplate({
      consultancy: maliciousConsultancy,
      payment
    });

    assert.ok(!html.includes('<script>alert("xss")</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
    assert.ok(!html.includes('<b>Hacker</b>'));
    assert.ok(html.includes('&lt;b&gt;Hacker&lt;/b&gt;'));
  });
});

describe('4. Email Service (Stubbed Transporter)', () => {
  let sentMails = [];

  beforeEach(() => {
    sentMails = [];
    setTransporter({
      sendMail: async (options) => {
        sentMails.push(options);
        return { messageId: 'mock-msg-' + Date.now() };
      }
    });
  });

  it('sendEmailOtp backward compatibility works with 2 arguments', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';
    process.env.NODE_ENV = 'test';

    const result = await sendEmailOtp('recipient@example.com', '123456');
    assert.equal(result, true);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'recipient@example.com');
    assert.ok(sentMails[0].html.includes('123456'));
  });

  it('production with placeholder credentials throws error and never sends email', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevUser = process.env.EMAIL_USER;

    process.env.NODE_ENV = 'production';
    process.env.EMAIL_USER = 'your-email@gmail.com';

    await assert.rejects(async () => {
      await sendBrandedMail({
        to: 'test@example.com',
        subject: 'Sub',
        html: '<p>Hi</p>'
      });
    }, /Email sending failed/);

    process.env.NODE_ENV = prevEnv;
    process.env.EMAIL_USER = prevUser;
  });

  it('sendAdvocateBookingConfirmationEmails claims atomically and skips already-sent', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';

    // Mock Prisma findUnique and updateMany
    const originalFindUnique = prisma.advocateBooking.findUnique;
    const originalUpdateMany = prisma.advocateBooking.updateMany;
    const originalUpdate = prisma.advocateBooking.update;

    const mockBooking = {
      id: 'mock-booking-id-1',
      bookingId: 'VLB-2026M1',
      userName: 'Client Test',
      userEmail: 'client@test.com',
      userPhone: '+91 9999999999',
      advocateName: 'Adv. Test',
      mode: 'VOICE_CALL',
      durationMinutes: 15,
      feePaise: 45000,
      gstPercent: 18,
      gstPaise: 8100,
      platformFeePaise: 2500,
      totalPaise: 55600,
      startAt: new Date(),
      endAt: new Date(Date.now() + 15 * 60 * 1000),
      userConfirmationEmailSentAt: null,
      advocateConfirmationEmailSentAt: null,
      advocate: { email: 'advocate@test.com' },
      user: { email: 'client@test.com' },
      payment: { id: 'p1', attempts: [] }
    };

    let userClaimed = false;
    let advocateClaimed = false;

    prisma.advocateBooking.findUnique = async () => mockBooking;
    prisma.advocateBooking.updateMany = async ({ where }) => {
      if ('userConfirmationEmailSentAt' in where) {
        if (!userClaimed) {
          userClaimed = true;
          return { count: 1 };
        }
        return { count: 0 };
      }
      if ('advocateConfirmationEmailSentAt' in where) {
        if (!advocateClaimed) {
          advocateClaimed = true;
          return { count: 1 };
        }
        return { count: 0 };
      }
      return { count: 0 };
    };

    // First call: both user & advocate claimed and sent (2 emails sent)
    const res1 = await sendAdvocateBookingConfirmationEmails('mock-booking-id-1');
    assert.equal(res1.success, true);
    assert.equal(sentMails.length, 2);

    // Second call: count is 0 because already claimed -> skipped (0 additional emails)
    const res2 = await sendAdvocateBookingConfirmationEmails('mock-booking-id-1');
    assert.equal(res2.success, true);
    assert.equal(sentMails.length, 2);

    // Restore Prisma methods
    prisma.advocateBooking.findUnique = originalFindUnique;
    prisma.advocateBooking.updateMany = originalUpdateMany;
    prisma.advocateBooking.update = originalUpdate;
  });

  it('send failure resets the claimed timestamp back to null so cron can retry', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';

    const originalFindUnique = prisma.advocateBooking.findUnique;
    const originalUpdateMany = prisma.advocateBooking.updateMany;
    const originalUpdate = prisma.advocateBooking.update;

    let resetFields = [];

    prisma.advocateBooking.findUnique = async () => ({
      id: 'mock-booking-id-2',
      bookingId: 'VLB-2026M2',
      userName: 'Client Fail',
      userEmail: 'fail@test.com',
      advocateName: 'Adv. Fail',
      mode: 'VOICE_CALL',
      durationMinutes: 15,
      feePaise: 45000,
      gstPercent: 18,
      gstPaise: 8100,
      platformFeePaise: 2500,
      totalPaise: 55600,
      startAt: new Date(),
      endAt: new Date(),
      advocate: { email: 'adv@test.com' },
      payment: null
    });

    prisma.advocateBooking.updateMany = async () => ({ count: 1 });
    prisma.advocateBooking.update = async ({ data }) => {
      resetFields.push(data);
      return {};
    };

    // Force transporter to fail
    setTransporter({
      sendMail: async () => {
        throw new Error('SMTP connection timed out');
      }
    });

    const res = await sendAdvocateBookingConfirmationEmails('mock-booking-id-2');
    assert.equal(res.success, true); // never throws
    assert.ok(resetFields.some((f) => f.userConfirmationEmailSentAt === null));
    assert.ok(resetFields.some((f) => f.advocateConfirmationEmailSentAt === null));

    prisma.advocateBooking.findUnique = originalFindUnique;
    prisma.advocateBooking.updateMany = originalUpdateMany;
    prisma.advocateBooking.update = originalUpdate;
  });

  it('sendConsultancyConfirmationEmail claims atomically and skips already-sent', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';

    const originalFindUnique = prisma.consultancyRequest.findUnique;
    const originalUpdateMany = prisma.consultancyRequest.updateMany;
    const originalUpdate = prisma.consultancyRequest.update;

    let claimAttempts = 0;

    prisma.consultancyRequest.findUnique = async () => ({
      id: 'mock-consultancy-id-1',
      bookingId: 'VSB-2026K4H7Q2M',
      callType: 'CALL',
      duration: 15,
      phoneNumber: '+91 9999999999',
      email: 'client@example.com',
      user: { fullName: 'Client One', email: 'account@example.com' },
      payment: {
        amount: 49900,
        paidAt: new Date(),
        attempts: [{ razorpayPaymentId: 'pay_123' }]
      }
    });

    prisma.consultancyRequest.updateMany = async () => {
      claimAttempts++;
      if (claimAttempts === 1) {
        return { count: 1 };
      }
      return { count: 0 };
    };

    // First call: claims and sends 1 email
    const res1 = await sendConsultancyConfirmationEmail('mock-consultancy-id-1');
    assert.equal(res1.success, true);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'client@example.com');

    // Second call: count is 0 -> skipped
    const res2 = await sendConsultancyConfirmationEmail('mock-consultancy-id-1');
    assert.equal(res2.success, true);
    assert.equal(sentMails.length, 1);

    prisma.consultancyRequest.findUnique = originalFindUnique;
    prisma.consultancyRequest.updateMany = originalUpdateMany;
    prisma.consultancyRequest.update = originalUpdate;
  });

  it('sendConsultancyConfirmationEmail falls back to user account email if consultancy.email is empty', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';

    const originalFindUnique = prisma.consultancyRequest.findUnique;
    const originalUpdateMany = prisma.consultancyRequest.updateMany;

    prisma.consultancyRequest.findUnique = async () => ({
      id: 'mock-consultancy-id-2',
      bookingId: 'VSB-2026K4H7Q2M',
      callType: 'CALL',
      duration: 15,
      phoneNumber: '+91 9999999999',
      email: '', // empty checkout email
      user: { fullName: 'Account User', email: 'account-fallback@example.com' },
      payment: {
        amount: 49900,
        attempts: []
      }
    });

    prisma.consultancyRequest.updateMany = async () => ({ count: 1 });

    const res = await sendConsultancyConfirmationEmail('mock-consultancy-id-2');
    assert.equal(res.success, true);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'account-fallback@example.com');

    prisma.consultancyRequest.findUnique = originalFindUnique;
    prisma.consultancyRequest.updateMany = originalUpdateMany;
  });

  it('sendConsultancyConfirmationEmail resets timestamp on transporter failure', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';

    const originalFindUnique = prisma.consultancyRequest.findUnique;
    const originalUpdateMany = prisma.consultancyRequest.updateMany;
    const originalUpdate = prisma.consultancyRequest.update;

    let resetPayload = null;

    prisma.consultancyRequest.findUnique = async () => ({
      id: 'mock-consultancy-id-3',
      bookingId: 'VSB-2026K4H7Q2M',
      callType: 'CALL',
      duration: 15,
      email: 'client@example.com',
      user: { fullName: 'Client' },
      payment: { amount: 49900 }
    });

    prisma.consultancyRequest.updateMany = async () => ({ count: 1 });
    prisma.consultancyRequest.update = async ({ data }) => {
      resetPayload = data;
      return {};
    };

    setTransporter({
      sendMail: async () => {
        throw new Error('Connection refused');
      }
    });

    const res = await sendConsultancyConfirmationEmail('mock-consultancy-id-3');
    assert.equal(res.success, false);
    assert.equal(resetPayload?.confirmationEmailSentAt, null);

    prisma.consultancyRequest.findUnique = originalFindUnique;
    prisma.consultancyRequest.updateMany = originalUpdateMany;
    prisma.consultancyRequest.update = originalUpdate;
  });
});

describe('5. Test Response Sheet Email & BCC', () => {
  const dummySnapshotQuestions = [
    {
      questionId: 'q-1',
      question: 'Under which Article can a person approach Supreme Court? <script>alert("xss")</script>',
      options: ['Article 226', 'Article 32 & <safe>', 'Article 136', 'Article 142'],
      correctIndex: 1
    },
    {
      questionId: 'q-2',
      question: 'Condonation of delay is under which Section of Limitation Act?',
      options: ['Section 3', 'Section 4', 'Section 5', 'Section 6'],
      correctIndex: 2
    },
    {
      questionId: 'q-3',
      question: 'Mutual consent divorce is under which Section of HMA?',
      options: ['Section 13', 'Section 13A', 'Section 13B', 'Section 14'],
      correctIndex: 2
    }
  ];

  const dummyAdvocate = {
    fullName: 'Adv. Priya Sharma <script>',
    barCouncilId: 'D/1234/2018',
    email: 'priya@example.com'
  };

  it('5.1 renders pass variant with green pill, Passed chip, score box, and review closing line', () => {
    const attempt = {
      questions: dummySnapshotQuestions,
      answers: [
        { index: 0, selected: 'B' }, // Correct
        { index: 1, selected: 'C' }, // Correct
        { index: 2, selected: 'C' }  // Correct
      ],
      startedAt: new Date('2026-11-28T10:40:00.000Z'),
      submittedAt: new Date('2026-11-28T10:54:32.000Z'),
      autoSubmitted: false,
      totalQuestions: 3,
      correctCount: 3,
      wrongCount: 0,
      passed: true
    };

    const { subject, html, text } = advocateTestResponseSheetTemplate({
      attempt,
      advocate: dummyAdvocate,
      attemptNumber: 2,
      durationMinutes: 20
    });

    assert.equal(subject, 'Your VakeelSetu test result – Passed (3/3)');
    assert.ok(html.includes('Test passed'));
    assert.ok(html.includes('Passed'));
    assert.ok(html.includes('Attempt 2'));
    assert.ok(html.includes('14 min 32 sec'));
    assert.ok(html.includes('By you'));
    assert.ok(html.includes('Our team will now review your profile. We will email you once it is approved.'));
    assert.ok(text.includes('Result: PASSED'));
  });

  it('5.2 renders fail variant with red pill, Not passed chip, and reschedule closing line', () => {
    const attempt = {
      questions: dummySnapshotQuestions,
      answers: [
        { index: 0, selected: 'A' }, // Wrong
        { index: 1, selected: null }, // Not answered
        { index: 2, selected: 'C' }   // Correct
      ],
      startedAt: new Date('2026-11-28T11:00:00.000Z'),
      submittedAt: new Date('2026-11-28T11:20:00.000Z'),
      autoSubmitted: true,
      totalQuestions: 3,
      correctCount: 1,
      wrongCount: 2,
      passed: false
    };

    const { subject, html, text } = advocateTestResponseSheetTemplate({
      attempt,
      advocate: dummyAdvocate,
      attemptNumber: 1,
      durationMinutes: 20
    });

    assert.equal(subject, 'Your VakeelSetu test result – Not passed (1/3)');
    assert.ok(html.includes('Test not passed'));
    assert.ok(html.includes('Not passed'));
    assert.ok(html.includes('Attempt 1'));
    assert.ok(html.includes('Automatically (time over)'));
    assert.ok(html.includes('You can request a new test from the test page using <strong>Request reschedule</strong>.'));
    assert.ok(text.includes('Result: NOT PASSED'));
  });

  it('5.3 categorizes wrong/unanswered vs correct sections and uses snapshot with HTML escaping', () => {
    const attempt = {
      questions: dummySnapshotQuestions,
      answers: [
        { index: 0, selected: 'A' }, // Wrong: selected Article 226, correct is Article 32 & <safe>
        { index: 1, selected: null }, // Unanswered
        { index: 2, selected: 'C' }  // Correct
      ],
      startedAt: new Date(),
      submittedAt: new Date(),
      autoSubmitted: false,
      totalQuestions: 3,
      correctCount: 1,
      wrongCount: 2,
      passed: false
    };

    const { html } = advocateTestResponseSheetTemplate({
      attempt,
      advocate: dummyAdvocate,
      attemptNumber: 1
    });

    // Check wrong / unanswered section
    assert.ok(html.includes('Wrong / not answered (2)'));
    assert.ok(html.includes('&#10007; Wrong'));
    assert.ok(html.includes('Not answered'));
    assert.ok(html.includes('Article 226'));
    assert.ok(html.includes('&amp; &lt;safe&gt;')); // Escaped option text

    // Check correct section
    assert.ok(html.includes('Correct (1)'));
    assert.ok(html.includes('&#10003; Correct'));
    assert.ok(html.includes('Section 13B'));

    // Check XSS escaping
    assert.ok(!html.includes('<script>alert("xss")</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  });

  it('5.4 caps time taken at test duration', () => {
    const startedAt = new Date('2026-11-28T10:00:00.000Z');
    const submittedAt = new Date('2026-11-28T10:35:00.000Z'); // 35 minutes later
    const attempt = {
      questions: [],
      answers: [],
      startedAt,
      submittedAt,
      autoSubmitted: true,
      totalQuestions: 0,
      correctCount: 0,
      wrongCount: 0,
      passed: false
    };

    const { html } = advocateTestResponseSheetTemplate({
      attempt,
      advocate: dummyAdvocate,
      attemptNumber: 1,
      durationMinutes: 20
    });

    assert.ok(html.includes('20 min 0 sec'));
  });

  it('5.5 parseAdvocateTestSheetBcc parses valid emails, ignores invalid, and logs single warning', () => {
    resetBccWarningState();
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const raw = ' admin@vakeelsetu.com , invalid-email, audit@vakeel.in , @bad.com ';
      const valid = parseAdvocateTestSheetBcc(raw);
      assert.deepEqual(valid, ['admin@vakeelsetu.com', 'audit@vakeel.in']);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('Invalid BCC email(s) ignored in ADVOCATE_TEST_SHEET_BCC'));

      // Second call must not log warning again
      parseAdvocateTestSheetBcc(raw);
      assert.equal(warnings.length, 1);

      // Empty/whitespace env returns empty list
      assert.deepEqual(parseAdvocateTestSheetBcc(''), []);
      assert.deepEqual(parseAdvocateTestSheetBcc('   '), []);
      assert.deepEqual(parseAdvocateTestSheetBcc(null), []);
    } finally {
      console.warn = origWarn;
      resetBccWarningState();
    }
  });

  it('5.6 sendTestResponseSheetEmail claims atomically and prevents double-send', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';
    const sentMails = [];
    setTransporter({
      sendMail: async (opts) => {
        sentMails.push(opts);
        return { messageId: 'test-sheet-msg-1' };
      }
    });

    const mockAttempt = {
      id: 'att-claim-1',
      advocateId: 'adv-claim-1',
      startedAt: new Date('2026-11-28T10:00:00.000Z'),
      submittedAt: new Date('2026-11-28T10:15:00.000Z'),
      autoSubmitted: false,
      totalQuestions: 1,
      correctCount: 1,
      wrongCount: 0,
      passed: true,
      questions: [
        { questionId: 'q-1', question: 'Test Question', options: ['A', 'B'], correctIndex: 0 }
      ],
      answers: [{ index: 0, selected: 'A' }],
      advocate: {
        fullName: 'Adv. Test User',
        barCouncilId: 'D/1111/2020',
        email: 'recipient@example.com'
      }
    };

    let claimed = false;
    const origFindUnique = prisma.advocateTestAttempt.findUnique;
    const origUpdateMany = prisma.advocateTestAttempt.updateMany;
    const origCount = prisma.advocateTestAttempt.count;

    prisma.advocateTestAttempt.findUnique = async () => mockAttempt;
    prisma.advocateTestAttempt.updateMany = async ({ where }) => {
      if (!claimed && where.responseSheetEmailSentAt === null) {
        claimed = true;
        return { count: 1 };
      }
      return { count: 0 };
    };
    prisma.advocateTestAttempt.count = async () => 1;

    // First call: succeeds and sends email
    const res1 = await sendTestResponseSheetEmail('att-claim-1');
    assert.equal(res1.success, true);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'recipient@example.com');
    assert.ok(sentMails[0].subject.includes('Passed'));

    // Second call (concurrent or double submit): claim count is 0 -> skipped
    const res2 = await sendTestResponseSheetEmail('att-claim-1');
    assert.equal(res2.success, true);
    assert.equal(res2.message, 'Already sent or claimed');
    assert.equal(sentMails.length, 1); // No new email sent

    prisma.advocateTestAttempt.findUnique = origFindUnique;
    prisma.advocateTestAttempt.updateMany = origUpdateMany;
    prisma.advocateTestAttempt.count = origCount;
  });

  it('5.7 sendTestResponseSheetEmail resets timestamp on transporter failure and never throws', async () => {
    process.env.EMAIL_USER = 'sender@vakeelsetu.com';
    setTransporter({
      sendMail: async () => {
        throw new Error('SMTP Timeout Error');
      }
    });

    const mockAttempt = {
      id: 'att-fail-reset',
      advocateId: 'adv-fail-1',
      startedAt: new Date(),
      submittedAt: new Date(),
      autoSubmitted: false,
      totalQuestions: 1,
      correctCount: 1,
      wrongCount: 0,
      passed: true,
      questions: [{ questionId: 'q-1', question: 'Q', options: ['A'], correctIndex: 0 }],
      answers: [],
      advocate: { email: 'fail@example.com' }
    };

    let resetToNull = false;
    const origFindUnique = prisma.advocateTestAttempt.findUnique;
    const origUpdateMany = prisma.advocateTestAttempt.updateMany;
    const origUpdate = prisma.advocateTestAttempt.update;
    const origCount = prisma.advocateTestAttempt.count;

    prisma.advocateTestAttempt.findUnique = async () => mockAttempt;
    prisma.advocateTestAttempt.updateMany = async () => ({ count: 1 });
    prisma.advocateTestAttempt.count = async () => 1;
    prisma.advocateTestAttempt.update = async ({ data }) => {
      if (data.responseSheetEmailSentAt === null) {
        resetToNull = true;
      }
      return {};
    };

    const res = await sendTestResponseSheetEmail('att-fail-reset');
    assert.equal(res.success, false);
    assert.equal(resetToNull, true);

    prisma.advocateTestAttempt.findUnique = origFindUnique;
    prisma.advocateTestAttempt.updateMany = origUpdateMany;
    prisma.advocateTestAttempt.update = origUpdate;
    prisma.advocateTestAttempt.count = origCount;
  });

  it('5.8 sendTestResponseSheetEmail skips cleanly when advocate has no email', async () => {
    const mockAttempt = {
      id: 'att-no-email',
      startedAt: new Date(),
      submittedAt: new Date(),
      advocate: { email: '' }
    };

    const origFindUnique = prisma.advocateTestAttempt.findUnique;
    prisma.advocateTestAttempt.findUnique = async () => mockAttempt;

    const res = await sendTestResponseSheetEmail('att-no-email');
    assert.equal(res.success, true);
    assert.equal(res.message, 'No email on record');

    prisma.advocateTestAttempt.findUnique = origFindUnique;
  });
});

describe('6. Help Request Acknowledgement Email & Flow', () => {
  beforeEach(() => {
    resetHelpRequestBccWarningState();
    delete process.env.HELP_REQUEST_BCC;
  });

  it('6.1 Template: "Your concern" label, escaping, truncation, phone masking, empty rows hidden, no links', () => {
    const longConcern = 'A'.repeat(1200);
    const mockRequest = {
      referenceId: 'VSH-5SVQFS',
      name: '<script>alert("hacked")</script>',
      email: 'kishori@example.com',
      phoneNumber: '8812345668',
      concern: `<img src=x onerror=alert(1)> ${longConcern}`,
      createdAt: new Date('2026-11-28T11:54:00.000Z') // 5:24 PM IST
    };

    const { subject, html, text } = helpRequestEmailTemplate({ helpRequest: mockRequest });

    // Subject & Preheader
    assert.equal(subject, "We've received your request – VSH-5SVQFS");
    assert.ok(html.includes("We&#39;ve received your request – VSH-5SVQFS") || html.includes("We've received your request – VSH-5SVQFS"));
    assert.ok(html.includes('Your reference ID is VSH-5SVQFS. Our team will get back to you soon.'));

    // Pill & Heading
    assert.ok(html.includes('Request received'));
    assert.ok(html.includes("We&#39;ve received your help request") || html.includes("We've received your help request"));

    // Label is "Your concern" (NOT "Your message")
    assert.ok(html.includes('Your concern'));
    assert.ok(!html.includes('Your message'));

    // XSS Escaping
    assert.ok(html.includes('&lt;script&gt;alert(&quot;hacked&quot;)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes('<img src=x'));

    // Truncation at 1000 chars + ellipsis
    const truncatedText = truncateConcern(`<img src=x onerror=alert(1)> ${longConcern}`);
    assert.equal(truncatedText.length, 1001); // 1000 chars + '…'
    assert.ok(truncatedText.endsWith('…'));
    assert.ok(html.includes('…'));

    // Phone masking: +91 88XXXXXX68
    assert.equal(maskPhone('8812345668'), '+91 88XXXXXX68');
    assert.ok(html.includes('+91 88XXXXXX68'));

    // Empty rows hidden: no Subject row because category/subject was omitted
    assert.ok(!html.includes('Subject'));

    // Status chip present
    assert.ok(html.includes('Received'));

    // No user-generated action buttons or links
    assert.ok(!html.includes('href="http')); // No link inside concern or dynamic content

    // Monospace reference ID & Submitted on IST
    assert.ok(html.includes('VSH-5SVQFS'));
    assert.ok(html.includes('28 Nov 2026'));
    assert.ok(html.includes('5:24 PM IST'));

    // Plain text version
    assert.ok(text.includes('Reference ID: VSH-5SVQFS'));
    assert.ok(text.includes('Your concern:'));
    assert.ok(text.includes('+91 88XXXXXX68'));
  });

  it('6.2 Template: Salutation handles absent name with "Hello," fallback', () => {
    const mockRequest = {
      referenceId: 'VSH-123456',
      name: '',
      email: 'guest@example.com',
      phoneNumber: '9876543210',
      concern: 'General inquiry about legal services.'
    };

    const { html, text } = helpRequestEmailTemplate({ helpRequest: mockRequest });
    assert.ok(html.includes('Hello,<br/>Thank you for reaching out'));
    assert.ok(!html.includes('Dear ,'));
    assert.ok(text.includes('Hello,'));
  });

  it('6.3 BCC Parsing: extracts valid, ignores invalid with warning, empty returns []', () => {
    // Empty
    assert.deepEqual(parseHelpRequestBcc(''), []);
    assert.deepEqual(parseHelpRequestBcc(undefined), []);

    // Valid only
    const validRaw = 'audit@vakeelsetu.com, support-lead@vakeelsetu.com';
    assert.deepEqual(parseHelpRequestBcc(validRaw), ['audit@vakeelsetu.com', 'support-lead@vakeelsetu.com']);

    // Mixed with invalid
    let warned = false;
    const origWarn = console.warn;
    console.warn = (msg) => {
      if (msg.includes('HELP_REQUEST_BCC')) warned = true;
    };

    resetHelpRequestBccWarningState();
    const mixed = parseHelpRequestBcc('valid@vakeelsetu.com, invalid-email, second@vakeelsetu.com');
    assert.deepEqual(mixed, ['valid@vakeelsetu.com', 'second@vakeelsetu.com']);
    assert.equal(warned, true);

    // Second call does NOT repeat warning
    let warnedSecondTime = false;
    console.warn = (msg) => {
      if (msg.includes('HELP_REQUEST_BCC')) warnedSecondTime = true;
    };
    parseHelpRequestBcc('valid@vakeelsetu.com, invalid-again');
    assert.equal(warnedSecondTime, false);

    console.warn = origWarn;
  });

  it('6.4 Once-Only Claim: atomic claim prevents duplicate sends on double call', async () => {
    let sentCount = 0;
    setTransporter({
      sendMail: async (options) => {
        sentCount++;
        return { messageId: `help-msg-${sentCount}` };
      }
    });

    const mockRequest = {
      id: 'hr-claim-1',
      referenceId: 'VSH-CLAIM1',
      name: 'Kishori',
      email: 'kishori@example.com',
      phoneNumber: '9876543210',
      concern: 'Need advice on tenancy law.'
    };

    let claimed = false;
    const origFindUnique = prisma.helpRequest.findUnique;
    const origCount = prisma.helpRequest.count;
    const origUpdateMany = prisma.helpRequest.updateMany;

    prisma.helpRequest.findUnique = async () => mockRequest;
    prisma.helpRequest.count = async () => 0; // abuse limit check
    prisma.helpRequest.updateMany = async ({ where }) => {
      if (!claimed && where.acknowledgementEmailSentAt === null) {
        claimed = true;
        return { count: 1 };
      }
      return { count: 0 }; // second call gets 0
    };

    // First call succeeds
    const firstRes = await sendHelpRequestAcknowledgementEmail('hr-claim-1');
    assert.equal(firstRes.success, true);
    assert.equal(sentCount, 1);

    // Second call is skipped cleanly
    const secondRes = await sendHelpRequestAcknowledgementEmail('hr-claim-1');
    assert.equal(secondRes.success, true);
    assert.equal(secondRes.message, 'Already sent or claimed');
    assert.equal(sentCount, 1); // Not sent again

    prisma.helpRequest.findUnique = origFindUnique;
    prisma.helpRequest.count = origCount;
    prisma.helpRequest.updateMany = origUpdateMany;
  });

  it('6.5 Failure Rollback: resets timestamp to null on transporter error', async () => {
    setTransporter({
      sendMail: async () => {
        throw new Error('SMTP Timeout Error');
      }
    });

    const mockRequest = {
      id: 'hr-fail-reset',
      referenceId: 'VSH-FAIL1',
      name: 'User',
      email: 'user@example.com',
      phoneNumber: '9876543210',
      concern: 'Test concern text that must NEVER appear in logs'
    };

    let resetToNull = false;
    const origFindUnique = prisma.helpRequest.findUnique;
    const origCount = prisma.helpRequest.count;
    const origUpdateMany = prisma.helpRequest.updateMany;
    const origUpdate = prisma.helpRequest.update;

    prisma.helpRequest.findUnique = async () => mockRequest;
    prisma.helpRequest.count = async () => 0;
    prisma.helpRequest.updateMany = async () => ({ count: 1 });
    prisma.helpRequest.update = async ({ data }) => {
      if (data.acknowledgementEmailSentAt === null) {
        resetToNull = true;
      }
      return {};
    };

    const res = await sendHelpRequestAcknowledgementEmail('hr-fail-reset');
    assert.equal(res.success, false);
    assert.equal(resetToNull, true);

    prisma.helpRequest.findUnique = origFindUnique;
    prisma.helpRequest.count = origCount;
    prisma.helpRequest.updateMany = origUpdateMany;
    prisma.helpRequest.update = origUpdate;
  });

  it('6.6 Abuse Limit: skips email if recipient got 3 acknowledgement emails in last 60m', async () => {
    let sendMailCalled = false;
    setTransporter({
      sendMail: async () => {
        sendMailCalled = true;
        return { messageId: 'msg-1' };
      }
    });

    const mockRequest = {
      id: 'hr-abuse-test',
      referenceId: 'VSH-ABUSE1',
      name: 'Spam User',
      email: 'spammer@example.com',
      phoneNumber: '9876543210',
      concern: 'Spamming repeatedly'
    };

    const origFindUnique = prisma.helpRequest.findUnique;
    const origCount = prisma.helpRequest.count;

    prisma.helpRequest.findUnique = async () => mockRequest;
    prisma.helpRequest.count = async () => 3; // 3 already sent in last 60 minutes!

    const res = await sendHelpRequestAcknowledgementEmail('hr-abuse-test');
    assert.equal(res.success, false);
    assert.equal(res.message, 'Abuse limit reached');
    assert.equal(sendMailCalled, false);

    prisma.helpRequest.findUnique = origFindUnique;
    prisma.helpRequest.count = origCount;
  });

  it('6.7 Trigger Resilience: createRequest controller returns 201 even when email service fails', async () => {
    // Stub transporter to fail
    setTransporter({
      sendMail: async () => {
        throw new Error('Network failure');
      }
    });

    const origCreate = prisma.helpRequest.create;
    const origFindUnique = prisma.helpRequest.findUnique;
    const origCount = prisma.helpRequest.count;
    const origUpdateMany = prisma.helpRequest.updateMany;
    const origUpdate = prisma.helpRequest.update;

    const mockSaved = {
      id: 'hr-created-1',
      referenceId: 'VSH-NEW123',
      name: 'Rohan',
      email: 'rohan@example.com',
      phoneNumber: '9876543210',
      concern: 'Need help with consumer court complaint.'
    };

    prisma.helpRequest.findUnique = async () => null; // for collision check and lookup
    prisma.helpRequest.create = async () => mockSaved;
    prisma.helpRequest.count = async () => 0;
    prisma.helpRequest.updateMany = async () => ({ count: 1 });
    prisma.helpRequest.update = async () => ({});

    let statusCode = null;
    let jsonResponse = null;

    const req = {
      body: {
        name: 'Rohan',
        email: 'rohan@example.com',
        phoneNumber: '9876543210',
        concern: 'Need help with consumer court complaint.'
      }
    };
    const res = {
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => {
            jsonResponse = data;
          }
        };
      }
    };
    const next = (err) => {
      assert.fail(`next() should not be called on email failure: ${err?.message}`);
    };

    await createRequest(req, res, next);

    assert.equal(statusCode, 201);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.message, 'Your help request has been submitted successfully.');
    assert.ok(jsonResponse.referenceId);

    prisma.helpRequest.create = origCreate;
    prisma.helpRequest.findUnique = origFindUnique;
    prisma.helpRequest.count = origCount;
    prisma.helpRequest.updateMany = origUpdateMany;
    prisma.helpRequest.update = origUpdate;
  });

  it('6.8 Cron Retry: reconcilePaymentsCron retries unsent help requests created in last 48h', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';

    let retriedHelpRequestId = null;
    setTransporter({
      sendMail: async () => ({ messageId: 'cron-help-retry' })
    });

    const origFindMany = prisma.helpRequest.findMany;
    const origFindUnique = prisma.helpRequest.findUnique;
    const origCount = prisma.helpRequest.count;
    const origUpdateMany = prisma.helpRequest.updateMany;

    // Payment mocks
    const origPaymentFindMany = prisma.payment.findMany;
    const origAdvBookingFindMany = prisma.advocateBooking.findMany;
    const origConsultancyFindMany = prisma.consultancyRequest.findMany;
    const origTestAttemptFindMany = prisma.advocateTestAttempt.findMany;

    prisma.payment.findMany = async () => [];
    prisma.advocateBooking.findMany = async () => [];
    prisma.consultancyRequest.findMany = async () => [];
    prisma.advocateTestAttempt.findMany = async () => [];

    prisma.helpRequest.findMany = async ({ where }) => {
      if (where.acknowledgementEmailSentAt === null) {
        return [{ id: 'hr-retry-48h' }];
      }
      return [];
    };
    prisma.helpRequest.findUnique = async ({ where }) => ({
      id: where.id,
      referenceId: 'VSH-RETRY48',
      name: 'Retry User',
      email: 'retry@example.com',
      phoneNumber: '9876543210',
      concern: 'Retry concern'
    });
    prisma.helpRequest.count = async () => 0; // abuse limit check passes
    prisma.helpRequest.updateMany = async () => {
      retriedHelpRequestId = 'hr-retry-48h';
      return { count: 1 };
    };

    let statusCode = null;
    let jsonResponse = null;

    const req = {
      headers: {
        authorization: 'Bearer test-cron-secret'
      }
    };
    const res = {
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => {
            jsonResponse = data;
          }
        };
      }
    };

    await reconcilePaymentsCron(req, res);

    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.helpRequestEmailsRetried, 1);
    assert.equal(retriedHelpRequestId, 'hr-retry-48h');

    prisma.helpRequest.findMany = origFindMany;
    prisma.helpRequest.findUnique = origFindUnique;
    prisma.helpRequest.count = origCount;
    prisma.helpRequest.updateMany = origUpdateMany;
    prisma.payment.findMany = origPaymentFindMany;
    prisma.advocateBooking.findMany = origAdvBookingFindMany;
    prisma.consultancyRequest.findMany = origConsultancyFindMany;
    prisma.advocateTestAttempt.findMany = origTestAttemptFindMany;
  });
});

