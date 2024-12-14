import {
  confirmPrompt,
  selectPrompt,
  task,
  inputPrompt,
} from "@reliverse/prompts";
import { multiselectPrompt, nextStepsPrompt } from "@reliverse/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import { installDependencies } from "nypm";
import { Octokit } from "octokit";
import open from "open";
import os from "os";
import path from "pathe";
import { simpleGit } from "simple-git";

import { FILE_PATHS } from "~/app/data/constants.js";
import {
  readReliverseMemory,
  updateReliverseMemory,
} from "~/args/memory/impl.js";
import {
  CHECKPOINT_STEPS,
  type CheckpointStep,
  clearCheckpoint,
  getPreviousStep,
  isValidCheckpointStep,
  readCheckpoint,
  saveCheckpoint,
} from "~/utils/checkpoint.js";
import { relinka } from "~/utils/console.js";
import { downloadGitRepo } from "~/utils/downloadGitRepo.js";
import { downloadI18nFiles } from "~/utils/downloadI18nFiles.js";
import { extractRepoInfo } from "~/utils/extractRepoInfo.js";
import { getCurrentWorkingDirectory } from "~/utils/fs.js";
import { initializeGitRepository } from "~/utils/git.js";
import { i18nMove } from "~/utils/i18nMove.js";
import { isVSCodeInstalled } from "~/utils/isAppInstalled.js";
import { replaceStringsInFiles } from "~/utils/replaceStringsInFiles.js";

import { askAppDomain } from "./askAppDomain.js";
import { askAppName } from "./askAppName.js";
import { askCheckAndDownloadFiles } from "./askCheckAndDownloadFiles.js";
import { askGithubName } from "./askGithubName.js";
import { askUserName } from "./askUserName.js";
import { askVercelName } from "./askVercelName.js";
import { composeEnvFile } from "./composeEnvFile.js";

async function checkScriptExists(
  targetDir: string,
  scriptName: string,
): Promise<boolean> {
  try {
    const packageJsonPath = path.join(targetDir, "package.json");
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      return !!packageJson.scripts?.[scriptName];
    }
    return false;
  } catch (error: unknown) {
    relinka(
      "error",
      `Error checking for script ${scriptName}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function handleGitHubOperations(
  octokit: Octokit,
  githubUsername: string,
  repoName: string,
  targetDir: string,
): Promise<boolean> {
  try {
    // First check if repo exists
    try {
      await octokit.rest.repos.get({
        owner: githubUsername,
        repo: repoName,
      });
      relinka(
        "info",
        `Repository ${githubUsername}/${repoName} already exists.`,
      );
    } catch (error: any) {
      if (error?.status === 404) {
        // Create the repository if it doesn't exist
        await octokit.rest.repos.createForAuthenticatedUser({
          name: repoName,
          description: `Created with @reliverse/cli - ${new Date().toISOString()}`,
          private: false,
          auto_init: false,
          has_issues: true,
          has_projects: true,
          has_wiki: true,
        });
        relinka(
          "success",
          `Repository ${githubUsername}/${repoName} created successfully!`,
        );
      } else {
        relinka(
          "error",
          "Failed to check repository existence:",
          error?.message || String(error),
        );
        throw error;
      }
    }

    // Initialize git repository
    await initializeGitRepository(targetDir, "initializeNewGitRepository");
    const git = simpleGit({ baseDir: targetDir });

    // Add remote
    const remoteUrl = `https://github.com/${githubUsername}/${repoName}.git`;
    const remotes = await git.getRemotes();

    if (!remotes.find((remote) => remote.name === "origin")) {
      await git.addRemote("origin", remoteUrl);
      relinka("success", "Remote 'origin' added successfully.");
    } else {
      relinka("info", "Remote 'origin' already exists.");
    }

    return true;
  } catch (error: any) {
    relinka(
      "error",
      "GitHub operation failed:",
      error?.message || String(error),
    );
    return false;
  }
}

