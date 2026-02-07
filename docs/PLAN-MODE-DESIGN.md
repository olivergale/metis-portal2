# Plan Mode Design Document

**Version**: 1.0
**Status**: Retroactive Documentation (deployed in portal-chat v39)
**Created**: 2026-02-06
**Author**: METIS System Documentation

## Overview

Plan mode is a conversational state within the METIS portal chat that enables multi-turn exploratory conversations for scoping, refining, and planning implementations before committing to work order creation. It implements a 3-way intent classification system (QUESTION, PLAN, BUILD) that allows users to seamlessly transition between asking questions, planning implementations, and triggering actual builds.

## Background

Prior to plan mode (v37 and earlier), the system had a binary classification:
- **QUESTION**: Answer user questions about status, system state, etc.
- **BUILD**: Detect build intent and immediately create work orders

This created a poor user experience when users wanted to explore ideas, discuss architectures, or refine requirements before committing to implementation. The system would either:
1. Prematurely create work orders for exploratory discussions
2. Miss legitimate build requests that didn't match exact patterns

Plan mode (v38+) introduced an intermediate state that allows exploratory conversation without immediate commitment.

## Intent Classification

### Three Intent Types

#### 1. QUESTION Intent
**Detection Pattern**: Questions about system state, status, or information retrieval
```javascript
const isQuestion = /\?|what|where|how|why|when|who|status|summary|summarize|pick up|left off|current|show me|list|check|tell me|explain|which|can you/i.test(msgLower);
```

**System Behavior**:
- Answer from loaded context
- No state changes
- No work order creation
- Standard conversational response

#### 2. PLAN Intent
**Detection Pattern**: Phrases indicating desire to explore or scope
```javascript
const planPhrases = [
  "let's plan", "help me plan", "plan out", "scope out",
  "what would it take", "how should we approach",
  "think about building", "explore options", "design approach",
  "/plan", "enter plan mode", "planning mode"
];
const isPlanRequest = planPhrases.some(p => msgLower.includes(p));
```

**System Behavior**:
- Set `thread_metadata.plan_mode = true`
- Record `plan_started_at` timestamp
- Store `plan_topic` (first 200 chars of triggering message)
- Update UI to show plan mode badge
- Enable multi-turn exploratory conversation
- **Block work order creation** even if build patterns detected

#### 3. BUILD Intent
**Detection Pattern**: Concrete build requests with technical nouns
```javascript
const buildPhrases = [
  "create a", "build a", "build me", "implement a", "deploy a",
  "add a new", "write a", "make a", "make me", "set up a",
  "i want a", "i need a", "i want to build", "i need to build",
  "let's build", "can you build", "help me build"
];
const techNouns = [
  "function", "endpoint", "api", "table", "schema", "component",
  "feature", "service", "webhook", "integration", "app", "application",
  "website", "site", "platform", "tool", "dashboard", "system",
  "project", "bot", "backend", "frontend"
];
const hasBuildPhrase = buildPhrases.some(p => msgLower.includes(p));
const hasTechNoun = techNouns.some(n => msgLower.includes(n));
const shouldCreateWorkOrder = !isQuestion && hasBuildPhrase && hasTechNoun && !isInPlanMode;
```

**System Behavior**:
- If NOT in plan mode: Trigger build flow (project creation, interrogation, WO creation)
- If IN plan mode: Continue planning conversation until explicit transition

## State Transitions

### Entering Plan Mode

**Trigger**: User message matches plan intent patterns
**Implementation**: `portal-chat/index.ts:1003-1010`

```javascript
if (isPlanRequest && !isInPlanMode) {
  await updateThreadMetadata(supabase, thread_id, {
    plan_mode: true,
    plan_started_at: new Date().toISOString(),
    plan_topic: message.slice(0, 200)
  });
  isInPlanMode = true;
}
```

**State Changes**:
- `conversation_threads.metadata.plan_mode` → `true`
- `conversation_threads.metadata.plan_started_at` → ISO timestamp
- `conversation_threads.metadata.plan_topic` → String (200 char limit)

**UI Changes**:
- Plan badge becomes visible with pulsing dot indicator
- "Build it" button appears in header
- Input placeholder changes to "Explore your idea with METIS..."

### Transitioning from Plan to Build

**Trigger**: User message matches build transition patterns while in plan mode
**Implementation**: `portal-chat/index.ts:996-1002`

