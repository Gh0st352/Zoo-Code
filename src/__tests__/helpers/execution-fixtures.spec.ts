import { withTaskExecution } from "./execution-fixtures"
import { ExecutionAuthorityError } from "../../core/task-persistence/taskLifecycle"

describe("scoped orchestration fixture", () => {
	it("permits only its supplied incarnation and preserves work rejection", async () => {
		const task = withTaskExecution({ taskId: "task", instanceId: "runtime", abort: false })
		expect(await task.guardExecution()).toBe(true)
		await expect(task.requireExecution()).resolves.toBeUndefined()
		const failure = Promise.reject(new Error("work failed"))
		await expect(task.trackExecutionWork(failure)).rejects.toThrow("work failed")
	})
	it.each(["abort", "abandoned", "executionBlocked", "executionGeneration", "taskId", "instanceId"] as const)(
		"refuses %s drift and never reauthorizes a stopped incarnation",
		async (field) => {
			const task = withTaskExecution({ taskId: "task", instanceId: "runtime", abort: Boolean(false) })
			const before = { ...task }
			if (field === "taskId" || field === "instanceId") task[field] = "other"
			else if (field === "executionGeneration") task[field]++
			else task[field] = true
			expect(await task.guardExecution()).toBe(false)
			Object.assign(task, before)
			await expect(task.requireExecution()).rejects.toBeInstanceOf(ExecutionAuthorityError)
		},
	)
})
