import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";

// Replaced with one manifest entry by scripts/build-connector-blueprints.mjs.
const CONFIG = __CONNECTOR_CONFIG__;
const MAX_ROWS = 60;
const MAX_ACTIVITY = 100;

const ACTIONS = {
  github: [{ id: "create-issue", label: "Create issue", fields: [
    { name: "title", label: "Issue title", required: true, placeholder: "Describe the work" },
    { name: "body", label: "Issue body", type: "textarea", placeholder: "Context, acceptance criteria, and notes" },
  ] }],
  "home-assistant": [{ id: "toggle", label: "Toggle entity", fields: [
    { name: "entityId", label: "Entity ID", required: true, placeholder: "light.office" },
  ] }],
  linear: [{ id: "create-issue", label: "Create issue", fields: [
    { name: "teamKey", label: "Team key", required: true, placeholder: "ENG" },
    { name: "title", label: "Issue title", required: true, placeholder: "Describe the work" },
    { name: "description", label: "Description", type: "textarea" },
  ] }],
  mcp: [{ id: "call-tool", label: "Call MCP tool", fields: [
    { name: "tool", label: "Exact tool name", required: true, placeholder: "search_issues" },
    { name: "arguments", label: "JSON arguments", type: "textarea", placeholder: "{}", hint: "Read tools run immediately; other tools enter the approval queue." },
  ] }],
  notion: [{ id: "create-page", label: "Create workspace page", fields: [
    { name: "title", label: "Page title", required: true },
    { name: "content", label: "Markdown content", type: "textarea" },
  ] }],
  spotify: [{ id: "play", label: "Play Spotify URI", fields: [
    { name: "uri", label: "Spotify URI", required: true, placeholder: "spotify:track:…" },
  ] }, { id: "create-playlist", label: "Create playlist", fields: [
    { name: "name", label: "Playlist name", required: true },
    { name: "description", label: "Description", type: "textarea" },
  ] }],
  supabase: [{ id: "query", label: "Run read-only SQL", fields: [
    { name: "sql", label: "SQL query", type: "textarea", required: true, placeholder: "select * from public.items limit 50" },
  ] }, { id: "execute", label: "Submit mutating SQL", fields: [
    { name: "sql", label: "SQL statement", type: "textarea", required: true, placeholder: "update public.items set …", hint: "Mutating SQL always requires approval." },
  ] }],
  "workers-ai": [
    { id: "embed", label: "Generate embeddings", fields: [{ name: "text", label: "Text", type: "textarea", required: true }] },
    { id: "classify", label: "Classify text", fields: [{ name: "text", label: "Text", type: "textarea", required: true }] },
    { id: "generate-image", label: "Generate image", fields: [{ name: "prompt", label: "Prompt", type: "textarea", required: true }] },
    { id: "text-to-speech", label: "Synthesize speech", fields: [{ name: "text", label: "Text", type: "textarea", required: true }] },
    { id: "transcribe", label: "Transcribe audio", fields: [{ name: "audio", label: "Audio file", type: "file", accept: "audio/*", required: true }] },
  ],
};

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.mutationTail = Promise.resolve();
  }

  async getConfig() {
    return {
      title: CONFIG.title,
      description: CONFIG.description,
      resourceName: CONFIG.resourceName,
      searchPlaceholder: CONFIG.searchPlaceholder,
      accent: CONFIG.accent,
      actions: ACTIONS[CONFIG.connector] || [],
    };
  }

  async load(query = "") {
    await this.ensureEmailSubscription();
    const rows = await loadConnector(
      this.env[CONFIG.binding.name], cleanText(query, 1000), this.ctx.storage);
    return { rows: rows.slice(0, MAX_ROWS), activity: await this.activity() };
  }

  async perform(action, payload = {}) {
    const run = this.mutationTail.then(async () => {
      const result = await performConnector(
        this.env[CONFIG.binding.name], String(action), payload, this.ctx.storage);
      await this.recordActivity({
        title: result.message || `Ran ${action}`,
        detail: CONFIG.title,
        resourceId: result.resourceId,
      });
      return result;
    });
    this.mutationTail = run.catch(() => {});
    return run;
  }

  async activity() {
    return (await this.ctx.storage.get("activity")) || [];
  }

  async recordActivity(event) {
    const entries = await this.activity();
    entries.unshift({ ...event, at: new Date().toISOString() });
    await this.ctx.storage.put("activity", entries.slice(0, MAX_ACTIVITY));
  }

  async exportSnapshot() {
    return {
      template: CONFIG.blueprintId,
      connector: CONFIG.connector,
      exportedAt: new Date().toISOString(),
      rows: await loadConnector(this.env[CONFIG.binding.name], "", this.ctx.storage),
      activity: await this.activity(),
    };
  }

  async [restore](params) {
    if (params?.type === "email-receiver") return new EmailReceiver(this.ctx.storage);
    throw new TypeError(`Unknown persistent callback type: ${params?.type}`);
  }

  async ensureEmailSubscription() {
    if (CONFIG.connector !== "email") return;
    if (await this.ctx.storage.get("email:subscribed")) return;
    const callback = await this.ctx.restore({ type: "email-receiver" });
    await this.env[CONFIG.binding.name].subscribe(callback);
    await this.ctx.storage.put("email:subscribed", true);
  }
}

