export async function connectInspector(port = 9222) {
  if (typeof WebSocket !== "function") throw new Error("Capture requires Node.js 22 or newer");
  const response = await fetch("http://127.0.0.1:" + port + "/json/list", {signal: AbortSignal.timeout(3000)});
  const targets = await response.json();
  const target = targets.find(item => item.type === "node");
  if (!target) throw new Error("A main-process inspector is required: start MiMo with --inspect=127.0.0.1:" + port);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const call of pending.values()) {clearTimeout(call.timer); call.reject(new Error("Inspector disconnected"));}
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Inspector connection timed out")), 5000);
    socket.addEventListener("open", () => {clearTimeout(timer); resolve();}, {once: true});
    socket.addEventListener("error", () => {clearTimeout(timer); reject(new Error("Inspector connection failed"));}, {once: true});
  });
  return {
    async evaluate(expression, timeoutMs = 15000) {
      const id = ++sequence;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {pending.delete(id); reject(new Error("Inspector evaluation timed out"));}, timeoutMs);
        pending.set(id, {resolve, reject, timer});
        socket.send(JSON.stringify({id, method: "Runtime.evaluate", params: {
          expression, awaitPromise: true, returnByValue: true
        }}));
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Inspector evaluation failed");
      }
      return result.result?.value;
    },
    close() {socket.close();}
  };
}
