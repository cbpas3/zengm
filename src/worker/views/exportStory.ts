import type { UpdateEvents } from "../../common/types.ts";

// The Story Export page is a static form (the actual work happens in the generateStoryExport API
// endpoint on submit), so there's no per-view data to compute - just satisfy the view contract.
const updateExportStory = async (inputs: unknown, updateEvents: UpdateEvents) => {
	if (updateEvents.includes("firstRun")) {
		return {};
	}
};

export default updateExportStory;
