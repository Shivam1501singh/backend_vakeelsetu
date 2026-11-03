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
  formatRupees,
  formatBookingDateTimeIst
} from '../src/templates/bookingEmail.template.js';
import {
  sendEmailOtp,
  sendBrandedMail,
  sendAdvocateBookingConfirmationEmails,
  setTransporter,
  maskEmail
} from '../src/services/email.service.js';
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
});
