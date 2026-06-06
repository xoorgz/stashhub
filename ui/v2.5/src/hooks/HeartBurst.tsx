import React, { useCallback, useRef, useState } from "react";

interface Particle {
  id: number;
  x: number;
  y: number;
  driftX: number;
  rise: number;
  rot: number;
  size: number;
  color: string;
  dur: number;
}

const COLORS = ["#ff3b6b", "#ff5f8a", "#df73ff", "#ff8aae"];

/**
 * Heart particle effect. Returns `burst(x, y, count)` to spawn particles at
 * viewport coordinates and `layer` to render once at the top of the tree. The
 * layer is position: fixed with pointer-events: none. Particles are removed
 * automatically after the animation completes.
 */
export function useHeartBurst(): {
  burst: (x: number, y: number, count?: number) => void;
  layer: React.ReactNode;
} {
  const [particles, setParticles] = useState<Particle[]>([]);
  const idRef = useRef(0);

  const burst = useCallback((x: number, y: number, count: number = 6) => {
    const fresh: Particle[] = [];
    for (let i = 0; i < count; i++) {
      const id = idRef.current++;
      fresh.push({
        id,
        x: x + (Math.random() - 0.5) * 20,
        y: y + (Math.random() - 0.5) * 10,
        driftX: (Math.random() - 0.5) * 120,
        rise: 140 + Math.random() * 80,
        rot: (Math.random() - 0.5) * 80,
        size: 22 + Math.random() * 18,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        dur: 900 + Math.random() * 500,
      });
    }
    setParticles((prev) => [...prev, ...fresh]);
    fresh.forEach((p) => {
      window.setTimeout(() => {
        setParticles((prev) => prev.filter((h) => h.id !== p.id));
      }, p.dur + 60);
    });
  }, []);

  const layer = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9999,
        overflow: "hidden",
      }}
    >
      {particles.map((p) => (
        <span
          key={p.id}
          aria-hidden="true"
          style={{
            position: "fixed",
            left: p.x,
            top: p.y,
            transform: "translate(-50%, -50%)",
            animation: `heartburst-rise ${p.dur}ms cubic-bezier(0.22, 1, 0.36, 1) forwards`,
            // expose particle params to CSS via custom properties
            ["--hb-drift-x" as string]: `${p.driftX}px`,
            ["--hb-rise" as string]: `${p.rise}px`,
            ["--hb-rot" as string]: `${p.rot}deg`,
            color: p.color,
            fontSize: 0,
          }}
        >
          <svg width={p.size} height={p.size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21s-7-4.35-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.65-9.5 9-9.5 9z" />
          </svg>
        </span>
      ))}
      <style>{`
        @keyframes heartburst-rise {
          0%   { transform: translate(-50%, -50%) scale(0.4) rotate(0deg); opacity: 0; }
          15%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1) rotate(0deg); }
          100% {
            transform:
              translate(
                calc(-50% + var(--hb-drift-x)),
                calc(-50% - var(--hb-rise))
              )
              scale(0.7)
              rotate(var(--hb-rot));
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );

  return { burst, layer };
}