```javascript
const buildTransitionPhrases = [
  "build it", "let's build this", "start building",
  "approve the plan", "ready to build", "go ahead and build",
  "make it happen", "execute the plan", "ship it",
  "/build", "let's do it"
];
const isBuildTransition = buildTransitionPhrases.some(p => msgLower.includes(p));

if (isInPlanMode && isBuildTransition) {
  await updateThreadMetadata(supabase, thread_id, {
    plan_mode: false,
    plan_transitioned_to_build: true,
    plan_ended_at: new Date().toISOString()
  });
  isInPlanMode = false;
  // Fall through to build intent detection
}
```

**State Changes**:
- `conversation_threads.metadata.plan_mode` → `false`
- `conversation_threads.metadata.plan_transitioned_to_build` → `true`
- `conversation_threads.metadata.plan_ended_at` → ISO timestamp

**Subsequent Behavior**:
- Build intent detection runs on the same message
- If build patterns match, triggers project creation or WO creation
- UI returns to normal state

### Exiting Plan Mode (without building)

**Trigger**: User starts new chat thread
**Implementation**: `index.html:1006`

```javascript
function startNewChat() {
  // ... thread creation logic ...
  updatePlanModeUI(false);  // Reset plan mode UI
}
```

**State Changes**:
- New thread created with no plan mode metadata
- UI resets to normal state

## Frontend Implementation

### UI Components

#### Plan Mode Badge
**Location**: `index.html:810-813`, `index.html:573-583`

```html
<div class="plan-badge" id="planBadge">
  <span class="plan-badge-dot"></span>
  <span>Plan Mode</span>
</div>
```

**CSS**:
```css
.plan-badge {
  display: none; /* Hidden by default */
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: 12px;
  font-size: 12px;
  color: #3b82f6;
}
.plan-badge.active { display: flex; }
.plan-badge-dot {
  width: 6px; height: 6px;
  background: #3b82f6;
  border-radius: 50%;
  animation: pulse 2s infinite;
}
```

#### Build Button
**Location**: `index.html:851`, `index.html:584-591`

```html
<button class="build-btn" id="buildBtn" onclick="sendBuild()">Build it</button>
```

**CSS**:
```css
.build-btn {
  display: none; /* Hidden by default */
  padding: 6px 16px;
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  border: none;
  border-radius: 6px;
  color: white;
  font-weight: 500;
  cursor: pointer;
}
.build-btn.active { display: block; }
```

**JavaScript**:
```javascript
function sendBuild() {
  document.getElementById('input').value = 'Build it';
  send();
}
```

### State Management

**Location**: `index.html:1160-1163`, `index.html:1266-1276`

```javascript
// Track plan mode from backend response
if (data.context?.plan_mode !== undefined) {
  updatePlanModeUI(data.context.plan_mode);
}

// UI update function
function updatePlanModeUI(active) {
  isPlanMode = active;
  document.getElementById('planBadge').classList.toggle('active', active);
  document.getElementById('buildBtn').classList.toggle('active', active);
  document.getElementById('input').placeholder = active
    ? 'Explore your idea with METIS...'
    : 'Message METIS...';
}
```

## Backend Implementation

### System Prompt Modification

**Location**: `portal-chat/index.ts:1066-1077`

When plan mode is active, the system prompt includes:

```javascript
const planModeSection = isInPlanMode
  ? '\n## PLAN MODE ACTIVE\nYou are in PLAN MODE. Help the user explore, scope, and refine their idea through multi-turn conversation.\n- Ask clarifying questions to understand requirements, constraints, and goals\n- Suggest architecture patterns, technology choices, and trade-offs\n- Help estimate scope, complexity, and potential risks\n- Structure your responses as evolving plans (use headers, bullet points, tables)\n- Do NOT create work orders or trigger builds yet\n- Do NOT say you cannot plan — you ARE planning\n- When the user is satisfied, tell them to say "build it" or "let\'s build" to transition to build mode and create work orders\n- Keep track of decisions made during the planning conversation\n'
  : '';
```

This instructs Claude to:
1. Engage in exploratory conversation
2. Ask clarifying questions
3. Suggest options and trade-offs
4. Structure responses as plans
5. NOT create work orders
6. Guide users to transition explicitly

### Work Order Creation Guard

**Location**: `portal-chat/index.ts:1045-1047`

```javascript
// v38: Don't create WOs when in plan mode — user must explicitly transition with "build it"
const shouldCreateWorkOrder = !isQuestion && hasBuildPhrase && hasTechNoun && !isInPlanMode;
```

The `!isInPlanMode` guard prevents accidental work order creation during planning conversations, even if build patterns are detected.

