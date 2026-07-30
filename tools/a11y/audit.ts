// Mobile-first accessibility audit harness.
//
// Serves the production build, bootstraps a league (once, into a persistent browser profile so
// subsequent runs reuse it), then walks every route in routes.ts across the reference viewports
// and font scales from MOBILE_FIRST_ACCESSIBILITY_PLAN.md §0, asserting:
//
//   - no horizontal document overflow (WCAG 1.4.10 Reflow)
//   - no text below 14px
//   - no interactive element below 24x24 (hard floor) / 44x44 (target)
//   - no content hidden under the fixed navbar
//   - no axe-core violations
//
// Usage:
//   node tools/a11y/audit.ts                     full matrix
//   node tools/a11y/audit.ts --quick             one viewport (390x844) + default scale
//   node tools/a11y/audit.ts --baseline          write out/baseline.json instead of comparing
//   node tools/a11y/audit.ts --screenshots       also save a PNG per page
//   node tools/a11y/audit.ts --routes=roster,playerStats     subset
//   node tools/a11y/audit.ts --fresh             discard the cached league profile
//
// Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH. Never run `playwright install`.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { PAGE_CHECKS, THRESHOLDS, type PageResult, type Violation } from "./checks.ts";
import { ROUTES, CONDITIONAL_ROUTES, resolvePath, type Fixture, type RouteSpec } from "./routes.ts";

// The sandbox preinstalls a Chromium that predates the pinned playwright's expected build, so
// launch the preinstalled binary explicitly rather than letting playwright download one.
const CHROMIUM_PATH = process.env.A11Y_CHROMIUM ?? "/opt/pw-browsers/chromium";

const OUT_DIR = path.resolve("tools/a11y/out");
const PROFILE_DIR = path.resolve("tools/a11y/.profile");
const BUILD_DIR = path.resolve("build");
const PORT = 3579;

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(`--${name}`);
const getOpt = (name: string) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
};
const QUICK = hasFlag("quick");
const BASELINE = hasFlag("baseline");
const SCREENSHOTS = hasFlag("screenshots");
const FRESH = hasFlag("fresh");
const ROUTE_FILTER = getOpt("routes")?.split(",").map((s) => s.trim());

const VIEWPORTS = QUICK
	? [{ name: "390x844", width: 390, height: 844 }]
	: [
			{ name: "360x640", width: 360, height: 640 },
			{ name: "390x844", width: 390, height: 844 },
			{ name: "1280x800", width: 1280, height: 800 },
		];

// `default` = the shipped 18px; the others exercise the Phase 6 scale attribute
const SCALES = QUICK ? ["default"] : ["compact", "default", "xlarge"];

// ---------------------------------------------------------------- static server
const MIME: Record<string, string> = {
	".css": "text/css",
	".gif": "image/gif",
	".html": "text/html",
	".ico": "image/x-icon",
	".jpg": "image/jpeg",
	".js": "text/javascript",
	".json": "application/json",
	".map": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
};
// Mirrors PREFIXES_STATIC in tools/lib/server.ts
const STATIC_PREFIXES = ["/css/", "/files/", "/fonts/", "/gen/", "/ico/", "/img/", "/manifest"];

const startServer = () =>
	new Promise<http.Server>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const { pathname } = new URL(req.url!, `http://localhost:${PORT}`);
			const rel = STATIC_PREFIXES.some((p) => pathname.startsWith(p))
				? pathname.slice(1)
				: "index.html";
			const filePath = path.resolve(BUILD_DIR, rel);
			if (!filePath.startsWith(BUILD_DIR) || !existsSync(filePath)) {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("404");
				return;
			}
			res.writeHead(200, {
				"Content-Type": MIME[path.extname(rel)] ?? "application/octet-stream",
				"Cache-Control": "no-cache",
			});
			createReadStream(filePath).pipe(res);
		});
		server.on("error", reject);
		server.listen(PORT, "127.0.0.1", () => resolve(server));
	});

// ---------------------------------------------------------------- league bootstrap
const waitForApp = async (page: Page) => {
	// The app boots a SharedWorker then renders; #actual-actual-content only exists once the
	// Controller has mounted.
	await page.waitForSelector("#actual-actual-content", { timeout: 90_000 });
};

