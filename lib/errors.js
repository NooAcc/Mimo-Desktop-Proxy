export class ProxyError extends Error {
  constructor(status, type, message, param, code) {
    super(message);
    this.name = "ProxyError";
    this.status = status;
    this.type = type;
    if (param !== undefined) this.param = param;
    if (code !== undefined) this.code = code;
  }
}
