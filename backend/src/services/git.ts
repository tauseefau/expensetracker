import { prisma } from "../db/client";
import { encryptSecret, decryptSecret } from "../utils/cipher";
import { config } from "../config";
import type { GitProvider } from "@prisma/client";

/**
 * Git service provider driver. Commits structured CSV/JSON financial records
 * to a user-connected repository (GitHub API implemented; GitLab/Bitbucket
 * share the same interface — stubbed to the GitHub endpoint for the mock).
 */
export interface GitCommitResult {
  sha: string;
  url: string;
  provider: GitProvider;
}

interface GitDriver {
  provider: GitProvider;
  commit(opts: {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    path: string;
    content: string;
    message: string;
  }): Promise<GitCommitResult>;
}

const githubDriver: GitDriver = {
  provider: "github",
  async commit({ token, owner, repo, branch, path, content, message }) {
    const api = "https://api.github.com/repos";
    const getSha = async () => {
      try {
        const r = await fetch(`${api}/${owner}/${repo}/contents/${path}?ref=${branch}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        });
        if (r.ok) {
          const j = (await r.json()) as { sha?: string };
          return j.sha;
        }
        return undefined; // file doesn't exist yet
      } catch {
        return undefined;
      }
    };
    const sha = await getSha();
    const body: Record<string, string> = {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(`${api}/${owner}/${repo}/contents/${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub commit failed (${res.status}): ${await res.text()}`);
    const j = (await res.json()) as { commit?: { sha?: string }; content?: { html_url?: string } };
    return { sha: j.commit?.sha || "", url: j.content?.html_url || "", provider: "github" };
  },
};

const gitlabDriver: GitDriver = {
  provider: "gitlab",
  async commit(opts) {
    // TODO: GitLab API v4 implement. Mirror of github for mock.
    return githubDriver.commit(opts as never);
  },
};

const bitbucketDriver: GitDriver = {
  provider: "bitbucket",
  async commit(opts) {
    // TODO: Bitbucket API 2.0 implement. Mirror for mock.
    return githubDriver.commit(opts as unknown as Parameters<GitDriver["commit"]>[0]);
  },
};

const drivers: Record<GitProvider, GitDriver> = {
  github: githubDriver,
  gitlab: gitlabDriver,
  bitbucket: bitbucketDriver,
};

/** Push a file to a connected git integration. */
export async function gitCommit(
  integrationId: string,
  opts: { path: string; content: string; message: string }
): Promise<GitCommitResult> {
  const integration = await prisma.git_integrations.findUnique({ where: { id: integrationId } });
  if (!integration) throw new Error("Git integration not found");
  const token = decryptSecret(integration.access_token_encrypted, config.encryptionKey);
  return drivers[integration.provider].commit({
    token,
    owner: integration.repository_owner,
    repo: integration.repository_name,
    branch: integration.branch,
    path: opts.path,
    content: opts.content,
    message: opts.message,
  });
}

/** Save a new git integration (access token stored encrypted at rest). */
export async function createGitIntegration(data: {
  orgId: string;
  provider: GitProvider;
  owner: string;
  repo: string;
  branch?: string;
  token: string;
  autoSyncCsv?: boolean;
  autoSyncJson?: boolean;
}) {
  const access_token_encrypted = encryptSecret(data.token, config.encryptionKey);
  return prisma.git_integrations.create({
    data: {
      org_id: data.orgId,
      provider: data.provider,
      repository_owner: data.owner,
      repository_name: data.repo,
      branch: data.branch || "main",
      access_token_encrypted,
      auto_sync_csv: data.autoSyncCsv ?? false,
      auto_sync_json: data.autoSyncJson ?? false,
    },
  });
}