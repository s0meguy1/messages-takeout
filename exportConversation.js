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

	return messages
		.map(m => `[${m.date}${m.time ? ", " + m.time : ""}] ${m.name}:\n${m.text}`)
		.join("\n\n");
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
	const json = format === "json";

	const data = await exportConversation({ ...rest, returnJson: json });
	const body = json ? JSON.stringify(data, null, 2) : data;

	const blob = new Blob([body], {
		type: json ? "application/json;charset=utf-8" : "text/plain;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");

	a.href = url;
	a.download = filename || `conversation.${json ? "json" : "txt"}`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);

	return json ? data.length : body.length;
}
