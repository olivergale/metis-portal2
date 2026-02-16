/**
 * Open Manifold Animation Library
 * Reusable Framer Motion animation variants
 * Tree-shakeable: only import what you use
 */

import { Variants } from 'framer-motion';

/**
 * ENTRANCE ANIMATIONS
 */

// Fade in from transparent
export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.4, ease: 'easeOut' },
};

// Slide up from below + fade in
export const slideUp: Variants = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 },
  transition: { duration: 0.4, ease: 'easeOut' },
};

// Slide right from left + fade in
export const slideRight: Variants = {
  initial: { opacity: 0, x: -20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 20 },
  transition: { duration: 0.4, ease: 'easeOut' },
};

// Scale in from smaller + fade in
export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: { duration: 0.3, ease: 'easeOut' },
};

/**
 * LIST ANIMATIONS
 */

// Container for staggered children
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.1,
    },
  },
};

// Individual item in staggered list
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: 'easeOut' },
};

/**
 * STATUS ANIMATIONS
 */

// Pulsing glow effect for status indicators
export const pulseGlow: Variants = {
  animate: {
    boxShadow: [
      '0 0 8px rgba(59, 130, 246, 0.3)',
      '0 0 16px rgba(59, 130, 246, 0.6)',
      '0 0 8px rgba(59, 130, 246, 0.3)',
    ],
  },
  transition: {
    duration: 2,
    repeat: Infinity,
    ease: 'easeInOut',
  },
};

/**
 * INTERACTION ANIMATIONS
 */

// Subtle scale on hover
export const hoverScale: Variants = {
  initial: { scale: 1 },
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.98 },
  transition: { duration: 0.2, ease: 'easeOut' },
};

// Border glow on hover
export const hoverGlow: Variants = {
  initial: { boxShadow: '0 0 0 rgba(59, 130, 246, 0)' },
  whileHover: { boxShadow: '0 0 8px rgba(59, 130, 246, 0.3)' },
  transition: { duration: 0.2, ease: 'easeOut' },
};

/**
 * PAGE TRANSITIONS
 */

// Page enter/exit animation
export const pageTransition: Variants = {
  initial: { opacity: 0, x: -20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 20 },
  transition: { duration: 0.3, ease: 'easeOut' },
};

/**
 * UTILITY FUNCTIONS
 */

// Create a custom stagger delay
export const createStagger = (delayChildren: number = 0.1, staggerChildren: number = 0.1): Variants => ({
  animate: {
    transition: {
      delayChildren,
      staggerChildren,
    },
  },
});

// Create a custom slide animation
export const createSlide = (direction: 'up' | 'down' | 'left' | 'right', distance: number = 20): Variants => {
  const axis = direction === 'up' || direction === 'down' ? 'y' : 'x';
  const value = direction === 'up' || direction === 'left' ? distance : -distance;
  
  return {
    initial: { opacity: 0, [axis]: value },
    animate: { opacity: 1, [axis]: 0 },
    exit: { opacity: 0, [axis]: -value },
    transition: { duration: 0.4, ease: 'easeOut' },
  };
};