class EmailReceiver extends RpcTarget {
  constructor(storage) {
    super();
    this.storage = storage;
  }

  async receiveEmail(email) {
    const messages = (await this.storage.get("email:messages")) || [];
    const id = email.messageId || `${Date.now()}-${crypto.randomUUID()}`;
    messages.unshift({
      id,
      from: email.from?.name || email.from?.address || "Unknown sender",
      fromAddress: email.from?.address || "",
      subject: email.subject || "(No subject)",
      receivedAt: dateValue(email.date) || new Date().toISOString(),
      preview: cleanText(email.text || stripHtml(email.html || ""), 600),
      attachmentCount: Array.isArray(email.attachments) ? email.attachments.length : 0,
    });
    await this.storage.put("email:messages", messages.slice(0, 200));
    const activity = (await this.storage.get("activity")) || [];
    activity.unshift({ title: `Received: ${email.subject || "(No subject)"}`, detail: email.from?.address || "", resourceId: id, at: new Date().toISOString() });
    await this.storage.put("activity", activity.slice(0, MAX_ACTIVITY));
  }
}

async function loadConnector(session, query, storage) {
  if (!session) throw new Error(`${CONFIG.binding.name} binding is not configured.`);
  switch (CONFIG.connector) {
    case "cloudflare": return loadCloudflare(session, query);
    case "confluence": return loadConfluence(session, query);
    case "email": return loadEmail(session, query, storage);
    case "github": return loadGitHub(session, query);
    case "google-drive": return loadGoogleDrive(session, query);
    case "home-assistant": return loadHomeAssistant(session, query);
    case "linear": return loadLinear(session, query);
    case "mcp": return loadMcp(session, query);
    case "notion": return loadNotion(session, query);
    case "slack": return loadSlack(session, query);
    case "spotify": return loadSpotify(session, query);
    case "supabase": return loadSupabase(session, query);
    case "workers-ai": return loadLocalRuns(storage);
    case "zoominfo": return loadZoomInfo(session, query);
    default: throw new Error(`Unsupported connector template: ${CONFIG.connector}`);
  }
}

async function loadCloudflare(session, query) {
  const page = await session.listEvents({ limit: MAX_ROWS, ...(query ? { search: { value: query } } : {}) });
  return page.events.map(event => {
    const meta = event.$metadata || {};
    return makeRow({
      id: meta.id || `${event.timestamp}:${meta.requestId || "event"}`,
      title: meta.message || meta.error || meta.type || event.dataset || "Worker event",
      subtitle: meta.service || meta.requestId || event.dataset,
      kind: meta.level || meta.type || "event",
      updatedAt: new Date(event.timestamp).toISOString(),
      owner: meta.region,
      url: typeof meta.url === "string" ? meta.url : undefined,
      details: {
        Service: meta.service, Dataset: event.dataset, Level: meta.level, Region: meta.region,
        "Request ID": meta.requestId, "Trace ID": meta.traceId,
        "Status code": meta.statusCode, Timestamp: new Date(event.timestamp).toISOString(),
      },
    });
  });
}