export async function createWebProject({
  template,
  message,
  allowI18nPrompt,
  isDev,
  checkpointName,
}: {
  template: string;
  message: string;
  mode: "buildBrandNewThing" | "installAnyGitRepo";
  allowI18nPrompt: boolean;
  isDev: boolean;
  checkpointName?: string;
}) {
  relinka("info", message);

  // Track deployment state from memory
  const memory = await readReliverseMemory();
  let currentStep: CheckpointStep = CHECKPOINT_STEPS.NOT_STARTED;

  // If checkpoint exists, try to restore state
  if (checkpointName) {
    const checkpoint = await readCheckpoint(checkpointName, isDev);
    if (checkpoint && isValidCheckpointStep(checkpoint.step)) {
      relinka("info", `Resuming project from checkpoint: ${checkpoint.step}`);
      currentStep = checkpoint.step;

      // If we're resuming from a failed state, start from the previous successful step
      if (currentStep === CHECKPOINT_STEPS.FAILED) {
        currentStep = getPreviousStep(currentStep);
      }
    }
  }

  // let defaultShouldDeploy = true;
  // if (isDev) {
  //   defaultShouldDeploy = false;
  // }
  let shouldDeploy = false;

  try {
    shouldDeploy = await confirmPrompt({
      title: "Do you plan to deploy this project right after creation?",
      defaultValue: false,
    });

    // Store shouldDeploy in memory
    await updateReliverseMemory({
      user: {
        ...memory.user,
        shouldDeploy,
      },
    });

    // Get usernames based on deployment plan
    const username = await askUserName();
    let githubUsername = "";
    let vercelTeamName = "";
    let deployService = "";

    if (shouldDeploy) {
      deployService = await selectPrompt({
        title: "Which deployment service do you want to use?",
        content:
          "You can deploy anywhere. This allows me to prepare the necessary tools for deployment.",
        options: [
          { label: "Vercel", value: "Vercel" },
          {
            label: "...",
            value: "coming-soon",
            hint: "coming soon",
            disabled: true,
          },
        ],
      });

      githubUsername = await askGithubName();
      vercelTeamName = await askVercelName();

      // Store GitHub and Vercel usernames in memory
      await updateReliverseMemory({
        user: {
          ...memory.user,
          name: username,
          githubName: githubUsername,
          vercelName: vercelTeamName,
        },
      });
    }

    const appName = await askAppName();

    // Save initial checkpoint
    if (!checkpointName) {
      checkpointName = appName;
    }

    currentStep = CHECKPOINT_STEPS.INITIAL_SETUP;
    await saveCheckpoint(
      checkpointName,
      {
        step: currentStep,
        data: {
          appName,
        },
      },
      isDev,
    );

    const domain = await askAppDomain(appName);
    let targetDir: string | undefined;

    relinka("info", `Now I'm downloading the ${template} template...`);

    await task({
      spinnerSolution: "ora",
      initialMessage: "Downloading template...",
      successMessage: "✅ Template downloaded successfully!",
      errorMessage: "❌ Failed to download template...",
      async action(updateMessage) {
        targetDir = await downloadGitRepo(appName, template, isDev);
        updateMessage("Some magic is happening... This may take a while...");
      },
    });

    await task({
      spinnerSolution: "ora",
      initialMessage: "Editing some texts in the initialized files...",
      successMessage:
        "✅ I edited some texts in the initialized files for you.",
      errorMessage:
        "❌ I've failed to edit some texts in the initialized files...",
      async action(updateMessage) {
        const { author, projectName: oldProjectName } =
          extractRepoInfo(template);
        updateMessage("Some magic is happening... This may take a while...");
        await replaceStringsInFiles(targetDir, {
          [`${oldProjectName}.com`]: domain,
          [author]: username,
          [oldProjectName]: appName,
          ["relivator.com"]: domain,
        });
      },
    });

    if (allowI18nPrompt) {
      const i18nShouldBeEnabled = await confirmPrompt({
        title:
          "Do you want to enable i18n (internationalization) for this project?",
        content: "Option `N` here may not work currently. Please be patient.",
      });

      const i18nFolderExists = await fs.pathExists(
        path.join(targetDir, "src/app/[locale]"),
      );

      if (i18nFolderExists) {
        relinka(
          "info-verbose",
          "i18n is already enabled for this project. Skipping...",
        );
      }

      if (i18nShouldBeEnabled && !i18nFolderExists) {
        await task({
          spinnerSolution: "ora",
          initialMessage: "Moving app to locale...",
          successMessage: "✅ I moved app to locale successfully!",
          errorMessage: "❌ I've failed to move app to locale...",
          async action(updateMessage) {
            try {
              await i18nMove(targetDir, "moveLocaleToApp");
              updateMessage(
                "Some magic is happening... This may take a while...",
              );
              await downloadI18nFiles(targetDir, isDev);
            } catch (error) {
              relinka("error", "Error during i18n move:", error.toString());
              throw error;
            }
          },
        });
      }

      if (!i18nShouldBeEnabled && i18nFolderExists) {
        relinka(
          "info",
          "Just a moment...",
          "I'm trying to convert initialized project from i18n version to non-i18n...",
        );
        await task({
          spinnerSolution: "ora",
          initialMessage: "Moving app to locale...",
          successMessage: "✅ I moved app to locale successfully!",
          errorMessage: "❌ I've failed to move app to locale...",
          async action(updateMessage) {
            await i18nMove(targetDir, "moveLocaleToApp");
            updateMessage(
              "Some magic is happening... This may take a while...",
            );
            await downloadI18nFiles(targetDir, isDev);
          },
        });
      }
    }

    await askCheckAndDownloadFiles(targetDir, appName);

    const cwd = getCurrentWorkingDirectory();

    // const { pmName } = await getPackageManager(cwd);
    // let pm = pmName;
    // if (await isBunInstalled()) {
    //   pm = "bun";
    // }

    // const gitOption = await askGitInitialization();
    const vscodeInstalled = isVSCodeInstalled();

    const tempGitURL =
      "https://raw.githubusercontent.com/blefnk/relivator/main/.env.example";
    await composeEnvFile(targetDir, tempGitURL);

    let shouldInstallByDefault = true;
    if (isDev) {
      shouldInstallByDefault = false;
    }
    const shouldInstallDependencies = await confirmPrompt({
      title: "Do you want me to install dependencies? (it may take some time)",
      titleColor: "retroGradient",
      defaultValue: shouldInstallByDefault,
    });

    if (!shouldInstallDependencies) {
      relinka("info", "You can always install dependencies manually later.");
    } else {
      await installDependencies({
        cwd: targetDir,
      });

      // deprecated
      /* Ask user if they want to install dependencies
      const installDeps = await confirmPrompt({
        title: "Would you like to install dependencies now?",
        defaultValue: true,
      });

      if (installDeps) {
        // Detect package manager and install dependencies
        const hasYarn = await fs.pathExists(path.join(targetDir, "yarn.lock"));
        const hasPnpm = await fs.pathExists(
          path.join(targetDir, "pnpm-lock.yaml"),
        );
        const hasBun = await fs.pathExists(path.join(targetDir, "bun.lockb"));

        const installCmd = hasBun
          ? "bun install"
          : hasPnpm
            ? "pnpm install"
            : hasYarn
              ? "yarn"
              : "npm install";

        await execa(installCmd.split(" ")[0], installCmd.split(" ").slice(1), {
          cwd: targetDir,
        });
        relinka("success-verbose", "Dependencies installed successfully");
      } */
    }

    if (!isDev && shouldInstallDependencies) {
      const hasDbPush = await checkScriptExists(targetDir, "db:push");
      const hasDbSeed = await checkScriptExists(targetDir, "db:seed");
      const hasCheck = await checkScriptExists(targetDir, "check");

      if (hasDbPush) {
        const shouldRunDbPush = await confirmPrompt({
          title: "Do you want to run `bun db:push`?",
          defaultValue: true,
        });
        if (shouldRunDbPush) {
          try {
            await execa("bun", ["db:push"], {
              cwd: targetDir,
              stdio: "inherit",
            });
          } catch (error) {
            relinka("error", "Error running `bun db:push`:", error.toString());
          }
        }
      }

      if (hasDbSeed) {
        const shouldRunDbSeed = await confirmPrompt({
          title: "Do you want to run `bun db:seed`?",
          defaultValue: true,
        });
        if (shouldRunDbSeed) {
          try {
            await execa("bun", ["db:seed"], {
              cwd: targetDir,
              stdio: "inherit",
            });
          } catch (error) {
            relinka("error", "Error running `bun db:seed`:", error.toString());
          }
        }
      }

      if (hasCheck) {
        const shouldRunCheck = await confirmPrompt({
          title: "Do you want to run `bun check`?",
          defaultValue: true,
        });
        if (shouldRunCheck) {
          try {
            await execa("bun", ["check"], {
              cwd: targetDir,
              stdio: "inherit",
            });
          } catch (error) {
            relinka("error", "Error running `bun check`:", error.toString());
          }
        }
      }
    } else {
      const scripts = [];
      if (await checkScriptExists(targetDir, "db:push")) {
        scripts.push("`bun db:push`");
      }
      if (await checkScriptExists(targetDir, "db:seed")) {
        scripts.push("`bun db:seed`");
      }
      if (await checkScriptExists(targetDir, "check")) {
        scripts.push("`bun check`");
      }

      if (scripts.length > 0) {
        relinka(
          "info",
          `Please run \`bun i\`, ${scripts.join(", ")} manually.`,
          "It's recommended to do it before starting the project at the first time.",
        );
      } else {
        relinka(
          "info",
          "Please run `bun i` manually.",
          "It's recommended to do it before starting the project at the first time.",
        );
      }
    }

    if (shouldDeploy) {
      relinka(
        "info",
        "To make deploy, let's create a GitHub repository first...",
      );

      let octokit: Octokit | null = null;

      // Initialize Octokit with token if available
      if (memory.githubKey) {
        octokit = new Octokit({
          auth: memory.githubKey,
        });
      } else {
        // Get token from user
        const token = await inputPrompt({
          title: "Please enter your GitHub personal access token:",
          content:
            "Create one at https://github.com/settings/tokens/new \nSet checkmark to `repo` scope and click `Generate token`",
          validate: (value: string): string | void => {
            if (!value?.trim()) {
              return "Token is required";
            }
          },
        });

        octokit = new Octokit({
          auth: token,
        });

        // Save token to memory
        await updateReliverseMemory({
          githubKey: token,
        });
      }

      // Handle repository setup
      let repoName = appName;
      let success = false;

      do {
        success = await handleGitHubOperations(
          octokit,
          githubUsername,
          repoName,
          targetDir,
        );

        if (!success) {
          repoName = await inputPrompt({
            title: "Please enter a different repository name:",
            defaultValue: `${repoName}-1`,
            validate: (value: string): string | void => {
              if (!value?.trim()) {
                return "Repository name is required";
              }
              if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
                return "Invalid repository name. Use only letters, numbers, hyphens, and underscores";
              }
            },
          });
        }
      } while (!success);

      // Handle pushing to remote
      const shouldPushCommit = await confirmPrompt({
        title: "Are you ready to push the commit?",
        content: "`N` will skip pushing and deploying.",
        defaultValue: true,
      });

      if (shouldPushCommit) {
        try {
          relinka("info", "Pushing to remote repository...");
          const git = simpleGit({ baseDir: targetDir });

          // Set up the upstream tracking and push
          await git.push("origin", "main", ["--set-upstream"]);

          relinka("success", "Successfully pushed to remote repository!");
        } catch (pushError) {
          relinka(
            "error",
            "Failed to push to repository:",
            pushError instanceof Error ? pushError.message : String(pushError),
          );
          return;
        }
      } else {
        relinka("info", "Okay... Skipping commit push and deployment...");
      }

      if (shouldPushCommit && deployService === "Vercel") {
        relinka("info", "Checking for Vercel authentication...");

        // First try to get token from memory
        let memory = await readReliverseMemory();
        let vercelToken = memory.vercelKey;

        // Check for both null and undefined cases explicitly
        if (vercelToken === null || vercelToken === undefined) {
          relinka("info", "Opening Vercel tokens page in your browser...");

          vercelToken = await inputPrompt({
            title: "Please create and paste your Vercel token:",
            content: "Visit 👉 https://vercel.com/account/tokens",
            hint: "🔐 It will be saved securely on your machine.",
            contentColor: "yellowBright",
            validate: (value: string): string | void => {
              if (!value?.trim()) {
                return "Token is required";
              }
            },
          });

          // Save token to memory
          await updateReliverseMemory({
            vercelKey: vercelToken,
          });

          // Verify token was saved
          memory = await readReliverseMemory();
          if (memory.vercelKey === null || memory.vercelKey === undefined) {
            relinka("error", "Failed to save Vercel token to memory.");
            return;
          }

          relinka("success", "Vercel token saved successfully!");
        }

        try {
          const { Vercel } = await import("@vercel/sdk");
          const vercel = new Vercel({
            bearerToken: vercelToken,
          });

          // Create project first
          try {
            await vercel.projects.createProject({
              requestBody: {
                name: appName,
                framework: "nextjs",
                gitRepository: {
                  type: "github",
                  repo: `${githubUsername}/${appName}`,
                },
              },
              teamId: vercelTeamName || undefined,
            });
            relinka("success", "Project created on Vercel successfully!");
          } catch (projectError: any) {
            if (projectError?.response?.status === 409) {
              relinka(
                "info",
                "Project already exists on Vercel, continuing...",
              );
            } else {
              throw projectError;
            }
          }

          // Now set up environment variables
          try {
            const envVars = [];

            // Always add NEXT_PUBLIC_APP_URL
            envVars.push({
              key: "NEXT_PUBLIC_APP_URL",
              value: domain
                ? `https://${domain}`
                : `https://${appName}.vercel.app`,
              target: ["production", "preview", "development"],
              type: "plain",
            });

            // Check if .env file exists and read variables from it
            const envFilePath = path.join(targetDir, ".env");
            if (await fs.pathExists(envFilePath)) {
              const envContent = await fs.readFile(envFilePath, "utf-8");
              const envLines = envContent.split("\n");

              for (const line of envLines) {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.startsWith("#")) {
                  const [key, ...valueParts] = trimmedLine.split("=");
                  const value = valueParts.join("=").trim();
                  if (key && value) {
                    envVars.push({
                      key: key.trim(),
                      value: value.replace(/["']/g, ""), // Remove quotes if present
                      target: ["production", "preview", "development"],
                      type: "encrypted", // Use encrypted type for .env variables
                    });
                  }
                }
              }
            }

            if (envVars.length > 0) {
              // Add environment variables to the project
              await vercel.projects.createProjectEnv({
                idOrName: appName,
                upsert: "true",
                requestBody: envVars,
              });

              relinka("success", "Environment variables set up successfully!");
            }
          } catch (envError) {
            relinka(
              "error",
              "Error setting up environment variables:",
              envError instanceof Error ? envError.message : String(envError),
            );
          }

          // Finally, create the deployment
          const createResponse = await vercel.deployments.createDeployment({
            requestBody: {
              name: appName,
              target: "production",
              gitSource: {
                type: "github",
                repo: appName,
                ref: "main",
                org: githubUsername,
              },
              projectSettings: {
                framework: "nextjs",
                buildCommand: "next build",
                outputDirectory: ".next",
                installCommand: "bun install",
                devCommand: "next dev",
                rootDirectory: null,
              },
            },
          });

          relinka(
            "info",
            `Deployment created: ID ${createResponse.id} and status ${createResponse.status}`,
          );

          relinka(
            "info",
            `You can visit 👉 https://vercel.com 👉 ${appName} 👉 Deployments, to see the deployment process.`,
          );

          // Check deployment status
          let deploymentStatus;
          let deploymentURL;

          await task({
            spinnerSolution: "ora",
            initialMessage: "Checking deployment status...",
            successMessage: "✅ Deployment status check complete",
            errorMessage: "❌ Failed to check deployment status",
            async action(updateMessage) {
              do {
                await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds between checks

                const statusResponse = await vercel.deployments.getDeployment({
                  idOrUrl: createResponse.id,
                  withGitRepoInfo: "true",
                });

                deploymentStatus = statusResponse.status;
                deploymentURL = statusResponse.url;
                updateMessage(`Deployment status: ${deploymentStatus}`);
              } while (
                deploymentStatus === "BUILDING" ||
                deploymentStatus === "INITIALIZING"
              );
            },
          });

          if (deploymentStatus === "READY") {
            relinka("success", `Deployment successful. URL: ${deploymentURL}`);

            // Set up domain if provided and it's not a .vercel.app domain
            if (domain && !domain.endsWith(".vercel.app")) {
              try {
                const addDomainResponse =
                  await vercel.projects.addProjectDomain({
                    idOrName: appName,
                    requestBody: {
                      name: domain,
                    },
                  });

                relinka("success", `Domain added: ${addDomainResponse.name}`);
              } catch (error) {
                relinka(
                  "error",
                  "Error setting up domain:",
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          } else {
            relinka("error", "Deployment failed or was canceled");
          }
        } catch (error) {
          if (error instanceof Error && error.message?.includes("403")) {
            relinka(
              "error",
              "Authentication failed. Your token might be invalid or expired.",
              "Please create a new token at https://vercel.com/account/tokens",
            );
            // Remove invalid token from memory
            await updateReliverseMemory({
              githubKey: null,
              vercelKey: null,
            });
          } else {
            relinka(
              "error",
              "Error during deployment:",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
    }

    const shouldRemoveTemp = true;
    if (shouldRemoveTemp) {
      // TODO: maybe we should reimplement this in a better way
      const tempRepoDir = isDev
        ? path.join(cwd, "tests-runtime", FILE_PATHS.tempRepoClone)
        : path.join(
            os.homedir(),
            ".reliverse",
            "checkpoints",
            FILE_PATHS.tempRepoClone,
          );

      if (await fs.pathExists(tempRepoDir)) {
        await fs.remove(tempRepoDir);
        relinka("info-verbose", "Temporary clone folder removed.");
      }
    }

    relinka(
      "info",
      `🎉 ${template} was successfully installed to ${targetDir}.`,
    );

    await nextStepsPrompt({
      title: "🤘 Project created successfully! Next steps to get started:",
      titleColor: "cyanBright",
      content: [
        `- If you have VSCode installed, run: code ${targetDir}`,
        `- You can open the project in your terminal: cd ${targetDir}`,
        "- Install dependencies manually if needed: bun i OR pnpm i",
        "- Apply linting and formatting: bun check OR pnpm check",
        "- Run the project: bun dev OR pnpm dev",
      ],
    });

    const nextActions = await multiselectPrompt({
      title: "What would you like to do next?",
      titleColor: "cyanBright",
      defaultValue: ["close", "ide"],
      options: [
        {
          label: "Close @reliverse/cli",
          value: "close",
        },
        {
          label: "Open Reliverse Documentation",
          value: "docs",
          hint: "View documentation",
        },
        {
          label: "Join Reliverse Discord Server",
          value: "discord",
        },
        {
          label: "Open Your Default Code Editor",
          value: "ide",
          hint: vscodeInstalled ? "Detected: VSCode-based IDE" : "",
        },
      ],
    });

    for (const action of nextActions) {
      if (action === "docs") {
        relinka("info", "Opening Reliverse Documentation...");
        try {
          await open("https://docs.reliverse.org");
        } catch (error) {
          relinka("error", "Error opening documentation:", error.toString());
        }
      } else if (action === "discord") {
        relinka("info", "Joining Reliverse Discord server...");
        try {
          await open("https://discord.gg/Pb8uKbwpsJ");
        } catch (error) {
          relinka("error", "Error opening Discord:", error.toString());
        }
      } else if (action === "ide") {
        relinka(
          "info",
          vscodeInstalled
            ? "Opening the project in VSCode-based IDE..."
            : "Trying to open the project in your default IDE...",
        );
        try {
          await execa("code", [targetDir]);
        } catch (error) {
          relinka(
            "error",
            "Error opening project in your IDE:",
            error instanceof Error ? error.message : String(error),
            `Try to open the project manually with command like: code ${targetDir}`,
          );
        }
      }
    }

    relinka(
      "info",
      `👋 I'll have some more features coming soon! See you soon, ${username}!`,
    );

    // Update checkpoint before potentially risky operations
    currentStep = CHECKPOINT_STEPS.DEPLOYMENT_SETUP;
    await saveCheckpoint(
      checkpointName,
      {
        step: currentStep,
        data: {
          username,
          appName,
          domain,
          deployService,
          targetDir,
          template,
        },
      },
      isDev,
    );

    // Mark as completed at the end
    if (checkpointName) {
      await saveCheckpoint(
        checkpointName,
        {
          step: CHECKPOINT_STEPS.COMPLETED,
          data: {
            username,
            appName,
            domain,
            deployService,
            targetDir,
            template,
          },
        },
        isDev,
      );
      await clearCheckpoint(checkpointName, isDev);
      relinka("success", "✅ Project created successfully!");
      relinka("success-verbose", "Checkpoint cleared.");
    }
  } catch (error) {
    // Save failed state if something goes wrong
    if (checkpointName) {
      await saveCheckpoint(
        checkpointName,
        {
          step: CHECKPOINT_STEPS.FAILED,
          data: {
            error: error instanceof Error ? error.message : String(error),
            lastStep: currentStep,
          },
        },
        isDev,
      );
      relinka(
        "error",
        "Project creation failed. You can resume from the last successful step later.",
      );
    }
    throw error;
  }
}
