import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerWatchdog } from "./runtime.ts";

export default function watchdogAgent(pi: ExtensionAPI): void {
	registerWatchdog(pi);
}
