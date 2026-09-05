#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { captureDashboardPerformance, parseArgs } from "./capture-dashboard-performance.mjs";
import { CAPTURE_ROUTES, validateFunctionalCapture } from "./performance-capture-policy.mjs";

export async function captureFunctionalPerformance(options, dependencies) {
  validateFunctionalCapture(options);
  return captureDashboardPerformance({ ...options, functional: true }, dependencies);
}
async function main() {
  const args = process.argv.slice(2);
  const routeIndex = args.indexOf("--route");
  const route = routeIndex >= 0 ? args[routeIndex + 1] : "dashboard";
  if (!Object.hasOwn(CAPTURE_ROUTES, route)) throw new Error("--route must name a fixed dashboard route.");
  const disposableData = args.includes("--disposable-data");
  const releaseArgs = args.filter((value, index) => value !== "--disposable-data" && (routeIndex < 0 || (index !== routeIndex && index !== routeIndex + 1)));
  const evidence = await captureFunctionalPerformance({ ...parseArgs(releaseArgs), route, disposableData });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Functional performance capture failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
