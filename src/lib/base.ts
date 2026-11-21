/**
 * Where Sangam lives on its server: "/" normally, or a sub-path such as "/unified-ChatBox/"
 * (set with SANGAM_BASE when building, see deploy/DEPLOY.md). Every URL the page builds goes
 * through here, so the same code works at the root and under a sub-path.
 */
export const BASE = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

/** `path` ("/api/x" or "icons/a.png") under Sangam's base: "/unified-ChatBox/api/x". */
export const withBase = (path: string) => BASE + path.replace(/^\//, "");
