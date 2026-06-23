/**
 * Layer 2: Round-trip validation against real OpenAI API.
 *
 * This test sends a single computer-use request to verify the full
 * pi-ai → OpenAI Responses API → computer_call path works end-to-end.
 *
 * Requires OPENAI_API_KEY in .env or environment.
 * Skipped when the key is not available.
 *
 * Run with: npx vitest run test/computer-use-e2e.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { complete, getModel, stream } from "../src/index.js";
import type { AssistantMessageEvent, ComputerCall, Context } from "../src/types.js";

// Load .env if present
try {
	const envPath = resolve(import.meta.dirname, "../../..", ".env");
	const envContent = readFileSync(envPath, "utf-8");
	for (const line of envContent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx);
		const value = trimmed.slice(eqIdx + 1);
		if (!process.env[key]) process.env[key] = value;
	}
} catch {
	// .env not found, rely on environment
}

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

// A valid 100x100 red PNG (base64) to use as a fake screenshot
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkAQMAAABKLAcXAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gQBEwIoL9SEsAAAABRJREFUOMtjYBgFo2AUjIJRQE8AAAV4AAEpcbn8AAAAAElFTkSuQmCC";

describe.skipIf(!hasOpenAIKey)("OpenAI Computer Use E2E", () => {
	it("sends a computer-use request and receives a computer_call action", async () => {
		// Try gpt-5.5 (GA computer use), fall back to gpt-4o
		const model = getModel("openai", "gpt-5.5") ?? getModel("openai", "gpt-4o")!;
		expect(model).toBeDefined();

		const context: Context = {
			systemPrompt:
				"You are controlling a computer. The user has given you a screenshot. Perform the requested action.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Click the red button in the center of the screen." },
						{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
			computerUse: { type: "computer_use" },
		};

		const response = await complete(model!, context);

		console.log("stopReason:", response.stopReason);
		console.log("errorMessage:", response.errorMessage);
		console.log(
			"content types:",
			response.content.map((c) => c.type),
		);

		// The model should respond with a computer_call (click, screenshot, etc.)
		expect(response.stopReason).toBe("computerUse");
		expect(response.content.length).toBeGreaterThan(0);

		const computerCall = response.content.find((c) => c.type === "computerCall") as ComputerCall | undefined;
		expect(computerCall).toBeDefined();
		expect(computerCall!.id).toBeTruthy();
		expect(computerCall!.actions.length).toBeGreaterThan(0);

		const action = computerCall!.actions[0];
		console.log("action:", JSON.stringify(action));
		// The action should have a valid type
		expect(["click", "double_click", "type", "keypress", "scroll", "screenshot", "drag", "move", "wait"]).toContain(
			action.type,
		);
	}, 30000);

	it("streams computer_call events correctly", async () => {
		// Try gpt-5.5 (GA computer use), fall back to gpt-4o
		const model = getModel("openai", "gpt-5.5") ?? getModel("openai", "gpt-4o")!;
		expect(model).toBeDefined();

		const context: Context = {
			systemPrompt: "You are controlling a computer. Take a screenshot.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Take a screenshot of what you see." },
						{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
			computerUse: { type: "computer_use" },
		};

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream(model!, context)) {
			events.push(event);
		}

		const eventTypes = events.map((e) => e.type);
		console.log("event types:", eventTypes);

		// Should have start, computercall_start, computercall_end, done
		expect(eventTypes).toContain("start");
		expect(eventTypes).toContain("done");

		// Should contain computer call events
		const hasComputerCall = eventTypes.includes("computercall_start") && eventTypes.includes("computercall_end");
		expect(hasComputerCall).toBe(true);

		// The done event should have computerUse stop reason
		const doneEvent = events.find((e) => e.type === "done");
		if (doneEvent?.type === "done") {
			expect(doneEvent.reason).toBe("computerUse");
			const ccBlock = doneEvent.message.content.find((c) => c.type === "computerCall") as ComputerCall | undefined;
			expect(ccBlock).toBeDefined();
			expect(ccBlock!.actions.length).toBeGreaterThan(0);
		}
	}, 30000);
});
