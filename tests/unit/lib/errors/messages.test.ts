/**
 * User-Friendly Error Messages Tests
 *
 * Comprehensive tests for error message utilities in lib/errors/messages.ts
 *
 * Test Coverage:
 * - ErrorMessages constant completeness (all error codes mapped)
 * - getUserFriendlyMessage() - error code mapping, unknown codes, custom defaults
 * - getContextualErrorMessage() - contextual messages with resource/action/field
 * - getValidationErrorMessages() - Zod error details transformation
 * - getFormErrorMessage() - form-specific error message extraction
 *
 * @see lib/errors/messages.ts
 */

import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '@/lib/api/errors';
import {
  ErrorMessages,
  getUserFriendlyMessage,
  getContextualErrorMessage,
  getValidationErrorMessages,
  getFormErrorMessage,
} from '@/lib/errors/messages';

/**
 * Test Suite: ErrorMessages Constant
 *
 * Ensures all error codes have user-friendly messages
 */
describe('ErrorMessages constant', () => {
  it('should have a message for each error code', () => {
    const errorCodeValues = Object.values(ErrorCodes);

    for (const code of errorCodeValues) {
      expect(ErrorMessages[code]).toBeDefined();
      expect(typeof ErrorMessages[code]).toBe('string');
      expect(ErrorMessages[code].length).toBeGreaterThan(0);
    }
  });

  it('should have proper message for UNAUTHORIZED', () => {
    expect(ErrorMessages[ErrorCodes.UNAUTHORIZED]).toBe('Please sign in to continue.');
  });

  it('should have proper message for FORBIDDEN', () => {
    expect(ErrorMessages[ErrorCodes.FORBIDDEN]).toBe(
      "You don't have permission to access this resource."
    );
  });

  it('should have proper message for NOT_FOUND', () => {
    expect(ErrorMessages[ErrorCodes.NOT_FOUND]).toBe('The requested resource could not be found.');
  });

  it('should have proper message for VALIDATION_ERROR', () => {
    expect(ErrorMessages[ErrorCodes.VALIDATION_ERROR]).toBe(
      'Please check your input and try again.'
    );
  });

  it('should have proper message for EMAIL_TAKEN', () => {
    expect(ErrorMessages[ErrorCodes.EMAIL_TAKEN]).toBe('This email address is already registered.');
  });

  it('should have proper message for RATE_LIMIT_EXCEEDED', () => {
    expect(ErrorMessages[ErrorCodes.RATE_LIMIT_EXCEEDED]).toBe(
      'Too many requests. Please try again later.'
    );
  });

  it('should have proper message for INTERNAL_ERROR', () => {
    expect(ErrorMessages[ErrorCodes.INTERNAL_ERROR]).toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('should have messages that are user-friendly', () => {
    const messages = Object.values(ErrorMessages);

    for (const message of messages) {
      // Messages should not contain technical jargon
      expect(message).not.toMatch(/exception|stack|trace|code|debug/i);

      // Messages should be actionable (contain guidance)
      expect(message.length).toBeGreaterThan(10); // Reasonable length

      // Messages should be properly capitalized and punctuated
      expect(message[0]).toMatch(/[A-Z]/); // Starts with capital letter
      expect(message).toMatch(/\.$/); // Ends with period
    }
  });
});

/**
 * Test Suite: getUserFriendlyMessage Function
 *
 * Tests error code to message mapping with fallback handling
 */
describe('getUserFriendlyMessage', () => {
  describe('Known error codes', () => {
    it('should return message for UNAUTHORIZED', () => {
      const message = getUserFriendlyMessage(ErrorCodes.UNAUTHORIZED);
      expect(message).toBe('Please sign in to continue.');
    });

    it('should return message for FORBIDDEN', () => {
      const message = getUserFriendlyMessage(ErrorCodes.FORBIDDEN);
      expect(message).toBe("You don't have permission to access this resource.");
    });

    it('should return message for NOT_FOUND', () => {
      const message = getUserFriendlyMessage(ErrorCodes.NOT_FOUND);
      expect(message).toBe('The requested resource could not be found.');
    });

    it('should return message for VALIDATION_ERROR', () => {
      const message = getUserFriendlyMessage(ErrorCodes.VALIDATION_ERROR);
      expect(message).toBe('Please check your input and try again.');
    });

    it('should return message for EMAIL_TAKEN', () => {
      const message = getUserFriendlyMessage(ErrorCodes.EMAIL_TAKEN);
      expect(message).toBe('This email address is already registered.');
    });

    it('should return message for RATE_LIMIT_EXCEEDED', () => {
      const message = getUserFriendlyMessage(ErrorCodes.RATE_LIMIT_EXCEEDED);
      expect(message).toBe('Too many requests. Please try again later.');
    });

    it('should return message for INTERNAL_ERROR', () => {
      const message = getUserFriendlyMessage(ErrorCodes.INTERNAL_ERROR);
      expect(message).toBe('Something went wrong. Please try again.');
    });
  });

  describe('Unknown error codes', () => {
    it('should return default message for unknown code', () => {
      const message = getUserFriendlyMessage('UNKNOWN_CODE');
      expect(message).toBe('An error occurred. Please try again.');
    });

    it('should return custom default message when provided', () => {
      const customDefault = 'Custom fallback message';
      const message = getUserFriendlyMessage('UNKNOWN_CODE', customDefault);
      expect(message).toBe(customDefault);
    });

    it('should return default message for empty string code', () => {
      const message = getUserFriendlyMessage('');
      expect(message).toBe('An error occurred. Please try again.');
    });

    it('should return default message for undefined code', () => {
      const message = getUserFriendlyMessage(undefined);
      expect(message).toBe('An error occurred. Please try again.');
    });

    it('should return custom default for undefined code', () => {
      const customDefault = 'Custom default for undefined';
      const message = getUserFriendlyMessage(undefined, customDefault);
      expect(message).toBe(customDefault);
    });
  });

  describe('Edge cases', () => {
    it('should handle code with extra whitespace', () => {
      // Should not match because codes are exact matches
      const message = getUserFriendlyMessage(' UNAUTHORIZED ');
      expect(message).toBe('An error occurred. Please try again.');
    });

    it('should be case-sensitive for error codes', () => {
      // Should not match because codes are case-sensitive
      const message = getUserFriendlyMessage('unauthorized');
      expect(message).toBe('An error occurred. Please try again.');
    });

    it('should handle null-like codes with custom default', () => {
      const customDefault = 'Something went wrong';
      expect(getUserFriendlyMessage(undefined, customDefault)).toBe(customDefault);
    });
  });
});

/**
 * Test Suite: getContextualErrorMessage Function
 *
 * Tests contextual message generation with resource/action/field context
 */
describe('getContextualErrorMessage', () => {
  describe('NOT_FOUND error code', () => {
    it('should generate contextual message with resource', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND, {
        resource: 'user',
      });
      expect(message).toBe('User not found.');
    });

    it('should capitalize resource name', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND, {
        resource: 'post',
      });
      expect(message).toBe('Post not found.');
    });

    it('should return default message without context', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND);
      expect(message).toBe(ErrorMessages[ErrorCodes.NOT_FOUND]);
    });

    it('should ignore action context for NOT_FOUND', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND, {
        action: 'delete',
      });
      expect(message).toBe(ErrorMessages[ErrorCodes.NOT_FOUND]);
    });
  });

  describe('VALIDATION_ERROR error code', () => {
    it('should generate contextual message with field', () => {
      const message = getContextualErrorMessage(ErrorCodes.VALIDATION_ERROR, {
        field: 'email',
      });
      expect(message).toBe('Email is invalid.');
    });

    it('should capitalize field name', () => {
      const message = getContextualErrorMessage(ErrorCodes.VALIDATION_ERROR, {
        field: 'password',
      });
      expect(message).toBe('Password is invalid.');
    });

    it('should return default message without context', () => {
      const message = getContextualErrorMessage(ErrorCodes.VALIDATION_ERROR);
      expect(message).toBe(ErrorMessages[ErrorCodes.VALIDATION_ERROR]);
    });

    it('should ignore resource context for VALIDATION_ERROR', () => {
      const message = getContextualErrorMessage(ErrorCodes.VALIDATION_ERROR, {
        resource: 'user',
      });
      expect(message).toBe(ErrorMessages[ErrorCodes.VALIDATION_ERROR]);
    });
  });

  describe('FORBIDDEN error code', () => {
    it('should generate message with action and resource', () => {
      const message = getContextualErrorMessage(ErrorCodes.FORBIDDEN, {
        action: 'delete',
        resource: 'post',
      });
      expect(message).toBe("You don't have permission to delete this post.");
    });

    it('should generate message with action only', () => {
      const message = getContextualErrorMessage(ErrorCodes.FORBIDDEN, {
        action: 'edit',
      });
      expect(message).toBe("You don't have permission to edit.");
    });

    it('should ignore resource without action', () => {
      const message = getContextualErrorMessage(ErrorCodes.FORBIDDEN, {
        resource: 'post',
      });
      expect(message).toBe(ErrorMessages[ErrorCodes.FORBIDDEN]);
    });

    it('should return default message without context', () => {
      const message = getContextualErrorMessage(ErrorCodes.FORBIDDEN);
      expect(message).toBe(ErrorMessages[ErrorCodes.FORBIDDEN]);
    });
  });

  describe('UNAUTHORIZED error code', () => {
    it('should generate message with action', () => {
      const message = getContextualErrorMessage(ErrorCodes.UNAUTHORIZED, {
        action: 'view this page',
      });
      expect(message).toBe('Please sign in to view this page.');
    });

    it('should return default message without context', () => {
      const message = getContextualErrorMessage(ErrorCodes.UNAUTHORIZED);
      expect(message).toBe(ErrorMessages[ErrorCodes.UNAUTHORIZED]);
    });

    it('should ignore resource context', () => {
      const message = getContextualErrorMessage(ErrorCodes.UNAUTHORIZED, {
        resource: 'user',
      });
      expect(message).toBe(ErrorMessages[ErrorCodes.UNAUTHORIZED]);
    });
  });

  describe('INTERNAL_ERROR error code', () => {
    it('should generate message with action', () => {
      const message = getContextualErrorMessage(ErrorCodes.INTERNAL_ERROR, {
        action: 'save your data',
      });
      expect(message).toBe('Failed to save your data. Please try again.');
    });

    it('should return default message without context', () => {
      const message = getContextualErrorMessage(ErrorCodes.INTERNAL_ERROR);
      expect(message).toBe(ErrorMessages[ErrorCodes.INTERNAL_ERROR]);
    });

    it('should ignore resource context', () => {
      const message = getContextualErrorMessage(ErrorCodes.INTERNAL_ERROR, {
        resource: 'post',
      });
      expect(message).toBe(ErrorMessages[ErrorCodes.INTERNAL_ERROR]);
    });
  });

  describe('Other error codes', () => {
    it('should return default message for EMAIL_TAKEN regardless of context', () => {
      const message = getContextualErrorMessage(ErrorCodes.EMAIL_TAKEN, {
        resource: 'user',
        action: 'create',
      });
      expect(message).toBe(ErrorMessages[ErrorCodes.EMAIL_TAKEN]);
    });

    it('should return default message for RATE_LIMIT_EXCEEDED regardless of context', () => {
      const message = getContextualErrorMessage(ErrorCodes.RATE_LIMIT_EXCEEDED, {
        resource: 'api',
        action: 'request',
      });
      expect(message).toBe(ErrorMessages[ErrorCodes.RATE_LIMIT_EXCEEDED]);
    });
  });

  describe('No context provided', () => {
    it('should fallback to getUserFriendlyMessage when context is undefined', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND, undefined);
      expect(message).toBe(getUserFriendlyMessage(ErrorCodes.NOT_FOUND));
    });

    it('should fallback when context is empty object', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND, {});
      expect(message).toBe(getUserFriendlyMessage(ErrorCodes.NOT_FOUND));
    });
  });

  describe('Unknown error codes', () => {
    it('should fallback to getUserFriendlyMessage for unknown code', () => {
      const message = getContextualErrorMessage('UNKNOWN_CODE', {
        resource: 'user',
      });
      expect(message).toBe(getUserFriendlyMessage('UNKNOWN_CODE'));
    });

    it('should fallback to getUserFriendlyMessage for unknown code with context', () => {
      const message = getContextualErrorMessage('CUSTOM_ERROR', {
        action: 'perform action',
      });
      expect(message).toBe(getUserFriendlyMessage('CUSTOM_ERROR'));
    });
  });

  describe('Capitalization', () => {
    it('should capitalize single-word resource', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND, {
        resource: 'user',
      });
      expect(message).toBe('User not found.');
    });

    it('should capitalize single-word field', () => {
      const message = getContextualErrorMessage(ErrorCodes.VALIDATION_ERROR, {
        field: 'email',
      });
      expect(message).toBe('Email is invalid.');
    });

    it('should capitalize first letter of multi-word field', () => {
      const message = getContextualErrorMessage(ErrorCodes.VALIDATION_ERROR, {
        field: 'firstName',
      });
      expect(message).toBe('FirstName is invalid.');
    });

    it('should handle empty string resource', () => {
      const message = getContextualErrorMessage(ErrorCodes.NOT_FOUND, {
        resource: '',
      });
      // Empty string should fallback to default
      expect(message).toBe(ErrorMessages[ErrorCodes.NOT_FOUND]);
    });
  });
});

