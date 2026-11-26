import type { CSSProperties } from "react";

/**
 * The logo is an isometric drawing of a cube whose three faces carry the letters
 * S (top), M (left) and B (right). Each matrix takes one face out of
 * public/logo.svg (its viewBox coordinates) and flattens it onto a 1000x1000
 * square, so it can be laid on a real 3D cube. Fitted to each face's own corners,
 * with an even 2.5% margin: next to each other, the margins make the seams
 * between the faces.
 */
const ART = {
  top: "matrix(0.7594 0.7521 -1.3189 1.3001 467.0566 -446.7904)",
  left: "matrix(1.5127 -0.768 0 1.3324 0.7962 -469.0227)",
  right: "matrix(1.5702 0.7797 0 1.3032 -1034.9174 -1464.3554)",
} as const;
type Art = keyof typeof ART;

/**
 * The cube's six sides (placed by src/index.css): the three the logo draws, and
 * the opposite three repeating them so it looks whole from every side. `shade`
 * lights each side differently, like a solid.
 */
const SIDES: { side: string; art: Art; shade: number }[] = [
  { side: "top", art: "top", shade: 1.08 },
  { side: "bottom", art: "top", shade: 0.75 },
  { side: "left", art: "left", shade: 1 },
  { side: "right", art: "left", shade: 0.9 },
  { side: "front", art: "right", shade: 0.88 },
  { side: "back", art: "right", shade: 0.8 },
];

const maskId = (art: Art) => `auth-backdrop-art-${art}`;
/** Light falling across a face: brighter at the top-left corner, shadowed at the bottom-right. */
const SHEEN_ID = "auth-backdrop-sheen";

/** One face's artwork, flattened; placed in the logo's own coordinates (its viewBox) first. */
function FaceArt({ art }: { art: Art }) {
  return <image href="/logo.svg" x={-108} y={-29} width={1520} height={1520} transform={ART[art]} />;
}

/**
 * Decoration behind the login, sign-up and setup screens: the logo built as a
 * solid cube, starting in the logo's own pose and tumbling while it drifts around
 * the screen, with two soft lights moving in the logo's colours. Each side is a
 * shell with the letter cut through it, over a dark core set back inside the
 * cube, so the letters read as grooves carved into a solid block. Pure CSS
 * animation (styles in src/index.css); still when the system asks for reduced
 * motion. Hidden from screen readers and never takes clicks.
 */
export function AuthBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="auth-backdrop-glow absolute -inset-s-1/4 -top-1/4 size-[70vmax] rounded-full bg-teal-400/15 blur-3xl dark:bg-teal-500/10" />
      <div className="auth-backdrop-glow auth-backdrop-glow-late absolute -inset-e-1/4 -bottom-1/4 size-[70vmax] rounded-full bg-sky-500/15 blur-3xl dark:bg-sky-600/10" />

      {/* Shared by the faces below. */}
      <svg className="absolute size-0">
        <defs>
          <linearGradient id={SHEEN_ID} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="white" stopOpacity={0.4} />
            <stop offset="0.5" stopColor="white" stopOpacity={0} />
            <stop offset="1" stopColor="black" stopOpacity={0.25} />
          </linearGradient>
          {(Object.keys(ART) as Art[]).map((art) => (
            <mask key={art} id={maskId(art)} style={{ maskType: "alpha" }}>
              <FaceArt art={art} />
            </mask>
          ))}
        </defs>
      </svg>

      {/* Faded here, not on the cube: opacity there would flatten its 3D. */}
      <div className="auth-backdrop-stage absolute inset-0 flex items-center justify-center opacity-35 dark:opacity-40">
        <div className="auth-backdrop-drift">
          <div className="auth-backdrop-cube relative">
            {SIDES.map(({ side, art, shade }) => {
              const style = { "--shade": shade } as CSSProperties;
              return [
                <div
                  key={`core-${side}`}
                  className={`auth-backdrop-face auth-backdrop-core auth-backdrop-side-${side} absolute inset-0 bg-sky-950 dark:bg-black`}
                  style={style}
                />,
                <svg
                  key={`shell-${side}`}
                  viewBox="0 0 1000 1000"
                  className={`auth-backdrop-face auth-backdrop-side-${side} absolute inset-0 size-full`}
                  style={style}
                >
                  <FaceArt art={art} />
                  <rect width={1000} height={1000} fill={`url(#${SHEEN_ID})`} mask={`url(#${maskId(art)})`} />
                </svg>,
              ];
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