### Thread Metadata Storage

Plan mode state is persisted in `conversation_threads.metadata` JSONB field:

```json
{
  "plan_mode": true,
  "plan_started_at": "2026-02-06T20:15:30.123Z",
  "plan_topic": "I want to build a multi-tenant SaaS platform with user authentication",
  "plan_transitioned_to_build": false,
  "plan_ended_at": null
}
```

**Helper Functions**: `portal-chat/index.ts:61-77`
- `getThreadMetadata(supabase, threadId)` - Retrieve metadata
- `updateThreadMetadata(supabase, threadId, updates)` - Merge updates

## UX Flow

### Typical Plan Mode Session

1. **User**: "Let's plan out a new API endpoint for user management"
2. **System**:
   - Detects plan intent
   - Enters plan mode
   - UI shows plan badge + build button
   - Response: Asks clarifying questions about requirements
3. **User**: "It should support CRUD operations on users with role-based access"
4. **System**:
   - Still in plan mode
   - Response: Discusses authentication strategies, database schema, API design patterns
5. **User**: "Let's use JWT tokens and PostgreSQL with RLS"
6. **System**:
   - Still in plan mode
   - Response: Outlines implementation approach, discusses trade-offs
7. **User**: "Build it" OR clicks "Build it" button
8. **System**:
   - Detects build transition
   - Exits plan mode
   - Triggers project creation → interrogation → WO decomposition
   - Response: Confirms WO creation

### Edge Case: Direct Build Request (No Planning)

1. **User**: "Build me a REST API for managing todos"
2. **System**:
   - Detects build intent (NOT in plan mode)
   - Immediately triggers project creation
   - Starts interrogation if new project
   - OR creates WO if existing project passes intake gate

### Edge Case: Question During Plan Mode