const bootstrapLeague = async (page: Page, origin: string): Promise<Fixture> => {
	await page.goto(`${origin}/new_league`, { waitUntil: "domcontentloaded" });
	await waitForApp(page);

	// Random players, default settings — fastest league that still exercises every page
	const createButton = page.locator('button:has-text("Create League")').first();
	await createButton.waitFor({ state: "visible", timeout: 60_000 });
	await createButton.click();

	// Redirects to /l/<lid> when done
	await page.waitForURL(/\/l\/\d+/, { timeout: 300_000 });
	await waitForApp(page);

	const lid = Number(/\/l\/(\d+)/.exec(page.url())![1]);
	console.log(`  league ${lid} created`);

	// Sim a full season so playoffs/history/awards/leaders have real data. Each of these is a
	// worker call that returns when the phase change completes.
	const simSteps = [
		"untilPlayoffs",
		"throughPlayoffs",
		"untilDraft",
		"untilResignPlayers",
		"untilFreeAgency",
		"untilPreseason",
		"untilRegularSeason",
	];
	for (const action of simSteps) {
		process.stdout.write(`  sim: ${action} … `);
		try {
			await page.evaluate(
				async (a) => {
					await (window as any).bbgm.toWorker("playMenu", a, undefined);
				},
				action,
			);
			// Phase changes are async on the worker side; wait for the UI to settle
			await page.waitForTimeout(1500);
			console.log("ok");
		} catch (error) {
			// A step that doesn't apply (e.g. no play-in) shouldn't abort the whole bootstrap
			console.log(`skipped (${(error as Error).message.split("\n")[0]})`);
		}
	}

	// Pull concrete param values for the route table out of the rendered DOM. Scraping links is
	// more robust than guessing at worker endpoint names, and it fails loudly if a page is broken.
	const fixture: Fixture = { lid };

	await page.goto(`${origin}/l/${lid}/roster`, { waitUntil: "domcontentloaded" });
	await waitForApp(page);
	fixture.pid = await page.evaluate(() => {
		const link = document.querySelector<HTMLAnchorElement>('a[href*="/player/"]');
		const m = link ? /\/player\/(\d+)/.exec(link.getAttribute("href")!) : null;
		return m ? Number(m[1]) : undefined;
	});

	// A game_log link carries abbrev, season and gid all at once: /l/1/game_log/ATL_0/2026/5
	await page.goto(`${origin}/l/${lid}/game_log`, { waitUntil: "domcontentloaded" });
	await waitForApp(page);
	await page.waitForTimeout(1000);
	const fromGameLog = await page.evaluate(() => {
		for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/game_log/"]')) {
			const m = /\/game_log\/([^/]+)\/(\d+)\/(\d+)/.exec(a.getAttribute("href")!);
			if (m) {
				return { abbrev: m[1], season: Number(m[2]), gid: Number(m[3]) };
			}
		}
		// No box score link (e.g. box scores pruned) — still try for abbrev + season
		for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/game_log/"]')) {
			const m = /\/game_log\/([^/]+)\/(\d+)/.exec(a.getAttribute("href")!);
			if (m) {
				return { abbrev: m[1], season: Number(m[2]), gid: undefined };
			}
		}
		return undefined;
	});
	if (fromGameLog) {
		fixture.abbrev = fromGameLog.abbrev;
		fixture.season = fromGameLog.season;
		fixture.gid = fromGameLog.gid;
	}

	// Fall back to a standings roster link for abbrev, and the season dropdown for season
	if (fixture.abbrev === undefined || fixture.season === undefined) {
		await page.goto(`${origin}/l/${lid}/standings`, { waitUntil: "domcontentloaded" });
		await waitForApp(page);
		const fallback = await page.evaluate(() => {
			const a = document.querySelector<HTMLAnchorElement>('a[href*="/roster/"]');
			const abbrev = a
				? (/\/roster\/([^/?#]+)/.exec(a.getAttribute("href")!)?.[1] ?? undefined)
				: undefined;
			// The title bar's season <select> lists real seasons
			const opt = document.querySelector<HTMLOptionElement>(".dropdown-select option");
			const season = opt && /^\d{4}$/.test(opt.value) ? Number(opt.value) : undefined;
			return { abbrev, season };
		});
		fixture.abbrev ??= fallback.abbrev;
		fixture.season ??= fallback.season;
	}

	// An eid for the trade_summary route, if any trade happened during the simmed season
	await page.goto(`${origin}/l/${lid}/transactions/all/all/trade`, {
		waitUntil: "domcontentloaded",
	});
	await waitForApp(page);
	await page.waitForTimeout(800);
	fixture.eid = await page.evaluate(() => {
		const a = document.querySelector<HTMLAnchorElement>('a[href*="/trade_summary/"]');
		const m = a ? /\/trade_summary\/(\d+)/.exec(a.getAttribute("href")!) : null;
		return m ? Number(m[1]) : undefined;
	});

	return fixture;
};

// ---------------------------------------------------------------- axe
let axeSource: string | undefined;
const loadAxe = async () => {
	if (axeSource === undefined) {
		// Inject from node_modules — external hosts are blocked in this sandbox
		axeSource = await fs.readFile(
			path.resolve("node_modules/axe-core/axe.min.js"),
			"utf8",
		);
	}
	return axeSource;
};

const runAxe = async (page: Page): Promise<Violation[]> => {
	await page.evaluate(await loadAxe());
	const results = await page.evaluate(async () => {
		const axe = (window as any).axe;
		const r = await axe.run(document, {
			runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
			resultTypes: ["violations"],
		});
		return r.violations.map((v: any) => ({
			id: v.id,
			impact: v.impact,
			help: v.help,
			nodes: v.nodes.slice(0, 3).map((n: any) => n.target.join(" ")),
			count: v.nodes.length,
		}));
	});
	return results.map(
		(v: any): Violation => ({
			kind: "axe",
			selector: v.nodes[0] ?? "?",
			detail: `${v.id} (${v.impact}) x${v.count}: ${v.help}`,
			value: v.count,
		}),
	);
};

// ---------------------------------------------------------------- one page
const auditPage = async (
	page: Page,
	url: string,
	scale: string,
): Promise<PageResult> => {
	try {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
		await page.evaluate((s) => {
			if (s === "default") {
				document.documentElement.removeAttribute("data-font-scale");
			} else {
				document.documentElement.setAttribute("data-font-scale", s);
			}
		}, scale);
		await waitForApp(page);
		// Let async view data land and any charts lay out
		await page.waitForTimeout(700);
		await page.evaluate(() => window.scrollTo(0, 0));

		const result: PageResult = await page.evaluate(
			// eslint-disable-next-line no-new-func
			`(${PAGE_CHECKS})(${JSON.stringify(THRESHOLDS)})`,
		);
		const axeViolations = await runAxe(page);
		result.violations.push(...axeViolations);
		if (axeViolations.length > 0) {
			result.counts.axe = (result.counts.axe ?? 0) + axeViolations.length;
		}
		return result;
	} catch (error) {
		return {
			scrollWidth: 0,
			innerWidth: 0,
			violations: [],
			counts: {},
			error: (error as Error).message.split("\n")[0],
		};
	}
};

// ---------------------------------------------------------------- main
const main = async () => {
	if (!existsSync(path.join(BUILD_DIR, "index.html"))) {
		console.error("build/index.html missing — run `SPORT=basketball pnpm run build` first");
		process.exit(1);
	}
	await fs.mkdir(OUT_DIR, { recursive: true });
	if (FRESH && existsSync(PROFILE_DIR)) {
		await fs.rm(PROFILE_DIR, { recursive: true, force: true });
	}

	const server = await startServer();
	const origin = `http://127.0.0.1:${PORT}`;
	console.log(`serving build/ at ${origin}`);

	// Persistent context so IndexedDB (and therefore the league) survives across runs
	const context = await chromium.launchPersistentContext(PROFILE_DIR, {
		headless: true,
		executablePath: existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
		viewport: VIEWPORTS[1] ?? VIEWPORTS[0],
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	const browser: Browser | null = context.browser();
	const page = await context.newPage();
	page.on("pageerror", (e) => {
		if (process.env.A11Y_VERBOSE) {
			console.log(`    [pageerror] ${e.message.split("\n")[0]}`);
		}
	});

	// Reuse an existing league if the profile already has one
	const fixturePath = path.join(OUT_DIR, "fixture.json");
	let fixture: Fixture | undefined;
	if (!FRESH && existsSync(fixturePath)) {
		fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
		console.log(`reusing league ${fixture!.lid} from cached profile`);
	} else {
		console.log("bootstrapping a league (this takes a few minutes)…");
		fixture = await bootstrapLeague(page, origin);
		await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2));
	}
	console.log(`fixture: ${JSON.stringify(fixture)}`);

	const allRoutes: RouteSpec[] = [...ROUTES, ...CONDITIONAL_ROUTES].filter(
		(r) => !ROUTE_FILTER || ROUTE_FILTER.includes(r.id),
	);

	type Key = string;
	const report: Record<Key, PageResult> = {};
	let done = 0;
	const total = allRoutes.length * VIEWPORTS.length * SCALES.length;

	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		for (const scale of SCALES) {
			for (const route of allRoutes) {
				const relPath = resolvePath(route.path, fixture!);
				done += 1;
				if (relPath === undefined) {
					continue;
				}
				const key = `${route.id}|${viewport.name}|${scale}`;
				const result = await auditPage(page, `${origin}${relPath}`, scale);
				report[key] = result;

				const n = result.violations.length;
				const flag = result.error ? "ERR" : n === 0 ? "ok " : `${n}`.padStart(3);
				console.log(
					`[${String(done).padStart(4)}/${total}] ${flag}  ${viewport.name} ${scale.padEnd(8)} ${route.id}${
						result.error ? `  (${result.error})` : ""
					}`,
				);

				if (SCREENSHOTS) {
					const dir = path.join(OUT_DIR, "shots", scale, viewport.name);
					await fs.mkdir(dir, { recursive: true });
					await page.screenshot({
						path: path.join(dir, `${route.id}.png`),
						fullPage: false,
					});
				}
			}
		}
	}

	// ---- summarise ----
	const totals: Record<string, number> = {};
	const byRoute: Record<string, number> = {};
	for (const [key, result] of Object.entries(report)) {
		const routeId = key.split("|")[0]!;
		for (const [kind, n] of Object.entries(result.counts)) {
			totals[kind] = (totals[kind] ?? 0) + n;
		}
		byRoute[routeId] = (byRoute[routeId] ?? 0) + result.violations.length;
	}
	const grand = Object.values(totals).reduce((a, b) => a + b, 0);

	const summary = { generatedAt: new Date().toISOString(), quick: QUICK, totals, grand, byRoute };
	await fs.writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify({ summary, report }, null, 2));

	const lines: string[] = [
		`# Accessibility audit — ${summary.generatedAt}`,
		"",
		`Matrix: ${allRoutes.length} routes x ${VIEWPORTS.length} viewports x ${SCALES.length} scales`,
		"",
		"## Violations by kind",
		"",
		"| Kind | Count |",
		"| ---- | ----- |",
		...Object.entries(totals)
			.sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `| ${k} | ${v} |`),
		`| **total** | **${grand}** |`,
		"",
		"## Worst routes",
		"",
		"| Route | Violations |",
		"| ----- | ---------- |",
		...Object.entries(byRoute)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 30)
			.map(([k, v]) => `| ${k} | ${v} |`),
	];
	await fs.writeFile(path.join(OUT_DIR, "report.md"), lines.join("\n") + "\n");

	console.log(`\n${"=".repeat(60)}`);
	console.log("violations by kind:");
	for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${k.padEnd(16)} ${v}`);
	}
	console.log(`  ${"TOTAL".padEnd(16)} ${grand}`);

	if (BASELINE) {
		await fs.writeFile(path.join(OUT_DIR, "baseline.json"), JSON.stringify(summary, null, 2));
		console.log("\nwrote tools/a11y/out/baseline.json");
	} else {
		const baselinePath = path.join(OUT_DIR, "baseline.json");
		if (existsSync(baselinePath)) {
			const base = JSON.parse(await fs.readFile(baselinePath, "utf8"));
			const delta = grand - base.grand;
			console.log(
				`\nvs baseline: ${base.grand} -> ${grand} (${delta <= 0 ? "" : "+"}${delta})`,
			);
			for (const kind of new Set([...Object.keys(totals), ...Object.keys(base.totals)])) {
				const b = base.totals[kind] ?? 0;
				const c = totals[kind] ?? 0;
				if (b !== c) {
					console.log(`  ${kind.padEnd(16)} ${b} -> ${c}`);
				}
			}
			if (delta > 0) {
				console.log("\nREGRESSION: violations increased vs baseline");
			}
		}
	}

	await context.close();
	await browser?.close();
	server.close();
};

await main();