async function loadConfluence(session, query) {
  const metadata = await session.getMetadata();
  if (!query) {
    const spaces = await firstPage(await session.listSpaces({ pageSize: MAX_ROWS }));
    return spaces.map(space => makeRow({
      id: `space:${space.id}`, title: space.name, subtitle: space.key, kind: "space", url: space.url,
      details: { Site: metadata.name, Key: space.key, Type: space.type, URL: space.url },
    }));
  }
  const pages = await firstPage(await session.search({ text: query, pageSize: MAX_ROWS }));
  return pages.map(page => makeRow({
    id: `${page.type}:${page.id}`, title: page.title, subtitle: page.spaceKey, kind: page.type,
    updatedAt: dateValue(page.lastUpdatedAt), url: page.url,
    details: { Site: metadata.name, Space: page.spaceKey, Status: page.status, Updated: dateValue(page.lastUpdatedAt), URL: page.url },
  }));
}

async function loadEmail(session, query, storage) {
  // Registration is idempotent; a template instance registers its own persistent callback on first open.
  const address = await session.getAddress();
  const messages = (await storage.get("email:messages")) || [];
  const needle = query.toLowerCase();
  return messages.filter(message => !needle || `${message.from} ${message.fromAddress} ${message.subject} ${message.preview}`.toLowerCase().includes(needle)).map(message => makeRow({
    id: message.id, title: message.subject, subtitle: message.preview, kind: "email",
    updatedAt: message.receivedAt, owner: message.from, details: {
      From: message.from, Address: message.fromAddress, Mailbox: address,
      Attachments: message.attachmentCount, Received: message.receivedAt,
    },
  }));
}

