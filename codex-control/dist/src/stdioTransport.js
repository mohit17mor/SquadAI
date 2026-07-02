import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import readline from "node:readline";
export const CODEX_DESKTOP_BINARY = "/Applications/Codex.app/Contents/Resources/codex";
export function resolveCodexBinary(options = {}) {
    const env = options.env ?? process.env;
    const configured = env.CODEX_BINARY?.trim();
    if (configured) {
        return configured;
    }
    const platform = options.platform ?? process.platform;
    const isExecutable = options.isExecutable ?? executable;
    if (platform === "darwin" && isExecutable(CODEX_DESKTOP_BINARY)) {
        return CODEX_DESKTOP_BINARY;
    }
    return "codex";
}
export class StdioCodexAppServerTransport {
    command;
    args;
    env;
    child = null;
    messageHandlers = [];
    closeHandlers = [];
    constructor(options = {}) {
        this.command = options.command ?? resolveCodexBinary(options.env ? { env: options.env } : {});
        this.args = options.args ?? ["app-server"];
        this.env = options.env;
    }
    getCommand() {
        return this.command;
    }
    async start() {
        if (this.child) {
            return;
        }
        const child = spawn(this.command, this.args, {
            env: this.env ?? process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        const stdout = readline.createInterface({
            input: child.stdout,
            crlfDelay: Infinity,
        });
        stdout.on("line", (line) => {
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                return;
            }
            for (const handler of this.messageHandlers) {
                handler(message);
            }
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
            this.emitClose(error);
        });
        child.once("exit", (code, signal) => {
            this.child = null;
            const clean = code === 0 || signal === "SIGTERM";
            this.emitClose(clean
                ? undefined
                : new Error(`codex app-server exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${stderr}`));
        });
    }
    send(message) {
        if (!this.child) {
            throw new Error("Codex App Server transport is not started.");
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onClose(handler) {
        this.closeHandlers.push(handler);
    }
    async close() {
        if (!this.child) {
            return;
        }
        const child = this.child;
        this.child = null;
        child.kill("SIGTERM");
    }
    emitClose(error) {
        for (const handler of this.closeHandlers) {
            handler(error);
        }
    }
}
function executable(path) {
    try {
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=stdioTransport.js.map