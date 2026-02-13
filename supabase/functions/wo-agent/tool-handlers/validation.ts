// wo-agent/tool-handlers/validation.ts
// WO-0534: File content validation for UTF-8 corruption prevention

/**
 * Validate file content before committing to prevent UTF-8 corruption.
 * WO-0534: Pre-commit validation guard for github_edit_file.
 * 
 * Checks:
 * 1. Non-ASCII corruption markers (byte values 0x80-0xFF) in code files (.ts, .js, .json)
 * 2. Size explosion (content.length > originalSize * 2) indicating encoding errors
 * 
 * @param content - The file content string to validate
 * @param originalSize - The original file size in bytes (before edit)
 * @param filePath - The file path (used to determine if validation should be strict)
 * @returns { valid: boolean, reason: string }
 */
export function validateFileContent(
  content: string,
  originalSize: number,
  filePath: string
): { valid: boolean; reason: string } {
  // Check 1: Size explosion detection
  if (content.length > originalSize * 2) {
    return {
      valid: false,
      reason: `Content size explosion detected: ${content.length} chars vs original ${originalSize} bytes (2x+ increase indicates encoding corruption)`,
    };
  }

  // Check 2: Non-ASCII corruption markers in code files
  const codeFileExtensions = ['.ts', '.js', '.json', '.tsx', '.jsx'];
  const isCodeFile = codeFileExtensions.some(ext => filePath.endsWith(ext));
  
  if (isCodeFile) {
    // Check for byte values in range 0x80-0xFF (non-ASCII high bytes)
    // These should not appear in properly encoded UTF-8 JavaScript/TypeScript/JSON
    let corruptedByteCount = 0;
    for (let i = 0; i < content.length; i++) {
      const charCode = content.charCodeAt(i);
      // Check for characters in the Latin-1 Supplement range (0x80-0xFF)
      // These indicate improper encoding when they appear as single characters
      if (charCode >= 0x80 && charCode <= 0xFF) {
        corruptedByteCount++;
      }
    }
    
    // If more than 10 corrupted bytes found, likely encoding issue
    if (corruptedByteCount > 10) {
      return {
        valid: false,
        reason: `Non-ASCII corruption detected: ${corruptedByteCount} bytes in range 0x80-0xFF found in ${filePath}. This indicates UTF-8 encoding errors.`,
      };
    }
  }

  return { valid: true, reason: '' };
}
