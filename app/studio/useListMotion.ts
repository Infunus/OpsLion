"use client";

import { useLayoutEffect, useRef } from "react";

/** Animate keyed cards into their new positions without remounting inputs. */
export function useListMotion(order: string) {
  const listRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    const animations: Animation[] = [];
    list.querySelectorAll<HTMLElement>("[data-motion-id]").forEach((card) => {
      const id = card.dataset.motionId!;
      const top = card.offsetTop;
      next.set(id, top);
      const previous = positions.current.get(id);
      if (animate && previous !== undefined && Math.abs(previous - top) > 1) {
        animations.push(card.animate([{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" }));
      }
    });
    positions.current = next;
    return () => animations.forEach((animation) => animation.cancel());
  }, [order]);
  return listRef;
}