1. **User** (in plan mode): "What's the status of WO-123?"
2. **System**:
   - Still in plan mode (doesn't exit)
   - Answers the question from context
   - Maintains plan mode state for next message

## Data Model

### Database Schema

#### conversation_threads Table
```sql
CREATE TABLE conversation_threads (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id text NOT NULL,
  title text,
  metadata jsonb DEFAULT '{}'::jsonb,  -- Stores plan_mode state
  message_count integer DEFAULT 0,
  total_cost_usd numeric(10,4) DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

#### Metadata Structure
```typescript
interface ThreadMetadata {
  plan_mode?: boolean;
  plan_started_at?: string;  // ISO timestamp
  plan_ended_at?: string;    // ISO timestamp
  plan_topic?: string;       // First 200 chars
  plan_transitioned_to_build?: boolean;
  // ... other fields for interrogation, etc.
}
```

## Context Propagation

### Backend → Frontend

**Response Object**: `portal-chat/index.ts:1263-1277`

```javascript
return respond({
  thread_id,
  message: assistantContent,
  context: {
    plan_mode: isInPlanMode,
    plan_topic: isInPlanMode ? (threadMeta.plan_topic || null) : null,
    // ... other context fields
  }
});
```

### Frontend → Backend

Plan mode state is read from thread metadata on each request:

```javascript
const threadMeta = await getThreadMetadata(supabase, thread_id);
let isInPlanMode = threadMeta.plan_mode === true;
```

No explicit client-side state tracking needed — backend is source of truth.

## Integration with Other Features

### Conversational Interrogation

When a new project is created during plan mode transition, the system:
1. Creates project brief
2. Starts interrogation session
3. Plan mode context can inform interrogation responses
4. Plan topic is NOT automatically used to prefill answers (user must respond conversationally)

### Intake Gate

If build transition triggers WO creation for existing project:
1. Check intake gate (`check_project_intake_ready`)
2. If missing docs, auto-start interrogation
3. Defer WO creation until docs generated
4. Plan mode exits regardless (state change already committed)

### Work Order Creation

When transitioning from plan to build:
1. Build intent detection runs immediately
2. If patterns match: Create project OR create WO
3. Response includes WO slug and approval notice
4. Plan mode metadata records `plan_transitioned_to_build: true` for analytics

## Edge Cases & Handling

### 1. User Abandons Plan Mode
**Scenario**: User enters plan mode, discusses for several turns, then starts new chat without building

**Behavior**:
- Plan mode metadata remains on old thread (historical record)
- New thread starts fresh (no plan mode)
- No orphaned state or dangling work orders

**Rationale**: Plan mode is exploratory — users can abandon ideas without consequence

### 2. User Says "Build" But No Tech Nouns
**Scenario**: User says "build it" but build pattern detection fails (no technical nouns)

**Behavior**:
- Exits plan mode (transition phrase matched)
- Build intent detection fails
- System provides conversational response (likely asking for clarification)
- User can provide more details, which will then match build patterns

**Example**:
- User: "Build it"
- System: "I'd be happy to help build this. Could you clarify what specific component or feature you'd like me to create?"

### 3. Concurrent Planning in Multiple Threads
**Scenario**: User has multiple browser tabs with different threads, some in plan mode

**Behavior**:
- Each thread has independent metadata
- Plan mode state is per-thread, not per-user
- No conflicts or race conditions
- Each conversation maintains its own planning context

### 4. Plan Mode + Commands
**Scenario**: User enters `/summary` while in plan mode

**Behavior**:
- Commands execute normally (they run early in request flow)
- Plan mode state remains unchanged
- After command completes, plan mode is still active
- Commands don't exit plan mode

### 5. Backend Crash During Plan Mode
**Scenario**: Server error occurs while in plan mode

**Behavior**:
- Thread metadata is already persisted (ACID guarantees)
- Next request reads plan_mode from database
- UI re-syncs from backend response
- No state loss

## Testing Considerations

### Unit Tests (Pattern Matching)
```javascript
// Plan intent detection
assert(detectPlanIntent("let's plan out this feature") === true);
assert(detectPlanIntent("what would it take to build this") === true);
assert(detectPlanIntent("/plan user authentication") === true);

// Build transition detection
assert(detectBuildTransition("build it") === true);
assert(detectBuildTransition("let's build this") === true);
assert(detectBuildTransition("approve the plan") === true);

// Build intent detection
assert(detectBuildIntent("build me a REST API", false) === true);  // not in plan mode
assert(detectBuildIntent("build me a REST API", true) === false);  // in plan mode (blocked)
```

### Integration Tests (State Transitions)
1. Send plan request → verify `plan_mode: true` in metadata
2. Send question while in plan mode → verify plan mode persists
3. Send build transition → verify `plan_mode: false` and `plan_transitioned_to_build: true`
4. Send build request (not in plan mode) → verify immediate WO creation

### E2E Tests (Full Flow)
1. User enters "/plan multi-tenant auth"
2. System responds with clarifying questions
3. User provides requirements
4. System discusses architecture options
5. User clicks "Build it" button
6. System creates project + starts interrogation
7. User answers interrogation questions
8. System generates docs + decomposes to WOs

## Performance Considerations

### No Additional Latency
- Plan mode detection uses simple string matching (no LLM calls)
- Metadata updates are single JSONB field merges (fast)
- UI updates are CSS class toggles (instant)

### Token Usage
- Plan mode system prompt adds ~200 tokens
- Multi-turn planning conversations accumulate history
- No token cost for state management itself

### Database Impact
- One additional JSONB field merge per plan mode entry/exit
- Thread metadata queries are indexed by thread_id (fast)
- No new tables or complex joins

## Limitations & Future Enhancements

### Current Limitations

1. **No Plan Versioning**: If user discusses multiple approaches, there's no way to save/compare plan variants
2. **No Plan Export**: Plans live in conversation history only, not exported to structured docs
3. **Simple Pattern Matching**: Intent detection can miss nuanced requests or false-positive on casual language
4. **No Explicit "Cancel Plan"**: User must start new chat to abandon plan (can't explicitly exit without building)
5. **No Plan Templates**: Every planning session starts from scratch
6. **No Collaboration**: Plan mode is single-user (no way to share plans or co-plan)

### Proposed Enhancements

1. **Plan Snapshots**:
   - Command: `/save-plan <name>`
   - Store plan snapshot in `project_briefs.metadata.saved_plans`
   - Allow loading saved plans later

2. **Plan Comparison**:
   - After discussing multiple approaches, offer side-by-side comparison
   - Use LLM to synthesize trade-offs table

3. **LLM-Based Intent Classification**:
   - Replace regex patterns with lightweight LLM classifier
   - More accurate detection of nuanced intent
   - Lower false-positive rate

4. **Explicit Exit Command**:
   - Command: `/exit-plan` or "cancel planning"
   - Exit plan mode without building
   - Preserves conversation for future reference

5. **Plan Templates**:
   - Pre-defined planning workflows for common scenarios
   - E.g., "/plan-api", "/plan-frontend", "/plan-integration"
   - Guide user through structured planning questions

6. **Plan Export to PRD**:
   - Command: `/export-plan-to-prd`
   - Auto-generate PRD document from planning conversation
   - Store in project_documents table

## Version History

- **v37**: No plan mode (binary QUESTION/BUILD classification)
- **v38**: Plan mode introduced (3-way QUESTION/PLAN/BUILD classification)
- **v39**: Plan mode stable (current version)

## Related Documentation

- `ENDGAME-001-ARCHITECTURE.md` - System architecture overview
- `portal-chat/index.ts` - Backend implementation
- `index.html` - Frontend implementation
- `CONVERSATIONAL-INTERROGATION.md` - Related feature for project intake

## Deployment Information

- **Backend Version**: portal-chat v39
- **Deployed**: 2026-02-06
- **Frontend Version**: index.html deployed 2026-02-06 20:20:00 UTC
- **Database Schema**: conversation_threads.metadata (JSONB, existing field)

## Acceptance Criteria Review

✅ **Intent Classification Logic**: Documented pattern matching for QUESTION/PLAN/BUILD
✅ **State Transitions**: Documented entry, transition, and exit flows
✅ **UX Flow**: Documented typical session and edge cases
✅ **Edge Cases**: Documented 5 edge cases with handling strategies
✅ **Implementation Review**: Backend code analyzed (portal-chat v39)
✅ **Frontend Integration**: UI components and state management documented

## Known Issues & Gaps

### Implementation Gaps (vs. Spec)

1. **No Explicit Exit Command**: Current implementation only allows exit by:
   - Starting new chat
   - Transitioning to build
   - User has no way to say "cancel this plan" and return to normal mode

2. **Plan Topic Not Used**: `plan_topic` is stored but never retrieved or displayed to user

3. **No Plan Mode Indicator in System Prompt**: While backend detects plan mode, there's no explicit "You entered plan mode" confirmation message

4. **Build Button Timing**: Build button appears immediately when plan mode activates, might be confusing before any planning happens

### Behavioral Inconsistencies

1. **Question Priority**: If user asks question matching question patterns while in plan mode, plan mode persists. This is correct but undocumented.

2. **Command Interaction**: Commands like `/summary` don't exit plan mode, but this isn't explicitly stated in user guidance.

3. **Incomplete Build Patterns**: If user says "build it" but message lacks tech nouns, plan mode exits but no WO is created (user gets confused).

### Missing Features (Not Bugs)

1. No plan versioning or snapshots
2. No plan export to structured format
3. No plan comparison tools
4. No LLM-based intent classification
5. No collaborative planning

## Recommendations for Follow-Up Work Orders

Based on this review, the following follow-up work orders are recommended:

### HIGH PRIORITY
1. **WO-PLANMODE-EXIT**: Add explicit plan mode exit command (`/exit-plan` or "cancel planning")
2. **WO-PLANMODE-CONFIRM**: Add confirmation message when entering plan mode (e.g., "Entered plan mode. Say 'build it' when ready to implement.")
3. **WO-PLANMODE-BUILD-GUARD**: Improve build transition UX when patterns don't fully match (ask for clarification instead of silently failing)

### MEDIUM PRIORITY
4. **WO-PLANMODE-TOPIC-DISPLAY**: Display plan topic in UI (show what user is planning)
5. **WO-PLANMODE-BUTTON-DELAY**: Delay build button appearance until at least one planning turn completes
6. **WO-PLANMODE-ANALYTICS**: Add tracking for plan mode entry, duration, exit method (build vs abandon)

### LOW PRIORITY (ENHANCEMENTS)
7. **WO-PLANMODE-SNAPSHOTS**: Implement plan snapshot save/load
8. **WO-PLANMODE-EXPORT**: Export plan conversations to PRD format
9. **WO-PLANMODE-LLM-INTENT**: Replace regex patterns with LLM-based intent classification

## Conclusion

Plan mode (v38+) successfully implements a 3-way intent classification system that enables exploratory conversations before commitment. The implementation is clean, performant, and well-integrated with existing features (interrogation, intake gate, WO creation).

The primary gaps are UX-related (missing exit command, no entry confirmation) rather than technical defects. The feature works as designed but could benefit from user guidance improvements and explicit state transition messages.

The decision to block work order creation during plan mode is architecturally sound and prevents the "premature WO creation" problem that existed in v37. Thread metadata-based state management is appropriate for per-conversation state without adding schema complexity.

---

**Document Status**: ✅ COMPLETE
**Review Required**: Yes (by METIS orchestrator)
**Follow-Up**: File 9 WOs for gaps and enhancements
