import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase } from "./types.js";

export const CASES_DIR = fileURLToPath(new URL("../../evals/cases/", import.meta.url));

export async function loadEvalCase(id: string): Promise<EvalCase> {
  const raw = await readFile(join(CASES_DIR, `${id.toLowerCase()}.json`), "utf8");
  return JSON.parse(raw) as EvalCase;
}

export async function listEvalCaseIds(): Promise<string[]> {
  const files = await readdir(CASES_DIR);
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export async function loadAllEvalCases(): Promise<EvalCase[]> {
  const ids = await listEvalCaseIds();
  return Promise.all(ids.map(loadEvalCase));
}
