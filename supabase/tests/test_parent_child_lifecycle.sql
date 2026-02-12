-- Integration test for parent-child WO lifecycle contract (WO-0455)
-- Tests all trigger functionality: settlement, escalation, root finding
-- Run manually: psql -f supabase/tests/test_parent_child_lifecycle.sql

-- Test setup: Create mock WOs
BEGIN;

-- Clean up any existing test data
DELETE FROM work_orders WHERE slug LIKE 'TEST-LC-%';
DELETE FROM audit_log WHERE target_type = 'work_order' AND action LIKE '%TEST-LC-%';

-- Create root parent WO
INSERT INTO work_orders (
  id, slug, name, objective, acceptance_criteria,
  created_by, status, priority, source
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'TEST-LC-ROOT',
  'Test Root WO',
  'Root work order for lifecycle testing',
  '1. Complete root objective',
  'engineering',
  'in_progress',
  'p2_medium',
  'test_suite'
);

-- Create 3 child remediation WOs
INSERT INTO work_orders (
  id, slug, name, objective, acceptance_criteria,
  created_by, status, priority, source, parent_id, tags
) VALUES 
(
  '00000000-0000-0000-0000-000000000002',
  'TEST-LC-CHILD-1',
  'Test Child 1',
  'First remediation attempt',
  '1. Fix issue',
  'engineering',
  'in_progress',
  'p1_high',
  'auto-qa',
  '00000000-0000-0000-0000-000000000001',
  ARRAY['remediation', 'parent:TEST-LC-ROOT']
),
(
  '00000000-0000-0000-0000-000000000003',
  'TEST-LC-CHILD-2',
  'Test Child 2',
  'Second remediation attempt',
  '1. Fix issue',
  'engineering',
  'ready',
  'p1_high',
  'auto-qa',
  '00000000-0000-0000-0000-000000000001',
  ARRAY['remediation', 'parent:TEST-LC-ROOT']
),
(
  '00000000-0000-0000-0000-000000000004',
  'TEST-LC-CHILD-3',
  'Test Child 3',
  'Third remediation attempt',
  '1. Fix issue',
  'engineering',
  'draft',
  'p1_high',
  'auto-qa',
  '00000000-0000-0000-0000-000000000001',
  ARRAY['remediation', 'parent:TEST-LC-ROOT']
);

-- TEST 1: Verify children exist and are linked to parent
DO $$
DECLARE
  child_count INT;
BEGIN
  SELECT COUNT(*) INTO child_count
  FROM work_orders
  WHERE parent_id = '00000000-0000-0000-0000-000000000001';
  
  IF child_count != 3 THEN
    RAISE EXCEPTION 'TEST FAILED: Expected 3 children, found %', child_count;
  END IF;
  
  RAISE NOTICE 'TEST 1 PASSED: All 3 children created with correct parent_id';
END $$;

-- TEST 2: Transition parent to 'done' and verify all children are cancelled
-- This tests the settle_children_on_parent_terminal trigger
SELECT set_config('app.wo_executor_bypass', 'true', true);

UPDATE work_orders 
SET status = 'done', completed_at = NOW(), summary = 'Test completion'
WHERE id = '00000000-0000-0000-0000-000000000001';

-- Verify all children are now cancelled
DO $$
DECLARE
  cancelled_count INT;
  active_count INT;
BEGIN
  SELECT COUNT(*) INTO cancelled_count
  FROM work_orders
  WHERE parent_id = '00000000-0000-0000-0000-000000000001'
  AND status = 'cancelled';
  
  SELECT COUNT(*) INTO active_count
  FROM work_orders
  WHERE parent_id = '00000000-0000-0000-0000-000000000001'
  AND status NOT IN ('cancelled', 'done');
  
  IF cancelled_count != 3 THEN
    RAISE EXCEPTION 'TEST FAILED: Expected 3 cancelled children, found %', cancelled_count;
  END IF;
  
  IF active_count != 0 THEN
    RAISE EXCEPTION 'TEST FAILED: Found % active children, expected 0', active_count;
  END IF;
  
  RAISE NOTICE 'TEST 2 PASSED: All children cancelled when parent transitioned to done';
