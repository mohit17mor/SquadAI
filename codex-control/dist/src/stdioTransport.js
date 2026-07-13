import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { win32 } from "node:path";
import readline from "node:readline";
export const CODEX_DESKTOP_BINARY = "/Applications/Codex.app/Contents/Resources/codex";
export function resolveCodexBinary(options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const isExecutable = options.isExecutable ?? executable;
    const configured = env.CODEX_BINARY?.trim();
    if (configured) {
        return platform === "win32"
            ? resolveWindowsCommand(configured, env, isExecutable)
            : configured;
    }
    if (platform === "darwin" && isExecutable(CODEX_DESKTOP_BINARY)) {
        return CODEX_DESKTOP_BINARY;
    }
    if (platform === "win32") {
        return resolveWindowsCommand("codex", env, isExecutable);
    }
    return "codex";
}
export function createCodexLaunchSpec(command, args, options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
        return { command, args: [...args] };
    }
    const env = options.env ?? process.env;
    return {
        command: environmentValue(env, "ComSpec") || "cmd.exe",
        args: ["/d", "/s", "/c", command, ...args],
    };
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
        const launch = createCodexLaunchSpec(this.command, this.args, { env: this.env ?? process.env });
        const child = spawn(launch.command, launch.args, {
            env: this.env ?? process.env,
            stdio: ["pipe", "pipe", "pipe"],
            // Isolate App Server and its tool subprocesses so shutdown can target
            // the complete tree without signalling the runner's parent shell.
            detached: process.platform !== "win32",
            windowsHide: true,
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
        child.stdin.end();
        if (process.platform === "win32") {
            // taskkill must see the root process in order to traverse descendants.
            // The turn was already interrupted by the runner, so tree termination is
            // the final cleanup guarantee rather than the normal stop mechanism.
            await terminateProcessTree(child, true);
            await waitForExit(child, 1_000);
            return;
        }
        await waitForExit(child, 1_000);
        await terminateProcessTree(child, false);
        await waitForProcessGroupExit(child.pid, 1_000);
        if (!processGroupExists(child.pid))
            return;
        await terminateProcessTree(child, true);
        await waitForProcessGroupExit(child.pid, 1_000);
    }
    emitClose(error) {
        for (const handler of this.closeHandlers) {
            handler(error);
        }
    }
}
async function terminateProcessTree(child, force) {
    const pid = child.pid;
    if (!pid)
        return;
    if (process.platform === "win32") {
        await runTaskkill(pid, force);
        return;
    }
    try {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    }
    catch (error) {
        if (error.code !== "ESRCH") {
            child.kill(force ? "SIGKILL" : "SIGTERM");
        }
    }
}
function runTaskkill(pid, force) {
    return new Promise((resolve) => {
        const args = ["/pid", String(pid), "/t"];
        if (force)
            args.push("/f");
        const taskkill = spawn("taskkill.exe", args, {
            stdio: "ignore",
            windowsHide: true,
        });
        taskkill.once("error", () => resolve());
        taskkill.once("exit", () => resolve());
    });
}
function processGroupExists(pid) {
    if (!pid || process.platform === "win32")
        return false;
    try {
        process.kill(-pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
async function waitForProcessGroupExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (processGroupExists(pid)) {
        if (Date.now() >= deadline)
            return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
}
function resolveWindowsCommand(command, env, isExecutable) {
    if (win32.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
        return command;
    }
    const pathValue = environmentValue(env, "Path");
    if (!pathValue)
        return command;
    const extensions = win32.extname(command)
        ? [""]
        : (environmentValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
            .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
    for (const pathEntry of pathValue.split(";").map((entry) => entry.trim().replace(/^"|"$/g, ""))) {
        if (!pathEntry)
            continue;
        for (const extension of extensions) {
            const candidate = win32.join(pathEntry, `${command}${extension.toLowerCase()}`);
            if (isExecutable(candidate))
                return candidate;
            const upperCaseCandidate = win32.join(pathEntry, `${command}${extension.toUpperCase()}`);
            if (upperCaseCandidate !== candidate && isExecutable(upperCaseCandidate))
                return upperCaseCandidate;
        }
    }
    return command;
}
function environmentValue(env, name) {
    const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1];
}
function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(true);
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish(false), timeoutMs);
        const exited = () => finish(true);
        const finish = (value) => {
            clearTimeout(timer);
            child.off("exit", exited);
            resolve(value);
        };
        child.once("exit", exited);
    });
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