// Fast SCSS validation without a full production build.
//
// `pnpm run build` takes minutes; while iterating on public/css/*.scss it's much faster to just
// compile the two entry points and grep the output for the tokens/rules you expect. This does NOT
// substitute for a real build — PurgeCSS only runs there (see MOBILE_FIRST_ACCESSIBILITY_PLAN.md
// §1.3), so a class that compiles fine here can still be stripped in production.
//
// Usage:
//   node tools/a11y/checkCss.ts
//   node tools/a11y/checkCss.ts --expect=--zen-fs-body,--zen-navbar-h
//   node tools/a11y/checkCss.ts --grep=font-size:1                 print matching declarations

import { promisify } from "node:util";
import { render } from "sass-embedded";

const argv = process.argv.slice(2);
const getOpt = (name: string) =>
	argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const expect = getOpt("expect")?.split(",").map((s) => s.trim()) ?? [
	"--zen-fs-body",
	"--zen-navbar-h",
	"--zen-tap-min",
];
const grep = getOpt("grep");

let failed = false;

for (const filename of ["light", "dark"]) {
	let css: string;
	try {
		const result = await promisify(render)({ file: `public/css/${filename}.scss` });
		css = result!.css.toString();
	} catch (error) {
		failed = true;
		console.log(`${filename}.scss FAILED to compile:`);
		console.log(
			String((error as Error).message ?? error)
				.split("\n")
				.slice(0, 20)
				.join("\n"),
		);
		continue;
	}

	console.log(`${filename}.scss compiled — ${(css.length / 1024).toFixed(0)} KiB`);

	for (const needle of expect) {
		const present = css.includes(needle);
		if (!present) {
			failed = true;
		}
		console.log(`  ${present ? "found   " : "MISSING "} ${needle}`);
	}

	if (grep) {
		const hits = css
			.split(/[{}]/)
			.flatMap((chunk) => chunk.split(";"))
			.map((s) => s.trim())
			.filter((s) => s.includes(grep));
		console.log(`  ${hits.length} declarations matching "${grep}"`);
		for (const hit of [...new Set(hits)].slice(0, 40)) {
			console.log(`    ${hit}`);
		}
	}
}

if (failed) {
	process.exitCode = 1;
}