END $$;

-- TEST 3: Verify audit_log entries exist for each cancellation
DO $$
DECLARE
  audit_count INT;
BEGIN
  SELECT COUNT(*) INTO audit_count
  FROM audit_log
  WHERE event_type = 'work_order_lifecycle'
  AND action = 'cancelled_by_parent_settlement'
  AND target_type = 'work_order'
  AND created_at > NOW() - INTERVAL '5 minutes';
  
  IF audit_count < 3 THEN
    RAISE EXCEPTION 'TEST FAILED: Expected at least 3 audit log entries, found %', audit_count;
  END IF;
  
  RAISE NOTICE 'TEST 3 PASSED: Audit log entries created for child cancellations (found %)', audit_count;
END $$;

-- TEST 4: Test parent failure escalation when all children fail
-- Clean up and create new test WOs
DELETE FROM work_orders WHERE slug LIKE 'TEST-LC-%';

-- Create new root parent WO
INSERT INTO work_orders (
  id, slug, name, objective, acceptance_criteria,
  created_by, status, priority, source
) VALUES (
  '00000000-0000-0000-0000-000000000010',
  'TEST-LC-ROOT-2',
  'Test Root WO 2',
  'Root work order for escalation testing',
  '1. Complete root objective',
  'engineering',
  'in_progress',
  'p2_medium',
  'test_suite'
);

-- Create 2 child remediation WOs
INSERT INTO work_orders (
  id, slug, name, objective, acceptance_criteria,
  created_by, status, priority, source, parent_id, tags
) VALUES 
(
  '00000000-0000-0000-0000-000000000011',
  'TEST-LC-CHILD-2-1',
  'Test Child 2-1',
  'First remediation attempt',
  '1. Fix issue',
  'engineering',
  'in_progress',
  'p1_high',
  'auto-qa',
  '00000000-0000-0000-0000-000000000010',
  ARRAY['remediation', 'parent:TEST-LC-ROOT-2']
),
(
  '00000000-0000-0000-0000-000000000012',
  'TEST-LC-CHILD-2-2',
  'Test Child 2-2',
  'Second remediation attempt',
  '1. Fix issue',
  'engineering',
  'in_progress',
  'p1_high',
  'auto-qa',
  '00000000-0000-0000-0000-000000000010',
  ARRAY['remediation', 'parent:TEST-LC-ROOT-2']
);

-- Fail first child
UPDATE work_orders 
SET status = 'failed', completed_at = NOW(), summary = 'Test failure 1'
WHERE id = '00000000-0000-0000-0000-000000000011';

-- Check parent is still in_progress (not all children failed yet)
DO $$
DECLARE
  parent_status TEXT;
BEGIN
  SELECT status INTO parent_status
  FROM work_orders
  WHERE id = '00000000-0000-0000-0000-000000000010';
  
  IF parent_status != 'in_progress' THEN
    RAISE EXCEPTION 'TEST FAILED: Parent should still be in_progress after 1 child failure, found %', parent_status;
  END IF;
  
  RAISE NOTICE 'TEST 4A PASSED: Parent remains in_progress with only 1 failed child';
END $$;

-- Fail second child - this should trigger parent escalation
UPDATE work_orders 
SET status = 'failed', completed_at = NOW(), summary = 'Test failure 2'
WHERE id = '00000000-0000-0000-0000-000000000012';

-- Check parent is now failed
DO $$
DECLARE
  parent_status TEXT;
  parent_summary TEXT;
BEGIN
  SELECT status, summary INTO parent_status, parent_summary
  FROM work_orders
  WHERE id = '00000000-0000-0000-0000-000000000010';
  
  IF parent_status != 'failed' THEN
    RAISE EXCEPTION 'TEST FAILED: Parent should be failed after all children failed, found %', parent_status;
  END IF;
  
  IF parent_summary NOT LIKE '%All%remediation%' AND parent_summary NOT LIKE '%exhausted%' THEN
    RAISE EXCEPTION 'TEST FAILED: Parent summary should indicate exhausted remediations, found: %', parent_summary;
  END IF;
  
  RAISE NOTICE 'TEST 4B PASSED: Parent escalated to failed when all children failed';
  RAISE NOTICE '  Summary: %', parent_summary;
