"use client";

import { useEffect, useState } from "react";

const startDelay = 240;
const letterInterval = 47;
const caretHold = 350;

export function TypedTask({ text }: { text: string }) {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisibleCount(text.length + 1);
      return;
    }

    const startsAt = performance.now() + startDelay;
    const finishesAt = startsAt + (text.length - 1) * letterInterval + caretHold;
    let timer = window.setTimeout(advance, startDelay);

    function advance() {
      const now = performance.now();
      if (now >= finishesAt) {
        setVisibleCount(text.length + 1);
        return;
      }

      const count = Math.min(text.length, Math.max(0, Math.floor((now - startsAt) / letterInterval) + 1));
      setVisibleCount(count);
      const nextAt = count === text.length ? finishesAt : startsAt + count * letterInterval;
      timer = window.setTimeout(advance, Math.ceil(nextAt - now));
    }

    return () => window.clearTimeout(timer);
  }, [text]);

  return (
    <span className="agent-demo-typing">
      <span className="agent-demo-typing-full">{text}</span>
      <span className="agent-demo-typing-progress" aria-hidden="true">
        {text.slice(0, visibleCount)}
        {visibleCount <= text.length && <span className="agent-demo-typing-caret" />}
      </span>
    </span>
  );
}
