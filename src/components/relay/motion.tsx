import { motion, type HTMLMotionProps, type Transition } from "motion/react";
import type { ReactNode } from "react";

// One motion vocabulary for the whole app, so everything moves with the same feel.
// MotionConfig reducedMotion="user" (in the route) turns transforms off for people who ask the OS for less motion.
export const spring: Transition = { type: "spring", stiffness: 520, damping: 40, mass: 0.8 };
export const softSpring: Transition = { type: "spring", stiffness: 320, damping: 32 };
export const fade: Transition = { duration: 0.18, ease: "easeOut" };

/** Dimmed, blurred page behind dialogs and panels; fades in and out. */
export function Backdrop({ onClick, children, className = "", z = "z-50" }: { onClick: () => void; children: ReactNode; className?: string; z?: string }) {
  return (
    <motion.div
      className={`fixed inset-0 ${z} bg-foreground/20 backdrop-blur-sm ${className}`}
      onClick={onClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fade}
    >
      {children}
    </motion.div>
  );
}

/** Centered dialog card: rises and scales in, settles with a spring. */
export const dialogMotion = {
  initial: { opacity: 0, scale: 0.95, y: 12 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97, y: 6 },
  transition: spring,
} satisfies HTMLMotionProps<"div">;

/** Right-hand panel sliding in from the edge. */
export const panelMotion = {
  initial: { x: "100%" },
  animate: { x: 0 },
  exit: { x: "100%" },
  transition: softSpring,
} satisfies HTMLMotionProps<"div">;

/** Small popovers and context menus, growing from where they were opened. */
export const menuMotion = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1 },
  transition: { type: "spring", stiffness: 700, damping: 40 },
} satisfies HTMLMotionProps<"div">;

/** A count that pops whenever its value changes (unread badges). */
export function PopCount({ value, className }: { value: number; className: string }) {
  return (
    <motion.span key={value} className={className} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring}>
      {value}
    </motion.span>
  );
}
