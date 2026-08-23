/**
 * Route impact / ETA model.
 *
 * WHAT IT IS
 * A transparent, fully deterministic simulation of how a disruption changes the
 * expected arrival time at one affected location. It is NOT a real routing
 * engine, and it does not call any external mapping service - the project is
 * about scalable event processing, not about navigation accuracy.
 *
 *   etaMinutes = baseEta + delayPenalty + disruptionPenalty + crowdingPenalty
 *
 * WHY IT IS DETERMINISTIC
 * Experiment A (one fixed task) and Experiment B (autoscaling) must run the
 * IDENTICAL workload so the two results can be compared. If the ETA depended on
 * randomness or wall-clock time, the same job would produce different results
 * in different runs and duplicate-suppression could not be verified either.
 * Every input here comes from the job itself.
 *
 * Input:  one analysis job (schemas/analysis-job.schema.json)
 * Output: a calculation result (etaMinutes, impactLevel and the component
 *         breakdown, so the number can be explained rather than trusted).
 */

/**
 * Minutes of extra travel time attributable to the disruption type itself.
 *
 * `base`   - impact at the incident location.
 * `perHop` - additional impact for each stop further along the route.
 *
 * The shape of each profile encodes the real operational difference:
 *   breakdown - moderate at the scene, but every stop further down the line
 *               waits progressively longer for the following service, so the
 *               per-hop term is the largest of the three.
 *   blocked   - a tram is on rails and cannot be diverted, so the entire track
 *               segment in that direction is affected roughly EQUALLY: high
 *               base, small per-hop growth.
 *   cancelled - a whole train service disappears, so the base impact is the
 *               largest and it persists along the line.
 */
export const DISRUPTION_PENALTIES = {
  breakdown: { base: 9, perHop: 1.6 },
  blocked: { base: 14, perHop: 0.35 },
  cancelled: { base: 22, perHop: 0.9 },
  severeDelay: { base: 5, perHop: 0.8 },
  crowding: { base: 2, perHop: 0.3 },
};

/** Typical headway per mode - the cost of missing a service, in minutes. */
export const MODE_HEADWAY = { bus: 12, tram: 8, train: 20, multimodal: 15 };

export const IMPACT_THRESHOLDS = { low: 8, medium: 16, high: 28 };

/** Base travel time to a location `hops` stops downstream of the incident. */
export function baseEtaMinutes(mode, hops) {
  const perHop = mode === 'train' ? 4 : (mode === 'tram' ? 2.5 : 2);
  return Number((3 + hops * perHop).toFixed(2));
}

export function delayPenaltyMinutes(delaySeconds) {
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) return 0;
  // Reported delay converted to minutes, damped: a service running 30 minutes
  // late does not make the next arrival 30 minutes later at every stop.
  return Number(Math.min(30, (delaySeconds / 60) * 0.6).toFixed(2));
}

export function disruptionPenaltyMinutes(reason, mode, hops) {
  const profile = DISRUPTION_PENALTIES[reason] ?? DISRUPTION_PENALTIES.severeDelay;
  // Longer headways make any missed service more expensive, so a train
  // disruption costs more than the same disruption on a frequent tram line.
  const headwayFactor = (MODE_HEADWAY[mode] ?? 12) / 12;
  return Number(((profile.base + profile.perHop * hops) * headwayFactor).toFixed(2));
}

export function crowdingPenaltyMinutes(crowdingLevel, occupancyRatio) {
  const byLevel = { normal: 0, moderate: 0.8, high: 2.2, critical: 4.5 };
  const base = byLevel[crowdingLevel] ?? 0;
  // Crush loading slows boarding at every stop, so add a little more above 1.0.
  const overload = Number.isFinite(occupancyRatio) && occupancyRatio > 1
    ? (occupancyRatio - 1) * 3
    : 0;
  return Number((base + overload).toFixed(2));
}

export function impactLevelFor(etaMinutes) {
  if (etaMinutes >= IMPACT_THRESHOLDS.high) return 'critical';
  if (etaMinutes >= IMPACT_THRESHOLDS.medium) return 'high';
  if (etaMinutes >= IMPACT_THRESHOLDS.low) return 'medium';
  return 'low';
}

/**
 * Calculate the route impact for one analysis job.
 * Pure function: same job in, same result out, always.
 */
export function calculateRouteImpact(job) {
  const hops = Number.isFinite(job.hopsFromIncident) ? job.hopsFromIncident : 0;
  const mode = job.transportMode;
  const context = job.context || {};

  const base = baseEtaMinutes(mode, hops);
  const delay = delayPenaltyMinutes(context.delaySeconds);
  const disruption = disruptionPenaltyMinutes(job.reason, mode, hops);
  const crowding = crowdingPenaltyMinutes(context.crowdingLevel, context.occupancyRatio);

  // Tram blockages are directional: the opposite direction recovers faster.
  const directionFactor = mode === 'tram' && context.direction === 'inbound' ? 0.85 : 1;

  const etaMinutes = Number(((base + delay + disruption + crowding) * directionFactor).toFixed(1));

  return {
    etaMinutes,
    impactLevel: impactLevelFor(etaMinutes),
    components: {
      baseEta: base,
      delayPenalty: delay,
      disruptionPenalty: disruption,
      crowdingPenalty: crowding,
      directionFactor,
    },
    qualityIndicator: 'simulated',
  };
}

export default calculateRouteImpact;
