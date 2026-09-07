import crypto from "crypto"
import os from "os"
import type { ExecutionClaim, ExecutionOwner } from "@roo-code/types"

export type ExecutionHostIdentity = Omit<ExecutionOwner, "providerId" | "runtimeId">
export type OwnerLiveness = "live" | "dead" | "unknown" | "settled"

/** Injectable OS boundary. Only ESRCH is positive process-absence evidence. */
export interface ExecutionHost {
	identity: ExecutionHostIdentity
	probeProcess: (processId: number) => Promise<"ESRCH" | "present" | "unknown">
}

// One nonce per loaded extension-host process, NOT per provider/store.
const sessionId = crypto.randomUUID()

/** Hostname is diagnostic only. Supply an OS-backed machine identity to enable dead-process repair. */
export function createExecutionHost(machine?: { id: string; proof: "local" }): ExecutionHost {
	return {
		identity: {
			hostSessionId: sessionId,
			processId: process.pid,
			machineId: machine?.id ?? os.hostname(),
			machineProof: machine?.proof ?? "unknown",
		},
		probeProcess: async (pid) => {
			try {
				process.kill(pid, 0)
				return "present"
			} catch (error) {
				return error && typeof error === "object" && "code" in error && error.code === "ESRCH"
					? "ESRCH"
					: "unknown"
			}
		},
	}
}

export async function probeExecutionOwner(claim: ExecutionClaim, host: ExecutionHost): Promise<OwnerLiveness> {
	if (claim.phase === "settled" && !claim.cleanupPending) return "settled"
	if (claim.owner.hostSessionId === host.identity.hostSessionId) return "live"
	if (
		claim.owner.machineProof !== "local" ||
		host.identity.machineProof !== "local" ||
		claim.owner.machineId !== host.identity.machineId ||
		claim.owner.processId === host.identity.processId
	)
		return "unknown"
	try {
		// A live PID may have been reused. It proves neither the old session nor its death.
		return (await host.probeProcess(claim.owner.processId)) === "ESRCH" ? "dead" : "unknown"
	} catch {
		return "unknown"
	}
}
