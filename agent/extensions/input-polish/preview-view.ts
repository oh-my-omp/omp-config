import type { ExtensionTheme, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { tr } from "../_shared/i18n.ts";

export type Preview =
	| { readonly kind: "polishing"; readonly partial: string }
	| { readonly kind: "ready"; readonly text: string }
	| { readonly kind: "failed"; readonly message: string };

const CHROME_ROWS = 6;
const MAX_TERMINAL_SHARE = 0.75;

function wrapLine(line: string, width: number): string[] {
	return line === "" ? [""] : wrap(line, width);
}

function wrappedTail(raw: string, width: number, count: number): string[] {
	const reversed: string[] = [];
	let end = raw.length;
	while (reversed.length < count) {
		// `lastIndexOf` clamps a negative position to 0, so the start of the text needs its own case:
		// otherwise a text that begins with a newline is read as one more empty line forever.
		const start = end === 0 ? -1 : raw.lastIndexOf("\n", end - 1);
		const rows = wrapLine(raw.slice(start + 1, end), width);
		const need = count - reversed.length;
		if (rows.length >= need) {
			for (const row of rows.slice(rows.length - need).reverse()) reversed.push(row);
			break;
		}
		for (const row of rows.reverse()) reversed.push(row);
		if (start < 0) break;
		end = start;
	}
	return reversed.reverse();
}

function wrappedHead(raw: string, width: number, count: number, theme: ExtensionTheme): string[] {
	const wrapped = raw.split("\n").flatMap((line) => wrapLine(line, width));
	if (wrapped.length <= count) return wrapped;
	const hidden = wrapped.length - (count - 1);
	return [...wrapped.slice(0, count - 1), theme.fg("dim", tr(`… ${hidden} more lines not shown`, `… 另有 ${hidden} 行未显示`))];
}

interface Content {
	readonly title: string;
	readonly hint: string;
	readonly lines: readonly string[];
}

export class PreviewView {
	constructor(
		private readonly ui: ExtensionUiHost,
		private readonly theme: ExtensionTheme,
		private readonly source: { readonly preview: Preview },
	) {}

	private content(width: number, count: number): Content {
		const preview = this.source.preview;
		switch (preview.kind) {
			case "polishing":
				return {
					title: tr("Polish preview", "润色预览"),
					hint: tr("Polishing… · Esc to cancel", "润色中… · Esc 取消"),
					lines: wrappedTail(preview.partial, width, count),
				};
			case "ready":
				return {
					title: tr("Polish preview", "润色预览"),
					hint: tr("Enter to send polished text · Esc to cancel and keep original", "Enter 发送润色稿 · Esc 取消，保留原文"),
					lines: wrappedHead(preview.text, width, count, this.theme),
				};
			case "failed":
				return {
					title: tr("Polish failed", "润色失败"),
					hint: tr("Esc to close and keep original", "Esc 关闭，保留原文"),
					lines: wrappedHead(preview.message, width, count, this.theme).map((line) => this.theme.fg("error", line)),
				};
			default: {
				const unreachable: never = preview;
				return unreachable;
			}
		}
	}

	render(width: number): readonly string[] {
		const t = this.theme;
		const innerWidth = Math.max(0, width - 2);
		const maxBody = Math.max(1, Math.floor(this.ui.size().rows * MAX_TERMINAL_SHARE) - CHROME_ROWS);
		const { title, hint, lines } = this.content(Math.max(1, innerWidth - 2), maxBody);

		const frame = (text: string): string => {
			const cut = truncate(` ${text}`, innerWidth, "");
			return `${t.fg("border", "│")}${cut}${" ".repeat(Math.max(0, innerWidth - visibleWidth(cut)))}${t.fg("border", "│")}`;
		};
		const rule = (l: string, r: string): string => t.fg("border", `${l}${"─".repeat(innerWidth)}${r}`);

		return [
			rule("┌", "┐"),
			frame(t.fg("accent", t.bold(title))),
			rule("├", "┤"),
			...lines.map(frame),
			rule("├", "┤"),
			frame(t.fg("dim", hint)),
			rule("└", "┘"),
		];
	}
}
