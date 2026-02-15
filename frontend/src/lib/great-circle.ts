// Great-circle interpolation using spherical linear interpolation (slerp)

const DEG2RAD = Math.PI / 180;

export function interpolateGreatCircle(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  t: number,
): { lat: number; lng: number } {
  // Convert to radians
  const phi1 = lat1 * DEG2RAD;
  const lambda1 = lng1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const lambda2 = lng2 * DEG2RAD;

  // Central angle
  const d =
    Math.acos(
      Math.sin(phi1) * Math.sin(phi2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1),
    ) || 0.0001; // avoid division by zero for same point

  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);

  const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
  const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);

  const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG2RAD;
  const lng = Math.atan2(y, x) / DEG2RAD;

  return { lat, lng };
}
