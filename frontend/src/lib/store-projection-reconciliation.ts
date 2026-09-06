import { useCallback } from "react";

// Exported business commands retain their result even if a projection read fails.
export function useReconciledProjectionCommand<Args extends unknown[], Result>(
  command: (...args: Args) => Promise<Result>,
  begin: () => () => void,
): (...args: Args) => Promise<Result> {
  return useCallback(async (...args: Args) => {
    const finish = begin();
    try {
      return await command(...args);
    } finally {
      finish();
    }
  }, [command, begin]);
}
