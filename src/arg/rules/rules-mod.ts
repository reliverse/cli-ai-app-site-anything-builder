import { ensuredir } from "@reliverse/fs";
import { defineCommand } from "@reliverse/prompts";
import os from "os";
import path from "pathe";

import { showRulesMenu } from "./rules-impl.js";

export default defineCommand({
  meta: {
    name: "rules",
    description: "Download and manage AI IDE rules",
  },
  args: {
    dev: {
      type: "boolean",
      description: "Run in development mode",
    },
  },
  run: async ({ args }) => {
    const isDev = !!args.dev;
    const homeDir = os.homedir();
    const rulesBaseDir = path.join(homeDir, ".reliverse", "rules");

    // Create the base rules directory if it doesn't exist
    await ensuredir(rulesBaseDir);

    // Run the rules menu
    await showRulesMenu({
      cwd: process.cwd(),
      isDev,
    });
  },
});
