import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_DESKTOP_BINARY, CodexAppServerError, CodexControlClient, resolveCodexBinary, } from "../src/index.js";
test("resolves the Codex app-server binary from override, Desktop, then PATH", () => {
    assert.equal(resolveCodexBinary({
        env: { CODEX_BINARY: "/custom/codex" },
        platform: "darwin",
        isExecutable: () => true,
    }), "/custom/codex");
    assert.equal(resolveCodexBinary({
        env: {},
        platform: "darwin",
        isExecutable: (path) => path === CODEX_DESKTOP_BINARY,
    }), CODEX_DESKTOP_BINARY);
    assert.equal(resolveCodexBinary({
        env: {},
        platform: "linux",
        isExecutable: () => false,
    }), "codex");
});
class FakeTransport {
    sent = [];
    messageHandlers = [];
    closeHandlers = [];
    async start() { }
    send(message) {
        this.sent.push(message);
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onClose(handler) {
        this.closeHandlers.push(handler);
    }
    async close() {
        for (const handler of this.closeHandlers) {
            handler();
        }
    }
    server(message) {
        for (const handler of this.messageHandlers) {
            handler(message);
        }
    }
    respondTo(method, result) {
        const request = this.sent.find((message) => message.method === method && message.id);
        assert.ok(request?.id, `expected client request for ${method}`);
        this.server({ id: request.id, result });
    }
    async waitForRequest(method) {
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline) {
            const request = this.sent.find((message) => message.method === method && message.id);
            if (request) {
                return request;
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.fail(`timed out waiting for client request ${method}`);
    }
    clientResponseFor(serverRequestId) {
        const response = this.sent.find((message) => message.id === serverRequestId && !message.method);
        assert.ok(response, `expected client response for server request ${serverRequestId}`);
        return response;
    }
    async waitForClientResponse(serverRequestId) {
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline) {
            const response = this.sent.find((message) => message.id === serverRequestId && !message.method);
            if (response) {
                return response;
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.fail(`timed out waiting for client response to server request ${serverRequestId}`);
    }
}
async function waitFor(condition, label) {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.fail(`timed out waiting for ${label}`);
}
async function startedSession(transport) {
    const client = new CodexControlClient({ transport });
    const starting = client.start();
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    await starting;
    const sessionPromise = client.startSession({
        cwd: "/tmp/project",
        model: "gpt-5.5",
        approvalPolicy: "on-request",
    });
    await transport.waitForRequest("thread/start");
    transport.respondTo("thread/start", { thread: { id: "thread-1" } });
    return { client, session: await sessionPromise };
}
test("ask starts a turn and resolves with final agent text", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("hello");
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    transport.server({
        method: "item/agentMessage/delta",
        params: { delta: "Hi " },
    });
    transport.server({
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "Hi Project User." } },
    });
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    const result = await turn;
    assert.equal(result.finalText, "Hi Project User.");
    assert.equal(result.threadId, "thread-1");
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.turn.status, "completed");
});
test("interrupt sends turn interrupt for active turn", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("stop me");
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    const interrupting = session.interrupt();
    const interrupt = await transport.waitForRequest("turn/interrupt");
    assert.deepEqual(interrupt.params, {
        threadId: "thread-1",
        turnId: "turn-1",
    });
    transport.respondTo("turn/interrupt", {});
    await interrupting;
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
    });
    const result = await turn;
    assert.equal(result.turn.status, "interrupted");
});
test("initialize advertises experimental API capability for dynamic tools", async () => {
    const transport = new FakeTransport();
    const client = new CodexControlClient({ transport });
    const starting = client.start();
    const initialize = await transport.waitForRequest("initialize");
    try {
        assert.deepEqual(initialize.params.capabilities, {
            experimentalApi: true,
        });
    }
    finally {
        transport.respondTo("initialize", {});
        await starting;
    }
});
test("preserves structured app-server errors for deterministic diagnosis", async () => {
    const transport = new FakeTransport();
    const client = new CodexControlClient({ transport });
    const listing = client.listModels();
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    const request = await transport.waitForRequest("model/list");
    assert.ok(request.id);
    transport.server({
        id: request.id,
        error: {
            code: -32602,
            message: "Model gpt-retired is not available",
            data: { model: "gpt-retired", kind: "model_not_found" },
        },
    });
    await assert.rejects(listing, (error) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.equal(error.code, -32602);
        assert.equal(error.message, "Model gpt-retired is not available");
        assert.deepEqual(error.data, { model: "gpt-retired", kind: "model_not_found" });
        assert.deepEqual(error.rpcError, {
            code: -32602,
            message: "Model gpt-retired is not available",
            data: { model: "gpt-retired", kind: "model_not_found" },
        });
        return true;
    });
});
test("exposes app-server runtime identity from initialize", async () => {
    const transport = new FakeTransport();
    const client = new CodexControlClient({ transport });
    const info = client.getRuntimeInfo();
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {
        userAgent: "codex_cli_rs/0.130.0 (macos 15.5; arm64)",
        platformFamily: "unix",
        platformOs: "macos",
        codexHome: "/tmp/codex-home",
    });
    assert.deepEqual(await info, {
        userAgent: "codex_cli_rs/0.130.0 (macos 15.5; arm64)",
        platformFamily: "unix",
        platformOs: "macos",
        codexHome: "/tmp/codex-home",
    });
});
test("permissions approval grants requested network but not filesystem by default", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("use a tool");
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", {});
    transport.server({
        id: 991,
        method: "item/permissions/requestApproval",
        params: {
            permissions: {
                network: { enabled: true },
                fileSystem: { read: ["/private"], write: ["/private"] },
            },
        },
    });
    const response = await transport.waitForClientResponse(991);
    assert.deepEqual(response.result, {
        permissions: { network: { enabled: true } },
        scope: "turn",
    });
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await turn;
});
test("MCP elicitations are declined unless external writes are confirmed", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("send a Slack message");
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", {});
    transport.server({
        id: 992,
        method: "mcpServer/elicitation/request",
        params: {
            mode: "form",
            message: "Confirm send",
            requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean", title: "Confirm" } },
                required: ["confirm"],
            },
        },
    });
    assert.deepEqual((await transport.waitForClientResponse(992)).result, {
        action: "decline",
        content: null,
        _meta: null,
    });
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await turn;
});
test("confirmed external writes accept form-mode MCP elicitations", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("send a Slack message", {
        externalWrites: "allow",
        confirmation: { confirmed: true, reason: "user confirmed by voice" },
    });
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", {});
    transport.server({
        id: 993,
        method: "mcpServer/elicitation/request",
        params: {
            mode: "form",
            message: "Confirm send",
            requestedSchema: {
                type: "object",
                properties: {
                    confirm: { type: "boolean", title: "Confirm send" },
                    note: { type: "string", default: "" },
                },
                required: ["confirm"],
            },
        },
    });
    assert.deepEqual((await transport.waitForClientResponse(993)).result, {
        action: "accept",
        content: { confirm: true },
        _meta: null,
    });
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await turn;
});
test("approval handler can pause and approve command execution requests", async () => {
    const transport = new FakeTransport();
    const captured = {};
    const resolver = {};
    const client = new CodexControlClient({
        transport,
        approvalHandler(request) {
            captured.request = request;
            return new Promise((resolve) => {
                resolver.approve = resolve;
            });
        },
    });
    const starting = client.start();
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    await starting;
    const sessionPromise = client.startSession({
        cwd: "/tmp/project",
        approvalPolicy: "on-request",
    });
    await transport.waitForRequest("thread/start");
    transport.respondTo("thread/start", { thread: { id: "thread-1" } });
    const session = await sessionPromise;
    const turn = session.ask("run tests");
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", {});
    transport.server({
        id: 994,
        method: "item/commandExecution/requestApproval",
        params: {
            command: ["npm", "test"],
            cwd: "/tmp/project",
        },
    });
    await waitFor(() => captured.request !== undefined, "approval handler request");
    assert.equal(captured.request?.kind, "command_approval");
    assert.equal(captured.request?.method, "item/commandExecution/requestApproval");
    assert.deepEqual(captured.request?.params, {
        command: ["npm", "test"],
        cwd: "/tmp/project",
    });
    assert.equal(transport.sent.some((message) => message.id === 994 && !message.method), false);
    assert.ok(resolver.approve, "expected approval resolver");
    resolver.approve({ decision: "approved", reason: "confirmed in UI" });
    const response = await transport.waitForClientResponse(994);
    assert.deepEqual(response.result, { decision: "accept" });
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await turn;
});
test("thread start passes dynamic tool specs to app server", async () => {
    const transport = new FakeTransport();
    const client = new CodexControlClient({ transport });
    const sessionPromise = client.startSession({
        cwd: "/tmp/project",
        dynamicTools: [
            {
                name: "manager_list_tasks",
                description: "List manager tasks.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
            },
        ],
    });
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    await transport.waitForRequest("thread/start");
    transport.respondTo("thread/start", { thread: { id: "thread-1" } });
    await sessionPromise;
    const threadStart = transport.sent.find((message) => message.method === "thread/start");
    assert.deepEqual((threadStart?.params).dynamicTools, [
        {
            name: "manager_list_tasks",
            description: "List manager tasks.",
            inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            deferLoading: false,
        },
    ]);
});
test("thread start passes model reasoning and service tier to app server", async () => {
    const transport = new FakeTransport();
    const client = new CodexControlClient({ transport });
    const sessionPromise = client.startSession({
        cwd: "/tmp/project",
        model: "gpt-test",
        reasoningEffort: "high",
        serviceTier: "fast",
    });
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    await transport.waitForRequest("thread/start");
    transport.respondTo("thread/start", { thread: { id: "thread-1" } });
    await sessionPromise;
    const threadStart = transport.sent.find((message) => message.method === "thread/start");
    assert.equal((threadStart?.params).model, "gpt-test");
    assert.equal((threadStart?.params).serviceTier, "fast");
    assert.deepEqual((threadStart?.params).config, {
        model_reasoning_effort: "high",
    });
});
test("lists model catalog from app server with pagination", async () => {
    const transport = new FakeTransport();
    const client = new CodexControlClient({ transport });
    const listing = client.listModels();
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    const first = await transport.waitForRequest("model/list");
    assert.deepEqual(first.params, { includeHidden: false, cursor: null });
    assert.ok(first.id, "expected first model/list request id");
    transport.server({ id: first.id, result: {
            data: [
                {
                    id: "gpt-test",
                    model: "gpt-test",
                    displayName: "GPT Test",
                    description: "Test model",
                    hidden: false,
                    supportedReasoningEfforts: [
                        { reasoningEffort: "low", description: "Fast" },
                        { reasoningEffort: "max", description: "Maximum" },
                        { reasoningEffort: "ultra", description: "Delegated maximum" },
                    ],
                    defaultReasoningEffort: "low",
                    additionalSpeedTiers: ["fast"],
                    serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
                    isDefault: true,
                },
            ],
            nextCursor: "next-page",
        } });
    await waitFor(() => transport.sent.filter((message) => message.method === "model/list").length === 2, "second model/list request");
    const second = transport.sent.filter((message) => message.method === "model/list").at(-1);
    assert.ok(second?.id, "expected second model/list request");
    assert.equal((second?.params).cursor, "next-page");
    transport.server({ id: second.id, result: { data: [], nextCursor: null } });
    assert.deepEqual(await listing, {
        models: [
            {
                id: "gpt-test",
                model: "gpt-test",
                displayName: "GPT Test",
                description: "Test model",
                hidden: false,
                supportedReasoningEfforts: [
                    { reasoningEffort: "low", description: "Fast" },
                    { reasoningEffort: "max", description: "Maximum" },
                    { reasoningEffort: "ultra", description: "Delegated maximum" },
                ],
                defaultReasoningEffort: "low",
                additionalSpeedTiers: ["fast"],
                serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
                isDefault: true,
            },
        ],
    });
});
test("dynamic tool calls are routed to registered handlers", async () => {
    const transport = new FakeTransport();
    const client = new CodexControlClient({ transport });
    const sessionPromise = client.startSession({
        cwd: "/tmp/project",
        dynamicTools: [
            {
                name: "manager_echo",
                description: "Echo text.",
                inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false,
                },
                handler: (async (args) => ({
                    contentItems: [{ type: "inputText", text: String(args.text) }],
                    success: true,
                })),
            },
        ],
    });
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    await transport.waitForRequest("thread/start");
    transport.respondTo("thread/start", { thread: { id: "thread-1" } });
    const session = await sessionPromise;
    transport.server({
        id: 7,
        method: "item/tool/call",
        params: {
            threadId: session.threadId,
            turnId: "turn-1",
            callId: "call-1",
            tool: "manager_echo",
            arguments: { text: "hello" },
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(transport.sent.at(-1), {
        id: 7,
        result: {
            contentItems: [{ type: "inputText", text: "hello" }],
            success: true,
        },
    });
});
test("ask rejects concurrent turns on the same session", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const first = session.ask("first");
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", {});
    await assert.rejects(session.ask("second"), /turn is already in progress/i);
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await first;
});
test("ask times out with last activity included", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("slow", { timeoutMs: 1 });
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", {});
    await assert.rejects(turn, /Timed out waiting for Codex turn/);
});
test("ask interrupts timed out app-server turns when a turn id is known", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("slow", { timeoutMs: 1 });
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", { turn: { id: "turn-1" } });
    await assert.rejects(turn, /Timed out waiting for Codex turn/);
    const interrupt = await transport.waitForRequest("turn/interrupt");
    assert.deepEqual(interrupt.params, {
        threadId: "thread-1",
        turnId: "turn-1",
    });
    transport.respondTo("turn/interrupt", {});
});
test("ask keeps waiting when app-server reports a retryable stream disconnect", async () => {
    const transport = new FakeTransport();
    const { session } = await startedSession(transport);
    const turn = session.ask("hello after idle");
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    let settled = false;
    turn.finally(() => {
        settled = true;
    }).catch(() => { });
    transport.server({
        method: "turn/completed",
        params: {
            threadId: "thread-1",
            turn: {
                id: "turn-1",
                status: "failed",
                error: {
                    error: {
                        message: "Reconnecting... 2/5",
                        codexErrorInfo: {
                            responseStreamDisconnected: {
                                httpStatusCode: null,
                            },
                        },
                    },
                    willRetry: true,
                    threadId: "thread-1",
                    turnId: "turn-1",
                },
            },
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    transport.server({
        method: "item/completed",
        params: { threadId: "thread-1", item: { type: "agentMessage", text: "Recovered." } },
    });
    transport.server({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    const result = await turn;
    assert.equal(result.finalText, "Recovered.");
});
test("approval requests after a timed out turn are auto-declined without UI approval", async () => {
    const transport = new FakeTransport();
    let approvalRequests = 0;
    const client = new CodexControlClient({
        transport,
        approvalHandler() {
            approvalRequests += 1;
            return { decision: "approved" };
        },
    });
    const starting = client.start();
    await transport.waitForRequest("initialize");
    transport.respondTo("initialize", {});
    await starting;
    const sessionPromise = client.startSession({
        cwd: "/tmp/project",
        approvalPolicy: "on-request",
    });
    await transport.waitForRequest("thread/start");
    transport.respondTo("thread/start", { thread: { id: "thread-1" } });
    const session = await sessionPromise;
    const turn = session.ask("slow", { timeoutMs: 1 });
    await transport.waitForRequest("turn/start");
    transport.respondTo("turn/start", { turn: { id: "turn-1" } });
    await assert.rejects(turn, /Timed out waiting for Codex turn/);
    await transport.waitForRequest("turn/interrupt");
    transport.respondTo("turn/interrupt", {});
    transport.server({
        id: 995,
        method: "item/commandExecution/requestApproval",
        params: {
            threadId: "thread-1",
            turnId: "turn-1",
            command: ["npm", "test"],
            cwd: "/tmp/project",
        },
    });
    const response = await transport.waitForClientResponse(995);
    assert.equal(approvalRequests, 0);
    assert.deepEqual(response.result, { decision: "decline" });
});
//# sourceMappingURL=control.test.js.map