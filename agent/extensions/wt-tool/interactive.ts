import { stripVTControlCharacters } from "node:util";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { isUiNode, type JSXNode } from "@oh-my-pi/pi-tui";
import { errorText } from "../_shared/errors.ts";

function shadow<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
	const own = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
	return () => {
		if (own) Object.defineProperty(target, key, own);
		else delete target[key];
	};
}

function nodeText(node: JSXNode, out: string[]): void {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return;
	}
	if (typeof node === "function") {
		nodeText(node(), out);
		return;
	}
	if (isUiNode(node)) {
		const props = node.props();
		if ("text" in props && typeof props.text === "string") out.push(props.text);
		else if ("spans" in props && Array.isArray(props.spans)) out.push(props.spans.map((span) => span.t).join(""));
		for (const child of node.children()) nodeText(child, out);
		return;
	}
	for (const item of node) nodeText(item, out);
}

function presentedText(factory: Parameters<InteractiveModeContext["present"]>[0]): string[] {
	const parts: string[] = [];
	nodeText(factory(), parts);
	const text = stripVTControlCharacters(parts.join("\n")).trim();
	return text ? [text] : [];
}

export async function runSlashCommand(mode: InteractiveModeContext, text: string): Promise<string[]> {
	const shown: string[] = [];
	const record = (prefix: string, message: string): void => {
		const line = stripVTControlCharacters(message).trim();
		if (line) shown.push(`${prefix}${line}`);
	};
	const showError = mode.showError;
	const showWarning = mode.showWarning;
	const showStatus = mode.showStatus;
	const present = mode.present;
	const undo = [
		shadow(mode, "showError", (message) => {
			record("Error: ", message);
			showError.call(mode, message);
		}),
		shadow(mode, "showWarning", (message, options) => {
			record("Warning: ", message);
			showWarning.call(mode, message, options);
		}),
		shadow(mode, "showStatus", (message, options) => {
			record("", message);
			showStatus.call(mode, message, options);
		}),
		shadow(mode, "present", (factory, options) => {
			shown.push(...presentedText(factory));
			return present.call(mode, factory, options);
		}),
		shadow(mode.composer, "addToHistory", () => {}),
	];
	try {
		const handled = await executeBuiltinSlashCommand(text, { ctx: mode, draftDetached: true });
		if (handled === false) shown.push(`Error: the built-in ${text.split(" ", 1)[0]} command was not found (omp internals changed).`);
	} catch (error) {
		shown.push(`Error: ${errorText(error)}`);
	} finally {
		for (const restore of undo.reverse()) restore();
	}
	return shown;
}

export const describeShown = (shown: readonly string[]): string => (shown.length > 0 ? shown.join("\n") : "(it showed nothing)");
