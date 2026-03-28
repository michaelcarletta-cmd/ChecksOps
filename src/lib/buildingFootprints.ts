export const BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY = "darwin-footprint-refresh";

export interface NearbyFootprintRow {
  source: string;
  source_id: string | null;
  centroid_lat: number;
  centroid_lng: number;
  area_sqft: number;
  vertex_count: number | null;
  distance_ft: number;
}

export interface PendingFootprintRefresh {
  address: string;
  lat: number;
  lng: number;
  bboxRadiusFt: number;
  timestamp: string;
}

const FEET_PER_DEGREE_LAT = 364000;

const toRad = (degrees: number) => (degrees * Math.PI) / 180;

export function buildCentroidBounds(lat: number, lng: number, radiusFeet: number) {
  const safeRadius = Math.max(25, radiusFeet);
  const latDelta = safeRadius / FEET_PER_DEGREE_LAT;
  const lngDelta = safeRadius / (FEET_PER_DEGREE_LAT * Math.max(Math.abs(Math.cos(toRad(lat))), 0.000001));

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

export function haversineDistanceFeet(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
) {
  const earthRadiusFeet = 20902231;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusFeet * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isAiVisionSource(source?: string | null) {
  return (source ?? "").toLowerCase().includes("ai vision");
}