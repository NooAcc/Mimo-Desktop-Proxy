// Shared SSE framing for live upstream responses and captured fixtures.
export class SSEProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "SSEProtocolError";
  }
}

export async function* readSSE(body, { maxEventBytes = Number.POSITIVE_INFINITY } = {}) {
  if (!body || typeof body.getReader !== "function") {
    throw new SSEProtocolError("Upstream response has no readable body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data = [];
  let event = "message";
  let id;
  let eventBytes = 0;
  let eof = false;

  function consumeLine(line) {
    if (line === "") {
      const result = data.length ? { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) } : null;
      data = [];
      event = "message";
      eventBytes = 0;
      return result;
    }
    eventBytes += Buffer.byteLength(line, "utf8") + 1;
    if (eventBytes > maxEventBytes) throw new SSEProtocolError("Upstream SSE event is too large");
    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value || "message";
    else if (field === "id" && !value.includes("\0")) id = value;
    return null;
  }

  try {
    while (!eof) {
      const chunk = await reader.read();
      eof = chunk.done;
      try {
        buffer += eof ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new SSEProtocolError("Upstream SSE contains invalid UTF-8");
      }

      while (true) {
        const lineEnd = buffer.search(/[\r\n]/);
        if (lineEnd < 0) break;
        // A CR at a chunk boundary may be the first byte of CRLF.
        if (!eof && buffer[lineEnd] === "\r" && lineEnd === buffer.length - 1) break;
        const width = buffer[lineEnd] === "\r" && buffer[lineEnd + 1] === "\n" ? 2 : 1;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + width);
        const parsed = consumeLine(line);
        if (parsed) yield parsed;
      }

      if (eventBytes + Buffer.byteLength(buffer, "utf8") > maxEventBytes) {
        throw new SSEProtocolError("Upstream SSE event is too large");
      }
    }

    // An incomplete event cannot safely be treated as a successful completion.
    if (data.length || (buffer && !buffer.startsWith(":"))) {
      throw new SSEProtocolError("Upstream SSE ended in an incomplete event");
    }
  } finally {
    if (!eof) {
      try { await reader.cancel(); } catch {}
    }
    reader.releaseLock();
  }
}
