"use client";

import { useEffect, useState } from "react";

/** Live "expires in mm:ss" for a given epoch-seconds timestamp; renders on the client only. */
export function Countdown({ epochSeconds }: { epochSeconds: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(tick, 1000);
    queueMicrotask(tick);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span className="mono">…</span>;
  const left = epochSeconds - now;
  if (left <= 0) return <span className="mono badge badge-warn">expired — next BFF call refreshes it</span>;
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <span className="mono">
      {mm}:{ss}
    </span>
  );
}
