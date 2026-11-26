import "leaflet/dist/leaflet.css";
import { AttributionControl, CircleMarker, MapContainer, TileLayer, useMapEvents } from "react-leaflet";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

interface LocationPickerProps {
  id: string;
  label: string;
  value: GeoPoint | null;
  onChange: (point: GeoPoint) => void;
  error?: string | null;
}

/** Iran as a whole, until a point is picked. */
const START = { center: [32.4, 53.7] as [number, number], zoom: 5 };
const PICKED_ZOOM = 15;

// OpenStreetMap's standard tiles. Their attribution must stay visible; it has no
// link, since a click would take the app's window to the website.
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILES_ATTRIBUTION = "© OpenStreetMap";
/** The tiles are light in both themes, so the marker keeps one colour that stands out on them. */
const MARKER_COLOR = "#2563eb";

/** Rounded to about 1 m, like the coordinates shown under the map. */
function round(degrees: number): number {
  return Math.round(degrees * 1e5) / 1e5;
}

function ClickToPick({ onPick }: { onPick: (point: GeoPoint) => void }) {
  useMapEvents({
    click: (e) => onPick({ latitude: round(e.latlng.lat), longitude: round(e.latlng.lng) }),
  });
  return null;
}

/**
 * A point picked by clicking a map, e.g. where a clinic is. Needs the internet
 * for the map tiles. Labelled and shows its error like FormField.
 */
export function LocationPicker({ id, label, value, onChange, error }: LocationPickerProps) {
  const { t } = useTranslation();
  const describedBy = `${id}-${error ? "error" : "hint"}`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label id={`${id}-label`} className="mb-1">
        {label}
      </Label>
      {/* Leaflet lays its controls out for left-to-right pages. */}
      <div
        id={id}
        dir="ltr"
        role="application"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        aria-invalid={!!error}
        className={cn(
          "isolate h-72 overflow-hidden rounded-lg border border-input",
          error && "border-destructive ring-3 ring-destructive/20",
        )}
      >
        <MapContainer
          center={value ? [value.latitude, value.longitude] : START.center}
          zoom={value ? PICKED_ZOOM : START.zoom}
          attributionControl={false}
          className="size-full"
        >
          <TileLayer url={TILES} attribution={TILES_ATTRIBUTION} />
          <AttributionControl prefix={false} />
          <ClickToPick onPick={onChange} />
          {value && (
            <CircleMarker
              center={[value.latitude, value.longitude]}
              radius={8}
              pathOptions={{ color: MARKER_COLOR, fillColor: MARKER_COLOR, fillOpacity: 0.6 }}
            />
          )}
        </MapContainer>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {value ? (
            <span dir="ltr">
              {value.latitude.toFixed(5)}, {value.longitude.toFixed(5)}
            </span>
          ) : (
            t("setup.hints.location")
          )}
        </p>
      )}
    </div>
  );
}
