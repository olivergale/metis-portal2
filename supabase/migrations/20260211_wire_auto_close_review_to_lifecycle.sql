-- WO-0370: Wire auto_close_review_on_qa_pass to evaluate_wo_lifecycle
-- This trigger auto-closes review WOs when all QA checklist items pass
-- Add lifecycle gate to verify WO is not moot before auto-closing

CREATE OR REPLACE FUNCTION auto_close_review_on_qa_pass()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_all_pass boolean := true;
  v_has_items boolean := false;
  v_lifecycle_verdict JSONB;
BEGIN
  -- Only act on review WOs with a checklist update
  IF NEW.status != 'review' THEN
    RETURN NEW;
  END IF;
  
  -- Only act if qa_checklist actually changed
  IF OLD.qa_checklist IS NOT DISTINCT FROM NEW.qa_checklist THEN
    RETURN NEW;
  END IF;
  
  -- Check if all checklist items are pass or na (none pending/fail)
  IF NEW.qa_checklist IS NULL OR jsonb_array_length(NEW.qa_checklist) = 0 THEN
    RETURN NEW;
  END IF;
  
  FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.qa_checklist)
  LOOP
    v_has_items := true;
    IF v_item->>'status' NOT IN ('pass', 'na') THEN
      v_all_pass := false;
      EXIT;
    END IF;
  END LOOP;
  
  IF v_has_items AND v_all_pass THEN
    -- WO-0370: Check lifecycle before auto-closing
    v_lifecycle_verdict := evaluate_wo_lifecycle(NEW.id, 'qa_verdict');
    
    -- Log verdict
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (NEW.id, 'stream', 'qa-gate',
      jsonb_build_object(
        'event_type', 'lifecycle_gate_check',
        'action', 'auto_close_on_qa_pass',
        'verdict', v_lifecycle_verdict
      )
    );
    
    -- Only close if verdict allows it
    IF (v_lifecycle_verdict->>'verdict') IN ('proceed', 'skip') THEN
      -- Use bypass to transition review → done
      PERFORM set_config('app.wo_executor_bypass', 'true', true);
      NEW.status := 'done';
      NEW.completed_at := NOW();
      IF NEW.summary IS NULL OR NEW.summary = '' THEN
        NEW.summary := 'Auto-closed: all QA checklist items passed';
      END IF;
      
      -- Log the auto-close
      INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
      VALUES (NEW.id, 'execution_complete', 'qa-gate',
        jsonb_build_object(
          'event_type', 'auto_close_qa_pass',
          'content', format('Auto-closed %s: all %s checklist items passed', NEW.slug, jsonb_array_length(NEW.qa_checklist)),
          'checklist_items', jsonb_array_length(NEW.qa_checklist)
        )
      );
    ELSE
      -- Don't auto-close
      RAISE NOTICE 'Skipping auto-close for %: %', NEW.slug, v_lifecycle_verdict->>'reason';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Recreate trigger (no change to trigger definition, just ensuring function is updated)
DROP TRIGGER IF EXISTS trg_auto_close_review_on_qa_pass ON work_orders;
CREATE TRIGGER trg_auto_close_review_on_qa_pass
  BEFORE UPDATE ON work_orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_close_review_on_qa_pass();
