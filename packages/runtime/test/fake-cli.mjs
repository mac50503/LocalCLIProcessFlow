// Fake CLI used by tests. The mode comes from the FAKE_MODE env var passed via the first argument.
import { spawn } from "node:child_process";

const mode = process.argv[2];
const args = process.argv.slice(3);

if (args.includes("--version")) {
  console.log("fake 1.0.0");
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  const envelope = (obj) => console.log(JSON.stringify({ is_error: false, ...obj }));
  switch (mode) {
    case "structured":
      return envelope({ structured_output: { ok: true, echoArgs: args, stdinLength: stdin.length, stdin } });
    case "result-string":
      return envelope({ result: JSON.stringify({ ok: true }) });
    case "result-garbage":
      return envelope({ result: "not json at all" });
    case "no-fields":
      return envelope({});
    case "is-error":
      return console.log(JSON.stringify({ is_error: true, subtype: "error_max_turns" }));
    case "not-json":
      return console.log("hello, I am not json");
    case "exit1":
      console.error("boom: something broke");
      return process.exit(1);
    case "env":
      return envelope({ structured_output: { hasSecret: "LCPF_SECRET" in process.env, hasPath: "PATH" in process.env || "Path" in process.env } });
    case "huge":
      return console.log("x".repeat(2_000_000));
    case "hang":
      return setInterval(() => undefined, 1000);
    default:
      if (mode.startsWith("tree:")) {
        // Starts a grandchild that writes a marker file after a delay. If the tree is killed, the file never appears.
        const marker = mode.slice(5);
        const child = spawn(process.execPath, ["-e", `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"alive"),1500)`], { stdio: "ignore" });
        child.unref();
        return setInterval(() => undefined, 1000);
      }
      process.exit(2);
  }
});
