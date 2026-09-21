import { createConnection } from "node:net";

const TOOL_SOCKET_PATH = "/run/wardby/tool/runner.sock";
const socket = createConnection(TOOL_SOCKET_PATH);

socket.once("error", () => process.exit(1));
socket.once("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once("close", () => process.exit());
