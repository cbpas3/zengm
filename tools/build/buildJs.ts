import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileHash } from "./fileHash.ts";
import { replace } from "./replace.ts";
import { FOLDER } from "../lib/rolldownConfig.ts";

export const buildJs = async (versionNumber: string) => {
	const promises: Promise<string[]>[] = [];
	for (const name of ["ui", "worker"]) {
		promises.push(
			new Promise((resolve) => {
				const worker = new Worker(
					new URL("buildJsWorker.ts", import.meta.url),
					{
						workerData: {
							name,
							versionNumber,
						},
					},
				);

				worker.on("message", (modulepreloadFilenames) => {
					resolve(modulepreloadFilenames);
				});
			}),
		);
	}
	const modulepreloadPaths = (await Promise.all(promises))
		.flat()
		.map((filename) => `/${FOLDER}/${filename}`);

	// Hack because otherwise I'm somehow left with no newline before the souce map URL, which confuses Bugsnag
	const replacePaths = (await fs.readdir(path.join("build", FOLDER)))
		.filter((filename) => filename.endsWith(".js"))
		.map((filename) => path.join("build", FOLDER, filename));
	await replace({
		paths: replacePaths,
		replaces: [
			{
				searchValue: ";//# sourceMappingURL",
				replaceValue: ";\n//# sourceMappingURL",
			},
		],
	});

	const jsonFiles = [
		"names",
		"names-female",
		"real-player-data",
		"real-player-stats",
		"real-schedules",
	];
	const replaces = [];
	for (const filename of jsonFiles) {
		const filePath = path.join("build", FOLDER, `${filename}.json`);
		let string;
		try {
			string = await fs.readFile(filePath, "utf8");
		} catch (error) {
			// File doesn't exist in this sport
			if (error.code === "ENOENT") {
				continue;
			}
			throw error;
		}

		const compressed = JSON.stringify(JSON.parse(string));

		const hash = fileHash(compressed);
		const newFilename = filePath.replace(".json", `-${hash}.json`);
		await fs.rm(filePath);
		await fs.writeFile(newFilename, compressed);

		replaces.push({
			searchValue: `/${FOLDER}/${filename}.json`,
			replaceValue: `/${FOLDER}/${filename}-${hash}.json`,
		});
	}
	// Rewrite the fingerprinted JSON references across ALL emitted JS files, not just the main
	// worker bundle: the fetch for real-player-data etc. lives in loadData.basketball.ts, which the
	// bundler code-splits into a worker chunk. Only rewriting worker-<version>.js left the chunk
	// requesting the now-deleted unhashed path (404 in a production build). replacePaths is every
	// .js file in the output, so this catches the chunk too; it's a no-op for files without the ref.
	await replace({
		paths: replacePaths,
		replaces,
	});

	return modulepreloadPaths;
};
