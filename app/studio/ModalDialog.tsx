"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Native modal semantics provide focus trapping, Escape and focus restoration. */
export function ModalDialog({ children, close, label }: { children: (dismiss: () => void) => ReactNode; close: () => void; label: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(close, 150);
    return () => clearTimeout(timer);
  }, [closing, close]);
  const dismiss = () => {
    if (closing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return close();
    setClosing(true);
  };
  return <dialog ref={dialogRef} className="modal-backdrop" data-closing={closing} aria-label={label} onCancel={(event) => { event.preventDefault(); dismiss(); }}>{children(dismiss)}</dialog>;
}