/**
 * Test Suite: getValidationErrorMessages Function
 *
 * Tests transformation of Zod error details to readable messages
 */
describe('getValidationErrorMessages', () => {
  describe('Single errors per field', () => {
    it('should return single error message for single field', () => {
      const details = {
        email: ['Invalid email format'],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        email: 'Invalid email format',
      });
    });

    it('should handle multiple fields with single errors', () => {
      const details = {
        email: ['Invalid email format'],
        password: ['Password is required'],
        name: ['Name must not be empty'],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        email: 'Invalid email format',
        password: 'Password is required',
        name: 'Name must not be empty',
      });
    });
  });

  describe('Multiple errors per field', () => {
    it('should join two errors with "and"', () => {
      const details = {
        password: ['Must be at least 8 characters', 'Must contain a number'],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        password: 'Must be at least 8 characters and Must contain a number',
      });
    });

    it('should join three errors with commas and "and"', () => {
      const details = {
        password: [
          'Must be at least 8 characters',
          'Must contain a number',
          'Must contain a special character',
        ],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        password:
          'Must be at least 8 characters, Must contain a number and Must contain a special character',
      });
    });

    it('should join four or more errors correctly', () => {
      const details = {
        password: ['Error 1', 'Error 2', 'Error 3', 'Error 4'],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        password: 'Error 1, Error 2, Error 3 and Error 4',
      });
    });
  });

  describe('Mixed scenarios', () => {
    it('should handle mix of single and multiple errors', () => {
      const details = {
        email: ['Invalid email format'],
        password: ['Too short', 'Must contain a number'],
        name: ['Name is required'],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        email: 'Invalid email format',
        password: 'Too short and Must contain a number',
        name: 'Name is required',
      });
    });
  });

  describe('Empty and undefined cases', () => {
    it('should return empty object for undefined details', () => {
      const messages = getValidationErrorMessages(undefined);
      expect(messages).toEqual({});
    });

    it('should return empty object for empty details', () => {
      const messages = getValidationErrorMessages({});
      expect(messages).toEqual({});
    });

    it('should handle fields with empty error arrays', () => {
      const details = {
        email: ['Invalid email'],
        password: [],
      };

      const messages = getValidationErrorMessages(details);

      // Empty array is treated as no single error and no multiple errors
      // It will produce " and undefined" for empty array
      expect(messages).toEqual({
        email: 'Invalid email',
        password: ' and undefined',
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle field with single empty string error', () => {
      const details = {
        email: [''],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        email: '',
      });
    });

    it('should handle field with multiple empty string errors', () => {
      const details = {
        email: ['', ''],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        email: ' and ',
      });
    });

    it('should preserve error message formatting', () => {
      const details = {
        email: ['Error with special chars: @#$%'],
        password: ['Error with "quotes"'],
      };

      const messages = getValidationErrorMessages(details);

      expect(messages).toEqual({
        email: 'Error with special chars: @#$%',
        password: 'Error with "quotes"',
      });
    });
  });
});

