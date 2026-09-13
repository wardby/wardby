const timeoutMs = 90_000;
const intervalMs = 1_000;
const deadline = Date.now() + timeoutMs;

async function waitFor(name, url, check) {
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (await check(response)) return;
      lastError = `${response.status} from ${url}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${name} was not ready within ${timeoutMs / 1_000}s: ${lastError}`);
}

await waitFor("Grafana", "http://127.0.0.1:3000/api/health", async (response) => response.ok);
await waitFor(
  "Prometheus target",
  "http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22reevo-coding-proxy%22%7D",
  async (response) => {
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === "success" && body.data?.result?.some((sample) => sample.value?.[1] === "1");
  },
);

const headers = { authorization: `Basic ${Buffer.from("admin:reevo-local-only").toString("base64")}` };
for (const uid of ["reevo-coding-proxy", "reevo-knock-knock"]) {
  const dashboard = await fetch(`http://127.0.0.1:3000/api/dashboards/uid/${uid}`, { headers });
  if (!dashboard.ok) throw new Error(`Grafana dashboard ${uid} was not provisioned: ${dashboard.status}`);
}

console.log(
  "Grafana smoke passed: Grafana is healthy, Prometheus scrapes reevo-coding-proxy, and both dashboards are provisioned.",
);
