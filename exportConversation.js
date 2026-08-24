// messages-takeout — export a Google Messages conversation from the DevTools console.
// https://github.com/s0meguy1/messages-takeout
//
// Based on exportConversation.js by prooma (MIT):
//   https://codeberg.org/prooma/google-messages-web-export  (primary)
//   https://github.com/prooma/google-messages-web-export    (mirror)
// Rewritten against the 2026 Google Messages DOM: pages the thread in, reads
// absolute timestamps, keeps line breaks, and captures attachments/reactions.
//
// Export chat conversation from https://messages.google.com/web to text and JSON.
//
// Paste this whole file into the DevTools console with a conversation open, then:
//   await exportConversation();                        // last 7 days, as text
//   copy(await exportConversation());                  // ...onto the clipboard
//   await exportConversation({ days: 30 });            // last 30 days
//   await exportConversation({ since: "2026-01-01" }); // from a fixed date
//   await exportConversation({ all: true });           // the entire thread
//   await exportConversation({ returnJson: true });    // array of message objects
//   await downloadConversation({ days: 30 });          // save conversation.txt
//   await downloadConversation({ format: "json" });    // save conversation.json
//
// NOTE: this is async, because the thread has to be paged in before it can be read.
// `exportConversation()` without `await` gives you a Promise, not messages.
//
// Google Messages renders only the newest ~25 messages and pages the rest in 25-50 at
// a time, roughly 1-4s per batch. A thread with 20k messages is ~20 minutes of paging,
// so the default is a one-week window; widen it with `days`, `since`, or `all`.
//
// Options:
//   days                7       how far back to export
//   since               null    Date | "YYYY-MM-DD" | epoch ms — overrides `days`
//   until               null    optional newer bound, same formats
//   all                 false   ignore the window and walk the whole thread
//   returnJson          false   return message objects instead of formatted text
//   meLabel             "Me"    name to use for your own messages
//   maxLoadClicks       500     safety cap on "Load more messages" clicks
//   loadWaitMs          25000   how long to wait for one batch to arrive
//   loadRetries         3       consecutive empty batches before calling it the end
//   includeLinkPreviews false   keep the link-preview card text in the message body
//   includeReactions    true    append "(reactions: ...)" when a message has any
//   onProgress          null    fn({ loaded, clicks, oldest }) after each batch

const MWS_SKIP_TAGS = new Set([
	"MWS-LINK-PREVIEW-DECORATOR", "MWS-MESSAGE-STATUS", "MWS-MESSAGE-ACTIONS",
	"MWS-ABSOLUTE-TIMESTAMP", "MWS-RELATIVE-TIMESTAMP",
	"MW-MESSAGE-REACTIONS-DISPLAY", "MW-MESSAGE-REACTIONS-SPACER",
	"MAT-PROGRESS-SPINNER", "MWS-SPINNER", "MWS-ICON",
]);

const MWS_BLOCK_TAGS = new Set([
	"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET",
	"FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
	"HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL",
]);

// Placeholders for parts that carry no text of their own. Anything not listed here
// falls back to a name derived from the tag, so new part types still show up.
const MWS_PART_LABELS = {
	"mws-image-message-part": "[Image]",
	"mws-video-message-part": "[Video]",
	"mws-audio-message-part": "[Audio]",
	"mws-file-message-part": "[File]",
	"mws-vcard-message-part": "[Contact card]",
	"mws-location-message-part": "[Location]",
	"mws-sticker-message-part": "[Sticker]",
	"mws-lottie-message-part": "[Animated emoji]",
};

const MWS_TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?$/i;

const mwsSleep = ms => new Promise(r => setTimeout(r, ms));

function mwsParts(wrapper) {
	const routed = wrapper.querySelectorAll("mws-message-part-router > *");
	if (routed.length) return Array.from(routed);

	// Fall back to any *-message-part element if the router markup ever changes.
	return Array.from(wrapper.querySelectorAll("*"))
		.filter(el => el.tagName.toLowerCase().endsWith("-message-part"));
}

