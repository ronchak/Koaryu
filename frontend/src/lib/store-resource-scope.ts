// One bounded scope per resource and identity. No records or credentials are retained.
export function createResourceScope() {
  return { revision: 0, pending: 0, sequence: 0, settled: Promise.resolve(), settle: () => {} };
}
export type ResourceScope = ReturnType<typeof createResourceScope>;

export function beginResourceMutation(scope: ResourceScope): () => void {
  if (scope.pending === 0) {
    scope.settled = new Promise<void>((resolve) => { scope.settle = resolve; });
  }
  scope.revision += 1;
  scope.pending += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    scope.revision += 1;
    scope.pending -= 1;
    if (scope.pending === 0) scope.settle();
  };
}
