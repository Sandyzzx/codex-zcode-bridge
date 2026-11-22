import { runExecutorMain } from "../../src/executor/main.js";

void runExecutorMain(process.argv.slice(2), { testOnly: true });
