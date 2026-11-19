import { sep } from "node:path";

export function layerRuleFiles(discovered: readonly string[], machineDir: string): string[] {
	const machine = machineDir + sep;
	return [...discovered.filter((path) => !path.startsWith(machine)), ...discovered.filter((path) => path.startsWith(machine))];
}
