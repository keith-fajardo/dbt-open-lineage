import { useEffect, type RefObject } from "react";

/** Close a popup (dropdown/menu) when the user mousedowns anywhere outside
 * `ref`, or presses Escape. No-op while `open` is false. */
export function useCloseOnOutside<T extends HTMLElement>(
  open: boolean, ref: RefObject<T | null>, close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}
