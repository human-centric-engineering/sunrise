/**
 * Storage Key Validation Tests
 *
 * Tests the validateStorageKey function to ensure it properly rejects:
 * - Empty or whitespace-only keys
 * - Path traversal attempts (..)
 * - Absolute path attempts (/ or \)
 * - Null bytes (\0)
 * - Backslashes (\)
 *
 * And accepts valid relative keys with normal path separators.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/storage/providers/validate-key.ts
 */

import { describe, it, expect } from 'vitest';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';

describe('lib/storage/providers/validate-key', () => {
  describe('validateStorageKey', () => {
    // Valid keys - should not throw
    describe('valid keys', () => {
      it('should accept simple key without path separators', () => {
        expect(() => validateStorageKey('avatar.jpg')).not.toThrow();
      });

      it('should accept key with single path segment', () => {
        expect(() => validateStorageKey('avatars/user-123/avatar.jpg')).not.toThrow();
      });

      it('should accept key with multiple path segments', () => {
        expect(() => validateStorageKey('uploads/file.png')).not.toThrow();
      });

      it('should accept deeply nested key', () => {
        expect(() => validateStorageKey('a/b/c/d/e/file.txt')).not.toThrow();
      });

      it('should accept key with dots in filename (not traversal)', () => {
        expect(() => validateStorageKey('file.name.jpg')).not.toThrow();
      });

      it('should accept key with multiple dots in filename', () => {
        expect(() => validateStorageKey('archive.tar.gz')).not.toThrow();
      });

      it('should accept key with single dot in directory name', () => {
        expect(() => validateStorageKey('current.dir/file.jpg')).not.toThrow();
      });

      it('should accept key with numbers and special characters', () => {
        expect(() => validateStorageKey('user-123_profile.v2.png')).not.toThrow();
      });

      it('should accept key with hyphens and underscores', () => {
        expect(() => validateStorageKey('my_avatar-v1_final.jpg')).not.toThrow();
      });

      it('should accept key starting with dot (but not ..)', () => {
        expect(() => validateStorageKey('.hidden/file.jpg')).not.toThrow();
      });

      it('should accept key with mixed case', () => {
        expect(() => validateStorageKey('Avatars/User123/Avatar.JPG')).not.toThrow();
      });

      it('should accept single character filename', () => {
        expect(() => validateStorageKey('a')).not.toThrow();
      });

      it('should accept key with leading spaces trimmed (but not empty after trim)', () => {
        // Note: the function accepts this because key.trim().length > 0
        expect(() => validateStorageKey('  file.jpg')).not.toThrow();
      });

      it('should accept trailing slashes (valid prefix patterns)', () => {
        expect(() => validateStorageKey('avatars/user-123/')).not.toThrow();
      });
    });

    // Empty/whitespace keys - should throw
    describe('empty and whitespace-only keys', () => {
      it('should reject empty string', () => {
        expect(() => validateStorageKey('')).toThrow('Storage key must not be empty');
      });

      it('should reject string with only spaces', () => {
        expect(() => validateStorageKey('   ')).toThrow('Storage key must not be empty');
      });

      it('should reject string with only tabs', () => {
        expect(() => validateStorageKey('\t\t\t')).toThrow('Storage key must not be empty');
      });

      it('should reject string with only newlines', () => {
        expect(() => validateStorageKey('\n\n')).toThrow('Storage key must not be empty');
      });

      it('should reject string with mixed whitespace', () => {
        expect(() => validateStorageKey('  \t\n  ')).toThrow('Storage key must not be empty');
      });
    });

    // Path traversal with ".." - should throw
    describe('path traversal attempts (..)', () => {
      it('should reject ".." at start', () => {
        expect(() => validateStorageKey('../etc/passwd')).toThrow(
          'Storage key must not contain ".."'
        );
      });

      it('should reject ".." in middle', () => {
        expect(() => validateStorageKey('uploads/../../etc/passwd')).toThrow(
          'Storage key must not contain ".."'
        );
      });

      it('should reject ".." at end', () => {
        expect(() => validateStorageKey('uploads/..')).toThrow('Storage key must not contain ".."');
      });

      it('should reject multiple ".." sequences', () => {
        expect(() => validateStorageKey('../../../../../../etc/passwd')).toThrow(
          'Storage key must not contain ".."'
        );
      });

      it('should reject ".." without path separators', () => {
        expect(() => validateStorageKey('..secret')).toThrow('Storage key must not contain ".."');
      });

      it('should reject ".." in directory name context', () => {
        expect(() => validateStorageKey('folder/../../../sensitive')).toThrow(
          'Storage key must not contain ".."'
        );
      });

      it('should reject complex traversal: uploads/../../admin/secret', () => {
        expect(() => validateStorageKey('uploads/../../admin/secret')).toThrow(
          'Storage key must not contain ".."'
        );
      });

      it('should reject Windows-style traversal with forward slashes', () => {
        expect(() => validateStorageKey('uploads\\..\\..\\windows')).toThrow();
        // Will throw for backslash, not for ..
      });
    });

    // Absolute paths (forward slash or backslash) - should throw
    describe('absolute paths', () => {
      it('should reject absolute path starting with forward slash', () => {
        expect(() => validateStorageKey('/etc/passwd')).toThrow(
          'Storage key must not be an absolute path'
        );
      });

      it('should reject absolute path starting with backslash (Windows)', () => {
        expect(() => validateStorageKey('\\windows\\system32')).toThrow(
          'Storage key must not be an absolute path'
        );
      });

      it('should reject absolute path with multiple segments', () => {
        expect(() => validateStorageKey('/home/user/file.txt')).toThrow(
          'Storage key must not be an absolute path'
        );
      });

      it('should reject single forward slash', () => {
        expect(() => validateStorageKey('/')).toThrow('Storage key must not be an absolute path');
      });

      it('should reject single backslash', () => {
        expect(() => validateStorageKey('\\')).toThrow('Storage key must not be an absolute path');
      });

      it('should reject absolute path to root', () => {
        expect(() => validateStorageKey('/root')).toThrow(
          'Storage key must not be an absolute path'
        );
      });
    });

    // Null bytes - should throw
    describe('null bytes', () => {
      it('should reject key with null byte at start', () => {
        expect(() => validateStorageKey('\0file.jpg')).toThrow(
          'Storage key must not contain null bytes'
        );
      });

      it('should reject key with null byte in middle', () => {
        expect(() => validateStorageKey('file\0.jpg')).toThrow(
          'Storage key must not contain null bytes'
        );
      });

      it('should reject key with null byte at end', () => {
        expect(() => validateStorageKey('file.jpg\0')).toThrow(
          'Storage key must not contain null bytes'
        );
      });

      it('should reject key with null byte after extension (truncation attack)', () => {
        expect(() => validateStorageKey('file.jpg\0.exe')).toThrow(
          'Storage key must not contain null bytes'
        );
      });

      it('should reject key with multiple null bytes', () => {
        expect(() => validateStorageKey('file\0name\0.jpg')).toThrow(
          'Storage key must not contain null bytes'
        );
      });

      it('should reject key that is just a null byte', () => {
        expect(() => validateStorageKey('\0')).toThrow('Storage key must not contain null bytes');
      });
    });

    // Backslashes - should throw
    describe('backslashes', () => {
      it('should reject key with backslash in path', () => {
        expect(() => validateStorageKey('uploads\\file.jpg')).toThrow(
          'Storage key must not contain backslashes'
        );
      });

      it('should reject key with backslash at start (absolute path check first)', () => {
        // This will throw for "absolute path" before "backslash"
        expect(() => validateStorageKey('\\file.jpg')).toThrow();
      });

      it('should reject key with multiple backslashes', () => {
        expect(() => validateStorageKey('folder\\subfolder\\file.jpg')).toThrow(
          'Storage key must not contain backslashes'
        );
      });

      it('should reject Windows-style path', () => {
        expect(() => validateStorageKey('C:\\Users\\user\\file.jpg')).toThrow();
        // Will throw for backslash
      });

      it('should reject key with single backslash', () => {
        expect(() => validateStorageKey('file\\name.jpg')).toThrow(
          'Storage key must not contain backslashes'
        );
      });

      it('should reject key with backslash in middle of filename', () => {
        expect(() => validateStorageKey('avatars/user\\file.jpg')).toThrow(
          'Storage key must not contain backslashes'
        );
      });

      it('should accept forward slashes (only backslashes rejected)', () => {
        expect(() => validateStorageKey('avatars/user/file.jpg')).not.toThrow();
      });
    });

    // Error handling and precedence
    describe('validation precedence', () => {
      it('should check emptiness first', () => {
        // Empty check comes first
        expect(() => validateStorageKey('')).toThrow('Storage key must not be empty');
      });

      it('should check absolute path before backslash', () => {
        // \file.jpg starts with \ so it fails absolute path check
        expect(() => validateStorageKey('\\file.jpg')).toThrow(
          'Storage key must not be an absolute path'
        );
      });

      it('should check .. traversal before backslashes', () => {
        // ../file has .. so it fails traversal check
        expect(() => validateStorageKey('../file.jpg')).toThrow(
          'Storage key must not contain ".."'
        );
      });

      it('should throw correct error for key with both .. and backslash', () => {
        // .. is checked before backslash
        expect(() => validateStorageKey('..\\file.jpg')).toThrow(
          'Storage key must not contain ".."'
        );
      });

      it('should throw correct error for absolute path with null byte', () => {
        // Absolute path check comes before null byte check
        expect(() => validateStorageKey('/file\0.jpg')).toThrow(
          'Storage key must not be an absolute path'
        );
      });
    });

    // Edge cases and special scenarios
    describe('edge cases', () => {
      it('should accept key with consecutive slashes (valid in object storage)', () => {
        expect(() => validateStorageKey('avatars//user//file.jpg')).not.toThrow();
      });

      it('should accept key with dot-slash pattern (not ..)', () => {
        expect(() => validateStorageKey('./file.jpg')).not.toThrow();
      });

      it('should accept key with many dots', () => {
        expect(() => validateStorageKey('file.v1.2.3.4.5.final.jpg')).not.toThrow();
      });

      it('should accept key with very long name', () => {
        const longName = 'a'.repeat(255);
        expect(() => validateStorageKey(longName)).not.toThrow();
      });

      it('should accept key with special but safe characters', () => {
        expect(() => validateStorageKey('file-name_v1+final(1).jpg')).not.toThrow();
      });

      it('should accept key that looks like a URL but is relative', () => {
        expect(() => validateStorageKey('https-file_name.jpg')).not.toThrow();
      });

      it('should accept UUID-style filename', () => {
        expect(() =>
          validateStorageKey('avatars/550e8400-e29b-41d4-a716-446655440000.jpg')
        ).not.toThrow();
      });

      it('should accept key with email-like name', () => {
        expect(() => validateStorageKey('avatars/user@example.com/avatar.jpg')).not.toThrow();
      });

      it('should accept key starting with underscore', () => {
        expect(() => validateStorageKey('_private/file.jpg')).not.toThrow();
      });

      it('should accept key with numbers only', () => {
        expect(() => validateStorageKey('123/456/789.jpg')).not.toThrow();
      });
    });

    // Actual threat scenarios
    describe('real-world threat scenarios', () => {
      it('should block: directory escape attacks', () => {
        expect(() => validateStorageKey('../../etc/passwd')).toThrow();
      });

      it('should block: multiple escape levels', () => {
        expect(() => validateStorageKey('../../../../../../../../etc/passwd')).toThrow();
      });

      it('should block: Windows absolute path', () => {
        expect(() => validateStorageKey('C:\\Windows\\System32\\config')).toThrow();
      });

      it('should block: null byte injection (classical C exploit)', () => {
        expect(() => validateStorageKey('avatar.jpg\0.txt')).toThrow();
      });

      it('should block: mixed separators with traversal', () => {
        expect(() => validateStorageKey('uploads/..\\..\\admin')).toThrow();
      });

      it('should allow: safe nested user uploads', () => {
        expect(() => validateStorageKey('users/123/avatars/2024/avatar.jpg')).not.toThrow();
      });

      it('should allow: safe versioned files', () => {
        expect(() => validateStorageKey('documents/contract.v1.2.3.pdf')).not.toThrow();
      });
    });
  });
});
