-- WO-0410: Auto-remediation trigger on QA failure
-- When qa_checklist is updated on a review WO with any fail items,
-- auto-transition to failed status. The existing trg_auto_failure_cascade
-- AFTER trigger will then create a remediation WO via smart_restart_chain.

-- Trigger function: auto-fail review WOs when QA checklist has failures
CREATE OR REPLACE FUNCTION auto_fail_review_on_qa_failure()
RETURNS TRIGGER AS $$
DECLARE
  v_item jsonb;
  v_has_fail boolean := false;
  v_fail_items text[] := '{}';
  v_fail_count int := 0;
  v_total_count int := 0;
BEGIN
  -- Only act on review WOs
  IF NEW.status != 'review' THEN
    RETURN NEW;
  END IF;
  
  -- Only act if qa_checklist actually changed
  IF OLD.qa_checklist IS NOT DISTINCT FROM NEW.qa_checklist THEN
    RETURN NEW;
  END IF;
  
  -- Skip if no checklist
  IF NEW.qa_checklist IS NULL OR jsonb_array_length(NEW.qa_checklist) = 0 THEN
    RETURN NEW;
  END IF;
  
  -- Check for any fail items in qa_checklist
  FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.qa_checklist)
  LOOP
    v_total_count := v_total_count + 1;
    IF v_item->>'status' = 'fail' THEN
      v_has_fail := true;
      v_fail_count := v_fail_count + 1;
      v_fail_items := array_append(v_fail_items, 
        format('%s: %s', v_item->>'id', v_item->>'criterion'));
    END IF;
  END LOOP;
  
  -- If no failures, let other triggers handle (e.g. auto_close on all pass)
  IF NOT v_has_fail THEN
    RETURN NEW;
  END IF;
  
  -- Skip if WO is tagged remediation to avoid infinite loops
  IF NEW.tags IS NOT NULL AND 'remediation' = ANY(NEW.tags) THEN
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (NEW.id, 'qa_validation', 'system',
      jsonb_build_object(
        'event_type', 'qa_fail_skip_remediation',
        'content', format('Skipping auto-fail for remediation WO %s', NEW.slug),
        'fail_count', v_fail_count
      )
    );
    RETURN NEW;
  END IF;
  
  -- Set enforcement bypass (same pattern as auto_close_review_on_qa_pass)
  PERFORM set_config('app.wo_executor_bypass', 'true', true);
  
  -- Transition to failed
  NEW.status := 'failed';
  NEW.completed_at := NOW();
  NEW.summary := format('Auto-failed by QA: %s of %s checklist items failed. Failures: %s',
    v_fail_count, v_total_count, array_to_string(v_fail_items, '; '));
  
  -- Log the auto-fail action
  INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
  VALUES (NEW.id, 'qa_validation', 'qa-gate',
    jsonb_build_object(
      'event_type', 'auto_fail_qa_failure',
      'content', format('Auto-failed %s: %s of %s QA checklist items failed', NEW.slug, v_fail_count, v_total_count),
      'fail_count', v_fail_count,
      'total_count', v_total_count,
      'fail_items', to_jsonb(v_fail_items)
    )
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger: fires BEFORE UPDATE when qa_checklist changes on review WOs
-- Named 'b_' prefix so it fires AFTER auto_close_review_on_qa_pass (which is 'a_' alphabetically)
-- Actually both fire on the same WHEN condition, Postgres fires alphabetically.
-- trg_auto_close_review_on_qa_pass fires first (c < f), checks for all-pass.
-- trg_auto_fail_review_on_qa_failure fires second, checks for any-fail.
-- If auto_close already changed status to 'done', the fail trigger sees status != 'review' and exits.
DROP TRIGGER IF EXISTS trg_auto_fail_review_on_qa_failure ON work_orders;
CREATE TRIGGER trg_auto_fail_review_on_qa_failure
  BEFORE UPDATE ON work_orders
  FOR EACH ROW
  WHEN (NEW.status = 'review' AND OLD.qa_checklist IS DISTINCT FROM NEW.qa_checklist)
  EXECUTE FUNCTION auto_fail_review_on_qa_failure();
