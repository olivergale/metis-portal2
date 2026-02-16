# Open Manifold Design System

## Overview
Token-efficient design system for Open Manifold UI. **Aesthetic**: Deep navy/slate, electric blue accent, clean grids, subtle glows, monospace data. **Dark mode only.**

## Color Tokens

**Backgrounds**: `bg-deep` (#0a0e17), `bg-surface` (#111827), `bg-card` (#1a2332), `bg-hover` (#1e2d3d), `bg-active` (#243447)

**Text**: `text-primary` (#f1f5f9), `text-secondary` (#94a3b8), `text-muted` (#64748b), `text-inverse` (#0a0e17)

**Borders**: `border` (#1e2d3d), `border-strong` (#2a3f54)

**Accent**: `accent` (#3b82f6), `accent-glow` (#60a5fa), `accent-subtle` (rgba(59,130,246,0.15))

**Status**: `success` (#22c55e), `warning` (#f59e0b), `error` (#ef4444), `info` (#3b82f6)

## Typography

**Fonts**: Inter (sans), JetBrains Mono (mono)

**Scale**: `text-xs` (11px), `text-sm` (13px), `text-base` (15px), `text-lg` (18px), `text-xl` (20px), `text-2xl` (24px), `text-3xl` (32px), `text-4xl` (48px)

**Weights**: `font-normal` (400), `font-medium` (500), `font-semibold` (600), `font-bold` (700)

## Spacing & Radius

**Spacing** (4px grid): `1` (4px), `2` (8px), `3` (12px), `4` (16px), `6` (24px), `8` (32px), `12` (48px), `16` (64px)

**Radius**: `rounded` (4px), `rounded-md` (8px), `rounded-lg` (12px), `rounded-full` (pills)

## Animation Patterns

### Entrance (Framer Motion)
```tsx
import { motion } from 'framer-motion';

// Fade + slide up
<motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: 'easeOut' }} />

// Stagger children
<motion.div variants={staggerContainer}>
  {items.map(item => <motion.div key={item.id} variants={staggerItem} />)}
</motion.div>
```

### Interactions
- **Scale**: `hover:scale-[1.02]`
- **Border glow**: `hover:border-accent-glow hover:shadow-[0_0_8px_rgba(59,130,246,0.3)]`
- **Background lift**: `hover:bg-hover`

### Status Pulse
```tsx
<motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }} />
```

## Component Conventions

### Card
```tsx
<div className="bg-surface border border-default rounded-lg p-6">{children}</div>
```

### Badge
```tsx
<span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-accent-subtle text-accent">Active</span>
```

### MetricCard
```tsx
<div className="bg-surface border border-default rounded-lg p-6 text-center">
  <div className="text-4xl font-bold font-mono text-primary">{value}</div>
  <div className="text-xs text-muted uppercase tracking-wide mt-1">{label}</div>
</div>
```

### DataTable
```tsx
<table className="w-full">
  <thead className="sticky top-0 bg-surface border-b border-default">
    <tr className="text-xs text-muted uppercase"><th className="text-left p-3">Column</th></tr>
  </thead>
  <tbody>
    <tr className="border-b border-default hover:bg-hover transition-colors">
      <td className="p-3 font-mono text-sm">Data</td>
    </tr>
  </tbody>
</table>
```

## Responsive

**Breakpoints**: `sm` (640px), `md` (768px), `lg` (1024px), `xl` (1280px)

**Grid pattern**: Mobile 1 col, Tablet `md:grid-cols-2`, Desktop `lg:grid-cols-3`

## Usage
**Prompt**: "Follow the Open Manifold design skill" — Claude applies all tokens/patterns automatically.

## Implementation

**Tailwind**: `tailwind.config.ts` has all tokens configured

**Animations**: `src/animations/index.ts` exports 8 reusable variants

**Exemplar**: `src/components/DashboardPanel.tsx` demonstrates every pattern

**Bridge**: `src/styles/tokens.css` provides CSS custom properties for legacy code