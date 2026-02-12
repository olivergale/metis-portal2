/**
 * Test file for anti-clobber detection system
 * Created by: WO-TEST-CLOBBER
 * Purpose: Verify that the scope guard prevents concurrent modifications to the same files
 * Modified by: WO-0463 (clobber detection test)
 */

export interface ClobberCheckResult {
  workOrderId: string;
  fileModified: string;
  timestamp: Date;
  conflictDetected: boolean;
}

/**
 * Simulates a file modification that could trigger clobber detection
 */
export function simulateFileModification(woId: string, filePath: string): ClobberCheckResult {
  return {
    workOrderId: woId,
    fileModified: filePath,
    timestamp: new Date(),
    conflictDetected: false
  };
}

/**
 * Checks if a file is currently being modified by another work order
 */
export function checkForConflict(filePath: string, activeWorkOrders: string[]): boolean {
  // This would integrate with the actual scope guard system
  // For now, this is a placeholder for testing
  return activeWorkOrders.length > 0;
}

export default {
  simulateFileModification,
  checkForConflict
};
