// TEST-ONLY client for isolated-bridge-broker.mjs.
import net from "node:net";
import { readFile } from "node:fs/promises";

const [command, ...args] = process.argv.slice(2);
if (command === "health") {
  await request({ command: "health" });
} else if (command === "call") {
  const [tool, argsFile] = args;
  if (!tool || !argsFile) throw new Error("usage: isolated-bridge-client.mjs call <tool> <args.json>");
  const toolArguments = JSON.parse(await readFile(argsFile, "utf8"));
  await request({ command: "call", tool, arguments: toolArguments });
} else if (command === "close") {
  await request({ command: "close" });
} else {
  throw new Error("usage: isolated-bridge-client.mjs health|call|close --pipe <pipe>");
}

async function request(payload) {
  const pipeIndex = args.indexOf("--pipe");
  const pipe = pipeIndex >= 0 ? args[pipeIndex + 1] : null;
  if (!pipe) throw new Error("--pipe is required");

  const response = await new Promise((resolve, reject) => {
    let buffer = "";
    const socket = net.createConnection(pipe);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        resolve(buffer.slice(0, newline));
      }
    });
    socket.on("error", reject);
  });
  process.stdout.write(`${response}\n`);
}
