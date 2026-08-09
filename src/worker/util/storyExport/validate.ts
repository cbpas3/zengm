// Pre-export validation (AI Story Export; the bug report's Part 3 item 3).
//
// Six of the bugs in that report were the same shape: a column that was uniformly zero, a ranking
// whose sort key had no variance so it silently degraded to insertion order, a doc that promised
// files the bundle didn't contain, and records whose schema differed from their neighbours'. All
// four are mechanically checkable, and all four are checked here before anything is written.
//
// The result is attached to meta.validation rather than thrown, so a user with an odd league still
// gets their export - but the issues travel *with* the bundle, where the consumer will see them,
// instead of being discovered 4,000 words into an article. Pure, DB-free.

import type { KnowledgeBase, ValidationIssue } from "./types.ts";

const NUMERIC_COLUMNS_TO_CHECK = [
	"pts",
	"trb",
	"ast",
	"ws",
	"per",
	"vorp",
] as const;

const variance = (values: number[]) => {
	if (values.length < 2) {
		return 0;
	}
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
};

// Every field name the README / canon-workflow tells a reader to go and look at. Kept here rather
// than parsed out of the prose so the check is exact; serialize.ts asserts the file list separately.
export type DocumentedReads = {
	files: string[];
	// "table.field" paths that the prompts tell the writer to argue from.
	claims: { path: string; describe: string }[];
};

// "Nothing to check here" - an empty table can't prove a field missing, so those paths are skipped
// rather than reported.
const NOT_CHECKABLE = Symbol("notCheckable");

// Resolves a dotted path, stepping into element 0 of any array along the way, so
// "canon.players.careerWS" answers "does a ranking entry have a careerWS key?".
const getPath = (
	root: unknown,
	path: string,
): unknown | typeof NOT_CHECKABLE => {
	let current: unknown = root;
	for (const part of path.split(".")) {
		if (Array.isArray(current)) {
			if (current.length === 0) {
				return NOT_CHECKABLE;
			}
			current = current[0];
		}
		if (current === null || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
};

export const validateKnowledgeBase = (
	kb: KnowledgeBase,
	bundleFiles: string[],
	documented: DocumentedReads,
): ValidationIssue[] => {
	const issues: ValidationIssue[] = [];

	// 1. Any all-zero numeric column. This is the shape of the win-shares bug: a field that is
	//    present, numeric, and uniformly meaningless.
	const statRows = kb.players.flatMap((p) => p.stats);
	for (const column of NUMERIC_COLUMNS_TO_CHECK) {
		const values = statRows
			.map((s) => s[column])
			.filter((v): v is number => typeof v === "number");
		if (values.length > 20 && values.every((v) => v === 0)) {
			issues.push({
				severity: "error",
				check: "all-zero-column",
				message: `players[].stats[].${column} is 0 in all ${values.length} rows that have a value. Either the field is not being derived correctly or it should be null.`,
			});
		}
	}

	// 2. Any ranking whose sort key has zero variance - it isn't a ranking, it's insertion order.
	const rankings: { name: string; values: (number | null)[] }[] = [
		{
			name: "canon.players.greatness",
			values: kb.canon.players.map((p) => p.greatness),
		},
		{
			name: "canon.teamSeasons.greatness",
			values: kb.canon.teamSeasons.map((t) => t.greatness),
		},
		{ name: "canon.busts.delta", values: kb.canon.busts.map((b) => b.delta) },
		{ name: "canon.steals.delta", values: kb.canon.steals.map((s) => s.delta) },
		{
			name: "canon.rivalries.intensity",
			values: kb.canon.rivalries.map((r) => r.intensity),
		},
	];
	for (const { name, values } of rankings) {
		const present = values.filter((v): v is number => v !== null);
		if (values.length >= 5 && present.length === 0) {
			issues.push({
				severity: "error",
				check: "unranked-list",
				message: `${name} is null for all ${values.length} entries, so the list is in insertion order, not ranked.`,
			});
			continue;
		}
		if (present.length >= 5 && variance(present) === 0) {
			issues.push({
				severity: "error",
				check: "unranked-list",
				message: `${name} has zero variance across ${present.length} entries, so the list is in insertion order, not ranked.`,
			});
		}
	}

	// 3. Everything the docs tell a reader to open must actually be in the bundle.
	const fileSet = new Set(bundleFiles);
	for (const file of documented.files) {
		if (!fileSet.has(file)) {
			issues.push({
				severity: "error",
				check: "documented-file-missing",
				message: `The bundle docs reference "${file}", which this export does not contain.`,
			});
		}
	}
	for (const { path, describe } of documented.claims) {
		const value = getPath(kb, path);
		// NOT_CHECKABLE (an empty table) is deliberately neither present nor missing.
		if (value === undefined) {
			issues.push({
				severity: "error",
				check: "documented-field-missing",
				message: `The bundle docs tell the writer to use ${path} (${describe}), which is not present in this export.`,
			});
		}
	}

	// 4. Uniform schema. A consumer that reads players[0] and assumes the rest match should be right.
	const schemaCheck = (label: string, records: Record<string, unknown>[]) => {
		if (records.length === 0) {
			return;
		}
		const expected = Object.keys(records[0]!).sort().join(",");
		for (const [i, record] of records.entries()) {
			const keys = Object.keys(record).sort().join(",");
			if (keys !== expected) {
				const missing = Object.keys(records[0]!).filter((k) => !(k in record));
				const extra = Object.keys(record).filter((k) => !(k in records[0]!));
				issues.push({
					severity: "error",
					check: "non-uniform-schema",
					message: `${label}[${i}] has a different set of keys than ${label}[0]${
						missing.length > 0 ? `; missing ${missing.join(", ")}` : ""
					}${extra.length > 0 ? `; extra ${extra.join(", ")}` : ""}.`,
				});
				return; // one report per table is enough
			}
		}
	};
	schemaCheck("players", kb.players as unknown as Record<string, unknown>[]);
	schemaCheck("teams", kb.teams as unknown as Record<string, unknown>[]);
	schemaCheck(
		"gameIndex",
		kb.gameIndex as unknown as Record<string, unknown>[],
	);
	schemaCheck(
		"playoffSeries",
		kb.playoffSeries as unknown as Record<string, unknown>[],
	);
	schemaCheck(
		"canon.players",
		kb.canon.players as unknown as Record<string, unknown>[],
	);

	// 5. Cross-table referential sanity: the postseason should be reachable from the index.
	if (kb.playoffSeries.length > 0) {
		const playoffRows = kb.gameIndex.filter((r) => r.playoffs);
		if (kb.gameIndex.length > 0 && playoffRows.length === 0) {
			issues.push({
				severity: "error",
				check: "no-playoff-games-indexed",
				message: `${kb.playoffSeries.length} playoff series exist but no game-index row is flagged playoffs.`,
			});
		}
		const withSeries = playoffRows.filter((r) => r.seriesId !== null).length;
		if (playoffRows.length > 0 && withSeries === 0) {
			issues.push({
				severity: "warning",
				check: "playoff-games-unlinked",
				message:
					"No playoff game-index row could be linked to a series, so round/gameNumber are null throughout. The playoffSeries store may predate per-series gids.",
			});
		}
	}

	return issues;
};
