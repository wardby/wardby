export function classifyModel(model: string, routableModels: ReadonlySet<string>): "routable" | "unroutable" {
  return routableModels.has(model) ? "routable" : "unroutable";
}
