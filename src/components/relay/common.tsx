import { useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { X, type LucideIcon } from "lucide-react";
import { ch, type ChannelId } from "@/lib/relay";
import { Backdrop, menuMotion, panelMotion, PopCount, spring } from "./motion";

/** The sidebar's selection highlight; one shared layoutId makes it glide between items. */
export const ActivePill = () => (
  <motion.span layoutId="sidebar-active" className="absolute inset-0 -z-0 rounded-lg bg-sidebar-accent" transition={spring} />
);

export function NavItem({ icon: I, label, count, active, collapsed, onClick }: { icon: LucideIcon; label: string; count?: number; active: boolean; collapsed: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} className={`relative isolate flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${collapsed ? "justify-center px-0" : ""} ${active ? "text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60"}`}>
      {active && <ActivePill />}
      <I className="relative h-4 w-4 shrink-0" />{!collapsed && <span className="relative flex-1 text-left">{label}</span>}
      {!collapsed && !!count && <PopCount value={count} className="relative rounded-full bg-sidebar-primary px-2 text-[10px] font-bold text-sidebar-primary-foreground" />}
    </button>
  );
}

/** Profile photo URL for a conversation, or undefined to show initials. */
export const avatarUrl = (c: { id: number; avatar: string | null }) => (c.avatar ? `/api/avatars/${c.id}?v=${c.avatar}` : undefined);

export function Avatar({ name, channel, big, photo }: { name: string; channel: ChannelId; big?: boolean; photo?: string | undefined }) {
  const C = ch(channel);
  const [broken, setBroken] = useState<string | null>(null);
  const size = big ? "h-24 w-24 text-3xl" : "h-10 w-10 text-sm";
  return (
    <div className="relative shrink-0">
      {photo && broken !== photo ? (
        <img src={photo} alt="" loading="lazy" onError={() => setBroken(photo)} className={`${size} rounded-full bg-secondary object-cover`} />
      ) : (
        <div className={`grid place-items-center rounded-full bg-secondary font-display font-semibold text-secondary-foreground ${size}`}>
          {initials(name)}
        </div>
      )}
      <span className={`absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full ring-2 ring-surface ${C.bg} ${big ? "h-7 w-7" : "h-4 w-4"}`}>
        <C.icon className={`text-primary-foreground ${big ? "h-3.5 w-3.5" : "h-2.5 w-2.5"}`} />
      </span>
    </div>
  );
}

export const initials = (name: string) =>
  name.split(" ").filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";

export type MenuAction = { icon: LucideIcon; label: string; danger?: boolean; fn: () => void };

/** A floating menu at a click position; closes on outside click, window blur or Escape. */
export function PopupMenu({ x, y, width, actions, onClose }: { x: number; y: number; width: number; actions: MenuAction[]; onClose: () => void }) {
  useDismiss(onClose);
  return (
    <motion.div
      {...menuMotion}
      className="fixed z-50 overflow-hidden rounded-xl border bg-popover py-1 shadow-soft"
      style={{ width, left: Math.min(x, window.innerWidth - width - 8), top: Math.min(y, window.innerHeight - actions.length * 40 - 16), transformOrigin: "top left" }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuButtons actions={actions} onClose={onClose} />
    </motion.div>
  );
}

export function MenuButtons({ actions, onClose }: { actions: MenuAction[]; onClose: () => void }) {
  return actions.map((a) => (
    <button key={a.label} onClick={() => { a.fn(); onClose(); }}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm transition hover:bg-muted ${a.danger ? "text-destructive" : ""}`}>
      <a.icon className="h-4 w-4" /> {a.label}
    </button>
  ));
}

export function useDismiss(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("click", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", onClose); window.removeEventListener("blur", onClose); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
}

/** Right-hand slide-over panel used by Profile, Contact info and Settings. */
export function SlideOver({ title, width = "w-96", onClose, children, closeLeft }: { title: string; width?: string; onClose: () => void; children: ReactNode; closeLeft?: boolean }) {
  const close = <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>;
  return (
    <Backdrop onClick={onClose} className="flex justify-end">
      <motion.div {...panelMotion} className={`scrollbar-thin h-full ${width} overflow-y-auto bg-surface p-6 shadow-soft`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center ${closeLeft ? "gap-3" : "justify-between"}`}>
          {closeLeft && close}
          <h2 className="text-lg font-semibold">{title}</h2>
          {!closeLeft && close}
        </div>
        {children}
      </motion.div>
    </Backdrop>
  );
}

export const SectionLabel = ({ children, className = "mt-6" }: { children: ReactNode; className?: string }) => (
  <p className={`${className} text-[11px] font-semibold uppercase tracking-widest text-muted-foreground`}>{children}</p>
);
