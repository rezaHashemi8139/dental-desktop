import { useEffect, useRef, type SVGProps } from "react";
import {
  ActivityIcon,
  CrossIcon,
  HeartPulseIcon,
  type LucideIcon,
  PillIcon,
  PlusIcon,
  StethoscopeIcon,
  SyringeIcon,
  ToothbrushIcon,
} from "lucide-react";

/** A tooth outline drawn like the lucide icons (24x24, 2px stroke), which have no tooth. */
function ToothIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M7 3C4.8 3 3 4.8 3 7.5c0 2 .6 3.4 1.2 5 .6 1.7.8 3.6 1.3 5.6.4 1.6 1 2.9 2 2.9 1.3 0 1.6-1.8 2-3.6.3-1.4.8-2.4 2.5-2.4s2.2 1 2.5 2.4c.4 1.8.7 3.6 2 3.6 1 0 1.6-1.3 2-2.9.5-2 .7-3.9 1.3-5.6.6-1.6 1.2-3 1.2-5C21 4.8 19.2 3 17 3c-1.8 0-2.8 1-5 1S8.8 3 7 3Z" />
    </svg>
  );
}

type Shape = {
  Icon: LucideIcon | typeof ToothIcon;
  /** Size in px. */
  size: number;
  /** Teal or sky, the logo's two colours. */
  tone: "teal" | "sky";
  /** Turns faster (crosses and pluses, which look the same upside down). */
  spin?: boolean;
};

const SHAPES: Shape[] = [
  { Icon: ToothIcon, size: 72, tone: "teal" },
  { Icon: PlusIcon, size: 36, tone: "sky", spin: true },
  { Icon: StethoscopeIcon, size: 64, tone: "sky" },
  { Icon: CrossIcon, size: 40, tone: "teal", spin: true },
  { Icon: ToothbrushIcon, size: 60, tone: "sky" },
  { Icon: HeartPulseIcon, size: 56, tone: "teal" },
  { Icon: PillIcon, size: 48, tone: "teal" },
  { Icon: ToothIcon, size: 80, tone: "sky" },
  { Icon: SyringeIcon, size: 44, tone: "sky" },
  { Icon: PlusIcon, size: 32, tone: "teal", spin: true },
  { Icon: ActivityIcon, size: 52, tone: "teal" },
  { Icon: CrossIcon, size: 28, tone: "sky", spin: true },
];

const TONE = {
  teal: "text-teal-600 dark:text-teal-400",
  sky: "text-sky-700 dark:text-sky-400",
} as const;

/** How the shapes move: px, px/s, px/s² and deg/s. */
const MOTION = {
  /** Cruising speed range: slow, so they drift rather than fly. */
  minSpeed: 10,
  maxSpeed: 24,
  /** How quickly a pushed shape settles back to its cruising speed (per second). */
  settle: 0.6,
  /** The pointer pushes shapes within this distance away, harder the closer they are. */
  pointerRadius: 180,
  pointerPush: 420,
  /** Turning speed range; `spin` shapes turn three times faster. */
  maxTurn: 10,
} as const;

/** Where a shape is and how it moves. */
interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Speed it settles back to after a push. */
  cruise: number;
  angle: number;
  turn: number;
}

const random = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Starting places spread over the screen: one cell of a grid per shape, at a
 * random spot inside it, so they never start bunched up.
 */
function startBodies(width: number, height: number): Body[] {
  const columns = Math.ceil(Math.sqrt((SHAPES.length * width) / Math.max(height, 1)));
  const rows = Math.ceil(SHAPES.length / columns);
  return SHAPES.map((shape, i) => {
    const cellX = width / columns;
    const cellY = height / rows;
    const direction = random(0, 2 * Math.PI);
    const cruise = random(MOTION.minSpeed, MOTION.maxSpeed);
    const turn = random(-MOTION.maxTurn, MOTION.maxTurn) * (shape.spin ? 3 : 1);
    return {
      x: ((i % columns) + random(0.2, 0.8)) * cellX,
      y: (Math.floor(i / columns) + random(0.2, 0.8)) * cellY,
      vx: Math.cos(direction) * cruise,
      vy: Math.sin(direction) * cruise,
      cruise,
      angle: random(-30, 30),
      turn,
    };
  });
}

