export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  // Optional: only populated by searchIssues/getIssue (fetched from Jira). Call sites
  // that build a JiraIssue by hand (e.g. from a stored PendingApproval) omit it — nothing
  // downstream of detectRepo/toTaskSpec needs it, it's purely for the /start ticket menu.
  status?: string;
}

interface AdfNode {
  text?: string;
  content?: AdfNode[];
}

function extractAdfText(node: AdfNode | null | undefined): string {
  if (!node) return "";
  if (node.text) return node.text;
  if (Array.isArray(node.content)) return node.content.map(extractAdfText).join("\n");
  return "";
}

function descriptionToText(description: unknown): string {
  if (typeof description === "string") return description;
  if (description && typeof description === "object") return extractAdfText(description as AdfNode);
  return "";
}

export class JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Jira ${path} -> ${res.status}: ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async searchIssues(jql: string): Promise<JiraIssue[]> {
    const data = (await this.request(
      `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,description,status&maxResults=50`,
    )) as { issues: Array<{ key: string; fields: { summary: string; description: unknown; status: { name: string } } }> };
    return data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      description: descriptionToText(issue.fields.description),
      status: issue.fields.status.name,
    }));
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    const data = (await this.request(`/rest/api/2/issue/${issueKey}?fields=summary,description,status`)) as {
      key: string;
      fields: { summary: string; description: unknown; status: { name: string } };
    };
    return {
      key: data.key,
      summary: data.fields.summary,
      description: descriptionToText(data.fields.description),
      status: data.fields.status.name,
    };
  }

  async transitionTo(issueKey: string, statusName: string): Promise<void> {
    const data = (await this.request(`/rest/api/2/issue/${issueKey}/transitions`)) as {
      transitions: Array<{ id: string; name: string; to: { name: string } }>;
    };
    const target = statusName.toLowerCase();
    const transition = data.transitions.find(
      (t) => t.to.name.toLowerCase() === target || t.name.toLowerCase() === target,
    );
    if (!transition) {
      const available = data.transitions.map((t) => t.to.name).join(", ");
      throw new Error(`No transition to "${statusName}" for ${issueKey}. Available: ${available}`);
    }
    await this.request(`/rest/api/2/issue/${issueKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.request(`/rest/api/2/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  // Multipart upload, deliberately not going through request() above: that method
  // always forces Content-Type: application/json, which would corrupt a multipart
  // body — fetch needs to set its own Content-Type (with the multipart boundary) from
  // the FormData itself. Jira's attachment endpoint also requires the X-Atlassian-Token
  // header specifically (its own XSRF check, separate from Bearer auth) or it 403s.
  async addAttachment(issueKey: string, filename: string, content: string, contentType = "text/plain; charset=utf-8"): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: contentType }), filename);
    const res = await fetch(`${this.baseUrl}/rest/api/2/issue/${issueKey}/attachments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Atlassian-Token": "no-check",
      },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Jira attachment upload for ${issueKey} -> ${res.status}: ${await res.text()}`);
    }
  }
}
