// Equirectangular projection with proper aspect ratio

const PADDING = 0.05;
const LAT_MIN = -60;
const LAT_MAX = 80;
const LNG_MIN = -180;
const LNG_MAX = 180;

// Natural aspect ratio for the lat/lng range
const LAT_RANGE = LAT_MAX - LAT_MIN;  // 140
const LNG_RANGE = LNG_MAX - LNG_MIN;  // 360
const NATURAL_ASPECT = LNG_RANGE / LAT_RANGE;  // ~2.57

export function latLngToCanvas(
  lat: number,
  lng: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  // Calculate the map dimensions that maintain aspect ratio
  const canvasAspect = canvasWidth / canvasHeight;
  let mapWidth, mapHeight, offsetX, offsetY;

  if (canvasAspect > NATURAL_ASPECT) {
    // Canvas is wider than needed - fit to height
    mapHeight = canvasHeight * (1 - 2 * PADDING);
    mapWidth = mapHeight * NATURAL_ASPECT;
    offsetX = (canvasWidth - mapWidth) / 2;
    offsetY = canvasHeight * PADDING;
  } else {
    // Canvas is taller than needed - fit to width
    mapWidth = canvasWidth * (1 - 2 * PADDING);
    mapHeight = mapWidth / NATURAL_ASPECT;
    offsetX = canvasWidth * PADDING;
    offsetY = (canvasHeight - mapHeight) / 2;
  }

  const x = offsetX + ((lng - LNG_MIN) / LNG_RANGE) * mapWidth;
  const y = offsetY + ((LAT_MAX - lat) / LAT_RANGE) * mapHeight;

  return { x, y };
}
