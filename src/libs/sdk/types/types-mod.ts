import type { ReliverseConfig } from "~/libs/cfg/constants/cfg-types.js";
import type { ReliverseMemory } from "~/libs/sdk/utils/schemaMemory.js";

export type AppParams = {
  projectName: string;
  cwd: string;
  isDev: boolean;
  memory: ReliverseMemory;
  config: ReliverseConfig;
  multireli: ReliverseConfig[];
  skipPrompts: boolean;
};

export type ParamsOmitSkipPN = Omit<AppParams, "skipPrompts" | "projectName">;
export type ParamsOmitReli = Omit<AppParams, "multireli">;

/**
 * Minimal object describing essential project info after initialization
 */
export type ProjectConfigReturn = {
  frontendUsername: string;
  projectName: string;
  primaryDomain: string;
};

export type GitModParams = {
  cwd: string;
  isDev: boolean;
  projectPath: string;
  projectName: string;
};
