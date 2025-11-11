(function() {
    'use strict';

    // ========================================
    // SHARED UTILITIES
    // ========================================
    
    const parentOrigin = '*';

    function sendToParent(type, data, severity = 'info') {
        window.parent.postMessage({
            source: 'preview-logger',
            type: type,
            category: getCategoryFromType(type),
            severity: severity,
            data: data,
            timestamp: new Date().toISOString()
        }, parentOrigin);
    }

    function getCategoryFromType(type) {
        const categoryMap = {
            'buildError': 'build',
            'runtimeError': 'runtime',
            'promiseRejection': 'runtime',
            'resourceError': 'resource',
            'networkError': 'network',
            'console': 'console'
        };
        return categoryMap[type] || 'other';
    }

    function serializeData(data, maxSize = 4096) {
        if (!data) return "";
        try {
            if (typeof data === "string") {
                return data.slice(0, maxSize);
            }
            if (data instanceof FormData) {
                const entries = {};
                for (const [key, value] of data.entries()) {
                    entries[key] = typeof value === "string" ? value : "[File]";
                }
                return JSON.stringify(entries).slice(0, maxSize);
            }
            if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
                return `[Binary data: ${data.byteLength} bytes]`;
            }
            return JSON.stringify(data).slice(0, maxSize);
        } catch (e) {
            return String(data).slice(0, maxSize);
        }
    }

    // ========================================
    // RRWEB SESSION RECORDING
    // ========================================
    
    const session = [];
    let stopRecording = null;

    function addCustomEvent(tag, payload) {
        session.push({
            type: 5,
            data: { tag, payload },
            timestamp: Date.now()
        });
    }

    // Initialize rrweb if available
    if (typeof window.rrweb !== 'undefined') {
        stopRecording = window.rrweb.record({
            emit(e) {
                session.push(e);
            },
            recordCanvas: true,
        });
    } else {
        console.warn('rrweb is not loaded. Session recording disabled.');
    }

    // ========================================
    // CONSOLE INTERCEPTION (for both systems)
    // ========================================
    
    const originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info,
        debug: console.debug
    };

    ['log', 'error', 'warn', 'info', 'debug'].forEach(method => {
        console[method] = function(...args) {
            originalConsole[method].apply(console, args);
            
            const severity = method === 'error' ? 'error' : method === 'warn' ? 'warning' : 'info';
            
            // Send to parent (preview logger)
            sendToParent('console', {
                level: method,
                message: args.map(arg => {
                    try {
                        return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
                    } catch (e) {
                        return String(arg);
                    }
                })
            }, severity);
        };
    });

    // ========================================
    // ERROR HANDLING (unified)
    // ========================================
    
    // Uncaught errors
    window.addEventListener('error', (event) => {
        if (event.target === window) {
            // Runtime error
            const errorData = {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                stack: event.error?.stack || '',
                errorType: event.error?.name || 'Error',
                errorObject: event.error ? {
                    name: event.error.name,
                    message: event.error.message,
                    stack: event.error.stack
                } : null
            };

            // Add to rrweb session
            addCustomEvent("console", {
                level: 'error',
                message: `Uncaught Error: ${event.message}`,
                args: [event.error?.stack || event.message],
                timestamp: Date.now(),
                url: location.href,
                source: event.filename,
                line: event.lineno,
                column: event.colno
            });

            // Send to parent
            sendToParent('runtimeError', errorData, 'error');
        }
    });

    // Resource loading errors
    window.addEventListener('error', (event) => {
        if (event.target !== window) {
            const tagName = event.target.tagName;
            const severity = (tagName === 'SCRIPT' || tagName === 'LINK') ? 'error' : 'warning';
            
            sendToParent('resourceError', {
                tagName: tagName,
                src: event.target.src || event.target.href,
                type: 'Resource failed to load',
                outerHTML: event.target.outerHTML
            }, severity);
        }
    }, true);

    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        let reason = event.reason;
        let reasonDetails = {};

        if (reason instanceof Error) {
            reasonDetails = {
                name: reason.name,
                message: reason.message,
                stack: reason.stack
            };
        } else if (typeof reason === 'object') {
            try {
                reasonDetails = JSON.parse(JSON.stringify(reason));
            } catch (e) {
                reasonDetails = { toString: String(reason) };
            }
        } else {
            reasonDetails = { value: String(reason) };
        }

        // Add to rrweb session
        addCustomEvent("console", {
            level: 'error',
            message: `Unhandled Promise Rejection: ${event.reason}`,
            args: [String(event.reason)],
            timestamp: Date.now(),
            url: location.href
        });

        // Send to parent
        sendToParent('promiseRejection', {
            reason: String(reason),
            reasonDetails: reasonDetails,
            stack: reason?.stack || '',
            promise: String(event.promise)
        }, 'error');
    });

    // ========================================
    // BUILD ERROR DETECTION
    // ========================================
    
    function detectBuildError() {
        let errorDetails = null;

        // 1. Vite Error Overlay (most detailed)
        const viteOverlay = document.querySelector('vite-error-overlay');
        if (viteOverlay && viteOverlay.shadowRoot) {
            const shadowRoot = viteOverlay.shadowRoot;
            
            const messageEl = shadowRoot.querySelector('.message-body') || 
                           shadowRoot.querySelector('.message') ||
                           shadowRoot.querySelector('pre');
            
            const stackEl = shadowRoot.querySelector('.stack') || 
                         shadowRoot.querySelector('.file');
            
            const fileEl = shadowRoot.querySelector('.file');
            
            if (messageEl) {
                errorDetails = {
                    message: messageEl.textContent.trim(),
                    stack: stackEl ? stackEl.textContent.trim() : '',
                    file: fileEl ? fileEl.textContent.trim() : '',
                    tool: 'Vite',
                    rawHTML: shadowRoot.innerHTML.substring(0, 5000)
                };
            }
        }

        // 2. Webpack Error Overlay
        if (!errorDetails) {
            const webpackOverlay = document.querySelector('iframe[id*="webpack"]') ||
                                document.querySelector('[data-reactroot]');
            
            if (webpackOverlay) {
                try {
                    let errorText = '';
                    
                    if (webpackOverlay.tagName === 'IFRAME') {
                        const iframeDoc = webpackOverlay.contentDocument || webpackOverlay.contentWindow?.document;
                        if (iframeDoc) {
                            errorText = iframeDoc.body.textContent;
                        }
                    } else {
                        errorText = webpackOverlay.textContent;
                    }

                    if (errorText) {
                        errorDetails = {
                            message: errorText.substring(0, 1000),
                            tool: 'Webpack',
                            rawText: errorText.substring(0, 5000)
                        };
                    }
                } catch (e) {
                    errorDetails = {
                        message: 'Webpack build error detected (unable to extract details due to iframe restrictions)',
                        tool: 'Webpack',
                        error: e.message
                    };
                }
            }
        }

        // 3. Check for error text in body
        if (!errorDetails) {
            const bodyText = document.body?.textContent || '';
            const bodyHTML = document.body?.innerHTML || '';
            
            const errorIndicators = [
                'Failed to compile',
                'Compilation failed',
                'Build failed',
                'Module not found',
                'Cannot find module',
                'Syntax error',
                'Module parse failed',
                'You may need an appropriate loader',
                'ERROR in',
                'Module build failed'
            ];

            const hasError = errorIndicators.some(indicator => 
                bodyText.includes(indicator) || bodyHTML.includes(indicator)
            );

            if (hasError) {
                const pre = document.querySelector('pre');
                const errorDiv = document.querySelector('[class*="error"]') ||
                                document.querySelector('[id*="error"]');

                let errorMessage = '';
                if (pre) {
                    errorMessage = pre.textContent;
                } else if (errorDiv) {
                    errorMessage = errorDiv.textContent;
                } else {
                    const lines = bodyText.split('\n');
                    const errorLineIndex = lines.findIndex(line => 
                        errorIndicators.some(indicator => line.includes(indicator))
                    );
                    
                    if (errorLineIndex !== -1) {
                        errorMessage = lines.slice(
                            Math.max(0, errorLineIndex - 2),
                            Math.min(lines.length, errorLineIndex + 15)
                        ).join('\n');
                    }
                }

                errorDetails = {
                    message: errorMessage.trim().substring(0, 2000),
                    tool: 'Build Tool',
                    fullBody: bodyText.substring(0, 3000)
                };
            }
        }

        // 4. Check for React error boundary
        const reactError = document.querySelector('[data-test-id="error-boundary"]') ||
                          document.querySelector('.react-error-overlay');
        
        if (!errorDetails && reactError) {
            errorDetails = {
                message: reactError.textContent.trim(),
                tool: 'React',
                stack: reactError.querySelector('.stack-trace')?.textContent || ''
            };
        }

        if (errorDetails) {
            sendToParent('buildError', errorDetails, 'critical');
            return true;
        }

        return false;
    }

    // ========================================
    // NETWORK MONITORING (unified)
    // ========================================
    
    const origFetch = window.fetch;
    window.fetch = async function (resource, init = {}) {
        const started = Date.now();
        const id = Math.random().toString(36).slice(2);
        const url = String(resource);

        let requestBody = "";
        if (init.body) {
            requestBody = serializeData(init.body);
        }

        // Add to rrweb session
        addCustomEvent("network", {
            id,
            phase: "start",
            api: "fetch",
            url,
            method: init.method || "GET",
            headers: init.headers || {},
            requestBody,
            timestamp: started,
        });

        try {
            const res = await origFetch.apply(this, arguments);
            const clone = res.clone();
            let responseText = "";
            let responseType = "text";

            try {
                const contentType = res.headers.get("content-type") || "";
                if (contentType.includes("application/json")) {
                    responseText = await clone.text();
                    responseType = "json";
                } else if (contentType.includes("text/")) {
                    responseText = await clone.text();
                    responseType = "text";
                } else if (
                    contentType.includes("image/") ||
                    contentType.includes("video/") ||
                    contentType.includes("audio/")
                ) {
                    responseText = `[${contentType} - ${res.headers.get("content-length") || "unknown"} bytes]`;
                    responseType = "binary";
                } else {
                    responseText = await clone.text();
                }
            } catch (err) {
                responseText = `[Error reading response: ${err.message}]`;
            }

            // Add to rrweb session
            addCustomEvent("network", {
                id,
                phase: "end",
                status: res.status,
                statusText: res.statusText,
                ok: res.ok,
                headers: Object.fromEntries(res.headers.entries()),
                responseBody: serializeData(responseText),
                responseType,
                duration: Date.now() - started,
                timestamp: Date.now(),
            });

            // Send error to parent if request failed
            if (!res.ok) {
                sendToParent('networkError', {
                    url: url,
                    status: res.status,
                    statusText: res.statusText,
                    responseBody: responseText.substring(0, 1000),
                    headers: Object.fromEntries(res.headers.entries()),
                    duration: Date.now() - started,
                    type: 'API Error'
                }, 'error');
            }

            return res;
        } catch (err) {
            // Add to rrweb session
            addCustomEvent("network", {
                id,
                phase: "error",
                error: err.message,
                stack: err.stack,
                duration: Date.now() - started,
                timestamp: Date.now(),
            });

            // Send to parent
            sendToParent('networkError', {
                url: url,
                message: err.message,
                stack: err.stack,
                type: 'Network Error',
                duration: Date.now() - started
            }, 'error');

            throw err;
        }
    };

    // XHR monitoring
    const X = window.XMLHttpRequest;
    window.XMLHttpRequest = function WrappedXHR() {
        const xhr = new X();
        const id = Math.random().toString(36).slice(2);
        let url = "", method = "GET", started = 0;
        let requestHeaders = {};
        let requestBody = "";

        const open = xhr.open;
        xhr.open = function (m, u) {
            method = m;
            url = u;
            return open.apply(xhr, arguments);
        };

        const setRequestHeader = xhr.setRequestHeader;
        xhr.setRequestHeader = function (header, value) {
            requestHeaders[header] = value;
            return setRequestHeader.apply(xhr, arguments);
        };

        const send = xhr.send;
        xhr.send = function (body) {
            started = Date.now();
            requestBody = serializeData(body);

            // Add to rrweb session
            addCustomEvent("network", {
                id,
                phase: "start",
                api: "xhr",
                url,
                method,
                headers: requestHeaders,
                requestBody,
                timestamp: started,
            });

            const handleResponse = () => {
                let responseBody = "";
                let responseType = "text";

                try {
                    if (
                        xhr.responseType === "json" ||
                        xhr.getResponseHeader("content-type")?.includes("application/json")
                    ) {
                        responseBody = xhr.responseText || xhr.response;
                        responseType = "json";
                    } else if (
                        xhr.responseType === "blob" ||
                        xhr.responseType === "arraybuffer"
                    ) {
                        responseBody = `[Binary response: ${xhr.response?.size || xhr.response?.byteLength || "unknown"} bytes]`;
                        responseType = "binary";
                    } else {
                        responseBody = xhr.responseText || String(xhr.response || "");
                    }
                } catch (e) {
                    responseBody = `[Error reading response: ${e.message}]`;
                }

                // Add to rrweb session
                addCustomEvent("network", {
                    id,
                    phase: "end",
                    status: xhr.status,
                    statusText: xhr.statusText,
                    ok: xhr.status >= 200 && xhr.status < 400,
                    responseHeaders: xhr.getAllResponseHeaders(),
                    responseBody: serializeData(responseBody),
                    responseType,
                    duration: Date.now() - started,
                    timestamp: Date.now(),
                });

                // Send to parent if error
                if (xhr.status >= 400) {
                    sendToParent('networkError', {
                        url: url,
                        method: method,
                        status: xhr.status,
                        statusText: xhr.statusText,
                        responseText: responseBody.substring(0, 1000),
                        type: 'XHR Error'
                    }, 'error');
                }
            };

            const handleError = () => {
                // Add to rrweb session
                addCustomEvent("network", {
                    id,
                    phase: "error",
                    error: "Network error",
                    duration: Date.now() - started,
                    timestamp: Date.now(),
                });

                // Send to parent
                sendToParent('networkError', {
                    url: url,
                    method: method,
                    type: 'XHR Error',
                    message: 'Request failed'
                }, 'error');
            };

            xhr.addEventListener("load", handleResponse);
            xhr.addEventListener("loadend", handleResponse);
            xhr.addEventListener("error", handleError);
            xhr.addEventListener("abort", handleError);
            xhr.addEventListener("timeout", handleError);

            return send.apply(xhr, arguments);
        };
        return xhr;
    };

    // ========================================
    // NAVIGATION TRACKING
    // ========================================
    
    const push = history.pushState, replace = history.replaceState;
    const emitNav = () => addCustomEvent("nav", { href: location.href, t: Date.now() });
    
    history.pushState = function () {
        const r = push.apply(this, arguments);
        emitNav();
        return r;
    };
    
    history.replaceState = function () {
        const r = replace.apply(this, arguments);
        emitNav();
        return r;
    };
    
    window.addEventListener("popstate", emitNav);
    window.addEventListener("hashchange", emitNav);

    // ========================================
    // WINDOW LIFECYCLE
    // ========================================
    
    window.addEventListener('pagehide', (event) => {
        if (!event.persisted) {
            if (window.opener && !window.opener.closed) {
                try {
                    window.opener.postMessage({ 
                        type: 'window_closing',
                        url: location.href,
                        timestamp: Date.now()
                    }, '*');
                } catch (e) {
                    console.error('Failed to send window_closing message:', e);
                }
            }
        }
    });

    // ========================================
    // PUBLIC API
    // ========================================
    
    window.__rr = {
        stop: () => stopRecording && stopRecording(),
        dump: () => session.slice(),
        download: () => {
            const blob = new Blob([JSON.stringify(session, null, 2)], {
                type: "application/json",
            });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `rrweb-session-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
        getNetworkEvents: () => {
            return session.filter(
                (event) =>
                    event.type === 5 &&
                    event.data.tag === "network",
            );
        },
    };

    // ========================================
    // TEST MODE UI
    // ========================================
    
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get("testmode") === "1" || urlParams.get("debug") === "1") {
        sessionStorage.setItem("rrweb_testmode", "true");
    }

    function loadCustomFont() {
        const style = document.createElement('style');
        style.textContent = `
            @font-face {
                font-family: 'NDOT 47';
                src: url('https://d2adkz2s9zrlge.cloudfront.net/ndot-47-inspired-by-nothing.otf') format('opentype');
                font-weight: 400;
                font-style: normal;
                font-display: swap;
            }
        `;
        document.head.appendChild(style);
    }

    if (sessionStorage.getItem("rrweb_testmode") === "true") {
        loadCustomFont();

        function createTestModeUI() {
            if (!document.body) {
                setTimeout(createTestModeUI, 100);
                return;
            }

            const hud = document.createElement("div");
            hud.style.cssText =
                "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);background:#111;color:#fff;padding:8px 16px;border-radius:8px;z-index:999999;display:flex;align-items:center;justify-content:space-between;min-width:200px";
            
            const startTime = Date.now();
            const timeDisplay = document.createElement("span");
            timeDisplay.style.cssText = "color:#FFF;font-family:'NDOT 47', 'Courier New', monospace;font-size:16px;font-style:normal;font-weight:400;line-height:20px;letter-spacing:-0.32px;opacity:0.7";
            
            const updateTimer = () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const secs = (elapsed % 60).toString().padStart(2, '0');
                timeDisplay.textContent = `${mins}:${secs}`;
            };
            updateTimer();
            const timerInterval = setInterval(updateTimer, 1000);
            
            hud.innerHTML = `
                <div style="cursor:pointer" id="record-indicator">
                    <svg width="37" height="36" viewBox="0 0 37 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="0.5" width="36" height="36" rx="18" fill="#2EE572" fill-opacity="0.1"/>
                        <circle opacity="0.2" cx="18.5004" cy="18.0004" r="9.6" fill="#2EE572"/>
                        <circle cx="18.5004" cy="18.0004" r="3" stroke="#2EE572" stroke-width="1.2"/>
                        <circle cx="18.4992" cy="17.9992" r="4.8" fill="#2EE572"/>
                    </svg>
                </div>
                <div style="width:1px;height:12px;background:#FFF;opacity:0.3"></div>
                <span></span>
                <div style="width:1px;height:12px;background:#FFF;opacity:0.3"></div>
                <div style="cursor:pointer" id="stop-btn">
                    <svg width="37" height="36" viewBox="0 0 37 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="0.5" width="36" height="36" rx="12" fill="#FF6A4D"/>
                        <path d="M10.166 17.9993C10.166 14.071 10.166 12.1068 11.386 10.886C12.6077 9.66602 14.571 9.66602 18.4993 9.66602C22.4277 9.66602 24.3918 9.66602 25.6118 10.886C26.8327 12.1077 26.8327 14.071 26.8327 17.9993C26.8327 21.9277 26.8327 23.8918 25.6118 25.1118C24.3927 26.3327 22.4277 26.3327 18.4993 26.3327C14.571 26.3327 12.6068 26.3327 11.386 25.1118C10.166 23.8927 10.166 21.9277 10.166 17.9993Z" fill="white"/>
                    </svg>
                </div>
            `;
            
            hud.children[2].replaceWith(timeDisplay);
            document.body.appendChild(hud);

            hud.querySelector("#stop-btn").onclick = () => {
                clearInterval(timerInterval);
                if (stopRecording) stopRecording();
                window.opener?.postMessage(
                    {
                        type: "rrweb_events",
                        data: JSON.stringify(session),
                    },
                    "*",
                );
                hud.remove();
            };
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createTestModeUI);
        } else {
            createTestModeUI();
        }
    }

    // ========================================
    // INITIALIZATION
    // ========================================
    
    // Check for build errors on load
    window.addEventListener('load', () => {
        setTimeout(() => {
            const hasError = detectBuildError();
            if (!hasError) {
                sendToParent('ready', { 
                    url: window.location.href,
                    userAgent: navigator.userAgent,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight
                    }
                }, 'info');
            }
        }, 100);
    });

    // Periodically check for build errors (for HMR)
    let lastErrorCheck = '';
    setInterval(() => {
        const currentBodyText = document.body?.textContent || '';
        if (currentBodyText !== lastErrorCheck) {
            detectBuildError();
            lastErrorCheck = currentBodyText;
        }
    }, 2000);

    // Initial check
    setTimeout(detectBuildError, 100);
})();
