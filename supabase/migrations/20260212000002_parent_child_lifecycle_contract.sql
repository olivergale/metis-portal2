-- WO-0455: Parent-child WO lifecycle contract
-- Implements automatic lifecycle management for parent-child work orders
-- Addresses gaps: remediation chains, autonomous settlement, orphan prevention, escalation

-- ============================================================================
-- AC#2: settle_children_on_parent_terminal() trigger
-- Cancels ALL descendant WOs when parent reaches done/cancelled status
-- ============================================================================

CREATE OR REPLACE FUNCTION settle_children_on_parent_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_child RECORD;
  v_cancelled_count INT := 0;
BEGIN
  -- Only act when parent transitions TO terminal state (done or cancelled)
  IF NEW.status NOT IN ('done', 'cancelled') THEN
    RETURN NEW;
  END IF;
  
  -- Only act if status actually changed to terminal
  IF OLD.status IN ('done', 'cancelled') THEN
    RETURN NEW;
  END IF;
  
  -- Recursively cancel all descendants (children, grandchildren, etc.)
  -- Use WITH RECURSIVE to walk the tree
  WITH RECURSIVE descendants AS (
    -- Base case: direct children
    SELECT id, slug, status, parent_id
    FROM work_orders
    WHERE parent_id = NEW.id
    
    UNION ALL
    
    -- Recursive case: children of children
    SELECT wo.id, wo.slug, wo.status, wo.parent_id
    FROM work_orders wo
    INNER JOIN descendants d ON wo.parent_id = d.id
  )
  UPDATE work_orders
  SET 
    status = 'cancelled',
    completed_at = NOW(),
    summary = COALESCE(summary, '') || 
      format(' [Auto-cancelled: parent %s reached %s status]', NEW.slug, NEW.status),
    cancellation_reason = format('Parent %s completed with status: %s', NEW.slug, NEW.status)
  WHERE id IN (
    SELECT id FROM descendants
    WHERE status NOT IN ('done', 'cancelled', 'failed')
  );
  
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;
  
  -- Log each cancellation to audit_log
  IF v_cancelled_count > 0 THEN
    FOR v_child IN 
      WITH RECURSIVE descendants AS (
        SELECT id, slug, status FROM work_orders WHERE parent_id = NEW.id
        UNION ALL
        SELECT wo.id, wo.slug, wo.status FROM work_orders wo
        INNER JOIN descendants d ON wo.parent_id = d.id
      )
      SELECT id, slug FROM descendants
    LOOP
      INSERT INTO audit_log (
        event_type, actor_type, actor_id,
        target_type, target_id,
        action, payload
      ) VALUES (
        'lifecycle_settlement',
        'system',
        'lifecycle_trigger',
        'work_order',
        v_child.id,
        format('Auto-cancelled child %s due to parent %s terminal status', v_child.slug, NEW.slug),
        jsonb_build_object(
          'parent_id', NEW.id,
          'parent_slug', NEW.slug,
          'parent_status', NEW.status,
          'child_slug', v_child.slug,
          'reason', 'parent_terminal_settlement'
        )
      );
    END LOOP;
    
    -- Log summary to parent execution log
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (
      NEW.id,
      'stream',
      'lifecycle_trigger',
      jsonb_build_object(
        'event_type', 'lifecycle_settlement',
        'content', format('Auto-cancelled %s descendant WOs due to parent %s status', 
          v_cancelled_count, NEW.status),
        'cancelled_count', v_cancelled_count,
        'parent_status', NEW.status
      )
    );
  END IF;
  
  RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists (WO-0452 legacy trigger)
DROP TRIGGER IF EXISTS trg_cancel_remediation_children_on_parent_done ON work_orders;

-- Create new comprehensive trigger
DROP TRIGGER IF EXISTS trg_settle_children_on_parent_terminal ON work_orders;
CREATE TRIGGER trg_settle_children_on_parent_terminal
  AFTER UPDATE ON work_orders
  FOR EACH ROW
  WHEN (NEW.status IN ('done', 'cancelled') AND OLD.status NOT IN ('done', 'cancelled'))
  EXECUTE FUNCTION settle_children_on_parent_terminal();

-- ============================================================================
-- AC#3: escalate_parent_on_all_children_failed() trigger
-- Marks parent as failed when ALL child remediations have failed
-- ============================================================================