async function loadGitHub(session, query) {
  const metadata = await session.getMetadata();
  const issueCursor = query
    ? await session.searchIssues({ text: query, resultsPerPage: 30 })
    : await session.listIssues({ resultsPerPage: 30, state: "open" });
  const pullCursor = query
    ? await session.searchPullRequests({ text: query, resultsPerPage: 30 })
    : await session.listPullRequests({ resultsPerPage: 30, state: "open" });
  const [issues, pulls] = await Promise.all([firstPage(issueCursor), firstPage(pullCursor)]);
  return [
    ...issues.map(issue => githubRow(issue, "issue", metadata)),
    ...pulls.map(pull => githubRow(pull, "pull request", metadata)),
  ].toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function githubRow(item, kind, repo) {
  return makeRow({
    id: `${kind}:${item.id}`, title: `#${item.id} ${item.title}`,
    subtitle: item.labels?.map(label => label.name).join(", ") || repo.fullName,
    kind, updatedAt: dateValue(item.updatedAt), owner: item.author?.login, url: item.url,
    details: {
      Repository: repo.fullName, State: item.state, Author: item.author?.displayName || item.author?.login,
      Assignees: item.assignees?.map(actor => actor.login).join(", "), Comments: item.commentCount,
      Updated: dateValue(item.updatedAt), URL: item.url,
    },
  });
}

async function loadGoogleDrive(session, query) {
  const scope = await session.getScope();
  const cursor = query
    ? await session.search({ fullTextContains: query })
    : await session.list({ order: "modifiedTimeDesc" });
  const entries = await firstPage(cursor);
  return entries.map(entry => makeRow({
    id: entry.id, title: entry.name, subtitle: entry.owner?.displayName || entry.owner?.emailAddress,
    kind: entry.isFolder ? "folder" : mimeLabel(entry.mimeType), updatedAt: dateValue(entry.modifiedTime),
    owner: entry.owner?.emailAddress, url: entry.webViewLink,
    details: {
      Scope: scope.kind, Type: entry.mimeType, Owner: entry.owner?.displayName || entry.owner?.emailAddress,
      Size: entry.size === undefined ? undefined : `${entry.size} bytes`, Modified: dateValue(entry.modifiedTime),
      "Drive ID": entry.driveId, URL: entry.webViewLink,
    },
  }));
}

async function loadHomeAssistant(session, query) {
  const [config, entities] = await Promise.all([session.getConfig(), session.listEntities()]);
  const needle = query.toLowerCase();
  return entities.filter(entity => !needle || `${entity.entityId} ${entity.name || ""} ${entity.domain || ""} ${entity.state || ""}`.toLowerCase().includes(needle)).slice(0, MAX_ROWS).map(entity => makeRow({
    id: entity.entityId, title: entity.name || entity.entityId, subtitle: entity.entityId,
    kind: entity.domain || entity.entityId.split(".")[0], updatedAt: dateValue(entity.lastUpdated),
    details: { Instance: config.locationName || config.name, State: entity.state, Domain: entity.domain, "Entity ID": entity.entityId, Updated: dateValue(entity.lastUpdated) },
  }));
}

async function loadLinear(session, query) {
  const metadata = await session.getMetadata();
  const cursor = query
    ? await session.searchIssues({ text: query, resultsPerPage: MAX_ROWS })
    : await session.listIssues({ resultsPerPage: MAX_ROWS, sort: "updated" });
  const issues = await firstPage(cursor);
  return issues.map(issue => makeRow({
    id: issue.id, title: `${issue.id} ${issue.title}`, subtitle: issue.team?.name,
    kind: issue.state?.name || "issue", updatedAt: dateValue(issue.updatedAt), owner: issue.assignee?.displayName || issue.assignee?.name,
    url: issue.url, details: {
      Workspace: metadata.name, Team: issue.team?.name, State: issue.state?.name, Priority: issue.priority,
      Assignee: issue.assignee?.displayName || issue.assignee?.name, Project: issue.project?.name,
      Updated: dateValue(issue.updatedAt), URL: issue.url,
    },
  }));
}

async function loadMcp(session, query) {
  const tools = query ? await session.listTools({ search: query }) : await session.listTools();
  return tools.map(tool => makeRow({
    id: tool.name, title: tool.title || tool.name, subtitle: tool.description, kind: tool.mode,
    details: { Name: tool.name, Mode: tool.mode, "Classified by": tool.classifiedBy, Description: tool.description },
  }));
}

async function loadNotion(session, query) {
  const metadata = await session.getMetadata();
  const items = await firstPage(await session.search({ ...(query ? { query } : {}), sort: "lastEditedDescending", pageSize: MAX_ROWS }));
  return items.map(item => makeRow({
    id: item.id, title: item.title || "Untitled", subtitle: metadata.name, kind: item.kind,
    updatedAt: dateValue(item.lastEditedAt), url: item.url,
    details: { Workspace: metadata.name, Type: item.kind, Created: dateValue(item.createdAt), Updated: dateValue(item.lastEditedAt), URL: item.url },
  }));
}

async function loadSlack(session, query) {
  const info = await session.getInfo();
  if (query) {
    const messages = await firstPage(await session.search(query));
    return messages.map(entry => {
      entry.thread?.[Symbol.dispose]?.();
      const message = entry.message;
      return makeRow({
        id: message.ts, title: cleanText(message.text, 150) || "Slack message",
        subtitle: message.author?.displayName || message.author?.realName || message.author?.username,
        kind: "message", updatedAt: dateValue(message.timestamp), url: message.permalink,
        details: { Workspace: info.name, Author: message.author?.displayName || message.author?.username, Replies: message.replyCount, Reactions: message.reactions?.reduce((sum, reaction) => sum + reaction.count, 0), Posted: dateValue(message.timestamp), URL: message.permalink },
      });
    });
  }
  const channels = await firstPage(await session.listChannels());
  return channels.map(entry => {
    entry.conversation?.[Symbol.dispose]?.();
    const channel = entry.info;
    return makeRow({
      id: channel.id, title: channel.name ? `#${channel.name}` : channel.peer?.displayName || channel.id,
      subtitle: channel.topic || channel.purpose, kind: channel.kind,
      details: { Workspace: info.name, Members: channel.memberCount, Archived: channel.isArchived ? "Yes" : "No", Topic: channel.topic, Purpose: channel.purpose },
    });
  });
}

async function loadSpotify(session, query) {
  const profile = await session.getProfile();
  if (query) {
    const results = await session.search(query, ["track", "artist", "album", "playlist"], 10);
    return [
      ...(results.tracks || []).map(track => spotifyTrackRow(track, profile)),
      ...(results.playlists || []).map(playlist => spotifyPlaylistRow(playlist, profile)),
      ...(results.artists || []).map(artist => makeRow({ id: artist.id, title: artist.name, kind: "artist", url: artist.url, details: { Account: profile.displayName, URI: artist.uri, URL: artist.url } })),
      ...(results.albums || []).map(album => makeRow({ id: album.id, title: album.name, subtitle: album.artists?.map(a => a.name).join(", "), kind: "album", url: album.url, details: { Account: profile.displayName, URI: album.uri, URL: album.url } })),
    ];
  }
  return (await session.listPlaylists(50, 0)).map(playlist => spotifyPlaylistRow(playlist, profile));
}

function spotifyTrackRow(track, profile) {
  return makeRow({ id: track.id, title: track.name, subtitle: track.artists?.map(artist => artist.name).join(", "), kind: "track", url: track.url, details: { Account: profile.displayName, Album: track.album?.name, Duration: track.durationMs ? `${Math.round(track.durationMs / 1000)}s` : undefined, URI: track.uri, URL: track.url } });
}

function spotifyPlaylistRow(playlist, profile) {
  return makeRow({ id: playlist.id, title: playlist.name, subtitle: playlist.description, kind: "playlist", owner: playlist.owner?.displayName || playlist.owner?.id, url: playlist.url, details: { Account: profile.displayName, Owner: playlist.owner?.displayName || playlist.owner?.id, Tracks: playlist.trackCount, Public: playlist.public, Collaborative: playlist.collaborative, URI: playlist.uri, URL: playlist.url } });
}

async function loadSupabase(session, query) {
  const [info, health, functions, buckets] = await Promise.all([
    session.getInfo(), session.checkHealth(), session.listEdgeFunctions(), session.listStorageBuckets(),
  ]);
  const database = await session.getDatabase();
  let tables;
  try { tables = await database.listTables({ includeViews: true }); }
  finally { database[Symbol.dispose]?.(); }
  const rows = [
    ...tables.map(table => makeRow({ id: `table:${table.schema}.${table.name}`, title: `${table.schema}.${table.name}`, subtitle: table.comment, kind: table.kind, details: { Project: info.name, Schema: table.schema, RLS: table.rlsEnabled ? "Enabled" : "Disabled", "Approx. rows": table.approximateRowCount } })),
    ...health.map(service => makeRow({ id: `service:${service.service}`, title: service.service, subtitle: service.error, kind: service.status, details: { Project: info.name, Status: service.status, Error: service.error } })),
    ...functions.map(fn => makeRow({ id: `function:${fn.slug}`, title: fn.name || fn.slug, subtitle: fn.slug, kind: "edge function", updatedAt: dateValue(fn.updatedAt), details: { Project: info.name, Status: fn.status, Version: fn.version, "Verify JWT": fn.verifyJwt, Updated: dateValue(fn.updatedAt) } })),
    ...buckets.map(bucket => makeRow({ id: `bucket:${bucket.id}`, title: bucket.name, kind: "storage bucket", updatedAt: dateValue(bucket.updatedAt), details: { Project: info.name, Public: bucket.public, Created: dateValue(bucket.createdAt), Updated: dateValue(bucket.updatedAt) } })),
  ];
  const needle = query.toLowerCase();
  return rows.filter(row => !needle || `${row.title} ${row.subtitle || ""} ${row.kind}`.toLowerCase().includes(needle));
}

async function loadLocalRuns(storage) {
  const runs = (await storage.get("model:runs")) || [];
  return runs.map(run => makeRow({ id: run.id, title: run.title, subtitle: run.detail, kind: run.kind, updatedAt: run.at, details: { Operation: run.kind, Result: run.detail, Time: run.at } }));
}

async function loadZoomInfo(session, query) {
  if (!query) {
    const usage = await session.getCreditUsage();
    return [makeRow({ id: "credit-usage", title: "Credit usage", subtitle: "Current account allowance", kind: "account", details: flattenObject(usage) })];
  }
  const looksLikeUrl = /^https?:\/\//i.test(query) || query.includes(".");
  const page = await session.searchCompanies(looksLikeUrl ? { companyWebsite: normalizeWebsite(query) } : { companyName: query }, { page: 1, pageSize: MAX_ROWS });
  return page.results.map(company => makeRow({
    id: company.id, title: company.name, subtitle: company.website, kind: "company", owner: company.country,
    url: company.website, details: { Website: company.website, City: company.city, State: company.state, Country: company.country, Employees: company.employeeCount, Revenue: company.revenue },
  }));
}

async function performConnector(session, action, payload, storage) {
  if (!session) throw new Error(`${CONFIG.binding.name} binding is not configured.`);
  switch (`${CONFIG.connector}:${action}`) {
    case "github:create-issue": {
      const title = required(payload.title, "Issue title");
      const issue = await session.createIssue({ title, bodyMarkdown: cleanText(payload.body, 100000) });
      issue[Symbol.dispose]?.();
      return { message: `Issue “${title}” submitted for approval.` };
    }
    case "home-assistant:toggle": {
      const entityId = required(payload.entityId, "Entity ID");
      const entity = await session.getEntity(entityId);
      try { await entity.toggle(); } finally { entity[Symbol.dispose]?.(); }
      return { message: `${entityId} toggle submitted for approval.`, resourceId: entityId };
    }
    case "linear:create-issue": {
      const title = required(payload.title, "Issue title");
      const issue = await session.createIssue({ title, teamKey: required(payload.teamKey, "Team key"), descriptionMarkdown: cleanText(payload.description, 100000) });
      issue[Symbol.dispose]?.();
      return { message: `Linear issue “${title}” submitted for approval.` };
    }
    case "mcp:call-tool": {
      const tool = required(payload.tool, "Tool name");
      let args = {};
      if (cleanText(payload.arguments, 100000).trim()) args = JSON.parse(cleanText(payload.arguments, 100000));
      const result = await session.callTool(tool, args);
      return { message: result.status === "ok" ? cleanText(result.text || `${tool} completed.`, 500) : result.message || `${tool}: ${result.status}` };
    }
    case "notion:create-page": {
      const title = required(payload.title, "Page title");
      const page = await session.createPage({ title, content: cleanText(payload.content, 100000) });
      page[Symbol.dispose]?.();
      return { message: `Notion page “${title}” submitted for approval.` };
    }
    case "spotify:play": {
      const uri = required(payload.uri, "Spotify URI");
      const player = session.getPlayer();
      try { await player.play(uri.startsWith("spotify:track:") ? { trackUris: [uri] } : { contextUri: uri }); }
      finally { player[Symbol.dispose]?.(); }
      return { message: "Playback request submitted for approval." };
    }
    case "spotify:create-playlist": {
      const name = required(payload.name, "Playlist name");
      const playlist = await session.createPlaylist(name, { description: cleanText(payload.description, 10000) });
      playlist[Symbol.dispose]?.();
      return { message: `Playlist “${name}” submitted for approval.` };
    }
    case "supabase:query":
    case "supabase:execute": {
      const sql = required(payload.sql, "SQL");
      const database = await session.getDatabase();
      try {
        if (action === "query") {
          const result = await database.query(sql);
          return { message: `Read-only query returned ${result.rows?.length || 0} row(s).` };
        }
        await database.execute(sql);
        return { message: "Mutating SQL submitted for approval." };
      } finally { database[Symbol.dispose]?.(); }
    }
    case "workers-ai:embed": {
      const result = await session.embed(required(payload.text, "Text"));
      await storeModelRun(storage, "embedding", `Generated ${result.vectors.length} vector(s), ${result.dimensions} dimensions.`);
      return { message: `Generated ${result.vectors.length} embedding vector(s).` };
    }
    case "workers-ai:classify": {
      const result = await session.classify(required(payload.text, "Text"));
      const detail = result.slice(0, 5).map(item => `${item.label}: ${Number(item.score).toFixed(3)}`).join(", ");
      await storeModelRun(storage, "classification", detail);
      return { message: detail || "Classification completed." };
    }
    case "workers-ai:generate-image": {
      const result = await session.generate(required(payload.prompt, "Prompt"));
      const detail = `Generated ${result.data.type || "image"}, ${result.data.size} bytes${result.seed === undefined ? "" : `, seed ${result.seed}`}.`;
      await storeModelRun(storage, "image", detail);
      return { message: detail };
    }
    case "workers-ai:text-to-speech": {
      const audio = await session.synthesize(required(payload.text, "Text"));
      const detail = `Generated ${audio.type || "audio"}, ${audio.size} bytes.`;
      await storeModelRun(storage, "speech", detail);
      return { message: detail };
    }
    case "workers-ai:transcribe": {
      if (!(payload.audio instanceof Blob) || payload.audio.size === 0) throw new Error("Audio file is required.");
      const transcript = await session.transcribe(payload.audio, { wordTimestamps: true });
      const detail = cleanText(transcript.text, 500);
      await storeModelRun(storage, "transcription", detail);
      return { message: detail || "Transcription completed." };
    }
    default: throw new Error(`Unsupported action ${action} for ${CONFIG.connector}.`);
  }
}

async function storeModelRun(storage, kind, detail) {
  const runs = (await storage.get("model:runs")) || [];
  runs.unshift({ id: crypto.randomUUID(), title: kind[0].toUpperCase() + kind.slice(1), kind, detail, at: new Date().toISOString() });
  await storage.put("model:runs", runs.slice(0, 100));
}

async function firstPage(cursor) {
  try { return (await cursor.next()) || []; }
  finally { cursor?.[Symbol.dispose]?.(); }
}

function makeRow(value) {
  const details = Object.entries(value.details || {})
    .filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
    .map(([label, entry]) => ({ label, value: typeof entry === "object" ? JSON.stringify(entry) : String(entry), ...(label === "URL" && /^https?:\/\//.test(String(entry)) ? { url: String(entry) } : {}) }));
  return {
    id: String(value.id), title: cleanText(value.title, 300) || "Untitled",
    subtitle: cleanText(value.subtitle, 500), kind: cleanText(value.kind, 80) || "resource",
    updatedAt: dateValue(value.updatedAt), owner: cleanText(value.owner, 200),
    url: /^https?:\/\//.test(String(value.url || "")) ? String(value.url) : undefined,
    icon: value.icon || "file", details,
  };
}

function dateValue(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}

function cleanText(value, max = 10000) {
  return String(value ?? "").replaceAll("\u0000", "").slice(0, max);
}

function required(value, label) {
  const text = cleanText(value, 100000).trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function stripHtml(value) {
  return String(value).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function mimeLabel(mime) {
  if (mime === "application/vnd.google-apps.document") return "Google Doc";
  if (mime === "application/vnd.google-apps.spreadsheet") return "Google Sheet";
  if (mime === "application/vnd.google-apps.presentation") return "Google Slides";
  return String(mime || "file").split("/").pop().replace(/^vnd\./, "");
}

function normalizeWebsite(value) {
  const text = String(value).trim();
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function flattenObject(value, prefix = "", out = {}) {
  for (const [key, entry] of Object.entries(value || {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => {
        const itemName = `${name}.${index + 1}`;
        if (item && typeof item === "object") flattenObject(item, itemName, out);
        else out[itemName] = item;
      });
    } else if (entry && typeof entry === "object") flattenObject(entry, name, out);
    else out[name] = entry;
  }
  return out;
}

const EXPORT_FORMATS = [
  { id: "json", label: "JSON", mode: "server", contentType: "application/json", fileExtension: ".json" },
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return EXPORT_FORMATS;
  }

  async export(gadget, id) {
    if (id !== "json") throw new Error(`Unsupported connector export format: ${id}`);
    const snapshot = await gadget.exportSnapshot();
    return new Response(`${JSON.stringify(snapshot, null, 2)}\n`).body;
  }
}
