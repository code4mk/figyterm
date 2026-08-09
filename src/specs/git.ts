/**
 * Git autocomplete spec for Figyterm.
 */
import { Figy } from "../types/figy";

const completionSpec: Figy.Spec = {
  name: "git",
  description: "The stupid content tracker",
  subcommands: [
    {
      name: "add",
      description: "Add file contents to the index",
      args: {
        name: "pathspec",
        isVariadic: true,
        template: "filepaths",
      },
      options: [
        { name: ["-A", "--all"], description: "Add all changes" },
        { name: ["-p", "--patch"], description: "Interactively choose hunks" },
        { name: ["-n", "--dry-run"], description: "Don't actually add files" },
        { name: ["-f", "--force"], description: "Allow adding ignored files" },
      ],
    },
    {
      name: "commit",
      description: "Record changes to the repository",
      options: [
        { name: ["-m", "--message"], description: "Commit message", args: { name: "message" } },
        { name: ["-a", "--all"], description: "Stage all modified and deleted files" },
        { name: "--amend", description: "Amend previous commit" },
        { name: "--no-edit", description: "Use previous commit message" },
        { name: ["-S", "--gpg-sign"], description: "GPG sign commit" },
      ],
    },
    {
      name: "push",
      description: "Update remote refs along with associated objects",
      args: [
        {
          name: "remote",
          generators: {
            script: ["git", "remote"],
            splitOn: "\n",
          },
        },
        {
          name: "branch",
          generators: {
            script: ["git", "branch", "--no-color", "--sort=-committerdate"],
            postProcess: (out) =>
              out.split("\n").map((branch) => ({
                name: branch.replace("*", "").trim(),
                description: "Branch",
              })),
          },
        },
      ],
      options: [
        { name: ["-f", "--force"], description: "Force push" },
        { name: ["-u", "--set-upstream"], description: "Set upstream for current branch" },
        { name: "--tags", description: "Push all tags" },
        { name: "--delete", description: "Delete remote branch" },
      ],
    },
    {
      name: "pull",
      description: "Fetch from and integrate with another repository or branch",
      args: [
        { name: "remote", isOptional: true },
        { name: "branch", isOptional: true },
      ],
      options: [
        { name: "--rebase", description: "Rebase instead of merge" },
        { name: "--no-rebase", description: "Merge (default)" },
        { name: "--ff-only", description: "Fast-forward only" },
      ],
    },
    {
      name: "checkout",
      description: "Switch branches or restore working tree files",
      args: {
        name: "branch",
        generators: {
          script: ["git", "branch", "-a", "--no-color", "--sort=-committerdate"],
          postProcess: (out) =>
            out
              .split("\n")
              .filter((line) => !line.includes("HEAD detached"))
              .map((branch) => ({
                name: branch.replace("*", "").replace("remotes/origin/", "").trim(),
                description: "Branch",
              })),
        },
      },
      options: [
        { name: ["-b"], description: "Create and checkout a new branch", args: { name: "new-branch" } },
        { name: ["-B"], description: "Create/reset and checkout a branch", args: { name: "branch" } },
      ],
    },
    {
      name: "branch",
      description: "List, create, or delete branches",
      args: { name: "branch-name", isOptional: true },
      options: [
        { name: ["-d", "--delete"], description: "Delete a branch" },
        { name: ["-D"], description: "Force delete a branch" },
        { name: ["-m", "--move"], description: "Rename a branch" },
        { name: ["-a", "--all"], description: "List both remote and local branches" },
        { name: ["-r", "--remotes"], description: "List remote branches" },
      ],
    },
    {
      name: "status",
      description: "Show the working tree status",
      options: [
        { name: ["-s", "--short"], description: "Short format" },
        { name: ["-b", "--branch"], description: "Show branch info" },
      ],
    },
    {
      name: "log",
      description: "Show commit logs",
      options: [
        { name: "--oneline", description: "One line per commit" },
        { name: "--graph", description: "Show graph" },
        { name: ["-n", "--max-count"], description: "Number of commits", args: { name: "number" } },
        { name: "--all", description: "Show all refs" },
      ],
    },
    {
      name: "diff",
      description: "Show changes between commits, commit and working tree, etc",
      args: { name: "path", template: "filepaths", isOptional: true, isVariadic: true },
      options: [
        { name: "--staged", description: "Show staged changes" },
        { name: "--cached", description: "Same as --staged" },
        { name: "--stat", description: "Show diffstat" },
        { name: "--name-only", description: "Show only names of changed files" },
      ],
    },
    {
      name: "stash",
      description: "Stash changes in a dirty working directory",
      subcommands: [
        { name: "push", description: "Save local modifications to a new stash entry" },
        { name: "pop", description: "Remove a single stashed state and apply it" },
        { name: "list", description: "List stash entries" },
        { name: "show", description: "Show changes in a stash" },
        { name: "drop", description: "Remove a single stash entry" },
        { name: "clear", description: "Remove all stash entries" },
        { name: "apply", description: "Apply a stash without removing it" },
      ],
    },
    {
      name: "merge",
      description: "Join two or more development histories together",
      args: {
        name: "branch",
        generators: {
          script: ["git", "branch", "--no-color", "--sort=-committerdate"],
          postProcess: (out) =>
            out.split("\n").map((b) => ({ name: b.replace("*", "").trim(), description: "Branch" })),
        },
      },
      options: [
        { name: "--no-ff", description: "Create a merge commit even for fast-forward" },
        { name: "--squash", description: "Squash commits" },
        { name: "--abort", description: "Abort the current merge" },
      ],
    },
    {
      name: "rebase",
      description: "Reapply commits on top of another base tip",
      args: { name: "upstream", isOptional: true },
      options: [
        { name: "--continue", description: "Continue after resolving conflicts" },
        { name: "--abort", description: "Abort rebase" },
        { name: "--skip", description: "Skip current patch" },
        { name: ["-i", "--interactive"], description: "Interactive rebase" },
      ],
    },
    {
      name: "clone",
      description: "Clone a repository into a new directory",
      args: [
        { name: "repository" },
        { name: "directory", isOptional: true, template: "folders" },
      ],
      options: [
        { name: "--depth", description: "Shallow clone", args: { name: "depth" } },
        { name: ["-b", "--branch"], description: "Checkout branch", args: { name: "branch" } },
        { name: "--single-branch", description: "Clone single branch" },
      ],
    },
    {
      name: "remote",
      description: "Manage set of tracked repositories",
      subcommands: [
        { name: "add", description: "Add a new remote", args: [{ name: "name" }, { name: "url" }] },
        { name: "remove", description: "Remove a remote", args: { name: "name" } },
        { name: "rename", description: "Rename a remote", args: [{ name: "old" }, { name: "new" }] },
        { name: "show", description: "Shows information about a remote" },
        { name: "prune", description: "Delete stale references" },
      ],
      options: [
        { name: "-v", description: "Be verbose" },
      ],
    },
    {
      name: "reset",
      description: "Reset current HEAD to the specified state",
      args: { name: "commit", isOptional: true },
      options: [
        { name: "--soft", description: "Keep changes in staging" },
        { name: "--mixed", description: "Keep changes in working tree (default)" },
        { name: "--hard", description: "Discard all changes" },
      ],
    },
    {
      name: "init",
      description: "Create an empty Git repository",
      args: { name: "directory", isOptional: true, template: "folders" },
      options: [
        { name: "--bare", description: "Create a bare repository" },
        { name: ["-b", "--initial-branch"], description: "Initial branch name", args: { name: "branch" } },
      ],
    },
  ],
};

export default completionSpec;