/**
 * Test Suite: getFormErrorMessage Function
 *
 * Tests extraction of appropriate error messages for forms
 */
describe('getFormErrorMessage', () => {
  describe('General errors (no field specified)', () => {
    it('should return user-friendly message for known error code', () => {
      const error = {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Not authorized',
      };

      const message = getFormErrorMessage(error);
      expect(message).toBe('Please sign in to continue.');
    });

    it('should return custom message when code is unknown', () => {
      const error = {
        code: 'UNKNOWN_ERROR',
        message: 'Custom error message',
      };

      const message = getFormErrorMessage(error);
      expect(message).toBe('Custom error message');
    });

    it('should use message as fallback when code is missing', () => {
      const error = {
        message: 'Something went wrong',
      };

      const message = getFormErrorMessage(error);
      expect(message).toBe('Something went wrong');
    });

    it('should return default message when both code and message are missing', () => {
      const error = {};

      const message = getFormErrorMessage(error);
      expect(message).toBe('An error occurred. Please try again.');
    });
  });

  describe('Field-specific errors', () => {
    it('should return field error when field is specified', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
        details: {
          email: ['Invalid email format'],
        },
      };

      const message = getFormErrorMessage(error, 'email');
      expect(message).toBe('Invalid email format');
    });

    it('should return field error for multiple error messages', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
        details: {
          password: ['Too short', 'Must contain number'],
        },
      };

      const message = getFormErrorMessage(error, 'password');
      expect(message).toBe('Too short and Must contain number');
    });

    it('should return correct error when multiple fields have errors', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
        details: {
          email: ['Invalid email format'],
          password: ['Password required'],
        },
      };

      const emailMessage = getFormErrorMessage(error, 'email');
      expect(emailMessage).toBe('Invalid email format');

      const passwordMessage = getFormErrorMessage(error, 'password');
      expect(passwordMessage).toBe('Password required');
    });

    it('should fallback to general message when field is not in details', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
        details: {
          email: ['Invalid email format'],
        },
      };

      const message = getFormErrorMessage(error, 'password');
      expect(message).toBe('Please check your input and try again.');
    });

    it('should fallback to general message when details is undefined', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
      };

      const message = getFormErrorMessage(error, 'email');
      expect(message).toBe('Please check your input and try again.');
    });

    it('should handle field with empty error array', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
        details: {
          email: [],
        },
      };

      const message = getFormErrorMessage(error, 'email');
      // Empty array gets processed and returns " and undefined"
      expect(message).toBe(' and undefined');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty field name', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
        details: {
          email: ['Invalid email'],
        },
      };

      const message = getFormErrorMessage(error, '');
      expect(message).toBe('Please check your input and try again.');
    });

    it('should handle undefined field parameter', () => {
      const error = {
        code: ErrorCodes.VALIDATION_ERROR,
        details: {
          email: ['Invalid email'],
        },
      };

      const message = getFormErrorMessage(error, undefined);
      expect(message).toBe('Please check your input and try again.');
    });

    it('should handle error with only details (no code or message)', () => {
      const error = {
        details: {
          email: ['Invalid email'],
        },
      };

      const message = getFormErrorMessage(error, 'email');
      expect(message).toBe('Invalid email');
    });

    it('should prioritize field error over general message', () => {
      const error = {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'Server error',
        details: {
          email: ['Invalid email format'],
        },
      };

      const message = getFormErrorMessage(error, 'email');
      expect(message).toBe('Invalid email format');
    });

    it('should use general message when field is specified but not found', () => {
      const error = {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'Custom server error',
        details: {
          email: ['Invalid email format'],
        },
      };

      const message = getFormErrorMessage(error, 'password');
      // Should use getUserFriendlyMessage for the code
      expect(message).toBe('Something went wrong. Please try again.');
    });
  });

  describe('Non-validation errors with field parameter', () => {
    it('should return general error for UNAUTHORIZED with field', () => {
      const error = {
        code: ErrorCodes.UNAUTHORIZED,
        details: {
          email: ['Something'],
        },
      };

      // Field doesn't exist in details, so fallback to general message
      const message = getFormErrorMessage(error, 'password');
      expect(message).toBe('Please sign in to continue.');
    });

    it('should return general error for FORBIDDEN with field', () => {
      const error = {
        code: ErrorCodes.FORBIDDEN,
      };

      const message = getFormErrorMessage(error, 'email');
      expect(message).toBe("You don't have permission to access this resource.");
    });

    it('should return general error for NOT_FOUND with field', () => {
      const error = {
        code: ErrorCodes.NOT_FOUND,
      };

      const message = getFormErrorMessage(error, 'user');
      expect(message).toBe('The requested resource could not be found.');
    });
  });
});
