# Figma Integration Pattern

This document describes how to use the existing Figma MCP connection to streamline design-to-code workflow for the Open Manifold design system.

## Overview

The Figma MCP server provides two main capabilities:
1. **Extract design context** from Figma files and nodes
2. **Create Code Connect mappings** that link Figma components to React code

## Workflow: Figma to Code

### Step 1: Design Component in Figma

Create your component in Figma following Open Manifold design system tokens:
- Colors: Use design tokens from `.claude/skills/open-manifold-design.md`
- Typography: Inter (sans), JetBrains Mono (monospace)
- Spacing: 4px grid system
- Border radius: 4px (small), 8px (standard), 12px (large)

### Step 2: Extract Design Context

Use the `get_design_context` MCP tool to extract the component's code representation:

```typescript
// Tool: mcp__figma__get_design_context
// Input:
{
  "fileKey": "your-figma-file-key",
  "nodeId": "123:456" // Component node ID
}

// Output: JSON representation of component structure, styles, and content
```

The tool returns:
- Component hierarchy
- Applied styles (colors, typography, spacing)
- Text content and images
- Layout constraints

### Step 3: Apply Open Manifold Tokens

Normalize the extracted output to use Open Manifold design tokens:

**Before (raw Figma output):**
```tsx
<div style={{ backgroundColor: '#111827', padding: '16px' }}>
```

**After (Open Manifold tokens):**
```tsx
<div className="bg-surface p-4">
```

**Mapping reference:**
- Figma color `#111827` → Tailwind class `bg-surface`
- Figma spacing `16px` → Tailwind class `p-4`
- Figma font "Inter 13px 500" → Tailwind class `text-sm font-medium`

### Step 4: Commit to Component Library

Add the normalized component to `src/components/`:

```tsx
// src/components/MyComponent.tsx
import { motion } from 'framer-motion';
import { fadeIn } from '../animations';

export default function MyComponent({ title }: { title: string }) {
  return (
    <motion.div
      className="bg-surface border border-default rounded-lg p-6"
      variants={fadeIn}
      initial="initial"
      animate="animate"
    >
      <h3 className="text-lg font-semibold text-primary">{title}</h3>
    </motion.div>
  );
}
```

## Code Connect Mappings

Code Connect creates a two-way link between Figma components and React code. When designers inspect a component in Figma, they see the actual React code that implements it.

### Creating a Mapping

Use the `add_code_connect_map` MCP tool:

```typescript
// Tool: mcp__figma__add_code_connect_map
// Input:
{
  "fileKey": "your-figma-file-key",
  "nodeId": "123:456",
  "componentPath": "src/components/StatusBadge.tsx",
  "mappings": {
    "props": {
      "status": "status"
    },
    "children": "children"
  }
}
```

### Example: StatusBadge Mapping

**Figma Component**: StatusBadge with variants (active, warning, error, success)

**Code Connect Configuration**:
```typescript
{
  "fileKey": "abc123def456",
  "nodeId": "100:200",
  "componentPath": "src/components/StatusBadge.tsx",
  "mappings": {
    "props": {
      "variant": "status"
    }
  },
  "example": "<StatusBadge status=\"active\" />"
}
```

Now when a designer clicks the StatusBadge component in Figma:
- They see: `<StatusBadge status="active" />`
- They can copy the code directly
- They know the exact prop API

### Example: MetricCard Mapping

**Figma Component**: MetricCard with label, value, trend indicator

**Code Connect Configuration**:
```typescript
{
  "fileKey": "abc123def456",
  "nodeId": "101:201",
  "componentPath": "src/components/MetricCard.tsx",
  "mappings": {
    "props": {
      "label": "label",
      "value": "value",
      "trend": "trend"
    }
  },
  "example": "<MetricCard label=\"Active WOs\" value={42} trend=\"up\" />"
}
```

### Example: WOCard Mapping

**Figma Component**: Work Order Card with status, priority, title

**Code Connect Configuration**:
```typescript
{
  "fileKey": "abc123def456",
  "nodeId": "102:202",
  "componentPath": "src/components/WOCard.tsx",
  "mappings": {
    "props": {
      "title": "name",
      "status": "status",
      "priority": "priority",
      "slug": "slug"
    }
  },
  "example": "<WOCard name=\"Build feature\" status=\"in_progress\" priority=\"p1_high\" slug=\"WO-0123\" />"
}
```

## Benefits

### For Designers
- See real production code in Figma
- Copy-paste working React components
- Understand prop APIs without reading docs
- Catch design-code inconsistencies early

### For Developers
- No manual translation from design to code
- Guaranteed design system compliance
- Faster implementation (point at design → get code)
- Single source of truth (Figma + Code Connect)

## Figma File Structure (Recommended)

```
Open Manifold Design System (Figma File)
├── 🎨 Foundations
│   ├── Colors
│   ├── Typography
│   ├── Spacing
│   └── Effects (shadows, glows)
├── 🧩 Components
│   ├── StatusBadge (variants: active, warning, error, success)
│   ├── MetricCard (with/without trend)
│   ├── WOCard (all status/priority combinations)
│   ├── DataTable (with sample rows)
│   └── Sidebar (collapsed/expanded)
└── 📦 Templates
    ├── Dashboard Layout
    ├── Manifold View
    └── Detail Panel
```

Each component in 🧩 Components should have a Code Connect mapping.

## Testing Code Connect

After creating a mapping:

1. Open Figma file
2. Select the mapped component
3. Open Dev Mode (Shift + D)
4. Look for "Code" tab in right panel
5. Verify React code snippet appears
6. Test copy-paste into codebase

## Troubleshooting

### Mapping Not Appearing
- Verify `fileKey` and `nodeId` are correct
- Check component is published in Figma library
- Ensure `componentPath` matches actual file location
- Try refreshing Figma (Cmd/Ctrl + R)

### Wrong Code Generated
- Review `mappings` configuration
- Ensure Figma component structure matches React props
- Update example code to show correct usage

### Token Mismatches
- Audit Figma styles against `.claude/skills/open-manifold-design.md`
- Update Figma library to use exact token values
- Re-extract design context after fixes

## Next Steps

1. **Audit existing Figma file**: Ensure all components use Open Manifold tokens
2. **Create Code Connect mappings**: Start with high-reuse components (StatusBadge, MetricCard, WOCard)
3. **Test workflow**: Design new component → extract → normalize → commit
4. **Iterate**: Refine mappings based on developer feedback

## Resources

- Open Manifold Design Skill: `.claude/skills/open-manifold-design.md`
- Tailwind Config: `tailwind.config.ts`
- Animation Library: `src/animations/index.ts`
- Exemplar Component: `src/components/DashboardPanel.tsx`
