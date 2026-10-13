import * as helpService from '../services/help.service.js';
import * as helpValidator from '../validators/help.validator.js';

export const createRequest = async (req, res, next) => {
  try {
    const validated = helpValidator.helpRequestSchema.parse(req.body);
    
    const helpRequest = await helpService.createHelpRequest({
      name: validated.name,
      email: validated.email,
      phoneNumber: validated.phoneNumber,
      concern: validated.concern
    });

    return res.status(201).json({
      success: true,
      message: 'Your help request has been submitted successfully.',
      referenceId: helpRequest.referenceId
    });
  } catch (error) {
    next(error);
  }
};

export const lookupRequest = async (req, res, next) => {
  try {
    const validated = helpValidator.helpLookupSchema.parse(req.body);
    
    const helpRequest = await helpService.lookupHelpRequest({
      referenceId: validated.referenceId,
      email: validated.email
    });

    return res.status(200).json({
      success: true,
      helpRequest
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};

export const adminListRequests = async (req, res, next) => {
  try {
    const { page, limit, status, email, referenceId, search } = req.query;
    
    const result = await helpService.listAllHelpRequestsAdmin({
      page,
      limit,
      status,
      email,
      referenceId,
      search
    });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
};

export const adminGetDetails = async (req, res, next) => {
  try {
    const { id } = req.params;
    const helpRequest = await helpService.getHelpRequestAdmin(id);

    return res.status(200).json({
      success: true,
      helpRequest
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};

export const submitAdminResponse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const validated = helpValidator.adminResponseSchema.parse(req.body);

    // Determine responder details from req.user
    let responder = null;
    if (req.user) {
      const userType = (req.user.type || req.user.role || '').toLowerCase();
      if (userType === 'admin') {
        responder = {
          id: 'admin',
          type: 'ADMIN',
          name: req.user.fullName || 'System Administrator'
        };
      } else {
        responder = {
          id: req.user.id,
          type: 'CONTENT_CREATOR',
          name: req.user.fullName || 'Staff'
        };
      }
    }

    const helpRequest = await helpService.respondToHelpRequest(id, {
      response: validated.response,
      status: validated.status,
      responder
    });

    return res.status(200).json({
      success: true,
      message: 'Help request response submitted successfully',
      helpRequest
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};
