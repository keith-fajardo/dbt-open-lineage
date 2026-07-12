import { useEffect, type RefObject } from "react";

/** Close a popup (dropdown/menu) when the user mousedowns anywhere outside
 * `ref`. No-op while `open` is false. */
export function useCloseOnOutside<T extends HTMLElement>(
  open: boolean, ref: RefObject<T | null>, close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, ref, close]);
}
