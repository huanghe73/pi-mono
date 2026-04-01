import { afterEach, describe, expect, it } from "vitest";
import { complete, fauxAssistantMessage, registerFauxProvider, stream } from "../src/index.js";
import { convertResponsesTools } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessageEvent, ComputerCall, ComputerCallResultMessage, Context } from "../src/types.js";

async function collectEvents(streamResult: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) {
		events.push(event);
	}
	return events;
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("computer use types", () => {
	it("ComputerCall is a valid content block type", () => {
		const computerCall: ComputerCall = {
			type: "computerCall",
			id: "call_123",
			actions: [
				{ type: "click", x: 340, y: 220 },
				{ type: "type", text: "hello" },
			],
		};
		expect(computerCall.type).toBe("computerCall");
		expect(computerCall.actions).toHaveLength(2);
		expect(computerCall.actions[0].type).toBe("click");
		expect(computerCall.actions[0].x).toBe(340);
	});

	it("ComputerCallResultMessage has the correct shape", () => {
		const result: ComputerCallResultMessage = {
			role: "computerCallResult",
			callId: "call_123",
			content: [
				{
					type: "image",
					data: "base64data",
					mimeType: "image/png",
				},
			],
			timestamp: Date.now(),
		};
		expect(result.role).toBe("computerCallResult");
		expect(result.callId).toBe("call_123");
	});
});

describe("computer use with faux provider", () => {
	it("streams a ComputerCall block and emits computercall_start/end events", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		const computerCall: ComputerCall = {
			type: "computerCall",
			id: "cc_001",
			actions: [{ type: "click", x: 100, y: 200 }],
		};

		registration.setResponses([
			{
				...fauxAssistantMessage(""),
				content: [computerCall],
				stopReason: "computerUse",
			},
		]);

		const context: Context = {
			systemPrompt: "You are a computer use agent.",
			messages: [{ role: "user", content: "Click the login button", timestamp: Date.now() }],
			computerUse: { type: "computer_use", displayWidth: 1024, displayHeight: 768 },
		};

		const events = await collectEvents(stream(registration.getModel(), context));

		const startEvents = events.filter((e) => e.type === "computercall_start");
		const endEvents = events.filter((e) => e.type === "computercall_end");

		expect(startEvents).toHaveLength(1);
		expect(endEvents).toHaveLength(1);

		if (endEvents[0].type === "computercall_end") {
			expect(endEvents[0].computerCall.id).toBe("cc_001");
			expect(endEvents[0].computerCall.actions[0].type).toBe("click");
			expect(endEvents[0].computerCall.actions[0].x).toBe(100);
		}
	});

	it("complete() returns a message with ComputerCall content", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		const computerCall: ComputerCall = {
			type: "computerCall",
			id: "cc_002",
			actions: [{ type: "screenshot" }],
		};

		registration.setResponses([
			{
				...fauxAssistantMessage(""),
				content: [computerCall],
				stopReason: "computerUse",
			},
		]);

		const context: Context = {
			messages: [{ role: "user", content: "Take a screenshot", timestamp: Date.now() }],
			computerUse: { type: "computer_use" },
		};

		const response = await complete(registration.getModel(), context);
		expect(response.stopReason).toBe("computerUse");
		expect(response.content).toHaveLength(1);
		expect(response.content[0].type).toBe("computerCall");
	});

	it("ComputerCallResultMessage can be included in conversation history", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		registration.setResponses([fauxAssistantMessage("Done clicking.")]);

		const context: Context = {
			messages: [
				{ role: "user", content: "Click the button", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{
							type: "computerCall",
							id: "cc_003",
							actions: [{ type: "click", x: 50, y: 100 }],
						},
					],
					api: "faux",
					provider: "faux",
					model: "faux",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "computerUse",
					timestamp: Date.now(),
				},
				{
					role: "computerCallResult",
					callId: "cc_003",
					content: [{ type: "image", data: "base64screenshot", mimeType: "image/png" }],
					timestamp: Date.now(),
				},
			],
			computerUse: { type: "computer_use" },
		};

		const response = await complete(registration.getModel(), context);
		expect(response.content[0].type).toBe("text");
	});
});

describe("OpenAI Responses tool conversion with computer use", () => {
	it("appends computer tool when computerUse is set", () => {
		const tools = convertResponsesTools([], undefined, {
			computerUse: { type: "computer_use", displayWidth: 1024, displayHeight: 768 },
		});

		expect(tools).toHaveLength(1);
		expect((tools[0] as any).type).toBe("computer");
	});

	it("includes both function tools and computer tool", () => {
		const functionTools = [
			{
				name: "get_weather",
				description: "Get weather",
				parameters: { type: "object", properties: {} },
			},
		] as any;

		const tools = convertResponsesTools(functionTools, undefined, {
			computerUse: { type: "computer_use" },
		});

		expect(tools).toHaveLength(2);
		expect((tools[0] as any).type).toBe("function");
		expect((tools[1] as any).type).toBe("computer");
	});

	it("does not append computer tool when computerUse is undefined", () => {
		const tools = convertResponsesTools([], undefined, {});
		expect(tools).toHaveLength(0);
	});
});
