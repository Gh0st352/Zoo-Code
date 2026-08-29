import fs from "node:fs/promises"
import path from "node:path"

let replacementOrdinal = 0

export async function syncDirectory(directory) {
	let handle
	try {
		handle = await fs.open(directory, "r")
		await handle.sync()
	} catch (error) {
		if (process.platform !== "win32" || !["EPERM", "EINVAL", "EISDIR"].includes(error.code)) throw error
	} finally {
		await handle?.close().catch(() => {})
	}
}

export async function writeJsonAtomic(filePath, data, options = {}) {
	const parentDirectory = path.dirname(filePath)
	await fs.mkdir(parentDirectory, { recursive: true })
	replacementOrdinal = (replacementOrdinal + 1) % Number.MAX_SAFE_INTEGER
	const temporaryPath = `${filePath}.tmp-${process.pid}-${replacementOrdinal}`
	const content = `${JSON.stringify(data, null, options.prettyPrint === false ? 0 : 2)}\n`
	let handle
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600)
		await handle.writeFile(content, "utf8")
		await handle.sync()
		await handle.close()
		handle = null
		await fs.rename(temporaryPath, filePath)
		await syncDirectory(parentDirectory)
	} finally {
		await handle?.close().catch(() => {})
		await fs.unlink(temporaryPath).catch((error) => {
			if (error.code !== "ENOENT") throw error
		})
	}
}

export async function readJsonBounded(filePath, maxBytes = 64 * 1024) {
	let handle
	try {
		const pathStat = await fs.lstat(filePath)
		if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maxBytes) {
			const error = new Error("JSON input is not a bounded regular file")
			error.code = "JSON_INPUT_BOUNDS"
			throw error
		}
		handle = await fs.open(filePath, "r")
		const openedStat = await handle.stat()
		if (
			!openedStat.isFile() ||
			openedStat.size > maxBytes ||
			openedStat.dev !== pathStat.dev ||
			openedStat.ino !== pathStat.ino
		) {
			const error = new Error("JSON input changed during bounded open")
			error.code = "JSON_INPUT_BOUNDS"
			throw error
		}
		const buffer = Buffer.alloc(openedStat.size)
		let offset = 0
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
			if (bytesRead === 0) {
				const error = new Error("JSON input was truncated during bounded read")
				error.code = "JSON_INPUT_BOUNDS"
				throw error
			}
			offset += bytesRead
		}
		const finalStat = await handle.stat()
		if (finalStat.size !== openedStat.size) {
			const error = new Error("JSON input changed during bounded read")
			error.code = "JSON_INPUT_BOUNDS"
			throw error
		}
		return JSON.parse(buffer.toString("utf8"))
	} finally {
		await handle?.close().catch(() => {})
	}
}