// Each part's aria-label carries the absolute timestamp and the sender:
//   "You said: hi. Sent on August 16, 2026 at 4:43 PM. Delivered. End-to-end encrypted."
//   "John Doe sent an image. Received on August 14, 2026 at 2:52 PM. ..."
// The visible tombstones are relative ("Sunday") and mostly year-less, so they can't
// be used for this. A message body can itself contain "Sent on ...", so take the last.
function mwsParseAria(aria) {
	const out = { sender: null, date: null };
	if (!aria) return out;

	const who = aria.match(/^(.*?)\s+(?:said|sent)\b/);
	if (who) out.sender = who[1].trim();

	const stamps = [...aria.matchAll(/\b(?:Sent|Received) on ([^.]+?)(?=\.(?:\s|$))/g)];
	if (stamps.length) {
		const parsed = new Date(stamps[stamps.length - 1][1].replace(/\s+at\s+/i, " "));
		if (!isNaN(parsed)) out.date = parsed;
	}

	return out;
}

// "... End-to-end encrypted. John Doe reacted with love." — the name has to be
// anchored to a sentence boundary, or a lazy `(.+?)` swallows the whole message body
// on its way to " reacted with ". The emoji is read from the DOM instead of the
// aria-label, so it survives a non-English UI even when the name does not.
function mwsReactions(wrapper) {
	const found = [];
	const seen = new Set();

	for (const el of wrapper.querySelectorAll("[aria-label]")) {
		const aria = el.getAttribute("aria-label") || "";
		const pattern = /(?:^|\.\s+)([^.]{1,60}?)\s+reacted with\s+([^.]+?)(?=\.(?:\s|$))/g;

		for (const m of aria.matchAll(pattern)) {
			const key = `${m[1].trim()}|${m[2].trim()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			found.push({ by: m[1].trim(), type: m[2].trim(), emoji: null });
		}
	}

	const emoji = [...wrapper.querySelectorAll("mw-message-reactions-display [data-e2e-reaction]")]
		.map(el => el.textContent.trim())
		.filter(Boolean);

	emoji.forEach((glyph, i) => {
		if (found[i]) found[i].emoji = glyph;
		else found.push({ by: null, type: null, emoji: glyph });
	});

	return found;
}

function mwsMessageMeta(wrapper) {
	const meta = { sender: null, date: null, reactions: [] };

	for (const part of mwsParts(wrapper)) {
		const parsed = mwsParseAria(part.getAttribute("aria-label"));
		meta.sender = meta.sender || parsed.sender;
		meta.date = meta.date || parsed.date;
		if (meta.sender && meta.date) break;
	}

	meta.reactions = mwsReactions(wrapper);
	return meta;
}

function mwsReactionSummary(reactions) {
	return reactions
		.map(r => [r.emoji, r.by].filter(Boolean).join(" ") || r.type)
		.filter(Boolean)
		.join(", ");
}

function mwsToDate(value, fallback = null) {
	if (value == null) return fallback;
	if (value instanceof Date) return isNaN(value) ? fallback : value;

	const parsed = new Date(typeof value === "number" ? value : String(value));
	return isNaN(parsed) ? fallback : parsed;
}

async function exportConversation(options = {}) {
	const {
		days = 7,
		since = null,
		until = null,
		all = false,
		returnJson = false,
		meLabel = "Me",
		maxLoadClicks = 500,
		loadWaitMs = 25000,
		loadRetries = 3,
		includeLinkPreviews = false,
		includeReactions = true,
		onProgress = null,
	} = options;

	const conversation = document.querySelector("mw-conversation-container");
	if (!conversation) {
		console.warn("[export] No <mw-conversation-container> — open a conversation first.");
		return returnJson ? [] : "";
	}

	const upperBound = mwsToDate(until);
	let cutoff = null;
	if (!all) {
		cutoff = mwsToDate(since);
		if (!cutoff) {
			cutoff = new Date(Date.now() - days * 86400000);
		}
	}

	await loadThreadUntil(conversation, {
		cutoff, maxLoadClicks, loadWaitMs, loadRetries, onProgress,
	});

	const headerText = conversation.querySelector("mws-header")?.innerText || "";
	const partnerName = headerText.trim().split("\n")[0].trim() || "Partner";

	const items = Array.from(
		conversation.querySelectorAll(
			"mws-tombstone-message-wrapper, mws-message-wrapper"
		)
	);

	let currentDate = "";
	let tombstoneTime = null;

	const messages = [];
	const seen = new Set();
	let undated = 0;

	// A tombstone reads "Sunday, Aug 16 · 9:13 PM", but today's reads just "9:09 AM".
	// Splitting on " · " unconditionally files that bare time under `date`.
	function getTombstoneDateTime(text) {
		const raw = (text || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
		if (!raw) return { date: "", time: null };

		const bits = raw.split(/\s*·\s*/);
		if (bits.length >= 2) {
			return { date: bits[0].trim(), time: bits.slice(1).join(" · ").trim() };
		}

		return MWS_TIME_ONLY.test(raw)
			? { date: "", time: raw }
			: { date: raw, time: null };
	}

	// Walk the live DOM instead of cloning: innerText on a detached clone has no
	// layout, so every <br> in a multi-line message collapses away.
	function extractText(root) {
		const buf = [];
		const pushBreak = () => {
			if (buf.length && !/\n$/.test(buf[buf.length - 1])) buf.push("\n");
		};

		(function walk(node) {
			if (node.nodeType === Node.TEXT_NODE) {
				buf.push(node.nodeValue);
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			if (MWS_SKIP_TAGS.has(node.tagName)) {
				const keep = includeLinkPreviews && node.tagName === "MWS-LINK-PREVIEW-DECORATOR";
				if (!keep) return;
			}
			if (node.tagName === "BR") {
				buf.push("\n");
				return;
			}

			const block = MWS_BLOCK_TAGS.has(node.tagName);
			if (block) pushBreak();
			node.childNodes.forEach(walk);
			if (block) pushBreak();
		})(root);

		return buf.join("")
			.replace(/ /g, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	function labelForPart(part) {
		const tag = part.tagName.toLowerCase();
		let base = MWS_PART_LABELS[tag];

		if (!base) {
			const kind = tag.replace(/^mws-/, "").replace(/-message-part$/, "").replace(/-/g, " ");
			base = `[${kind.charAt(0).toUpperCase()}${kind.slice(1)}]`;
		}

		// "You sent a video: clip.mp4. Sent on ..." — keep the filename when there is one.
		const aria = part.getAttribute("aria-label") || "";
		const named = aria.match(/\bsent (?:a|an|the) [a-z ]*?:\s*((?:[^.]|\.(?!\s|$))+)/i);

		return named ? `${base.slice(0, -1)}: ${named[1].trim()}]` : base;
	}

	function getMessageText(wrapper) {
		const out = [];

		for (const part of mwsParts(wrapper)) {
			const content = part.querySelector("mws-message-part-content") || part;
			const text = extractText(content);

			// An image with a caption is one wrapper holding an image part (whose
			// content is empty) plus a text part, so both belong in the output.
			if (part.tagName.toLowerCase() !== "mws-text-message-part") {
				out.push(labelForPart(part));
			}
			if (text) out.push(text);
		}

		if (!out.length) {
			const fallback = extractText(wrapper);
			if (fallback) out.push(fallback);
		}

		return out.join("\n");
	}

	for (const item of items) {
		switch (item.nodeName) {
			case "MWS-TOMBSTONE-MESSAGE-WRAPPER": {
				const { date, time } = getTombstoneDateTime(item.textContent);
				if (date) currentDate = date;
				tombstoneTime = time;
				break;
			}

			case "MWS-MESSAGE-WRAPPER": {
				const id = item.getAttribute("msg-id") || "";
				if (id && seen.has(id)) break;
				if (id) seen.add(id);

				const meta = mwsMessageMeta(item);
				const absolute = meta.date;
				const pendingTombstoneTime = tombstoneTime;
				tombstoneTime = null;

				if (!absolute) undated++;

				// Keep messages we can't date rather than silently dropping them.
				if (absolute) {
					if (cutoff && absolute < cutoff) break;
					if (upperBound && absolute > upperBound) break;
				}

				const outgoing = item.getAttribute("is-outgoing") === "true";
				let text = getMessageText(item);

				const reactionSummary = mwsReactionSummary(meta.reactions);
				if (includeReactions && reactionSummary) {
					text += `\n(reactions: ${reactionSummary})`;
				}

				const fallbackTime =
					item.querySelector("mws-absolute-timestamp")?.textContent.trim() || null;

				const date = absolute
					? absolute.toLocaleDateString(undefined, {
						weekday: "long", year: "numeric", month: "long", day: "numeric",
					})
					: currentDate;

				const time = absolute
					? absolute.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
					: (fallbackTime ?? pendingTombstoneTime ?? "");

				let name = meLabel;
				if (!outgoing) {
					// In a group thread the header is the group name, so prefer the
					// per-message sender that the aria-label gives us.
					name = (meta.sender && meta.sender !== "You") ? meta.sender : partnerName;
				}

				messages.push({
					id, outgoing, name, date, time,
					iso: absolute ? absolute.toISOString() : null,
					text,
					reactions: meta.reactions,
				});
				break;
			}
		}
	}

	const range = all
		? "entire thread"
		: `since ${cutoff.toLocaleDateString()}${upperBound ? ` until ${upperBound.toLocaleDateString()}` : ""}`;
	console.info(`[export] ${messages.length} messages from "${partnerName}" (${range}).`);
	if (undated) {
		console.warn(`[export] ${undated} message(s) had no readable timestamp and were kept unfiltered.`);
	}

	if (returnJson) return messages;
	return mwsToText(messages);
}

function mwsToText(messages) {
	return messages
		.map(m => `[${m.date}${m.time ? ", " + m.time : ""}] ${m.name}:\n${m.text}`)
		.join("\n\n");
}

// RFC 4180: quote anything containing a comma, quote or newline, and double the
// internal quotes. The BOM makes Excel read the emoji and accents as UTF-8.
function mwsToCsv(messages) {
	const cell = value => {
		const text = value == null ? "" : String(value);
		return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};

	const header = ["iso", "date", "time", "sender", "direction", "text", "reactions"];
	const rows = messages.map(m => [
		m.iso || "", m.date || "", m.time || "", m.name || "",
		m.outgoing ? "sent" : "received",
		m.text || "",
		mwsReactionSummary(m.reactions || []),
	].map(cell).join(","));

	return "\uFEFF" + [header.join(","), ...rows].join("\r\n");
}

function mwsFormat(messages, format) {
	if (format === "json") return JSON.stringify(messages, null, 2);
	if (format === "csv") return mwsToCsv(messages);
	return mwsToText(messages);
}

function mwsSaveFile(body, format, filename) {
	const types = { json: "application/json", csv: "text/csv", text: "text/plain" };
	const extensions = { json: "json", csv: "csv", text: "txt" };

	const blob = new Blob([body], { type: `${types[format] || types.text};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");

	link.href = url;
	link.download = filename || `conversation.${extensions[format] || "txt"}`;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Google Messages keeps only the newest ~25 messages in the DOM and pages older ones
// in behind "Load more messages", so reading the DOM once returns a stub of the thread.
async function loadThreadUntil(conversation, opts) {
	const { cutoff, maxLoadClicks, loadWaitMs, loadRetries, onProgress } = opts;

	const wrappers = () => conversation.querySelectorAll("mws-message-wrapper");
	const count = () => wrappers().length;
	const button = () => conversation.querySelector("mws-messages-list button.load-more");
	const oldest = () => {
		const first = wrappers()[0];
		return first ? mwsMessageMeta(first).date : null;
	};

	// The button is always parked at `position: fixed; left: -9999px` in a zero-height
	// container, whether or not more messages exist, and stays enabled to the very end.
	// So geometry, `disabled` and `offsetParent` say nothing: the only reliable signals
	// are the oldest loaded message's date and whether a batch actually arrived.
	if (cutoff) {
		const start = oldest();
		if (start && start < cutoff) return count();
		if (!start) {
			console.warn("[export] Can't read message timestamps (non-English UI?) — " +
				"falling back to maxLoadClicks; pass `all: true` or a bigger `maxLoadClicks` if short.");
		}
	}

	let clicks = 0;
	let misses = 0;

	while (clicks < maxLoadClicks) {
		const btn = button();
		if (!btn) break;

		const before = count();
		btn.click();
		clicks++;

		const deadline = Date.now() + loadWaitMs;
		let grew = false;
		while (Date.now() < deadline) {
			await mwsSleep(250);
			if (count() > before) { grew = true; break; }
		}

		// A batch can take longer than expected, so one empty round isn't the end.
		if (!grew) {
			if (++misses >= loadRetries) break;
			continue;
		}
		misses = 0;

		const current = oldest();
		onProgress?.({ loaded: count(), clicks, oldest: current });
		if (cutoff && current && current < cutoff) break;
	}

	if (clicks >= maxLoadClicks) {
		console.warn(`[export] Stopped at maxLoadClicks=${maxLoadClicks}; raise it for older history.`);
	}

	return count();
}

async function downloadConversation(options = {}) {
	const { format = "text", filename = null, ...rest } = options;

	const messages = await exportConversation({ ...rest, returnJson: true });
	const body = mwsFormat(messages, format);

	mwsSaveFile(body, format, filename);
	return messages.length;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
// Built with createElement/textContent and a constructable stylesheet, never
// innerHTML: messages.google.com enforces Trusted Types, so assigning innerHTML
// throws "This document requires 'TrustedHTML'". It lives in a shadow root so
// the app's styles can't reach in and these styles can't leak out.

const MWS_MENU_ID = "messages-takeout-menu";

const MWS_MENU_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  position: fixed; right: 20px; bottom: 20px; width: 306px; z-index: 2147483647;
  font-family: "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px; line-height: 1.45;
  background: #fff; color: #1f1f1f;
  border: 1px solid #dadce0; border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); overflow: hidden;
}
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  background: #f1f3f4; border-bottom: 1px solid #dadce0; cursor: move; user-select: none; }
.titles { flex: 1; min-width: 0; }
.title { font-weight: 600; }
.who { font-size: 11px; color: #5f6368; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.x { border: 0; background: transparent; cursor: pointer; color: #5f6368;
  font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
.x:hover { background: rgba(0,0,0,.08); }
.body { padding: 12px; display: flex; flex-direction: column; gap: 13px; }
.lab { font-size: 10.5px; font-weight: 600; letter-spacing: .05em;
  text-transform: uppercase; color: #5f6368; margin-bottom: 7px; }
.seg { display: flex; flex-wrap: wrap; gap: 6px; }
.seg button { flex: 1 1 auto; min-width: 54px; padding: 6px 9px; font: inherit; font-size: 12px;
  background: #fff; color: #1f1f1f; border: 1px solid #dadce0; border-radius: 999px; cursor: pointer; }
.seg button:hover:not(.sel) { background: #f1f3f4; }
.seg button.sel { background: #1a73e8; border-color: #1a73e8; color: #fff; }
.dates { display: none; gap: 6px; margin-top: 8px; }
.dates.on { display: flex; }
.dates input { flex: 1; min-width: 0; padding: 5px 7px; font: inherit; font-size: 12px;
  border: 1px solid #dadce0; border-radius: 8px; background: #fff; color: #1f1f1f; }
.acts { display: flex; gap: 8px; }
.acts button { flex: 1; padding: 8px; font: inherit; font-size: 13px; font-weight: 500;
  border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
.acts button.go { background: #1a73e8; color: #fff; border-color: #1a73e8; }
.acts button.go:hover:not(:disabled) { background: #1765cc; border-color: #1765cc; }
.acts button.cp { background: #fff; color: #1a73e8; border-color: #dadce0; }
.acts button.cp:hover:not(:disabled) { background: #f1f3f4; }
button:disabled { opacity: .5; cursor: default; }
.status { font-size: 11.5px; color: #5f6368; min-height: 15px; }
.status.err { color: #c5221f; }
.status.ok { color: #188038; }
@media (prefers-color-scheme: dark) {
  .panel { background: #1f1f1f; color: #e8eaed; border-color: #3c4043; }
  .head { background: #2a2b2e; border-bottom-color: #3c4043; }
  .who, .lab, .status, .x { color: #9aa0a6; }
  .x:hover { background: rgba(255,255,255,.1); }
  .seg button { background: #2a2b2e; color: #e8eaed; border-color: #3c4043; }
  .seg button:hover:not(.sel) { background: #35363a; }
  .seg button.sel { background: #8ab4f8; border-color: #8ab4f8; color: #202124; }
  .dates input { background: #2a2b2e; color: #e8eaed; border-color: #3c4043; }
  .acts button.go { background: #8ab4f8; color: #202124; border-color: #8ab4f8; }
  .acts button.go:hover:not(:disabled) { background: #a8c7fa; border-color: #a8c7fa; }
  .acts button.cp { background: #2a2b2e; color: #8ab4f8; border-color: #3c4043; }
  .acts button.cp:hover:not(:disabled) { background: #35363a; }
  .status.err { color: #f28b82; }
  .status.ok { color: #81c995; }
}`;

function mwsEl(tag, props = {}, children = []) {
	const node = document.createElement(tag);

	for (const [key, value] of Object.entries(props)) {
		if (key === "text") node.textContent = value;
		else if (key === "on") for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
		else node.setAttribute(key, value);
	}

	children.forEach(child => node.appendChild(child));
	return node;
}

function closeExportMenu() {
	document.getElementById(MWS_MENU_ID)?.remove();
}

function showExportMenu() {
	closeExportMenu();

	const host = mwsEl("div", { id: MWS_MENU_ID });
	const root = host.attachShadow({ mode: "open" });

	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(MWS_MENU_CSS);
		root.adoptedStyleSheets = [sheet];
	} catch {
		// Older engines: a <style> element with textContent is Trusted-Types safe too.
		root.appendChild(mwsEl("style", { text: MWS_MENU_CSS }));
	}

	const partner = document.querySelector("mw-conversation-container mws-header")
		?.innerText.trim().split("\n")[0].trim();

	let range = "7";
	let format = "text";
	let busy = false;

	const status = mwsEl("div", { class: "status" });
	const setStatus = (text, kind = "") => {
		status.textContent = text;
		status.setAttribute("class", `status ${kind}`.trim());
	};

	const today = new Date();
	const weekAgo = new Date(Date.now() - 7 * 86400000);
	const asValue = d => d.toISOString().slice(0, 10);

	const fromInput = mwsEl("input", { type: "date", value: asValue(weekAgo), title: "From" });
	const toInput = mwsEl("input", { type: "date", value: asValue(today), title: "To" });
	const dates = mwsEl("div", { class: "dates" }, [fromInput, toInput]);

	function segmented(options, initial, onPick) {
		const buttons = options.map(([value, label]) =>
			mwsEl("button", {
				text: label,
				class: value === initial ? "sel" : "",
				on: {
					click: () => {
						if (busy) return;
						buttons.forEach(b => b.setAttribute("class", ""));
						buttons[options.findIndex(o => o[0] === value)].setAttribute("class", "sel");
						onPick(value);
					},
				},
			}));

		return { row: mwsEl("div", { class: "seg" }, buttons), buttons };
	}

	const rangeSeg = segmented(
		[["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All"], ["custom", "Custom"]],
		"7",
		value => {
			range = value;
			dates.setAttribute("class", value === "custom" ? "dates on" : "dates");
			setStatus(value === "all" ? "Whole thread — this can take a while." : "");
		});

	const formatSeg = segmented(
		[["text", "TXT"], ["json", "JSON"], ["csv", "CSV"]],
		"text",
		value => { format = value; });

	const download = mwsEl("button", { class: "go", text: "Download" });
	const copy = mwsEl("button", { class: "cp", text: "Copy" });

	function rangeOptions() {
		if (range === "all") return { all: true };
		if (range !== "custom") return { days: Number(range) };

		const opts = {};
		if (fromInput.value) opts.since = fromInput.value;
		// Include the whole end day, not just its first instant.
		if (toInput.value) opts.until = new Date(`${toInput.value}T23:59:59.999`);
		if (!opts.since) opts.all = true;
		return opts;
	}

	async function run(action) {
		if (busy) return;
		if (!document.querySelector("mw-conversation-container")) {
			setStatus("Open a conversation first.", "err");
			return;
		}

		busy = true;
		[download, copy].forEach(b => (b.disabled = true));
		setStatus("Loading messages…");

		try {
			const messages = await exportConversation({
				...rangeOptions(),
				returnJson: true,
				onProgress: p => setStatus(`Loading… ${p.loaded} messages`),
			});

			if (!messages.length) {
				setStatus("No messages in that range.", "err");
				return;
			}

			const body = mwsFormat(messages, format);

			if (action === "copy") {
				await navigator.clipboard.writeText(body);
				setStatus(`Copied ${messages.length} messages.`, "ok");
			} else {
				mwsSaveFile(body, format);
				setStatus(`Downloaded ${messages.length} messages.`, "ok");
			}
		} catch (err) {
			setStatus(`Error: ${err.message}`, "err");
			console.error("[export]", err);
		} finally {
			busy = false;
			[download, copy].forEach(b => (b.disabled = false));
		}
	}

	download.addEventListener("click", () => run("download"));
	copy.addEventListener("click", () => run("copy"));

	const head = mwsEl("div", { class: "head" }, [
		mwsEl("div", { class: "titles" }, [
			mwsEl("div", { class: "title", text: "messages-takeout" }),
			mwsEl("div", { class: "who", text: partner || "No conversation open" }),
		]),
		mwsEl("button", { class: "x", text: "✕", title: "Close", on: { click: closeExportMenu } }),
	]);

	const panel = mwsEl("div", { class: "panel" }, [
		head,
		mwsEl("div", { class: "body" }, [
			mwsEl("div", {}, [mwsEl("div", { class: "lab", text: "Range" }), rangeSeg.row, dates]),
			mwsEl("div", {}, [mwsEl("div", { class: "lab", text: "Format" }), formatSeg.row]),
			mwsEl("div", { class: "acts" }, [download, copy]),
			status,
		]),
	]);

	// Drag by the header, so the panel can be moved off whatever it covers.
	head.addEventListener("mousedown", event => {
		if (event.target.closest(".x")) return;

		const box = panel.getBoundingClientRect();
		const offsetX = event.clientX - box.left;
		const offsetY = event.clientY - box.top;

		const move = e => {
			panel.style.left = `${Math.max(0, Math.min(innerWidth - box.width, e.clientX - offsetX))}px`;
			panel.style.top = `${Math.max(0, Math.min(innerHeight - box.height, e.clientY - offsetY))}px`;
			panel.style.right = "auto";
			panel.style.bottom = "auto";
		};
		const up = () => {
			removeEventListener("mousemove", move);
			removeEventListener("mouseup", up);
		};

		addEventListener("mousemove", move);
		addEventListener("mouseup", up);
		event.preventDefault();
	});

	root.appendChild(panel);
	document.body.appendChild(host);
	return host;
}

// Pop the menu as soon as the script is pasted in. Wrapped so that a UI failure
// can never take the programmatic API down with it.
try {
	showExportMenu();
} catch (err) {
	console.warn("[export] Menu failed to open; the functions still work:", err);
}
