import { randomInt } from "node:crypto";
import { once } from "node:events";

// Fetch forbids some ports up to 10080; customized ephemeral ranges can include them.
export async function listenForFetch(server) {
  for (let attempt = 0; attempt < 32; attempt++) {
    server.listen(randomInt(16384, 65536), "127.0.0.1");
    try {
      await once(server, "listening");
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    }
  }
  throw new Error("Cannot allocate an available local HTTP test port");
}
