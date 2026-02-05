import * as vscode from "vscode";
import * as path from "path";

// Track open panels
let primaryPanel: vscode.WebviewPanel | undefined;
const openPanels = new Set<vscode.WebviewPanel>();

// Message commands for communication with webview
const VSCODE_UI_READY_COMMAND = "vscode-ui-ready";
const VSCODE_LOAD_TRACE_COMMAND = "vscode-load-trace";
const VSCODE_TRACE_LOADED_COMMAND = "vscode-trace-loaded";

export function activate(context: vscode.ExtensionContext) {
    const openCore = async (
        uri: vscode.Uri | undefined,
        mode: "replace" | "newTab"
    ) => {
        const previousEditor = vscode.window.activeTextEditor;
        // Fallback to active editor if no URI was passed (e.g. command palette)
        if (!uri) {
            const active = vscode.window.activeTextEditor?.document.uri;
            if (!active) {
                void vscode.window.showWarningMessage(
                    "RightTrace: No file selected."
                );
                return;
            }
            uri = active;
        }

        const config = vscode.workspace.getConfiguration("rightrace");
        const perfettoBase = config.get<string>(
            "perfettoUrl",
            "https://ui.perfetto.dev/"
        );
        const perfettoOrigin = new URL(
            perfettoBase || "https://ui.perfetto.dev/"
        ).origin;

        // Read trace file into memory
        let traceData: Uint8Array;
        try {
            traceData = await vscode.workspace.fs.readFile(uri);
        } catch (err) {
            void vscode.window.showErrorMessage(
                `RightTrace: Failed to read trace file: ${String(err)}`
            );
            return;
        }

        const fileName = path.basename(uri.fsPath);
        const title = fileName;

        const panel = vscode.window.createWebviewPanel(
            "rightrace.perfetto",
            `RightTrace: ${fileName}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: []
            }
        );

        // Track panel and clean up when all panels are closed
        openPanels.add(panel);
        panel.onDidDispose(() => {
            openPanels.delete(panel);
            if (primaryPanel === panel) {
                primaryPanel = undefined;
            }
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage((message: { command: string }) => {
            switch (message.command) {
                case VSCODE_UI_READY_COMMAND:
                    // Perfetto UI is ready, send trace data
                    panel.webview.postMessage({
                        command: VSCODE_LOAD_TRACE_COMMAND,
                        payload: {
                            buffer: traceData.buffer,
                            title: title,
                            fileName: fileName,
                            keepApiOpen: true,
                        }
                    });
                    return;
                case VSCODE_TRACE_LOADED_COMMAND:
                    // Trace loaded successfully
                    console.log(`RightTrace: Trace loaded: ${fileName}`);
                    return;
                default:
                    console.error("RightTrace: Unexpected message:", message);
                    return;
            }
        });

        // Set webview HTML with Perfetto iframe and message handling
        panel.webview.html = getWebviewHTML(panel.webview, perfettoOrigin, perfettoBase);

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
            await vscode.window.showTextDocument(
                previousEditor.document,
                previousEditor.viewColumn
            );
        }
    };

    const openReplaceDisposable = vscode.commands.registerCommand(
        "rightrace.openTrace",
        async (uri?: vscode.Uri) => {
            await openCore(uri, "replace");
        }
    );

    const openNewTabDisposable = vscode.commands.registerCommand(
        "rightrace.openTraceInNewTab",
        async (uri?: vscode.Uri) => {
            await openCore(uri, "newTab");
        }
    );

    context.subscriptions.push(openReplaceDisposable, openNewTabDisposable);
}

export function deactivate() {
    // Panels will be disposed automatically by VS Code
    primaryPanel = undefined;
    openPanels.clear();
}

function getWebviewHTML(webview: vscode.Webview, perfettoOrigin: string, perfettoBase: string): string {
    const perfettoFrameId = "perfetto-ui-iframe";
    const normalizedBase = perfettoBase.replace(/\/+$/, "") + "/";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
            script-src ${webview.cspSource} ${perfettoOrigin} 'unsafe-inline';
            style-src ${webview.cspSource} ${perfettoOrigin} 'unsafe-inline';
            frame-src ${perfettoOrigin}">
    <title>RightTrace - Perfetto UI</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: #1e1e1e;
            color: #ffffff;
        }
        iframe {
            border: none;
            width: 100vw;
            height: 100vh;
        }
    </style>
</head>
<body>
    <script type="text/javascript">
        (function() {
            document.addEventListener("DOMContentLoaded", function() {
                const vscode = acquireVsCodeApi();
                const ui = document.getElementById("${perfettoFrameId}");

                let pingInterval = null;
                let uiReady = false;
                let traceLoaded = false;

                const sendPing = () => {
                    ui.contentWindow.postMessage("PING", "${perfettoOrigin}");
                };

                // Handle messages from Perfetto UI and extension
                const messageHandler = event => {
                    if (event.data === "PONG" && event.origin === "${perfettoOrigin}") {
                        if (!uiReady) {
                            uiReady = true;
                            vscode.postMessage({ command: "${VSCODE_UI_READY_COMMAND}" });
                            console.log("RightTrace: Perfetto UI ready");
                        } else if (traceLoaded) {
                            console.log("RightTrace: Trace loaded");
                            clearInterval(pingInterval);
                            pingInterval = null;
                            vscode.postMessage({ command: "${VSCODE_TRACE_LOADED_COMMAND}" });
                        }
                    } else if (event.data && event.data.command === "${VSCODE_LOAD_TRACE_COMMAND}") {
                        if (!traceLoaded) {
                            traceLoaded = true;
                            ui.contentWindow.postMessage({ perfetto: event.data.payload }, "${perfettoOrigin}");
                            console.log("RightTrace: Sending trace data to Perfetto");
                        }
                    }
                };

                window.addEventListener('message', messageHandler);

                // Start pinging Perfetto UI to detect when it's ready
                pingInterval = setInterval(() => sendPing(), 500);
            });
        }())
    </script>
    <iframe id="${perfettoFrameId}" src="${normalizedBase}"></iframe>
</body>
</html>`;
}
