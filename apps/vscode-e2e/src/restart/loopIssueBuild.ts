import * as fs from "fs/promises"
import * as path from "path"
import { build } from "esbuild"

/** Isolated development candidate: never clean shared dist, copy .env, or rebuild concurrent UI work. */
export async function buildLoopIssueCandidate(source: string, scenarioRoot: string): Promise<string> {
	const candidate = path.join(scenarioRoot, "extension")
	await fs.mkdir(candidate)
	for (const entry of await fs.readdir(source)) {
		if (entry === "package.json" || /^package\.nls(?:\.[\w-]+)?\.json$/.test(entry)) {
			await fs.copyFile(path.join(source, entry), path.join(candidate, entry))
		}
	}
	for (const entry of ["assets", "webview-ui", "dist", "integrations/theme/default-themes"]) {
		await fs.cp(path.join(source, entry), path.join(candidate, entry), {
			recursive: true,
			filter: (file) => !["extension.js", "extension.js.map", ".env"].includes(path.basename(file)),
		})
	}
	// Only external runtime dependencies resolve through this link; no profile installation.
	await fs.symlink(path.join(source, "node_modules"), path.join(candidate, "node_modules"), "junction")
	await build({
		absWorkingDir: source,
		entryPoints: ["extension.ts"],
		outfile: path.join(candidate, "dist", "extension.js"),
		bundle: true,
		platform: "node",
		format: "cjs",
		sourcemap: true,
		sourcesContent: false,
		external: ["vscode", "esbuild", "global-agent", "@vscode/ripgrep", "axios"],
		define: { "process.env.PKG_RELEASE_CHANNEL": '"stable"', "process.env.POSTHOG_API_KEY": '""' },
		// Install before extension activation (and its background catalogue fetches).
		// nock is an existing extension devDependency, resolved through the candidate link.
		banner: {
			js: `
const loopIssueNock = require(require("node:path").join(__dirname, "../node_modules/nock"));
loopIssueNock.disableNetConnect();
loopIssueNock.enableNetConnect(/^(127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?$/);
const loopIssueModels = { data: [{
  id: "openai/gpt-4.1", name: "LoopIssue mock", context_length: 128000,
  top_provider: { max_completion_tokens: 4096 }, supported_parameters: ["tools"],
  pricing: { prompt: "0", completion: "0" }
}] };
loopIssueNock("https://openrouter.ai").persist().get("/api/v1/models").reply(200, loopIssueModels);
// Axios can choose an adapter not intercepted by nock in Electron. Fence it explicitly.
const loopIssueAxios = require("axios");
const loopIssueAdapter = loopIssueAxios.getAdapter(loopIssueAxios.defaults.adapter);
loopIssueAxios.defaults.adapter = async (config) => {
  const url = new URL(config.url, config.baseURL);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return loopIssueAdapter(config);
  if (url.href === "https://openrouter.ai/api/v1/models")
    return { data: loopIssueModels, status: 200, statusText: "OK", headers: {}, config };
  throw new Error("LoopIssue blocked external Axios request: " + url.origin);
};
`,
		},
	})
	console.log(
		`[LoopIssue build] isolated current-source candidate: ${candidate}; reused existing UI/worker/wasm assets`,
	)
	return candidate
}
