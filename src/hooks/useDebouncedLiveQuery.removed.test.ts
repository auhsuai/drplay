import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// WHY: useDebouncedLiveQuery was the debounce used by the old in-memory
// search path; Task 3 of the search rebuild replaced it with the
// worker-hosted engine. This guard ensures the orphaned module never comes
// back and no straggler import survives a future refactor.
const GUARD_FILE = fileURLToPath(import.meta.url);

function collectTsSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".")) continue;
    if (statSync(full).isDirectory()) {
      collectTsSources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("useDebouncedLiveQuery removed", () => {
  it("no file under src references useDebouncedLiveQuery anymore", () => {
    const offenders = collectTsSources(join(process.cwd(), "src")).filter(
      (file) =>
        file !== GUARD_FILE &&
        readFileSync(file, "utf8").includes("useDebouncedLiveQuery"),
    );
    expect(offenders).toEqual([]);
  });
});
