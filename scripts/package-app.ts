import { name, version } from "../package.json";
import zip from "bestzip";
import { exists, mkdir, rmdir } from "node:fs/promises";

const destinationDirectory = ".build/bundle";
console.info("Cleaning up...");
if (await exists(destinationDirectory)) {
  //@ts-expect-error node type issues
  await rmdir(destinationDirectory, { force: true, recursive: true });
}
console.info("Done!");
await mkdir(destinationDirectory);

console.info("Zipping app...");
const appName = `${name}-v${version}`;
await zip({
  cwd: ".build",
  source: ["caps-api", "caps-worker", "caps-scheduler"],
  destination: `bundle/${appName}.zip`,
});
console.info("Done!");
