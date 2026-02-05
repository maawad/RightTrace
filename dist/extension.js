"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
// Shared server + routing table so we can serve multiple traces at once
// from the fixed CSP-allowed port 9001.
let sharedServer;
let sharedServerOrigin;
const traceFiles = new Map(); // basename -> absolute path
let primaryPanel;
function activate(context) {
    const openCore = async (uri, mode) => {
        const previousEditor = vscode.window.activeTextEditor;
        // Fallback to active editor if no URI was passed (e.g. command palette)
        if (!uri) {
            const active = vscode.window.activeTextEditor?.document.uri;
            if (!active) {
                void vscode.window.showWarningMessage("RightTrace: No file selected.");
                return;
            }
            uri = active;
        }
        const config = vscode.workspace.getConfiguration("rightrace");
        const perfettoBase = config.get("perfettoUrl", "https://ui.perfetto.dev/");
        const perfettoOrigin = new URL(perfettoBase || "https://ui.perfetto.dev/").origin;
        // Register this trace file and ensure the shared HTTP server is
        // running so we can point Perfetto's ?url= at it. This mirrors
        // tools/open_trace_in_ui.py but allows multiple traces at once.
        let traceUrl;
        try {
            traceUrl = await registerTraceAndEnsureServer(uri.fsPath, perfettoOrigin);
        }
        catch (err) {
            void vscode.window.showErrorMessage(`RightTrace: Failed to start local server: ${String(err)}`);
            return;
        }
        // Ensure there's exactly one trailing slash before appending hash/params.
        const normalizedBase = perfettoBase.replace(/\/+$/, "") + "/";
        // Point Perfetto at our local trace URL, matching open_trace_in_ui.py.
        const perfettoWithTrace = `${normalizedBase}#!/?url=${encodeURIComponent(traceUrl)}&referrer=open_trace_in_ui`;
        const panel = vscode.window.createWebviewPanel("rightrace.perfetto", `RightTrace: ${path.basename(uri.fsPath)}`, vscode.ViewColumn.Beside, {
            enableScripts: true
        });
        const safeUrl = escapeHtml(perfettoWithTrace);
        panel.webview.html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>RightTrace</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
      background: #1e1e1e;
    }
    iframe {
      border: 0;
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <iframe src="${safeUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
            </body>
            </html>`;
        if (mode === "replace") {
            // Close any previous primary panel so "Open (Replace)" always reuses
            // the same logical slot.
            if (primaryPanel) {
                primaryPanel.dispose();
            }
            primaryPanel = panel;
        }
        // Restore focus back to the previously active text editor so that
        // opening a trace does not steal focus from the current file.
        if (previousEditor) {
            await vscode.window.showTextDocument(previousEditor.document, previousEditor.viewColumn);
        }
    };
    const openReplaceDisposable = vscode.commands.registerCommand("rightrace.openTrace", async (uri) => {
        await openCore(uri, "replace");
    });
    const openNewTabDisposable = vscode.commands.registerCommand("rightrace.openTraceInNewTab", async (uri) => {
        await openCore(uri, "newTab");
    });
    context.subscriptions.push(openReplaceDisposable, openNewTabDisposable);
}
function deactivate() {
    if (sharedServer) {
        sharedServer.close();
        sharedServer = undefined;
        sharedServerOrigin = undefined;
        traceFiles.clear();
        primaryPanel = undefined;
    }
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
async function registerTraceAndEnsureServer(tracePath, perfettoOrigin) {
    const filename = path.basename(tracePath);
    traceFiles.set(filename, tracePath);
    // If there's already a server with the same origin, reuse it.
    if (sharedServer && sharedServerOrigin === perfettoOrigin) {
        return `http://127.0.0.1:9001/${encodeURIComponent(filename)}`;
    }
    // If there's a server with a different origin, restart it to match.
    if (sharedServer) {
        sharedServer.close();
        sharedServer = undefined;
        sharedServerOrigin = undefined;
    }
    return await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (!req.url || !req.method) {
                res.statusCode = 400;
                res.end("Bad request");
                return;
            }
            const url = new URL(req.url, "http://127.0.0.1:9001");
            const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
            const target = traceFiles.get(name);
            if (req.method === "GET" && target) {
                fs.readFile(target, (err, data) => {
                    if (err) {
                        res.statusCode = 500;
                        res.setHeader("Content-Type", "text/plain; charset=utf-8");
                        res.end(`Failed to read trace: ${String(err)}`);
                        return;
                    }
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json; charset=utf-8");
                    // Match tools/open_trace_in_ui.py: allow only the Perfetto origin.
                    res.setHeader("Access-Control-Allow-Origin", perfettoOrigin);
                    res.end(data);
                });
            }
            else {
                res.statusCode = 404;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Not found");
            }
        });
        server.on("error", (err) => {
            reject(err);
        });
        const PORT = 9001;
        server.listen(PORT, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address.port !== "number") {
                server.close();
                reject(new Error("Failed to get server port"));
                return;
            }
            sharedServer = server;
            sharedServerOrigin = perfettoOrigin;
            const url = `http://127.0.0.1:${address.port}/${encodeURIComponent(filename)}`;
            resolve(url);
        });
    });
}
//# sourceMappingURL=extension.js.map