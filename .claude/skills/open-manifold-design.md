# Open Manifold Design System

## Overview
Token-efficient design system for Open Manifold UI. Load this skill to generate on-brand interfaces without bloating prompts.

**Aesthetic**: Deep navy/slate backgrounds, electric blue accent, clean grids, subtle glows, monospace data, minimal chrome.
**Theme**: Dark mode only. No light mode support.

---

## Color Tokens

### Backgrounds
- `bg-deep` (#0a0e17) — Deepest navy, page background
- `bg-surface` (#111827) — Elevated surfaces, cards
- `bg-card` (#1a2332) — Higher elevation cards
- `bg-hover` (#1e2d3d) — Hover state
- `bg-active` (#243447) — Active/pressed state

### Text
- `text-primary` (#f1f5f9) — Primary content
- `text-secondary` (#94a3b8) — Secondary labels
- `text-muted` (#64748b) — Subtle text, placeholders
- `text-inverse` (#0a0e17) — Text on light backgrounds

### Borders
- `border` (#1e2d3d) — Default border
- `border-strong` (#2a3f54) — Emphasized borders

### Accent
- `accent` (#3b82f6) — Primary blue accent
- `accent-glow` (#60a5fa) — Lighter glow variant
- `accent-subtle` (rgba(59,130,246,0.15)) — Transparent backgrounds

### Status
- `success` (#22c55e) — Green for success/done
- `warning` (#f59e0b) — Orange for warnings
- `error` (#ef4444) — Red for errors/failures
- `info` (#3b82f6) — Blue for info states

---

## Typography

### Font Families
- **Sans**: Inter (UI text, labels, content)
- **Mono**: JetBrains Mono (code, data, metrics)

### Scale
- `text-xs` (11px) — Footnotes, metadata
- `text-sm` (13px) — Body text, labels
- `text-base` (15px) — Default content
- `text-lg` (18px) — Subheadings
- `text-xl` (20px) — Headings
- `text-2xl` (24px) — Page titles
- `text-3xl` (32px) — Hero text
- `text-4xl` (48px) — Large metrics

### Weights
- `font-normal` (400) — Body text
- `font-medium` (500) — Emphasized text
- `font-semibold` (600) — Headings
- `font-bold` (700) — Strong emphasis

---

## Spacing
4px grid system:
- `1` (4px)
- `2` (8px)
- `3` (12px)
- `4` (16px)
- `6` (24px)
- `8` (32px)
- `12` (48px)
- `16` (64px)

---

## Border Radius
- `rounded` (4px) — Small elements
- `rounded-md` (8px) — Standard cards
- `rounded-lg` (12px) — Large surfaces
- `rounded-full` — Pills, badges

---

## Animation Patterns

### Entrance Animations (Framer Motion)
```tsx
import { motion } from 'framer-motion';

// Fade in + slide up
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.4, ease: 'easeOut' }}
>

// Stagger children
<motion.div variants={staggerContainer}>
  {items.map(item => <motion.div key={item.id} variants={staggerItem} />)}
</motion.div>
```

### Hover Micro-interactions
- Scale: `hover:scale-[1.02]`
- Border glow: `hover:border-accent-glow hover:shadow-[0_0_8px_rgba(59,130,246,0.3)]`
- Background lift: `hover:bg-hover`

### Status Pulse
For active/loading states:
```tsx
<motion.div
  animate={{ opacity: [0.5, 1, 0.5] }}
  transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
/>
```

---

## Component Conventions

### Card
Elevated surface with subtle border:
```tsx
<div className="bg-surface border border-default rounded-lg p-6">
  {children}
</div>
```

### Badge
Status indicator pill:
```tsx
<span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-accent-subtle text-accent">
  Active
</span>
```

### MetricCard
Large value with muted label:
```tsx
<div className="bg-surface border border-default rounded-lg p-6 text-center">
  <div className="text-4xl font-bold font-mono text-primary">{value}</div>
  <div className="text-xs text-muted uppercase tracking-wide mt-1">{label}</div>
</div>
```

### DataTable
Striped rows, sticky header:
```tsx
<table className="w-full">
  <thead className="sticky top-0 bg-surface border-b border-default">
    <tr className="text-xs text-muted uppercase">
      <th className="text-left p-3">Column</th>
    </tr>
  </thead>
  <tbody>
    <tr className="border-b border-default hover:bg-hover transition-colors">
      <td className="p-3 font-mono text-sm">Data</td>
    </tr>
  </tbody>
</table>
```

---

## Responsive Breakpoints
- `sm` (640px) — Mobile landscape
- `md` (768px) — Tablet
- `lg` (1024px) — Desktop
- `xl` (1280px) — Large desktop

### Grid Patterns
- Mobile: 1 column (default)
- Tablet: 2 columns (`md:grid-cols-2`)
- Desktop: 3 columns (`lg:grid-cols-3`)

---

## Usage
**Prompt shorthand**: "Follow the Open Manifold design skill"

Claude will apply all tokens, conventions, and patterns automatically.