import { sep } from "node:path";

/**
 * Rule files in precedence order: project files (every discovered path outside
 * `machineDir`) in discovery order, then every machine file in `machineDir` in
 * discovery order. Layers, not names: a project file never hides a machine
 * file, so the machine rules stay behind the project's as its fallback.
 */
export function layerRuleFiles(discovered: readonly string[], machineDir: string): string[] {
	const machine = machineDir + sep;
	return [...discovered.filter((path) => !path.startsWith(machine)), ...discovered.filter((path) => path.startsWith(machine))];
}
