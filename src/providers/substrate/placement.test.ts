import { describe, expect, it } from "vitest";
import { canPlaceAll, pickWorker } from "./placement.js";

const room = (cpuMillicores: number, memoryBytes: number) => ({ cpuMillicores, memoryBytes });

describe("placement", () => {
  it("picks the worker with the most free room that fits", () => {
    expect(pickWorker([room(500, 10), room(900, 10), room(900, 20)], room(400, 5))).toBe(2);
    expect(pickWorker([room(500, 10), room(900, 4)], room(400, 5))).toBe(0);
    expect(pickWorker([room(300, 10)], room(400, 5))).toBeUndefined();
    expect(pickWorker([], room(1, 1))).toBeUndefined();
  });

  it("places the larger size first, then the other, sharing a worker when it fits", () => {
    expect(canPlaceAll([room(1000, 100)], [room(250, 30), room(750, 70)])).toBe(true);
    expect(canPlaceAll([room(999, 100)], [room(250, 30), room(750, 70)])).toBe(false);
    expect(canPlaceAll([room(800, 100), room(300, 100)], [room(250, 30), room(750, 70)])).toBe(true);
    expect(canPlaceAll([room(800, 100), room(200, 100)], [room(250, 30), room(750, 70)])).toBe(false);
    // Memory binds too.
    expect(canPlaceAll([room(1000, 60), room(1000, 40)], [room(250, 30), room(750, 70)])).toBe(false);
    expect(canPlaceAll([room(1000, 70), room(250, 30)], [room(250, 30), room(750, 70)])).toBe(true);
    // Does not mutate its input.
    const free = [room(1000, 100)];
    canPlaceAll(free, [room(500, 50)]);
    expect(free).toEqual([room(1000, 100)]);
  });
});
