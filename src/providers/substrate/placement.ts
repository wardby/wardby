/**
 * Placement by free resources, the way Substrate packs actors onto workers: a worker holds many
 * actors, bounded by its free CPU and memory. Used by the launcher's capacity check and by the
 * in-memory fake, so both agree on what fits.
 */

export interface Room {
  cpuMillicores: number;
  memoryBytes: number;
}

const fits = (room: Room, size: Room): boolean =>
  room.cpuMillicores >= size.cpuMillicores && room.memoryBytes >= size.memoryBytes;

/** Orders by CPU, then memory: positive when `a` is larger. */
const compare = (a: Room, b: Room): number => a.cpuMillicores - b.cpuMillicores || a.memoryBytes - b.memoryBytes;

/** The index of the worker with the most free room that fits `size` (first on a tie); undefined when none fits. */
export function pickWorker(free: readonly Room[], size: Room): number | undefined {
  let best: number | undefined;
  free.forEach((room, index) => {
    if (fits(room, size) && (best === undefined || compare(room, free[best]) > 0)) best = index;
  });
  return best;
}

/**
 * Whether every size can be placed on the workers at once, greedily: the largest first, each on the
 * worker with the most free room that still fits it. Sizes may share a worker.
 */
export function canPlaceAll(free: readonly Room[], sizes: readonly Room[]): boolean {
  const rooms = free.map((room) => ({ ...room }));
  for (const size of [...sizes].sort((a, b) => compare(b, a))) {
    const index = pickWorker(rooms, size);
    if (index === undefined) return false;
    rooms[index].cpuMillicores -= size.cpuMillicores;
    rooms[index].memoryBytes -= size.memoryBytes;
  }
  return true;
}
