import type { ReactNode } from "react";

export function WindowFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="win">
      <div className="win-title">
        <span>{`> ${title}`}</span>
        <span className="win-ctl" aria-hidden="true">
          _ □ ×
        </span>
      </div>
      <div className="win-body">{children}</div>
    </div>
  );
}
