import { defineCommand } from "@reliverse/prompts";

import { relinka } from "~/utils/console.js";

export default defineCommand({
  meta: {
    name: "help",
    description: "Displays the help message",
    hidden: true,
  },
  args: {
    dev: {
      type: "boolean",
      description: "Displays the help message for the dev command",
    },
  },
  run: async ({ args }) => {
    if (args.dev) {
      relinka("info", "Use `bun dev --help` instead.");
    } else {
      relinka("info", "Use `reliverse --help` instead.");
    }
    process.exit(0);
  },
});
