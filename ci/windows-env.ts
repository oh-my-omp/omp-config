import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL = "opencode-go/deepseek-v4.1-flash";
const ROLES = ["default", "smol", "slow", "plan", "commit", "tiny", "memory", "task", "advisor"];

type Mapping = { readonly [key: string]: unknown };

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

export function bindModelRoles(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true });
	const configPath = join(agentDir, "config.yml");
	const config: unknown = existsSync(configPath) ? Bun.YAML.parse(readFileSync(configPath, "utf8")) : {};
	const modelRoles = Object.fromEntries(ROLES.map((role) => [role, MODEL]));
	writeFileSync(configPath, Bun.YAML.stringify({ ...(isMapping(config) ? config : {}), modelRoles, skills: { enabled: false } }, null, 2));
}