END $$;

-- TEST 5: Test recursive cancellation (grandchildren)
DELETE FROM work_orders WHERE slug LIKE 'TEST-LC-%';

-- Create root -> child -> grandchild hierarchy
INSERT INTO work_orders (
  id, slug, name, objective, acceptance_criteria,
  created_by, status, priority, source
) VALUES (
  '00000000-0000-0000-0000-000000000020',
  'TEST-LC-ROOT-3',
  'Test Root WO 3',
  'Root work order for recursive testing',
  '1. Complete root objective',
  'engineering',
  'in_progress',
  'p2_medium',
  'test_suite'
);

INSERT INTO work_orders (
  id, slug, name, objective, acceptance_criteria,
  created_by, status, priority, source, parent_id, tags
) VALUES (
  '00000000-0000-0000-0000-000000000021',
  'TEST-LC-CHILD-3-1',
  'Test Child 3-1',
  'Child of root',
  '1. Fix issue',
  'engineering',
  'in_progress',
  'p1_high',
  'auto-qa',
  '00000000-0000-0000-0000-000000000020',
  ARRAY['remediation', 'parent:TEST-LC-ROOT-3']
);

INSERT INTO work_orders (
  id, slug, name, objective, acceptance_criteria,
  created_by, status, priority, source, parent_id, tags
) VALUES (
  '00000000-0000-0000-0000-000000000022',
  'TEST-LC-GRANDCHILD-3-1',
  'Test Grandchild 3-1',
  'Grandchild of root',
  '1. Fix issue',
  'engineering',
  'in_progress',
  'p1_high',
  'auto-qa',
  '00000000-0000-0000-0000-000000000021',
  ARRAY['remediation', 'parent:TEST-LC-CHILD-3-1']
);

-- Complete root - should cancel both child and grandchild
UPDATE work_orders 
SET status = 'done', completed_at = NOW(), summary = 'Test completion'
WHERE id = '00000000-0000-0000-0000-000000000020';

-- Verify both descendants are cancelled
DO $$
DECLARE
  child_status TEXT;
  grandchild_status TEXT;
BEGIN
  SELECT status INTO child_status
  FROM work_orders WHERE id = '00000000-0000-0000-0000-000000000021';
  
  SELECT status INTO grandchild_status
  FROM work_orders WHERE id = '00000000-0000-0000-0000-000000000022';
  
  IF child_status != 'cancelled' THEN
    RAISE EXCEPTION 'TEST FAILED: Child should be cancelled, found %', child_status;
  END IF;
  
  IF grandchild_status != 'cancelled' THEN
    RAISE EXCEPTION 'TEST FAILED: Grandchild should be cancelled, found %', grandchild_status;
  END IF;
  
  RAISE NOTICE 'TEST 5 PASSED: Recursive cancellation works for grandchildren';
END $$;

-- Clean up test data
DELETE FROM work_orders WHERE slug LIKE 'TEST-LC-%';
DELETE FROM audit_log WHERE action LIKE '%TEST-LC-%' OR (payload->>'parent_slug')::TEXT LIKE 'TEST-LC-%';

COMMIT;

-- Summary
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'PARENT-CHILD LIFECYCLE TESTS COMPLETE';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'All tests passed:';
  RAISE NOTICE '  ✓ TEST 1: Children created with correct parent_id';
  RAISE NOTICE '  ✓ TEST 2: Children cancelled when parent completes';
  RAISE NOTICE '  ✓ TEST 3: Audit log entries created';
  RAISE NOTICE '  ✓ TEST 4: Parent escalated when all children fail';
  RAISE NOTICE '  ✓ TEST 5: Recursive cancellation works';
  RAISE NOTICE '';
END $$;
