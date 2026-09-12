"use client";
import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";

function fitContent(element: HTMLTextAreaElement | null) {
  if (!element?.clientWidth) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

export function AutoTextarea(props: ComponentPropsWithoutRef<"textarea"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let lastWidth = 0;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitContent(element));
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    fitContent(ref.current);
  }, [props.value]);
  return <textarea {...props} ref={ref} rows={1} />;
}