CREATE OR REPLACE FUNCTION escalate_parent_on_all_children_failed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent_id UUID;
  v_parent_slug TEXT;
  v_total_children INT;
  v_failed_children INT;
  v_terminal_children INT;
  v_parent_status TEXT;
BEGIN
  -- Only act when a child transitions TO failed status
  IF NEW.status != 'failed' THEN
    RETURN NEW;
  END IF;
  
  -- Only act if status actually changed to failed
  IF OLD.status = 'failed' THEN
    RETURN NEW;
  END IF;
  
  -- Only act if this WO has a parent
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Get parent info and check if it's already terminal
  SELECT id, slug, status INTO v_parent_id, v_parent_slug, v_parent_status
  FROM work_orders
  WHERE id = NEW.parent_id;
  
  IF NOT FOUND OR v_parent_status IN ('done', 'cancelled', 'failed') THEN
    -- Parent already terminal, nothing to do
    RETURN NEW;
  END IF;
  
  -- Count all children of this parent (siblings of the newly failed WO)
  SELECT COUNT(*) INTO v_total_children
  FROM work_orders
  WHERE parent_id = v_parent_id;
  
  -- Count how many are in terminal-failed state
  SELECT COUNT(*) INTO v_failed_children
  FROM work_orders
  WHERE parent_id = v_parent_id
  AND status = 'failed';
  
  -- Count ALL terminal states (done, cancelled, failed)
  SELECT COUNT(*) INTO v_terminal_children
  FROM work_orders
  WHERE parent_id = v_parent_id
  AND status IN ('done', 'cancelled', 'failed');
  
  -- If ALL children are in terminal state AND ALL terminal children are failed
  -- (i.e., no child succeeded), escalate parent to failed
  IF v_terminal_children = v_total_children AND v_failed_children = v_total_children THEN
    -- Use bypass to transition parent to failed
    PERFORM set_config('app.wo_executor_bypass', 'true', true);
    
    UPDATE work_orders
    SET 
      status = 'failed',
      completed_at = NOW(),
      summary = format('All %s remediation attempts exhausted. Review required.', v_total_children)
    WHERE id = v_parent_id
    AND status NOT IN ('done', 'cancelled', 'failed');
    
    -- Log escalation
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (
      v_parent_id,
      'failed',
      'lifecycle_trigger',
      jsonb_build_object(
        'event_type', 'remediation_exhausted',
        'content', format('All %s child remediations failed. Parent %s escalated to failed.', 
          v_total_children, v_parent_slug),
        'failed_children_count', v_failed_children,
        'total_children_count', v_total_children,
        'trigger_child_slug', NEW.slug
      )
    );
    
    -- Log to audit_log
    INSERT INTO audit_log (
      event_type, actor_type, actor_id,
      target_type, target_id,
      action, payload
    ) VALUES (
      'lifecycle_escalation',
      'system',
      'lifecycle_trigger',
      'work_order',
      v_parent_id,
      format('Parent %s escalated to failed: all %s child remediations exhausted', 
        v_parent_slug, v_total_children),
      jsonb_build_object(
        'parent_id', v_parent_id,
        'parent_slug', v_parent_slug,
        'failed_children_count', v_failed_children,
        'total_children_count', v_total_children,
        'last_failed_child', NEW.slug,
        'reason', 'all_remediations_failed'
      )
    );
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_escalate_parent_on_all_children_failed ON work_orders;
CREATE TRIGGER trg_escalate_parent_on_all_children_failed
  AFTER UPDATE ON work_orders
  FOR EACH ROW
  WHEN (NEW.status = 'failed' AND OLD.status != 'failed')
  EXECUTE FUNCTION escalate_parent_on_all_children_failed();

-- ============================================================================
-- Verification queries (run manually to verify triggers work)
-- ============================================================================

-- Check trigger installation
-- SELECT 
--   tgname as trigger_name,
--   tgrelid::regclass as table_name,
--   tgenabled as enabled
-- FROM pg_trigger
-- WHERE tgname IN (
--   'trg_settle_children_on_parent_terminal',
--   'trg_escalate_parent_on_all_children_failed'
-- );

-- Check function definitions
-- SELECT 
--   proname as function_name,
--   prosrc as source_snippet
-- FROM pg_proc
-- WHERE proname IN (
--   'settle_children_on_parent_terminal',
--   'escalate_parent_on_all_children_failed'
-- );
