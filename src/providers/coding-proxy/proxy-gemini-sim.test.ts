import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelService, MODEL_PREFIX } from "../../../tools/wardby-sim/src/model/service.js";
import { simRequest } from "../../../tools/wardby-sim/src/server.js";
import { createSimulatorModelFetch, loadTestSimulators } from "../../config/test-simulators.js";
import { body, gemini, VERTEX_US } from "./gemini.test-support.js";

let server: Server;
let base: string;
const service = createModelService();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void handle(req, res, chunks));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await service.actions!["model.load"](
    {
      scripts: [
        {
          agent: "gemini-cli",
          protocol: "gemini-generate-content",
          match: "hello",
          turns: [{ parts: [{ text: "sim reply" }] }],
        },
      ],
    },
    { state: {} as never },
  );
});
afterAll(() => server.close());

async function handle(req: IncomingMessage, res: ServerResponse, chunks: Buffer[]) {
  const url = new URL(req.url ?? "/", "http://sim.invalid");
  const path = url.pathname.startsWith(MODEL_PREFIX) ? url.pathname.slice(MODEL_PREFIX.length) : url.pathname;
  const request = simRequest(req.method ?? "GET", `${path}${url.search}`, Buffer.concat(chunks));
  const response = (await service.handle(request, {} as never)) ?? { status: 404, body: "" };
  res.writeHead(response.status, response.headers).end(response.body);
}

describe("Gemini through the proxy against the scripted model", () => {
  it("relays and settles a stream (AI Studio) and a JSON reply (Vertex)", async () => {
    const sims = loadTestSimulators({ WARDBY_TEST_SIMULATORS: "1", WARDBY_SIM_BASE_URL: base })!;
    const fetch = createSimulatorModelFetch(sims, () => new Error("blocked"));
    const studio = await gemini({ fetch });
    expect((await studio.execute(body())).text()).toContain("sim reply");
    const vertex = await gemini({ model: VERTEX_US, fetch });
    expect(
      JSON.parse((await vertex.execute(body(), "generateContent")).text()).candidates[0].content.parts[0].text,
    ).toBe("sim reply");
  });
});
