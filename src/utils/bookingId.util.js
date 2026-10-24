import { generateBookingId, generateAdvocateBookingId } from './idFormat.js';

export { generateBookingId, generateAdvocateBookingId };

/**
 * Attempts to create a ConsultancyRequest safely by generating a bookingId
 * and checking for existing collisions before calling create, avoiding aborted
 * Postgres interactive transaction blocks.
 *
 * @param {object} prismaClientOrTx - Prisma client or transaction instance
 * @param {object} createData - ConsultancyRequest creation data payload (without bookingId)
 * @param {Date|string|number} [date=new Date()] - Date to derive year/month letter in IST
 * @param {number} [maxPrecheckRetries=5] - Maximum precheck generation attempts
 * @returns {Promise<object>} The created ConsultancyRequest
 */
export const createConsultancyWithUniqueBookingId = async (
  prismaClientOrTx,
  createData,
  date = new Date(),
  maxPrecheckRetries = 5
) => {
  let attempts = 0;
  let bookingId;

  while (attempts < maxPrecheckRetries) {
    attempts++;
    bookingId = generateBookingId(date);

    // Pre-check existence to avoid aborting active PostgreSQL transactions
    const existing = await prismaClientOrTx.consultancyRequest.findUnique({
      where: { bookingId },
      select: { id: true }
    });

    if (!existing) {
      break;
    }
  }

  return await prismaClientOrTx.consultancyRequest.create({
    data: {
      ...createData,
      bookingId
    }
  });
};

/**
 * Generates a unique AdvocateBooking bookingId with pre-checks.
 *
 * @param {object} prismaClientOrTx - Prisma client or transaction instance
 * @param {Date|string|number} [date=new Date()] - Date to derive year/month letter in IST
 * @param {number} [maxPrecheckRetries=5] - Maximum precheck generation attempts
 * @returns {Promise<string>} The unique bookingId
 */
export const generateUniqueAdvocateBookingId = async (
  prismaClientOrTx,
  date = new Date(),
  maxPrecheckRetries = 5
) => {
  let attempts = 0;
  let bookingId;

  while (attempts < maxPrecheckRetries) {
    attempts++;
    bookingId = generateAdvocateBookingId(date);

    const existing = await prismaClientOrTx.advocateBooking.findUnique({
      where: { bookingId },
      select: { id: true }
    });

    if (!existing) {
      return bookingId;
    }
  }

  return bookingId;
};
