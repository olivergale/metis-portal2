-- WO-0473: Tighten remediation depth guard from 3 to 1
-- Kill QA cascade: only one Fix: child per root WO to eliminate $64/week burn
-- Changes:
-- 1. Depth guard: v_depth >= 3 → v_depth >= 1
-- 2. Error message: "Manual intervention required" → "Flagged for human review"

CREATE OR REPLACE FUNCTION spawn_remediation_on_qa_failure()
RETURNS TRIGGER AS $$
DECLARE
  v_item jsonb;
  v_has_fail boolean := false;
  v_fail_descriptions text[] := '{}';
  v_fail_count int := 0;
  v_total_count int := 0;
  v_active_children int;
  v_remediation_slug text;
  v_remediation_id uuid;
  v_next_number int;
  v_parent_ac text;
  v_depth int := 0;
  v_walk_id uuid;
BEGIN
  -- Only act on review WOs with a checklist change
  IF NEW.status != 'review' THEN
    RETURN NEW;
  END IF;

  IF OLD.qa_checklist IS NOT DISTINCT FROM NEW.qa_checklist THEN
    RETURN NEW;
  END IF;

  IF NEW.qa_checklist IS NULL OR jsonb_array_length(NEW.qa_checklist) = 0 THEN
    RETURN NEW;
  END IF;

  -- DEPTH GUARD: Walk parent_id chain counting remediation ancestors. Max 1.
  v_walk_id := NEW.parent_id;
  WHILE v_walk_id IS NOT NULL AND v_depth < 4 LOOP
    v_depth := v_depth + 1;
    SELECT parent_id INTO v_walk_id FROM work_orders WHERE id = v_walk_id;
  END LOOP;

  -- AC#1: Changed from v_depth >= 3 to v_depth >= 1
  IF v_depth >= 1 THEN
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (NEW.id, 'qa_validation', 'qa-gate',
      jsonb_build_object(
        'event_type', 'remediation_depth_exceeded',
        -- AC#2: Changed message to "Flagged for human review"
        'content', format('Remediation depth %s exceeds max 1 for %s. No further children will be spawned. Flagged for human review.', v_depth, NEW.slug),
        'depth', v_depth
      )
    );
    RETURN NEW;
  END IF;

  -- Check for any fail items
  FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.qa_checklist)
  LOOP
    v_total_count := v_total_count + 1;
    IF v_item->>'status' = 'fail' THEN
      v_has_fail := true;
      v_fail_count := v_fail_count + 1;
      v_fail_descriptions := array_append(v_fail_descriptions,
        format('- %s', left(v_item->>'criterion', 200)));
    END IF;
  END LOOP;

  -- No fails = let auto_close_review_on_qa_pass handle it
  IF NOT v_has_fail THEN
    RETURN NEW;
  END IF;

  -- GUARD: Skip if active remediation children already exist for this WO
  SELECT count(*) INTO v_active_children
  FROM work_orders
  WHERE parent_id = NEW.id
    AND 'remediation' = ANY(tags)
    AND status IN ('draft', 'ready', 'in_progress', 'review');

  IF v_active_children > 0 THEN
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (NEW.id, 'qa_validation', 'qa-gate',
      jsonb_build_object(
        'event_type', 'remediation_spawn_skipped',
        'content', format('Skipped remediation spawn for %s: %s active remediation children already exist', NEW.slug, v_active_children),
        'active_children', v_active_children
      )
    );
    RETURN NEW;
  END IF;

  -- Generate next slug
  SELECT COALESCE(MAX(
    CASE WHEN slug ~ '^WO-[0-9]{4}$' THEN CAST(SUBSTRING(slug FROM 4) AS INTEGER) ELSE 0 END
  ), 0) + 1 INTO v_next_number FROM work_orders;
  v_remediation_slug := 'WO-' || LPAD(v_next_number::text, 4, '0');

  -- Build remediation AC from failed items
  v_parent_ac := format('1. Fix the following QA failures from %s:\n%s\n2. Re-run verification to confirm fixes address the failed criteria\n3. Call resolve_qa_findings for parent WO %s to clear blocking findings',
    NEW.slug, array_to_string(v_fail_descriptions, E'\n'), NEW.id);

  PERFORM set_config('app.state_write_bypass', 'true', true);

  INSERT INTO work_orders (
    id, slug, name, objective, acceptance_criteria, priority, status,
    created_by, source, tags, requires_approval, parent_id
  ) VALUES (
    gen_random_uuid(), v_remediation_slug,
    format('Fix: %s QA failures (%s)', NEW.slug, NEW.name),
    format('Remediation for %s which has %s of %s QA criteria failing. Fix the identified issues and resolve QA findings on the parent.',
      NEW.slug, v_fail_count, v_total_count),
    v_parent_ac,
    NEW.priority,
    'draft'::work_order_status,
    'engineering', 'auto-qa',
    ARRAY['remediation', 'auto-qa', format('parent:%s', NEW.slug)],
    false,
    NEW.id
  ) RETURNING id INTO v_remediation_id;

  PERFORM set_config('app.state_write_bypass', 'false', true);

  -- Log
  INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
  VALUES (NEW.id, 'qa_validation', 'qa-gate',
    jsonb_build_object(
      'event_type', 'remediation_spawned',
      'content', format('QA found %s failures on %s. Created remediation child %s (depth %s). Parent stays in review.', v_fail_count, NEW.slug, v_remediation_slug, v_depth),
      'remediation_slug', v_remediation_slug,
      'remediation_id', v_remediation_id,
      'fail_count', v_fail_count,
      'depth', v_depth,
      'parent_stays_in_review', true
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