/** Moves a shape by `dt` seconds: pushed by the pointer, settling, bouncing off the edges. */
function step(body: Body, size: number, dt: number, width: number, height: number, pointer: { x: number; y: number } | null) {
  if (pointer) {
    const dx = body.x - pointer.x;
    const dy = body.y - pointer.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0 && distance < MOTION.pointerRadius) {
      const push = (1 - distance / MOTION.pointerRadius) * MOTION.pointerPush * dt;
      body.vx += (dx / distance) * push;
      body.vy += (dy / distance) * push;
      // Nudged shapes also turn a little more.
      body.angle += Math.sign(body.turn || 1) * push * 0.15;
    }
  }

  const speed = Math.hypot(body.vx, body.vy) || 1;
  const settled = 1 + (body.cruise / speed - 1) * Math.min(1, MOTION.settle * dt);
  body.vx *= settled;
  body.vy *= settled;

  body.x += body.vx * dt;
  body.y += body.vy * dt;
  body.angle += body.turn * dt;

  // Bounce once half of the shape has left the screen.
  const half = size / 2;
  if (body.x < -half) [body.x, body.vx] = [-half, Math.abs(body.vx)];
  if (body.x > width + half) [body.x, body.vx] = [width + half, -Math.abs(body.vx)];
  if (body.y < -half) [body.y, body.vy] = [-half, Math.abs(body.vy)];
  if (body.y > height + half) [body.y, body.vy] = [height + half, -Math.abs(body.vy)];
}

/**
 * Decoration behind the login, sign-up, setup and lock screens and the logged-in
 * pages (src/pages/app-layout.tsx): two soft lights
 * moving in the logo's colours, and flat outline shapes of a dental clinic
 * (teeth, toothbrush, stethoscope, medical crosses...) drifting slowly all over
 * the screen, turning as they go, and gently pushed aside by the mouse. Animated
 * on every frame without re-rendering; still when the system asks for reduced
 * motion. Hidden from screen readers and never takes clicks (the pointer is
 * followed on the window).
 */
export function AuthBackdrop() {
  const containerRef = useRef<HTMLDivElement>(null);
  const shapeRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let width = container.clientWidth;
    let height = container.clientHeight;
    const bodies = startBodies(width, height);

    const draw = () =>
      bodies.forEach((body, i) => {
        const node = shapeRefs.current[i];
        if (!node) return;
        const half = SHAPES[i].size / 2;
        node.style.transform = `translate(${body.x - half}px, ${body.y - half}px) rotate(${body.angle}deg)`;
      });
    draw();
    // Shown at once, after the first placement (not all bunched at the corner).
    container.dataset.ready = "";

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let pointer: { x: number; y: number } | null = null;
    const onPointerMove = (e: PointerEvent) => {
      const box = container.getBoundingClientRect();
      pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const onPointerLeave = () => {
      pointer = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("blur", onPointerLeave);

    const resize = new ResizeObserver(() => {
      width = container.clientWidth;
      height = container.clientHeight;
    });
    resize.observe(container);

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Capped, so a long pause (a hidden window) does not make them jump.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      bodies.forEach((body, i) => step(body, SHAPES[i].size, dt, width, height, pointer));
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("blur", onPointerLeave);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="group/backdrop pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <div className="auth-backdrop-glow absolute -inset-s-1/4 -top-1/4 size-[70vmax] rounded-full bg-teal-400/15 blur-3xl dark:bg-teal-500/10" />
      <div className="auth-backdrop-glow auth-backdrop-glow-late absolute -inset-e-1/4 -bottom-1/4 size-[70vmax] rounded-full bg-sky-500/15 blur-3xl dark:bg-sky-600/10" />

      {SHAPES.map(({ Icon, size, tone }, i) => (
        <div
          key={i}
          ref={(node) => {
            shapeRefs.current[i] = node;
          }}
          // Placed by the effect above; hidden until then.
          className={`absolute top-0 left-0 opacity-0 transition-opacity duration-700 will-change-transform group-data-ready/backdrop:opacity-25 dark:group-data-ready/backdrop:opacity-20 ${TONE[tone]}`}
        >
          <Icon width={size} height={size} strokeWidth={1.5} />
        </div>
      ))}
    </div>
  );
}
