import type { SVGProps } from "react";

/** A party hat, drawn like the lucide-react icons (which have none): marks birthdays on the calendar. */
export function PartyHatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 5 5 21h14Z" />
      <circle cx="12" cy="3" r="1.5" />
      <path d="m8.5 13 4 2.5" />
      <path d="m10.5 9 3 2" />
      <path d="m7 17 6 3.5" />
    </svg>
  );
}
