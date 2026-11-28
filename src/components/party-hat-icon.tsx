import { useId, type SVGProps } from "react";

/**
 * A filled, striped party hat in bright colours, for the user's own birthday:
 * on their avatar and beside "Happy birthday" in the header.
 */
export function ColorfulPartyHat(props: SVGProps<SVGSVGElement>) {
  // Unique per hat: several can be on the page at once.
  const clip = useId();
  const cone = "M12 3.5 4.5 20.5q7.5 3 15 0Z";
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <defs>
        <clipPath id={clip}>
          <path d={cone} />
        </clipPath>
      </defs>
      <path d={cone} fill="#ec4899" />
      <g clipPath={`url(#${clip})`}>
        <path d="M2 12.5 22 6v3.2L2 15.7Z" fill="#facc15" />
        <path d="M2 19 22 12.5v3.2L2 22.2Z" fill="#38bdf8" />
        <circle cx="10" cy="10" r="0.9" fill="#fff" />
        <circle cx="14.2" cy="16.5" r="0.9" fill="#fff" />
        <circle cx="8.6" cy="18.6" r="0.8" fill="#fff" />
      </g>
      <path d={cone} fill="none" stroke="#9d174d" strokeOpacity="0.35" strokeWidth="0.8" strokeLinejoin="round" />
      <circle cx="12" cy="3.2" r="2.1" fill="#a855f7" />
      <circle cx="11.3" cy="2.6" r="0.6" fill="#fff" fillOpacity="0.7" />
    </svg>
  );
}

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
