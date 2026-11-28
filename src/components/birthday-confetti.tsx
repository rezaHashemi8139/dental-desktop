import { useEffect, useRef, useState } from "react";
import { useSession } from "@/auth/store";
import { useTodayBirthdays } from "@/lib/birthdays";

/** Paper colours: bright on both the light and the dark theme. */
const COLORS = ["#f43f5e", "#ec4899", "#a855f7", "#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#facc15", "#f97316"];
/** Pieces per shot of each cannon. */
const PIECES_PER_SHOT = 90;
/** Shots of the two cannons, in milliseconds after the start. */
const SHOTS = [0, 450];
/** Stops even if some pieces are still in the air. */
const MAX_DURATION = 15_000;

/**
 * Over the whole window, once per login on a day when it is someone's birthday
 * (one of this computer's users): coloured paper shot up from the two bottom
 * corners, which then flutters slowly down. Never blocks the pointer; skipped
 * when the system asks for reduced motion.
 */
export function BirthdayConfetti() {
  const session = useSession();
  const { today, people } = useTodayBirthdays();
  // The login and day it has played for: once each, again after logging in anew.
  const [played, setPlayed] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!session) {
      setPlayed(null);
      return;
    }
    const key = `${session.userId}/${today}`;
    if (people.length === 0 || played === key) return;
    setPlayed(key);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPlaying(true);
  }, [session, today, people.length, played]);

  return playing ? <ConfettiCanvas onDone={() => setPlaying(false)} /> : null;
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** How fast it falls once it flutters, in pixels per frame. */
  fall: number;
  width: number;
  height: number;
  color: string;
  rotation: number;
  spin: number;
  /** Its flip about its own axis, which makes the paper flash as it turns. */
  tilt: number;
  tiltSpeed: number;
  swayPhase: number;
  swaySpeed: number;
}

function ConfettiCanvas({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let width = 0;
    let height = 0;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const pieces: Piece[] = [];
    const random = (min: number, max: number) => min + Math.random() * (max - min);
    // Up and inwards from a bottom corner; stronger on taller windows.
    const shoot = (fromLeft: boolean) => {
      const power = Math.max(height, 500) / 800;
      for (let i = 0; i < PIECES_PER_SHOT; i++) {
        const angle = (random(52, 82) * Math.PI) / 180;
        // Reaches from about 40% to 85% of the window's height.
        const speed = random(22, 38) * power;
        pieces.push({
          x: fromLeft ? random(-10, 30) : width - random(-10, 30),
          y: height + random(0, 20),
          vx: Math.cos(angle) * speed * (fromLeft ? 1 : -1),
          vy: -Math.sin(angle) * speed,
          fall: random(1.1, 2.1),
          width: random(7, 12),
          height: random(4, 7),
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          rotation: random(0, Math.PI * 2),
          spin: random(-0.15, 0.15),
          tilt: random(0, Math.PI * 2),
          tiltSpeed: random(0.06, 0.16),
          swayPhase: random(0, Math.PI * 2),
          swaySpeed: random(0.02, 0.05),
        });
      }
    };

    const start = performance.now();
    let last = start;
    let nextShot = 0;
    let frame = 0;
    const draw = (now: number) => {
      // In frames of 60 per second, so slow and fast screens look the same.
      const step = Math.min((now - last) / (1000 / 60), 3);
      last = now;
      while (nextShot < SHOTS.length && now - start >= SHOTS[nextShot]) {
        shoot(true);
        shoot(false);
        nextShot++;
      }

      context.clearRect(0, 0, width, height);
      for (const piece of pieces) {
        // Air slows it quickly; then it sways down at its own slow pace.
        const drag = Math.pow(0.965, step);
        piece.vx *= drag;
        piece.vy = Math.min(piece.vy * (piece.vy < 0 ? drag : 1) + 0.28 * step, piece.fall);
        piece.swayPhase += piece.swaySpeed * step;
        piece.x += (piece.vx + Math.sin(piece.swayPhase) * 0.9) * step;
        piece.y += piece.vy * step;
        piece.rotation += piece.spin * step;
        piece.tilt += piece.tiltSpeed * step;

        if (piece.y > height + 20) continue;
        const flip = Math.cos(piece.tilt);
        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.rotation);
        context.scale(1, flip);
        context.fillStyle = piece.color;
        // Darker while its back faces the screen.
        context.globalAlpha = flip < 0 ? 0.75 : 1;
        context.fillRect(-piece.width / 2, -piece.height / 2, piece.width, piece.height);
        context.restore();
      }

      const landed = nextShot === SHOTS.length && pieces.every((piece) => piece.y > height + 20);
      if (landed || now - start > MAX_DURATION) {
        doneRef.current();
        return;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 z-100 size-full" />;
}
