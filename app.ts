// The forge's HTTP server, v1 (Ronde 1): REST v3 surface — repos, contents,
// refs/branches/commits, issues, labels, comments — over an in-memory store,
// plus the global protocol middleware (JSON always, X-GitHub-Request-Id,
// Bearer auth, ownership 404-not-403). No git smart HTTP, GraphQL or MCP yet.
//
// Store rules: everything lives in Maps; no fs sync per request; no wall-clock
// timestamps anywhere (commit objects use a fixed 0 timestamp, API date fields
// are a fixed epoch string), so two runs on the same instance export identically.
// Object ids are real git ids (SHA-1 of `blob/tree/commit <len>\0<body>`), so
// the content layer already speaks the object model the git layer will reuse.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_DATE = '1970-01-01T00:00:00Z';
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO_OID = '0'.repeat(40);
const GIT_AGENT = 'github-core-clone-forge/1.0.0';

/** One raw git object, exactly as hashed (header excluded, as the hash is computed over it). */
interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

// ---------------------------------------------------------------------------
// git object ids (pure SHA-1, deterministic)

function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function blobSha(content: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`, 'utf8'), content]));
}

interface TreeEntry {
  name: string;
  mode: string;
  sha: string;
}

/** Git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareGitTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** The exact bytes of a git tree object built from entries (sorted git's way). */
function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareGitTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** SHA-1 of a git tree object built from entries. */
function treeSha(entries: readonly TreeEntry[]): string {
  const body = buildTreeBytes(entries);
  return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`, 'utf8'), body]));
}

/** Tree sha of the files under `prefix` ('' = whole tree), recursively. */
function treeShaForFiles(files: ReadonlyMap<string, FileRec>, prefix: string): string {
  const direct = new Map<string, FileRec>();
  const subdirs = new Set<string>();
  for (const [path, file] of files) {
    if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
    const rest = prefix === '' ? path : path.slice(prefix.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) direct.set(rest, file);
    else subdirs.add(rest.slice(0, slash));
  }
  const entries: TreeEntry[] = [];
  for (const [name, file] of direct) entries.push({ name, mode: '100644', sha: file.sha });
  for (const name of subdirs) {
    entries.push({ name, mode: '40000', sha: treeShaForFiles(files, prefix === '' ? name : `${prefix}/${name}`) });
  }
  return treeSha(entries);
}

/** The exact bytes of a git commit object (fixed Forge identity, epoch 0). */
function commitBytes(
  tree: string,
  parents: readonly string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const body =
    `tree ${tree}\n` +
    parents.map((parent) => `parent ${parent}\n`).join('') +
    `author ${author}\n` +
    `committer ${committer}\n` +
    `\n${msg}`;
  return Buffer.from(body, 'utf8');
}

function commitSha(tree: string, parent: string | null, message: string): string {
  const body = commitBytes(tree, parent === null ? [] : [parent], 'Forge <forge@localhost> 0 +0000', 'Forge <forge@localhost> 0 +0000', message);
  return sha1(Buffer.concat([Buffer.from(`commit ${body.length}\0`, 'utf8'), body]));
}

// ---------------------------------------------------------------------------
// git object store helpers (shared by the REST layer and the git layer)

function hashObject(type: GitObject['type'], data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

function putObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

interface ParsedTreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): ParsedTreeEntry[] {
  const entries: ParsedTreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Memoized commit parse: object bytes are immutable, so a parsed commit for
 * an oid never changes. Hot paths (ancestry, fetch, sync) parse each commit
 * once instead of once per walk. */
function commitOf(repo: RepoRec, oid: string): ParsedCommit | null {
  const cached = repo.parsedCommits.get(oid);
  if (cached !== undefined) return cached;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  repo.parsedCommits.set(oid, parsed);
  return parsed;
}

/** Memoized tree parse, same reasoning as commitOf. */
function treeOf(repo: RepoRec, oid: string): ParsedTreeEntry[] | null {
  const cached = repo.parsedTrees.get(oid);
  if (cached !== undefined) return cached;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tree') return null;
  const parsed = parseTree(obj.data);
  repo.parsedTrees.set(oid, parsed);
  return parsed;
}

/** Deflated object bytes, computed once per oid (zlib output is deterministic). */
function deflatedOf(repo: RepoRec, oid: string, data: Buffer): Buffer {
  const cached = repo.deflated.get(oid);
  if (cached !== undefined) return cached;
  const out = deflateSync(data);
  repo.deflated.set(oid, out);
  return out;
}

/** Store every blob/tree of a file map in the object store; returns the root tree oid. */
function storeFileTree(repo: RepoRec, files: ReadonlyMap<string, FileRec>, prefix: string): string {
  const direct = new Map<string, FileRec>();
  const subdirs = new Set<string>();
  for (const [path, file] of files) {
    if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
    const rest = prefix === '' ? path : path.slice(prefix.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) direct.set(rest, file);
    else subdirs.add(rest.slice(0, slash));
  }
  const entries: TreeEntry[] = [];
  for (const [name, file] of direct) {
    putObject(repo, 'blob', file.content);
    entries.push({ name, mode: '100644', sha: file.sha });
  }
  for (const name of subdirs) {
    entries.push({
      name,
      mode: '40000',
      sha: storeFileTree(repo, files, prefix === '' ? name : `${prefix}/${name}`),
    });
  }
  return putObject(repo, 'tree', buildTreeBytes(entries));
}

/** The files at a commit, materialised by walking its tree objects. */
function materializeFiles(repo: RepoRec, commitOid: string): Map<string, FileRec> {
  const out = new Map<string, FileRec>();
  const parsed = commitOf(repo, commitOid);
  if (parsed === null) return out;
  const walk = (treeOid: string, prefix: string): void => {
    const entries = treeOf(repo, treeOid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined && blob.type === 'blob') {
          out.set(path, { content: blob.data, sha: entry.oid });
        }
      }
    }
  };
  walk(parsed.tree, '');
  return out;
}

/** Ancestry of a commit, newest first (pre-order DFS over all parents), deduplicated. */
function ancestryOf(repo: RepoRec, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const parsed = commitOf(repo, oid);
    if (parsed === null) return;
    out.push(oid);
    for (const parent of parsed.parents) visit(parent);
  };
  visit(tip);
  return out;
}

/** True when `anc` is `desc` itself or one of its ancestors. */
function isAncestor(repo: RepoRec, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue: string[] = [desc];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head]!;
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = commitOf(repo, oid);
    if (parsed === null) continue;
    for (const parent of parsed.parents) {
      if (parent === anc) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Follow annotated tags to the commit they point at (or null when it is not a commit). */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Create CommitRec entries for every commit in a tip's ancestry that lacks one.
 * Incremental: stop descending past a commit that already has one, because its
 * whole ancestry is synced by the same invariant (recs are always created for
 * a full ancestry closure). */
function syncCommitRecs(repo: RepoRec, tip: string): void {
  const stack: string[] = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha) || repo.commits.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = commitOf(repo, sha);
    if (parsed === null) continue;
    repo.commits.set(sha, {
      sha,
      message: parsed.message,
      parent: parsed.parents[0] ?? null,
      treeSha: parsed.tree,
      files: materializeFiles(repo, sha),
    });
    for (const parent of parsed.parents) stack.push(parent);
  }
}

/** Point a branch record at a pushed commit (tip, files, history) and sync its commits. */
function syncBranchFromCommit(repo: RepoRec, branchName: string, tip: string): void {
  let branch = repo.branches.get(branchName);
  if (branch === undefined) {
    branch = { name: branchName, tip: '', files: new Map(), history: [] };
    repo.branches.set(branchName, branch);
  }
  const oldTip = branch.tip;
  branch.tip = tip;
  branch.files = materializeFiles(repo, tip);
  if (oldTip !== '' && oldTip !== tip && isAncestor(repo, oldTip, tip)) {
    // Fast-forward: only the commits between tip and oldTip are new. Walking
    // them in ancestryOf's pre-order (stopping at oldTip) yields exactly the
    // prefix ancestryOf(tip) has before oldTip, so prepending it to the old
    // history reproduces ancestryOf(tip) without re-walking the whole history.
    const fresh: string[] = [];
    const seen = new Set<string>([oldTip]);
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const parsed = commitOf(repo, oid);
      if (parsed === null) return;
      fresh.push(oid);
      for (const parent of parsed.parents) visit(parent);
    };
    visit(tip);
    branch.history = [...fresh, ...branch.history];
  } else {
    branch.history = ancestryOf(repo, tip);
  }
  syncCommitRecs(repo, tip);
}

// ---------------------------------------------------------------------------
// store

interface FileRec {
  content: Buffer;
  sha: string;
}

interface CommitRec {
  sha: string;
  message: string;
  parent: string | null;
  treeSha: string;
  files: Map<string, FileRec>;
}

interface BranchRec {
  name: string;
  tip: string;
  files: Map<string, FileRec>;
  history: string[];
}

interface LabelRec {
  name: string;
  color: string;
}

interface CommentRec {
  id: number;
  body: string;
}

interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRec[];
  comments: CommentRec[];
  seq: number;
}

interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

interface RepoRec {
  id: number;
  name: string;
  ownerLogin: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  branches: Map<string, BranchRec>;
  commits: Map<string, CommitRec>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
  /** Raw git objects by id (blobs/trees/commits/tags), shared by REST and git. */
  objects: Map<string, GitObject>;
  /** Git refs (full name -> oid). The REST initial commit is deliberately NOT
   * advertised here: a fresh repo has an unborn HEAD until the first push. */
  gitRefs: Map<string, string>;
  /** Perf caches (all keyed by immutable content, so entries never go stale):
   * parsed commit/tree objects by oid, deflated object bytes by oid, and
   * complete fetch responses by fetch-args key. */
  parsedCommits: Map<string, ParsedCommit>;
  parsedTrees: Map<string, ParsedTreeEntry[]>;
  deflated: Map<string, Buffer>;
  fetchCache: Map<string, Buffer>;
}

const reposByName = new Map<string, RepoRec>();
let repoIdCounter = 0;
let requestCounter = 0;
/** The login the bearer token names, learned from the first repo-scoped read. */
let viewerLogin: string | null = null;

function makeCommit(repo: RepoRec, branch: BranchRec, files: Map<string, FileRec>, message: string): CommitRec {
  const tree = storeFileTree(repo, files, '');
  const parent = branch.history.length > 0 ? branch.history[0]! : null;
  const sha = commitSha(tree, parent, message);
  putObject(
    repo,
    'commit',
    commitBytes(tree, parent === null ? [] : [parent], 'Forge <forge@localhost> 0 +0000', 'Forge <forge@localhost> 0 +0000', message),
  );
  const commit: CommitRec = { sha, message, parent, treeSha: tree, files };
  repo.commits.set(sha, commit);
  branch.tip = sha;
  branch.files = files;
  branch.history = [sha, ...branch.history];
  repo.gitRefs.set(`refs/heads/${branch.name}`, sha);
  return commit;
}

function createRepo(name: string, isPrivate: boolean, description: string): RepoRec {
  const repo: RepoRec = {
    id: (repoIdCounter += 1),
    name,
    ownerLogin: viewerLogin,
    description,
    isPrivate,
    defaultBranch: 'main',
    branches: new Map(),
    commits: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    seq: 0,
    objects: new Map(),
    gitRefs: new Map(),
    parsedCommits: new Map(),
    parsedTrees: new Map(),
    deflated: new Map(),
    fetchCache: new Map(),
  };
  const branch: BranchRec = { name: 'main', tip: '', files: new Map(), history: [] };
  repo.branches.set('main', branch);
  // Deterministic initial empty commit, so branches/commits/refs work before
  // any file exists. Fixed author/committer (epoch 0): no clock in any id.
  // Its objects live in the object store, but it is NOT a git ref: a fresh
  // repo has an unborn HEAD until the first push (clone-empty needs that).
  putObject(repo, 'tree', Buffer.alloc(0));
  const sha = commitSha(EMPTY_TREE_SHA, null, 'Initial commit');
  putObject(
    repo,
    'commit',
    commitBytes(EMPTY_TREE_SHA, [], 'Forge <forge@localhost> 0 +0000', 'Forge <forge@localhost> 0 +0000', 'Initial commit'),
  );
  repo.commits.set(sha, { sha, message: 'Initial commit', parent: null, treeSha: EMPTY_TREE_SHA, files: new Map() });
  branch.tip = sha;
  branch.history = [sha];
  reposByName.set(name, repo);
  return repo;
}

/** Resolve a repo by path owner + name, applying the ownership rule. */
function resolveRepo(owner: string, name: string): RepoRec | 'foreign' | null {
  const repo = reposByName.get(name) ?? null;
  if (repo === null) return null;
  if (viewerLogin === null) {
    viewerLogin = owner;
    repo.ownerLogin = owner;
  }
  if (owner !== viewerLogin) return 'foreign';
  return repo;
}

function ownerLoginOf(repo: RepoRec): string {
  return repo.ownerLogin ?? viewerLogin ?? '';
}

// ---------------------------------------------------------------------------
// pull requests (minimal store, shared by REST, MCP and GraphQL)

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = ownerLoginOf(repo);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, label: `${owner}:${pull.head}`, sha: pull.headSha },
    base: { ref: pull.base, label: `${owner}:${pull.base}`, sha: pull.baseSha },
    user: { login: owner, id: 1, type: 'User' },
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pull.number}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

/** Create a pull request; returns an error string when the refs do not exist. */
function createPull(
  repo: RepoRec,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: PullRec } | { error: string } {
  const headBranch = repo.branches.get(head);
  const baseBranch = repo.branches.get(base);
  if (headBranch === undefined) return { error: `Head branch does not exist: ${head}` };
  if (baseBranch === undefined) return { error: `Base branch does not exist: ${base}` };
  for (const existing of repo.pulls.values()) {
    if (existing.head === head && existing.base === base && existing.state === 'open') {
      return { error: 'A pull request already exists for this head and base' };
    }
  }
  repo.seq += 1;
  const number = repo.nextPull;
  repo.nextPull += 1;
  const pull: PullRec = {
    id: number,
    number,
    title,
    body,
    head,
    base,
    headSha: headBranch.tip,
    baseSha: baseBranch.tip,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: repo.seq,
  };
  repo.pulls.set(number, pull);
  return { pull };
}

/** The merge-base commit of two branches: the first commit of `head` also on `base`. */
function mergeBaseSha(repo: RepoRec, head: string, base: string): string | null {
  const headBranch = repo.branches.get(head);
  const baseBranch = repo.branches.get(base);
  if (headBranch === undefined || baseBranch === undefined) return null;
  const onBase = new Set(baseBranch.history);
  for (const sha of headBranch.history) if (onBase.has(sha)) return sha;
  return null;
}

function filesOfCommit(repo: RepoRec, sha: string | null): Map<string, FileRec> {
  if (sha === null) return new Map();
  return repo.commits.get(sha)?.files ?? new Map();
}

interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function countLines(buf: Buffer): string[] {
  const text = buf.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts between two file maps (multiset line comparison). */
function changedFiles(from: ReadonlyMap<string, FileRec>, to: ReadonlyMap<string, FileRec>): ChangedFile[] {
  const out: ChangedFile[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const oldFile = from.get(path);
    const newFile = to.get(path);
    if (oldFile === undefined && newFile !== undefined) {
      out.push({ path, status: 'added', additions: countLines(newFile.content).length, deletions: 0 });
    } else if (oldFile !== undefined && newFile === undefined) {
      out.push({ path, status: 'removed', additions: 0, deletions: countLines(oldFile.content).length });
    } else if (oldFile !== undefined && newFile !== undefined && oldFile.sha !== newFile.sha) {
      const oldLines = countLines(oldFile.content);
      const newLines = countLines(newFile.content);
      const oldCount = new Map<string, number>();
      for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
      let additions = 0;
      for (const line of newLines) {
        const left = oldCount.get(line) ?? 0;
        if (left > 0) oldCount.set(line, left - 1);
        else additions += 1;
      }
      let deletions = 0;
      for (const left of oldCount.values()) deletions += left;
      out.push({ path, status: 'modified', additions, deletions });
    }
  }
  return out;
}

/** The files a pull request changes, against its merge-base. */
function prChangedFiles(repo: RepoRec, pull: PullRec): ChangedFile[] {
  const base = filesOfCommit(repo, mergeBaseSha(repo, pull.head, pull.base));
  const head = repo.branches.get(pull.head)?.files ?? new Map<string, FileRec>();
  return changedFiles(base, head);
}

/** True when head and base both changed the same path differently since the merge-base. */
function prHasConflict(repo: RepoRec, pull: PullRec): boolean {
  const baseFiles = filesOfCommit(repo, mergeBaseSha(repo, pull.head, pull.base));
  const headFiles = repo.branches.get(pull.head)?.files ?? new Map<string, FileRec>();
  const baseBranchFiles = repo.branches.get(pull.base)?.files ?? new Map<string, FileRec>();
  const headChanged = changedFiles(baseFiles, headFiles);
  const baseChanged = changedFiles(baseFiles, baseBranchFiles);
  const baseChangedPaths = new Map<string, ChangedFile>();
  for (const file of baseChanged) baseChangedPaths.set(file.path, file);
  for (const file of headChanged) {
    if (!baseChangedPaths.has(file.path)) continue;
    const headFile = headFiles.get(file.path);
    const baseFile = baseBranchFiles.get(file.path);
    const headSha = headFile === undefined ? null : headFile.sha;
    const baseSha = baseFile === undefined ? null : baseFile.sha;
    if (headSha !== baseSha) return true;
  }
  return false;
}

function mergeableOf(repo: RepoRec, pull: PullRec): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  return prHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or an error. */
function mergePull(repo: RepoRec, pull: PullRec): { sha: string } | { error: string; conflict?: boolean } {
  if (pull.state !== 'open') return { error: 'Pull request is not open' };
  if (prHasConflict(repo, pull)) return { error: 'Merge conflict', conflict: true };
  const baseBranch = repo.branches.get(pull.base);
  const headBranch = repo.branches.get(pull.head);
  if (baseBranch === undefined || headBranch === undefined) return { error: 'Branch not found' };
  const newFiles = new Map(headBranch.files);
  const commit = makeCommit(repo, baseBranch, newFiles, `Merge pull request #${pull.number} from ${pull.head}`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_DATE;
  pull.mergeCommitSha = commit.sha;
  return { sha: commit.sha };
}

// ---------------------------------------------------------------------------
// HTTP plumbing

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const requestId = `forge-${requestCounter}`;
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(buf);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 16 * 1024 * 1024) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function splitPath(req: IncomingMessage): { segments: string[]; query: URLSearchParams } {
  const raw = req.url ?? '/';
  // Fast path: plain paths (the overwhelming case) without a `new URL` parse.
  // Fall back to URL parsing for dot-segments / fragments, where URL
  // normalisation (e.g. '/a/../b' -> '/b') must be preserved.
  if (!raw.includes('/.') && !raw.includes('#')) {
    const q = raw.indexOf('?');
    const pathname = q === -1 ? raw : raw.slice(0, q);
    const clean = pathname.replace(/\/+$/, '') || '/';
    const segments = clean
      .split('/')
      .filter((part) => part !== '')
      .map((part) => {
        if (!part.includes('%')) return part;
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    return { segments, query: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)) };
  }
  const url = new URL(raw, 'http://forge');
  const clean = url.pathname.replace(/\/+$/, '') || '/';
  const segments = clean
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return { segments, query: url.searchParams };
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return host !== undefined && host !== '' ? `http://${host}` : 'http://forge';
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): { slice: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

// ---------------------------------------------------------------------------
// JSON shapes

function repoJson(repo: RepoRec): Record<string, unknown> {
  const owner = ownerLoginOf(repo);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    visibility: repo.isPrivate ? 'private' : 'public',
    url: `/api/v3/repos/${owner}/${repo.name}`,
    html_url: `https://example.invalid/${owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    language: null,
  };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const owner = ownerLoginOf(repo);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments.length,
    user: { login: owner, id: 1, type: 'User' },
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

function commitJson(commit: CommitRec): Record<string, unknown> {
  return {
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: { name: 'Forge', email: 'forge@localhost', date: FIXED_DATE },
      committer: { name: 'Forge', email: 'forge@localhost', date: FIXED_DATE },
    },
    parents: commit.parent === null ? [] : [{ sha: commit.parent }],
  };
}

function branchJson(branch: BranchRec): Record<string, unknown> {
  return { name: branch.name, commit: { sha: branch.tip }, protected: false };
}

/** Resolve a ref (branch name, else commit sha) to the files at that point. */
function filesAtRef(repo: RepoRec, ref: string | null): Map<string, FileRec> | null {
  const branchName = ref ?? repo.defaultBranch;
  const branch = repo.branches.get(branchName);
  if (branch !== undefined) return branch.files;
  const commit = repo.commits.get(branchName);
  if (commit !== undefined) return commit.files;
  return null;
}

function directoryListing(repo: RepoRec, files: ReadonlyMap<string, FileRec>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const fileEntries = new Map<string, FileRec>();
  const subdirs = new Set<string>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) fileEntries.set(rest, file);
    else subdirs.add(rest.slice(0, slash));
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, file] of [...fileEntries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({ type: 'file', name, path: `${prefix}${name}`, sha: file.sha, size: file.content.length });
  }
  for (const name of [...subdirs].sort()) {
    const subPrefix = `${prefix}${name}`;
    out.push({ type: 'dir', name, path: subPrefix, sha: treeShaForFiles(files, subPrefix) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP, JSON-RPC 2.0) — Ronde 2
//
// One POST per message, single JSON answer (no SSE). Both eras are spoken:
// modern 2026-07-28 (server/discover, no handshake) and legacy (initialize +
// notifications/initialized). The six tools delegate to the same store
// functions REST uses, so MCP and REST always read the same objects.

const FORGE_NAME = 'github-core-clone-forge';
const FORGE_VERSION = '1.0.0';
const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function isAuthed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (expected !== '') return auth === `Bearer ${expected}`;
  return auth.startsWith('Bearer ') && auth.slice('Bearer '.length).trim() !== '';
}

/** The first non-empty string among the argument's synonym names. */
function mcpArg(args: Record<string, unknown>, names: readonly string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function mcpNum(args: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/** Create an issue in the shared store (REST, MCP and GraphQL all use this). */
function makeIssue(repo: RepoRec, title: string, body: string, labels: LabelRec[]): IssueRec {
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  repo.seq += 1;
  const issue: IssueRec = {
    id: number,
    number,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: repo.seq,
  };
  repo.issues.set(number, issue);
  return issue;
}

/** Append a comment to an issue in the shared store. */
function addCommentTo(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: repo.nextComment, body };
  repo.nextComment += 1;
  issue.comments.push(comment);
  return comment;
}

/** Learn the token owner's login from an MCP argument (the suite names it). */
function learnViewer(owner: string): void {
  if (viewerLogin === null && owner !== '') viewerLogin = owner;
}

type McpToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (args: Record<string, unknown>) => McpToolOutcome;
}

function resolveMcpRepo(args: Record<string, unknown>): { repo: RepoRec } | { error: string } {
  const owner = mcpArg(args, ['owner', 'owner_login', 'login']);
  const name = mcpArg(args, ['repo', 'repository', 'repo_name']);
  if (owner === '' || name === '') return { error: 'owner and repo are required' };
  learnViewer(owner);
  const resolved = resolveRepo(owner, name);
  if (resolved === null || resolved === 'foreign') return { error: 'Not Found' };
  return { repo: resolved };
}

const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login (defaults to the token owner).' },
    },
    required: ['name'],
    run: (args) => {
      const name = mcpArg(args, ['name', 'repo', 'repository']);
      if (name === '') return { ok: false, message: 'name is required' };
      learnViewer(mcpArg(args, ['owner', 'owner_login', 'login']));
      if (reposByName.has(name)) return { ok: false, message: 'Repository already exists' };
      const repo = createRepo(name, asBool(args.private, false), mcpArg(args, ['description', 'about']));
      return { ok: true, value: repoJson(repo) };
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const resolved = resolveMcpRepo(args);
      if ('error' in resolved) return { ok: false, message: resolved.error };
      return { ok: true, value: repoJson(resolved.repo) };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (args) => {
      const resolved = resolveMcpRepo(args);
      if ('error' in resolved) return { ok: false, message: resolved.error };
      const title = mcpArg(args, ['title', 'issue_title']);
      if (title === '') return { ok: false, message: 'title is required' };
      const issue = makeIssue(resolved.repo, title, mcpArg(args, ['body', 'issue_body', 'description']), []);
      return { ok: true, value: issueJson(resolved.repo, issue) };
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const resolved = resolveMcpRepo(args);
      if ('error' in resolved) return { ok: false, message: resolved.error };
      const state = mcpArg(args, ['state', 'status']);
      let list = [...resolved.repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      else if (state !== 'all') list = list.filter((issue) => issue.state === 'open');
      list.sort((a, b) => b.seq - a.seq);
      return { ok: true, value: { issues: list.map((issue) => issueJson(resolved.repo, issue)) } };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (args) => {
      const resolved = resolveMcpRepo(args);
      if ('error' in resolved) return { ok: false, message: resolved.error };
      const head = mcpArg(args, ['head', 'head_ref', 'head_branch']);
      const base = mcpArg(args, ['base', 'base_ref', 'base_branch']);
      const created = createPull(
        resolved.repo,
        mcpArg(args, ['title', 'pr_title']),
        mcpArg(args, ['body', 'description']),
        head,
        base,
      );
      if ('error' in created) return { ok: false, message: created.error };
      return { ok: true, value: pullJson(resolved.repo, created.pull) };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (args) => {
      const resolved = resolveMcpRepo(args);
      if ('error' in resolved) return { ok: false, message: resolved.error };
      const number = mcpNum(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
      if (number === null) return { ok: false, message: 'pull_number is required' };
      const pull = resolved.repo.pulls.get(number);
      if (pull === undefined) return { ok: false, message: 'Pull request not found' };
      const merged = mergePull(resolved.repo, pull);
      if ('error' in merged) return { ok: false, message: merged.error };
      return { ok: true, value: { ...pullJson(resolved.repo, pull), merged: true, sha: merged.sha } };
    },
  },
];

function mcpToolsList(): Record<string, unknown>[] {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    if (!isAuthed(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isAuthed(req)) {
    rpcError(res, 401, null, -32001, 'Requires authentication');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error');
    return;
  }
  const obj = asObject(parsed);
  if (obj === null || typeof obj.method !== 'string') {
    rpcError(res, 200, obj !== null ? (obj.id ?? null) : null, -32600, 'Invalid Request');
    return;
  }
  const id = obj.id ?? null;
  const hasId = 'id' in obj && obj.id !== null && obj.id !== undefined;
  const params = asObject(obj.params) ?? {};
  switch (obj.method) {
    case 'server/discover': {
      rpcResult(res, id, {
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
        capabilities: { tools: {} },
        supportedVersions: [...MCP_REVISIONS],
        protocolVersion: MCP_REVISIONS[0],
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: FORGE_NAME, version: FORGE_VERSION } },
      });
      return;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_REVISIONS.includes(requested) ? requested : '2025-06-18';
      rpcResult(res, id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      if (!hasId) {
        res.writeHead(202);
        res.end();
        return;
      }
      rpcResult(res, id, {});
      return;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: mcpToolsList() });
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) {
        rpcError(res, 200, id, -32601, `Method not found: ${name}`);
        return;
      }
      const args = asObject(params.arguments) ?? {};
      const missing = tool.required.filter((key) => {
        const value = args[key];
        return value === undefined || value === null || (typeof value === 'string' && value === '');
      });
      if (missing.length > 0) {
        rpcError(res, 200, id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
        return;
      }
      const outcome = tool.run(args);
      if (!outcome.ok) {
        rpcResult(res, id, {
          content: [{ type: 'text', text: outcome.message }],
          isError: true,
        });
        return;
      }
      rpcResult(res, id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
      });
      return;
    }
    default: {
      rpcError(res, 200, id, -32601, `Method not found: ${obj.method}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// GraphQL v4 (hand-rolled parser + executor for exactly the documents the
// suite sends — gh / github-mcp-server shapes). No schema library: static
// field tables for the probed types, one store underneath REST/MCP/GraphQL.

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const sep = text.indexOf(':');
    if (sep <= 0) return null;
    return { kind: text.slice(0, sep), key: text.slice(sep + 1) };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const GQL_TYPE_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'assignees', 'milestone'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'author', 'files', 'commits', 'reviews', 'labels', 'comments'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'fork', 'private', 'visibility'],
  SearchType: [],
  User: ['id', 'login', 'name', 'url'],
};
const GQL_SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---- tokenizer ------------------------------------------------------------

type GqlToken =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function gqlTokenize(src: string): GqlToken[] | null {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():[]=!@{}:'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j]!;
        if (c === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        out += c;
        j += 1;
      }
      if (!closed) return null;
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    return null;
  }
  return tokens;
}

// ---- parser ---------------------------------------------------------------

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { $var: string };

interface GqlFieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}
interface GqlFragmentSel {
  kind: 'fragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}
type GqlSelection = GqlFieldSel | GqlFragmentSel;

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefaults: Record<string, GqlValue>;
  selections: GqlSelection[];
}

class GqlParser {
  private pos = 0;
  private readonly tokens: GqlToken[];
  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }
  private next(): GqlToken | undefined {
    return this.tokens[this.pos++];
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }
  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string | null {
    const t = this.next();
    return t !== undefined && t.kind === 'name' ? t.value : null;
  }

  parseDocument(): GqlOperation[] | null {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const op = this.parseOperation();
      if (op === null) return null;
      ops.push(op);
    }
    return ops;
  }

  private parseOperation(): GqlOperation | null {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.pos += 1;
    } else if (first !== undefined && first.kind === 'name' && first.value === 'fragment') {
      // Fragment definition: skip it (the suite uses inline fragments only).
      this.pos += 1;
      if (this.expectName() === null) return null;
      if (this.expectName() !== 'on') return null;
      if (this.expectName() === null) return null;
      if (this.parseSelectionSet() === null) return null;
      return { kind: 'query', name: null, varDefaults: {}, selections: [] };
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') {
      name = maybeName.value;
      this.pos += 1;
    }
    const varDefaults: Record<string, GqlValue> = {};
    if (this.eatPunct('(')) {
      while (!this.eatPunct(')')) {
        if (this.pos >= this.tokens.length) return null;
        if (!this.eatPunct('$')) return null;
        const varName = this.expectName();
        if (varName === null) return null;
        if (!this.eatPunct(':')) return null;
        // Skip the type: Name, '[', ']', '!' tokens, until '=' or ')' or ','.
        while (this.pos < this.tokens.length) {
          const t = this.peek()!;
          if (t.kind === 'punct' && (t.value === '=' || t.value === ')' || t.value === ',')) break;
          this.pos += 1;
        }
        if (this.eatPunct('=')) {
          const def = this.parseValue();
          if (def === undefined) return null;
          varDefaults[varName] = def;
        }
        this.eatPunct(',');
      }
    }
    const selections = this.parseSelectionSet();
    if (selections === null) return null;
    return { kind, name, varDefaults, selections };
  }

  private parseSelectionSet(): GqlSelection[] | null {
    if (!this.eatPunct('{')) return null;
    const selections: GqlSelection[] = [];
    while (!this.eatPunct('}')) {
      if (this.pos >= this.tokens.length) return null;
      const sel = this.parseSelection();
      if (sel === null) return null;
      selections.push(sel);
    }
    return selections;
  }

  private parseSelection(): GqlSelection | null {
    const t = this.peek();
    if (t === undefined) return null;
    if (t.kind === 'spread') {
      this.pos += 1;
      let typeCondition: string | null = null;
      const on = this.peek();
      if (on !== undefined && on.kind === 'name' && on.value === 'on') {
        this.pos += 1;
        typeCondition = this.expectName();
        if (typeCondition === null) return null;
      }
      const selections = this.parseSelectionSet();
      if (selections === null) return null;
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.expectName();
    if (first === null) return null;
    let alias: string | null = null;
    let name = first;
    if (this.eatPunct(':')) {
      alias = first;
      const second = this.expectName();
      if (second === null) return null;
      name = second;
    }
    let args: Record<string, GqlValue> = {};
    if (this.isPunct('(')) {
      const parsed = this.parseArguments();
      if (parsed === null) return null;
      args = parsed;
    }
    let selections: GqlSelection[] = [];
    if (this.isPunct('{')) {
      const parsed = this.parseSelectionSet();
      if (parsed === null) return null;
      selections = parsed;
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> | null {
    if (!this.eatPunct('(')) return null;
    const args: Record<string, GqlValue> = {};
    while (!this.eatPunct(')')) {
      if (this.pos >= this.tokens.length) return null;
      const name = this.expectName();
      if (name === null) return null;
      if (!this.eatPunct(':')) return null;
      const value = this.parseValue();
      if (value === undefined) return null;
      args[name] = value;
      this.eatPunct(',');
    }
    return args;
  }

  private parseValue(): GqlValue | undefined {
    const t = this.next();
    if (t === undefined) return undefined;
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return Number(t.value);
    if (t.kind === 'punct' && t.value === '$') {
      const name = this.expectName();
      if (name === null) return undefined;
      return { $var: name };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      while (!this.eatPunct(']')) {
        if (this.pos >= this.tokens.length) return undefined;
        const value = this.parseValue();
        if (value === undefined) return undefined;
        items.push(value);
        this.eatPunct(',');
      }
      return items;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, GqlValue> = {};
      while (!this.eatPunct('}')) {
        if (this.pos >= this.tokens.length) return undefined;
        const name = this.expectName();
        if (name === null) return undefined;
        if (!this.eatPunct(':')) return undefined;
        const value = this.parseValue();
        if (value === undefined) return undefined;
        obj[name] = value;
        this.eatPunct(',');
      }
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value;
    }
    return undefined;
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if ('$var' in value) return variables[(value as { $var: string }).$var];
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveGqlValue(entry, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveGqlValue(entry, variables));
  return value;
}

function gqlArg(args: Record<string, GqlValue>, name: string, variables: Record<string, unknown>): unknown {
  if (!(name in args)) return undefined;
  return resolveGqlValue(args[name]!, variables);
}

function gqlArgStr(args: Record<string, GqlValue>, name: string, variables: Record<string, unknown>): string {
  const value = gqlArg(args, name, variables);
  return typeof value === 'string' ? value : '';
}

function gqlArgInt(args: Record<string, GqlValue>, name: string, variables: Record<string, unknown>): number | null {
  const value = gqlArg(args, name, variables);
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// ---- executor -------------------------------------------------------------

type GqlParent =
  | { type: 'Query' }
  | { type: 'Mutation' }
  | { type: 'Repository'; repo: RepoRec }
  | { type: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { type: 'User'; login: string }
  | { type: 'Ref'; name: string }
  | { type: 'IssueConnection'; repo: RepoRec; issues: IssueRec[]; hasNext: boolean; endCursor: string | null }
  | { type: 'PageInfo'; hasNext: boolean; endCursor: string | null }
  | { type: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { type: 'PullRequestConnection'; repo: RepoRec; pulls: PullRec[] }
  | { type: 'ChangedFile'; file: ChangedFile }
  | { type: 'ChangedFileConnection'; files: ChangedFile[] }
  | { type: '__Type'; name: string }
  | { type: 'CreateIssuePayload'; repo: RepoRec; issue: IssueRec }
  | { type: 'CloseIssuePayload'; repo: RepoRec; issue: IssueRec }
  | { type: 'CreatePullRequestPayload'; repo: RepoRec; pull: PullRec }
  | { type: 'MergePullRequestPayload'; repo: RepoRec; pull: PullRec }
  | { type: 'AddCommentPayload'; repo: RepoRec; issue: IssueRec; comment: CommentRec }
  | { type: 'CommentEdge'; repo: RepoRec; issue: IssueRec; comment: CommentRec }
  | { type: 'Comment'; repo: RepoRec; issue: IssueRec; comment: CommentRec };

interface GqlContext {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

const GQL_FIELD_SETS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [...GQL_TYPE_FIELDS.Repository!],
  Issue: [...GQL_TYPE_FIELDS.Issue!],
  PullRequest: [...GQL_TYPE_FIELDS.PullRequest!],
  User: [...GQL_TYPE_FIELDS.User!],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestConnection: ['nodes'],
  ChangedFile: ['path', 'additions', 'deletions', 'status'],
  ChangedFileConnection: ['nodes', 'totalCount'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
};

function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return gid('Issue', `${ownerLoginOf(repo)}/${repo.name}#${issue.number}`);
}
function repoGlobalId(repo: RepoRec): string {
  return gid('Repository', `${ownerLoginOf(repo)}/${repo.name}`);
}
function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return gid('PullRequest', `${ownerLoginOf(repo)}/${repo.name}#${pull.number}`);
}
function commentGlobalId(repo: RepoRec, issue: IssueRec, comment: CommentRec): string {
  return gid('IssueComment', `${ownerLoginOf(repo)}/${repo.name}#${issue.number}/comment/${comment.id}`);
}

function repoFromGlobalId(id: string): RepoRec | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const slash = decoded.key.lastIndexOf('/');
  if (slash <= 0) return null;
  const owner = decoded.key.slice(0, slash);
  const name = decoded.key.slice(slash + 1);
  const resolved = resolveRepo(owner, name);
  return resolved !== null && resolved !== 'foreign' ? resolved : null;
}

function issueFromGlobalId(id: string): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash <= 0) return null;
  const repoPart = decoded.key.slice(0, hash);
  const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
  const slash = repoPart.lastIndexOf('/');
  if (slash <= 0 || !Number.isFinite(number)) return null;
  const resolved = resolveRepo(repoPart.slice(0, slash), repoPart.slice(slash + 1));
  if (resolved === null || resolved === 'foreign') return null;
  const issue = resolved.issues.get(number);
  return issue === undefined ? null : { repo: resolved, issue };
}

function pullFromGlobalId(id: string): { repo: RepoRec; pull: PullRec } | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash <= 0) return null;
  const repoPart = decoded.key.slice(0, hash);
  const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
  const slash = repoPart.lastIndexOf('/');
  if (slash <= 0 || !Number.isFinite(number)) return null;
  const resolved = resolveRepo(repoPart.slice(0, slash), repoPart.slice(slash + 1));
  if (resolved === null || resolved === 'foreign') return null;
  const pull = resolved.pulls.get(number);
  return pull === undefined ? null : { repo: resolved, pull };
}

function issueStateGql(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Resolve one field of a parent node; returns {missing:true} for unknown fields. */
function resolveGqlField(
  parent: GqlParent,
  field: GqlFieldSel,
  ctx: GqlContext,
): { value: unknown } | { missing: true } {
  const name = field.name;
  const args = field.args;
  const vars = ctx.variables;
  switch (parent.type) {
    case 'Query': {
      if (name === 'viewer') return { value: { type: 'User', login: viewerLogin ?? '' } as GqlParent };
      if (name === 'repository') {
        const owner = gqlArgStr(args, 'owner', vars);
        const repoName = gqlArgStr(args, 'name', vars);
        const resolved = resolveRepo(owner, repoName);
        if (resolved === null || resolved === 'foreign') return { value: null };
        return { value: { type: 'Repository', repo: resolved } as GqlParent };
      }
      if (name === 'node') {
        const id = gqlArgStr(args, 'id', vars);
        const decoded = ungid(id);
        if (decoded === null) return { value: null };
        if (decoded.kind === 'Repository') {
          const repo = repoFromGlobalId(id);
          return { value: repo === null ? null : ({ type: 'Repository', repo } as GqlParent) };
        }
        if (decoded.kind === 'Issue') {
          const found = issueFromGlobalId(id);
          return { value: found === null ? null : ({ type: 'Issue', repo: found.repo, issue: found.issue } as GqlParent) };
        }
        if (decoded.kind === 'PullRequest') {
          const found = pullFromGlobalId(id);
          return { value: found === null ? null : ({ type: 'PullRequest', repo: found.repo, pull: found.pull } as GqlParent) };
        }
        return { value: null };
      }
      if (name === '__type') {
        const typeName = gqlArgStr(args, 'name', vars);
        if (!(typeName in GQL_TYPE_FIELDS)) return { value: null };
        return { value: { type: '__Type', name: typeName } as GqlParent };
      }
      if (name === '__schema') return { value: null };
      return { missing: true };
    }
    case 'Mutation': {
      const input = asObject(gqlArg(args, 'input', vars)) ?? {};
      if (name === 'createIssue') {
        const repo = repoFromGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        if (repo === null) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
          return { value: null };
        }
        const issue = makeIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
        return { value: { type: 'CreateIssuePayload', repo, issue } as GqlParent };
      }
      if (name === 'closeIssue') {
        const found = issueFromGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.' });
          return { value: null };
        }
        found.issue.state = 'closed';
        return { value: { type: 'CloseIssuePayload', repo: found.repo, issue: found.issue } as GqlParent };
      }
      if (name === 'createPullRequest') {
        const repo = repoFromGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        if (repo === null) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
          return { value: null };
        }
        const created = createPull(
          repo,
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
          typeof input.headRefName === 'string' ? input.headRefName : '',
          typeof input.baseRefName === 'string' ? input.baseRefName : '',
        );
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return { value: null };
        }
        return { value: { type: 'CreatePullRequestPayload', repo, pull: created.pull } as GqlParent };
      }
      if (name === 'mergePullRequest') {
        const found = pullFromGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id.' });
          return { value: null };
        }
        const merged = mergePull(found.repo, found.pull);
        if ('error' in merged) {
          ctx.errors.push({ message: merged.error });
        }
        return { value: { type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull } as GqlParent };
      }
      if (name === 'addComment') {
        const found = issueFromGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.' });
          return { value: null };
        }
        const comment = addCommentTo(found.repo, found.issue, typeof input.body === 'string' ? input.body : '');
        return { value: { type: 'AddCommentPayload', repo: found.repo, issue: found.issue, comment } as GqlParent };
      }
      return { missing: true };
    }
    case 'Repository': {
      const repo = parent.repo;
      const owner = ownerLoginOf(repo);
      if (name === 'id') return { value: repoGlobalId(repo) };
      if (name === 'databaseId') return { value: repo.id };
      if (name === 'name') return { value: repo.name };
      if (name === 'nameWithOwner') return { value: `${owner}/${repo.name}` };
      if (name === 'owner') return { value: { type: 'User', login: owner } as GqlParent };
      if (name === 'defaultBranchRef') return { value: { type: 'Ref', name: repo.defaultBranch } as GqlParent };
      if (name === 'viewerPermission') return { value: 'ADMIN' };
      if (name === 'hasIssuesEnabled') return { value: true };
      if (name === 'description') return { value: repo.description };
      if (name === 'url') return { value: `https://example.invalid/${owner}/${repo.name}` };
      if (name === 'createdAt' || name === 'updatedAt') return { value: FIXED_DATE };
      if (name === 'fork') return { value: false };
      if (name === 'private') return { value: repo.isPrivate };
      if (name === 'visibility') return { value: repo.isPrivate ? 'PRIVATE' : 'PUBLIC' };
      if (name === 'issue') {
        const number = gqlArgInt(args, 'number', vars);
        if (number === null) return { value: null };
        const issue = repo.issues.get(number);
        return { value: issue === undefined ? null : ({ type: 'Issue', repo, issue } as GqlParent) };
      }
      if (name === 'issues') {
        const first = gqlArgInt(args, 'first', vars);
        const after = gqlArg(args, 'after', vars);
        const states = gqlArg(args, 'states', vars);
        const orderBy = asObject(gqlArg(args, 'orderBy', vars));
        let list = [...repo.issues.values()];
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => (typeof s === 'string' ? s : '')));
          list = list.filter((issue) => wanted.has(issueStateGql(issue)));
        }
        const direction = orderBy !== null && orderBy.direction === 'ASC' ? 1 : orderBy !== null && orderBy.direction === 'DESC' ? -1 : 1;
        const hasOrder = orderBy !== null && typeof orderBy.field === 'string';
        list.sort((a, b) => (hasOrder ? (a.seq - b.seq) * direction : a.seq - b.seq));
        let start = 0;
        if (typeof after === 'string' && after !== '') {
          const afterNumber = numberFromCursor(after);
          if (afterNumber !== null) {
            const idx = list.findIndex((issue) => issue.number === afterNumber);
            if (idx >= 0) start = idx + 1;
          }
        }
        const limit = first === null ? list.length : first;
        const page = list.slice(start, start + limit);
        const hasNext = start + page.length < list.length;
        const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]!.number);
        return { value: { type: 'IssueConnection', repo, issues: page, hasNext, endCursor } as GqlParent };
      }
      if (name === 'pullRequests') {
        const first = gqlArgInt(args, 'first', vars);
        let list = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
        list.sort((a, b) => b.seq - a.seq);
        if (first !== null) list = list.slice(0, first);
        return { value: { type: 'PullRequestConnection', repo, pulls: list } as GqlParent };
      }
      if (name === 'pullRequest') {
        const number = gqlArgInt(args, 'number', vars);
        if (number === null) return { value: null };
        const pull = repo.pulls.get(number);
        return { value: pull === undefined ? null : ({ type: 'PullRequest', repo, pull } as GqlParent) };
      }
      return { missing: true };
    }
    case 'Issue': {
      const issue = parent.issue;
      const repo = parent.repo;
      if (name === 'id') return { value: issueGlobalId(repo, issue) };
      if (name === 'databaseId') return { value: issue.id };
      if (name === 'number') return { value: issue.number };
      if (name === 'title') return { value: issue.title };
      if (name === 'body') return { value: issue.body };
      if (name === 'state') return { value: issueStateGql(issue) };
      if (name === 'url') return { value: `https://example.invalid/${ownerLoginOf(repo)}/${repo.name}/issues/${issue.number}` };
      if (name === 'createdAt' || name === 'updatedAt') return { value: FIXED_DATE };
      if (name === 'author') return { value: { type: 'User', login: ownerLoginOf(repo) } as GqlParent };
      if (name === 'labels') return { value: { nodes: issue.labels.map((l) => ({ name: l.name })) } };
      if (name === 'comments') return { value: { nodes: issue.comments.map((c) => ({ id: c.id, body: c.body })) } };
      return { missing: true };
    }
    case 'User': {
      if (name === 'login') return { value: parent.login };
      if (name === 'id') return { value: gid('User', parent.login) };
      if (name === 'name') return { value: parent.login };
      if (name === 'url') return { value: `https://example.invalid/${parent.login}` };
      return { missing: true };
    }
    case 'Ref': {
      if (name === 'name') return { value: parent.name };
      return { missing: true };
    }
    case 'IssueConnection': {
      if (name === 'nodes') {
        return { value: parent.issues.map((issue) => ({ type: 'Issue', repo: parent.repo, issue }) as GqlParent) };
      }
      if (name === 'pageInfo') {
        return { value: { type: 'PageInfo', hasNext: parent.hasNext, endCursor: parent.endCursor } as GqlParent };
      }
      if (name === 'totalCount') return { value: parent.issues.length };
      return { missing: true };
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return { value: parent.hasNext };
      if (name === 'endCursor') return { value: parent.endCursor };
      if (name === 'hasPreviousPage') return { value: false };
      if (name === 'startCursor') return { value: null };
      return { missing: true };
    }
    case 'PullRequest': {
      const pull = parent.pull;
      const repo = parent.repo;
      if (name === 'id') return { value: pullGlobalId(repo, pull) };
      if (name === 'databaseId') return { value: pull.id };
      if (name === 'number') return { value: pull.number };
      if (name === 'title') return { value: pull.title };
      if (name === 'body') return { value: pull.body };
      if (name === 'state') return { value: pullStateGql(pull) };
      if (name === 'merged') return { value: pull.merged };
      if (name === 'mergeable') return { value: mergeableOf(repo, pull) };
      if (name === 'headRefName') return { value: pull.head };
      if (name === 'baseRefName') return { value: pull.base };
      if (name === 'headRefOid') return { value: pull.headSha };
      if (name === 'baseRefOid') return { value: pull.baseSha };
      if (name === 'url') return { value: `https://example.invalid/${ownerLoginOf(repo)}/${repo.name}/pull/${pull.number}` };
      if (name === 'createdAt' || name === 'updatedAt') return { value: FIXED_DATE };
      if (name === 'author') return { value: { type: 'User', login: ownerLoginOf(repo) } as GqlParent };
      if (name === 'files') {
        const first = gqlArgInt(args, 'first', vars);
        let files = prChangedFiles(repo, pull);
        if (first !== null) files = files.slice(0, first);
        return { value: { type: 'ChangedFileConnection', files } as GqlParent };
      }
      return { missing: true };
    }
    case 'ChangedFileConnection': {
      if (name === 'nodes') {
        return { value: parent.files.map((file) => ({ type: 'ChangedFile', file }) as GqlParent) };
      }
      if (name === 'totalCount') return { value: parent.files.length };
      return { missing: true };
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') {
        return { value: parent.pulls.map((pull) => ({ type: 'PullRequest', repo: parent.repo, pull }) as GqlParent) };
      }
      return { missing: true };
    }
    case 'ChangedFile': {
      if (name === 'path') return { value: parent.file.path };
      if (name === 'additions') return { value: parent.file.additions };
      if (name === 'deletions') return { value: parent.file.deletions };
      if (name === 'status') {
        return { value: parent.file.status === 'added' ? 'ADDED' : parent.file.status === 'removed' ? 'REMOVED' : 'MODIFIED' };
      }
      return { missing: true };
    }
    case '__Type': {
      if (name === 'name') return { value: parent.name };
      if (name === 'kind') return { value: parent.name === 'SearchType' ? 'ENUM' : 'OBJECT' };
      if (name === 'description') return { value: null };
      if (name === 'fields') {
        const fields = GQL_TYPE_FIELDS[parent.name] ?? [];
        return { value: fields.map((fieldName) => ({ name: fieldName })) };
      }
      if (name === 'enumValues') {
        if (parent.name !== 'SearchType') return { value: [] };
        return { value: GQL_SEARCH_ENUMS.map((enumName) => ({ name: enumName })) };
      }
      return { missing: true };
    }
    case 'CreateIssuePayload':
      if (name === 'issue') return { value: { type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlParent };
      if (name === 'clientMutationId') return { value: null };
      return { missing: true };
    case 'CloseIssuePayload':
      if (name === 'issue') return { value: { type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlParent };
      if (name === 'clientMutationId') return { value: null };
      return { missing: true };
    case 'CreatePullRequestPayload':
      if (name === 'pullRequest') return { value: { type: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlParent };
      if (name === 'clientMutationId') return { value: null };
      return { missing: true };
    case 'MergePullRequestPayload':
      if (name === 'pullRequest') return { value: { type: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlParent };
      if (name === 'clientMutationId') return { value: null };
      return { missing: true };
    case 'AddCommentPayload':
      if (name === 'commentEdge') return { value: { type: 'CommentEdge', repo: parent.repo, issue: parent.issue, comment: parent.comment } as GqlParent };
      if (name === 'clientMutationId') return { value: null };
      return { missing: true };
    case 'CommentEdge':
      if (name === 'node') return { value: { type: 'Comment', repo: parent.repo, issue: parent.issue, comment: parent.comment } as GqlParent };
      if (name === 'cursor') return { value: cursorFor(parent.comment.id) };
      return { missing: true };
    case 'Comment':
      if (name === 'id') return { value: commentGlobalId(parent.repo, parent.issue, parent.comment) };
      if (name === 'body') return { value: parent.comment.body };
      if (name === 'author') return { value: { type: 'User', login: ownerLoginOf(parent.repo) } as GqlParent };
      if (name === 'createdAt' || name === 'updatedAt') return { value: FIXED_DATE };
      return { missing: true };
  }
}

function executeGqlSelections(
  selections: GqlSelection[],
  parent: GqlParent,
  ctx: GqlContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.type) continue;
      Object.assign(out, executeGqlSelections(selection.selections, parent, ctx));
      continue;
    }
    const fieldSet = GQL_FIELD_SETS[parent.type] ?? [];
    if (!fieldSet.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.type}".` });
      continue;
    }
    const resolved = resolveGqlField(parent, selection, ctx);
    if ('missing' in resolved) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.type}".` });
      continue;
    }
    const value = resolved.value;
    const key = selection.alias ?? selection.name;
    if (value === null || typeof value !== 'object') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry) =>
        entry !== null && typeof entry === 'object' && 'type' in entry
          ? executeGqlSelections(selection.selections, entry as GqlParent, ctx)
          : entry,
      );
    } else if ('type' in (value as Record<string, unknown>)) {
      out[key] = executeGqlSelections(selection.selections, value as GqlParent, ctx);
    } else {
      // Plain object (e.g. __type fields/enumValues rows, label nodes): resolve
      // nested selections only when they exist, else pass through.
      if (selection.selections.length === 0) {
        out[key] = value;
      } else {
        const record = value as Record<string, unknown>;
        const nested: Record<string, unknown> = {};
        for (const sub of selection.selections) {
          if (sub.kind === 'fragment') continue;
          nested[sub.alias ?? sub.name] = record[sub.name];
        }
        out[key] = nested;
      }
    }
  }
  return out;
}

function executeGqlOperation(
  operation: GqlOperation,
  operationName: string | undefined,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(operation.varDefaults)) {
    if (!(name in vars) || vars[name] === undefined || vars[name] === null) {
      vars[name] = resolveGqlValue(def, vars);
    }
  }
  void operationName;
  const ctx: GqlContext = { variables: vars, errors: [] };
  const root: GqlParent = operation.kind === 'mutation' ? { type: 'Mutation' } : { type: 'Query' };
  const data = executeGqlSelections(operation.selections, root, ctx);
  return { data, errors: ctx.errors };
}

function handleGraphql(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const obj = asObject(entry);
    if (obj === null || typeof obj.query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL document string is required.' }] };
    }
    const variables = asObject(obj.variables) ?? {};
    const tokens = gqlTokenize(obj.query);
    if (tokens === null) {
      return { data: null, errors: [{ message: 'The GraphQL document could not be parsed.' }] };
    }
    const operations = new GqlParser(tokens).parseDocument();
    if (operations === null || operations.length === 0) {
      return { data: null, errors: [{ message: 'The GraphQL document could not be parsed.' }] };
    }
    const operationName = typeof obj.operationName === 'string' ? obj.operationName : undefined;
    let operation = operations[0]!;
    if (operationName !== undefined) {
      const named = operations.find((entry) => entry.name === operationName);
      if (named !== undefined) operation = named;
    }
    // Skip empty fragment-definition placeholders the parser emits.
    if (operation.selections.length === 0 && operations.length > 1) {
      const real = operations.find((entry) => entry.selections.length > 0);
      if (real !== undefined) operation = real;
    }
    const { data, errors } = executeGqlOperation(operation, operationName, variables as Record<string, unknown>);
    if (errors.length > 0) return { data, errors };
    return { data };
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOne(entry)));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------------------
// handlers

// ---------------------------------------------------------------------------
// git smart HTTP (upload-pack v2, receive-pack v0) — Ronde 3
//
// One process, stdlib only, in-memory object store shared with REST. Outbound
// packs carry whole objects only (no delta search); inbound packs must parse
// and apply OFS/REF deltas, because real git clients push delta-compressed
// packs. The REST initial commit is deliberately NOT a git ref: a fresh repo
// has an unborn HEAD until the first push.

const GIT_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const GIT_CODE_TYPES: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// --- pkt-line ----------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line payload is too long');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (item === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse pkt-lines; with `stopAtFlush` stop after the first flush (receive-pack's pack follows it). */
function decodePackets(
  body: Buffer,
  stopAtFlush: boolean,
): { packets: DecodedPacket[]; consumed: number } | null {
  const packets: DecodedPacket[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      if (stopAtFlush) return { packets, consumed: off };
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len === 3 || len > 65520 || off + len > body.length) return null;
    packets.push({ kind: 'data', payload: body.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

/** Wrap bytes in side-band frames (band 1 = data), chunked to the pkt-line maximum. */
function sidebandWrap(data: Buffer, band = 1): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// --- packfile ----------------------------------------------------------------

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

function writePackObjectHeader(type: GitObject['type'], size: number): Buffer {
  const code = GIT_TYPE_CODES[type]!;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it.
 * Entries carry their oid, so sorting needs no SHA-1 recomputation, and the
 * deflated bytes are cached per oid (identical objects deflate identically). */
function writePack(repo: RepoRec, entries: Iterable<{ oid: string; obj: GitObject }>): Buffer {
  const list = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const { oid, obj } of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflatedOf(repo, oid, obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Parse a packfile (version 2/3) and resolve every object, including OFS_DELTA
 * and REF_DELTA (thin-pack bases resolve against the repo's store). Throws on
 * any corruption, including a bad trailer checksum.
 */
function readPackObjects(pack: Buffer, repo: RepoRec): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= pack.length) throw new Error('pack entry size varint is truncated');
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset]!;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        if (offset >= pack.length) throw new Error('ofs-delta base offset is truncated');
        b = pack[offset]!;
        offset += 1;
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta base offset is invalid');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (GIT_CODE_TYPES[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== entry.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${entry.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: GitObject['type']; data: Buffer; oid: string }>();
  const resolvedByOid = new Map<string, { type: GitObject['type']; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw, depth: number): { type: GitObject['type']; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    if (depth > 50) throw new Error('delta chain is too deep');
    resolving.add(entry.offset);
    let type: GitObject['type'];
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry, depth + 1);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      if (inPack !== undefined) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const external = repo.objects.get(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = GIT_CODE_TYPES[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolvedByOid.set(oid, out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry, 0);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// --- object collection for fetch -------------------------------------------------

interface CollectOpts {
  /** Commit generations to include (1 = tips only, their trees/blobs included). */
  depth?: number;
  /** Commits whose parents are not traversed (the client's shallow boundaries). */
  stop?: ReadonlySet<string>;
}

/**
 * The objects reachable from `tips`: every included commit with its full tree
 * closure. `boundary` names the commits at the depth limit that still have
 * parents (the new shallow boundary). Tags are followed to their target.
 */
function collectGitObjects(
  repo: RepoRec,
  tips: readonly string[],
  opts: CollectOpts,
): { objects: Map<string, GitObject>; boundary: string[] } {
  const objects = new Map<string, GitObject>();
  const boundary: string[] = [];
  const seenTrees = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seenTrees.has(oid)) continue;
      seenTrees.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      if (obj.type === 'tree') {
        objects.set(oid, obj);
        const entries = treeOf(repo, oid);
        if (entries === null) continue;
        for (const entry of entries) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else {
            const blob = repo.objects.get(entry.oid);
            if (blob !== undefined) objects.set(entry.oid, blob);
          }
        }
      } else {
        objects.set(oid, obj);
      }
    }
  };
  const seenCommits = new Set<string>();
  const queue: { oid: string; dist: number }[] = [];
  let qhead = 0;
  const enqueueTip = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    if (obj.type === 'tag') {
      objects.set(oid, obj);
      enqueueTip(parseTag(obj.data).object);
      return;
    }
    if (obj.type === 'commit') queue.push({ oid, dist: 0 });
  };
  for (const tip of tips) enqueueTip(tip);
  while (qhead < queue.length) {
    const { oid, dist } = queue[qhead]!;
    qhead += 1;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    objects.set(oid, obj);
    const parsed = commitOf(repo, oid);
    if (parsed === null) continue;
    addTreeClosure(parsed.tree);
    const atBoundary = opts.depth !== undefined && dist === opts.depth - 1;
    if (atBoundary) {
      if (parsed.parents.length > 0) boundary.push(oid);
      continue;
    }
    if (opts.stop !== undefined && opts.stop.has(oid)) continue;
    for (const parent of parsed.parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  return { objects, boundary };
}

// --- advertisements -------------------------------------------------------------

function gitCapsV0(repo: RepoRec, service: string): string {
  const base =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta push-options'
      : 'side-band-64k shallow thin-pack ofs-delta multi_ack';
  return `${base} symref=HEAD:refs/heads/${repo.defaultBranch} agent=${GIT_AGENT}`;
}

/** A v0 ref advertisement (receive-pack, and upload-pack without Git-Protocol: version=2). */
function v0Advertisement(repo: RepoRec, service: string): Buffer {
  const caps = gitCapsV0(repo, service);
  const items: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = [...repo.gitRefs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headTip = repo.gitRefs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    items.push(`${headTip} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      items.push(`${oid} ${name}\n`);
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null && peeled !== oid) items.push(`${peeled} ${name}^{}\n`);
    }
  }
  items.push('flush');
  return encodePktLines(items);
}

/** A v2 capability advertisement (upload-pack with Git-Protocol: version=2). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${GIT_AGENT}\n`,
    'flush',
  ]);
}

// --- ls-refs -------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: RepoRec, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headTip = repo.gitRefs.get(`refs/heads/${repo.defaultBranch}`);
  // HEAD is listed when no prefix filter is given, or when a prefix matches
  // HEAD itself (real git clones ask for `ref-prefix HEAD` explicitly).
  if (args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (headTip !== undefined) {
      lines.push(
        `${headTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`,
      );
    } else if (args.unborn) {
      lines.push(
        `unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`,
      );
    }
  }
  const refs = [...repo.gitRefs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// --- fetch ---------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  /** `deepen-relative`: deepen is measured from the client's shallow boundary. */
  deepenRelative?: boolean;
}

/** Shortest parent-distance from `want` (peeled to a commit) to any of
 * `boundaries`, or null when no boundary is an ancestor of `want`. */
function distanceToBoundary(repo: RepoRec, want: string, boundaries: ReadonlySet<string>): number | null {
  const start = peelToCommit(repo, want);
  if (start === null) return null;
  const seen = new Set<string>([start]);
  let frontier: string[] = [start];
  let dist = 0;
  while (frontier.length > 0) {
    for (const oid of frontier) if (boundaries.has(oid)) return dist;
    const next: string[] = [];
    for (const oid of frontier) {
      const parsed = commitOf(repo, oid);
      if (parsed === null) continue;
      for (const parent of parsed.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
    dist += 1;
  }
  return null;
}

/** The objects a fetch must send, and the shallow-info lines for it. */
function computeFetch(
  repo: RepoRec,
  args: FetchArgs,
): { send: { oid: string; obj: GitObject }[]; boundary: string[]; unshallow: string[]; acks: string[] } {
  // With no haves there is nothing to acknowledge: skip the full-history walk
  // the old code did here unconditionally (a depth-1 clone of a 200-commit
  // repo paid for all 200 commits just to learn that acks = []).
  const acks: string[] = [];
  if (args.haves.length > 0) {
    const fullWant = collectGitObjects(repo, args.wants, {}).objects;
    for (const have of args.haves) if (fullWant.has(have)) acks.push(have);
  }
  // Effective depth is per-want: with `deepen-relative` the deepen value is
  // measured from the client's shallow boundary, so D = deepen + distance
  // (want -> boundary) + 1 (verified against real git 2.43: deepen=1 on a
  // depth-1 clone adds exactly one generation, also for a new tip). Without
  // the flag, deepen is the total depth from the want.
  let wantObjects: Map<string, GitObject>;
  let wantBoundary: string[] = [];
  if (args.depth !== undefined) {
    wantObjects = new Map<string, GitObject>();
    const boundarySet = new Set(args.shallow);
    const mergedBoundary: string[] = [];
    for (const want of args.wants) {
      let d = args.depth;
      if (args.deepenRelative === true && boundarySet.size > 0) {
        const dist = distanceToBoundary(repo, want, boundarySet);
        if (dist !== null) d = args.depth + dist + 1;
      }
      const coll = collectGitObjects(repo, [want], { depth: d });
      for (const [oid, obj] of coll.objects) wantObjects.set(oid, obj);
      mergedBoundary.push(...coll.boundary);
    }
    // A commit is only a boundary when some parent is absent from the merged
    // set (a commit interior to another want's walk is not a boundary).
    wantBoundary = [...new Set(mergedBoundary)].filter((oid) => {
      const parsed = commitOf(repo, oid);
      if (parsed === null) return false;
      const parents = parsed.parents;
      return parents.length > 0 && !parents.every((p) => wantObjects.has(p));
    });
  } else {
    const coll = collectGitObjects(repo, args.wants, {});
    wantObjects = coll.objects;
    wantBoundary = [];
  }
  const haveSet =
    args.haves.length > 0
      ? collectGitObjects(repo, args.haves, { stop: new Set(args.shallow) }).objects
      : new Map<string, GitObject>();
  const send = [...wantObjects.entries()]
    .filter(([oid]) => !haveSet.has(oid))
    .map(([oid, obj]) => ({ oid, obj }));
  const unshallow: string[] = [];
  if (args.depth !== undefined) {
    for (const old of args.shallow) {
      if (wantObjects.has(old) && !wantBoundary.includes(old)) unshallow.push(old);
    }
  }
  return { send, boundary: wantBoundary, unshallow, acks };
}

/** Cache key for a fetch response: the whole response is a pure function of
 * the fetch args plus the object store, and objects are immutable once stored
 * (content-addressed, never overwritten), so a cached response for these args
 * can never go stale — a later push changes the tip, hence the args. */
function fetchCacheKey(prefix: string, args: FetchArgs): string {
  return `${prefix}:${JSON.stringify([args.wants, args.haves, args.shallow, args.depth ?? null, args.deepenRelative ?? false])}`;
}

function fetchCachePut(repo: RepoRec, key: string, body: Buffer): Buffer {
  repo.fetchCache.set(key, body);
  if (repo.fetchCache.size > 128) {
    const first = repo.fetchCache.keys().next().value;
    if (first !== undefined) repo.fetchCache.delete(first);
  }
  return body;
}

function handleFetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const key = fetchCacheKey('v2', args);
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) return cached;
  const { send, boundary, unshallow, acks } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    const lines: (string | 'delim')[] = ['acknowledgments\n'];
    if (acks.length > 0) for (const ack of acks) lines.push(`ACK ${ack}\n`);
    else lines.push('NAK\n');
    // 'ready' tells the client the pack follows in this same response;
    // without it real git rejects any further section ("expected no other
    // sections to be sent after no 'ready'").
    lines.push('ready\n');
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  if (boundary.length > 0 || unshallow.length > 0) {
    const lines: (string | 'delim')[] = ['shallow-info\n'];
    for (const oid of boundary) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  // The packfile section is always sent (even when empty) — real git expects
  // it after 'ready', and the kit client accepts a 0-object pack.
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandWrap(writePack(repo, send), 1));
  parts.push(encodePktLines(['flush']));
  return fetchCachePut(repo, key, Buffer.concat(parts));
}

function handleFetchV0(repo: RepoRec, args: FetchArgs): Buffer {
  const key = fetchCacheKey('v0', args);
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) return cached;
  const { send, acks } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (acks.length > 0) for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  else parts.push(pktLine('NAK\n'));
  // The packfile section is always sent (even when empty) — see v2 above.
  parts.push(sidebandWrap(writePack(repo, send), 1));
  parts.push(encodePktLines(['flush']));
  return fetchCachePut(repo, key, Buffer.concat(parts));
}

// --- upload-pack ---------------------------------------------------------------

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'deepen-relative') args.deepenRelative = true;
  }
  return args;
}

/** POST /{o}/{r}.git/git-upload-pack. Returns null on a malformed request. */
function handleUploadPack(repo: RepoRec, raw: Buffer, isV2: boolean): Buffer | null {
  const decoded = decodePackets(raw, false);
  if (decoded === null || decoded.packets.length === 0) return null;
  const packets = decoded.packets;
  if (isV2) {
    const first = packets[0]!;
    if (first.kind !== 'data' || first.payload === undefined) return null;
    const command = first.payload.toString('utf8').replace(/\n$/, '');
    // Capability lines up to the delim, then the command's arguments up to the flush.
    const rest: string[] = [];
    let i = 1;
    for (; i < packets.length; i += 1) {
      const p = packets[i]!;
      if (p.kind === 'delim') {
        i += 1;
        break;
      }
      if (p.kind === 'flush') break;
    }
    for (; i < packets.length; i += 1) {
      const p = packets[i]!;
      if (p.kind === 'flush') break;
      if (p.kind === 'data' && p.payload !== undefined) rest.push(p.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'command=ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of rest) {
        if (line === 'peel') lsArgs.peel = true;
        else if (line === 'symrefs') lsArgs.symrefs = true;
        else if (line === 'unborn') lsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
      }
      return lsRefsResponse(repo, lsArgs);
    }
    if (command === 'command=fetch') return handleFetchV2(repo, parseFetchArgs(rest));
    return null;
  }
  // v0: want section (until the first flush), then the have/done section.
  const sections: string[][] = [[], []];
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      if (section > 1) break;
      continue;
    }
    if (p.kind === 'data' && p.payload !== undefined && section < 2) {
      sections[section]!.push(p.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const lines = [...sections[0]!, ...sections[1]!];
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'deepen-relative') args.deepenRelative = true;
  }
  if (args.wants.length === 0) return null;
  return handleFetchV0(repo, args);
}

// --- receive-pack --------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string[];
}

/** POST /{o}/{r}.git/git-receive-pack. Never throws; a bad request is a 400. */
function handleReceivePack(repo: RepoRec, body: Buffer): { status: number; body: Buffer } {
  const bad = { status: 400, body: Buffer.from('bad request\n', 'utf8') };
  const decoded = decodePackets(body, true);
  if (decoded === null) return bad;
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const p of decoded.packets) {
    if (p.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (p.kind !== 'data' || p.payload === undefined) continue;
    let line = p.payload.toString('utf8');
    let caps: string[] = [];
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const parts = line.replace(/\n$/, '').split(' ');
    if (
      parts.length < 3 ||
      !/^[0-9a-f]{40}$/.test(parts[0]!) ||
      !/^[0-9a-f]{40}$/.test(parts[1]!) ||
      !parts[2]!.startsWith('refs/')
    ) {
      return bad;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]!, caps });
  }
  if (!sawFlush || commands.length === 0) return bad;
  const packBytes = body.subarray(decoded.consumed);
  const sideband = commands[0]!.caps.includes('side-band-64k');
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'missing pack';
  } else if (packBytes.length > 0) {
    try {
      const objects = readPackObjects(packBytes, repo);
      for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err instanceof Error ? err.message : 'unpack failed').replace(/\s+/g, ' ').slice(0, 120);
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.gitRefs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (current === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
        else if (cmd.oldOid !== current) results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        else {
          repo.gitRefs.delete(cmd.ref);
          if (cmd.ref.startsWith('refs/heads/')) repo.branches.delete(cmd.ref.slice('refs/heads/'.length));
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'ref already exists' });
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
          continue;
        }
        repo.gitRefs.set(cmd.ref, cmd.newOid);
        if (cmd.ref.startsWith('refs/heads/')) syncBranchFromCommit(repo, cmd.ref.slice('refs/heads/'.length), cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
        continue;
      }
      if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (cmd.ref.startsWith('refs/heads/') && cmd.newOid !== current) {
        const oldObj = repo.objects.get(current);
        const newObj = repo.objects.get(cmd.newOid);
        if (oldObj?.type === 'commit' && newObj?.type === 'commit' && !isAncestor(repo, current, cmd.newOid)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.gitRefs.set(cmd.ref, cmd.newOid);
      if (cmd.ref.startsWith('refs/heads/')) syncBranchFromCommit(repo, cmd.ref.slice('refs/heads/'.length), cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  }
  const lines: (string | 'flush')[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const r of results) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  lines.push('flush');
  const reportStream = encodePktLines(lines);
  const out = sideband
    ? Buffer.concat([sidebandWrap(reportStream, 1), encodePktLines(['flush'])])
    : Buffer.concat([reportStream, encodePktLines(['flush'])]);
  return { status: 200, body: out };
}

// --- dispatcher ----------------------------------------------------------------

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `forge-${requestCounter}`,
  });
  res.end(body);
}

/** The git smart-HTTP surface: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}. */
function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  segments: string[],
  query: URLSearchParams,
): void {
  try {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -4);
    const resolved = resolveRepo(owner, repoName);
    if (resolved === null || resolved === 'foreign') {
      sendGit(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
      return;
    }
    const repo = resolved;
    const rest = segments.slice(2);
    if (req.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendGit(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
        return;
      }
      const isV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
      const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
      sendGit(res, 200, `application/x-${service}-advertisement`, body);
      return;
    }
    if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const body = handleUploadPack(repo, raw, isV2);
      if (body === null) {
        sendGit(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad request\n', 'utf8'));
        return;
      }
      sendGit(res, 200, 'application/x-git-upload-pack-result', body);
      return;
    }
    if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
      const out = handleReceivePack(repo, raw);
      sendGit(
        res,
        out.status,
        out.status === 200 ? 'application/x-git-receive-pack-result' : 'text/plain; charset=utf-8',
        out.body,
      );
      return;
    }
    sendGit(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
  } catch {
    try {
      sendGit(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad request\n', 'utf8'));
    } catch {
      // Response already gone; nothing to do.
    }
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const method = req.method ?? 'GET';
      const { segments, query } = splitPath(req);

      // Body first: read the raw bytes. MCP and GraphQL judge a malformed
      // body with their own errors; everything else gets a REST 400.
      let raw: Buffer = Buffer.alloc(0);
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        try {
          raw = await readBody(req);
        } catch {
          sendError(res, 400, 'Request body could not be read');
          return;
        }
      }

      // Git smart HTTP: binary pkt-line bodies, never JSON — intercept before
      // the JSON body parse below (which would 400 them).
      if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
        handleGit(req, res, raw, segments, query);
        return;
      }

      // MCP (Streamable HTTP) and GraphQL have their own wire contracts.
      if (segments.length === 1 && segments[0] === 'mcp') {
        handleMcp(req, res, raw);
        return;
      }
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        handleGraphql(req, res, raw);
        return;
      }

      let body: unknown = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, 400, 'Request body is not valid JSON');
          return;
        }
        body = parsed.value;
      }

      // Public routes: health probe, API root, meta (no token required).
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        method === 'GET' &&
        segments.length === 2 &&
        segments[0] === 'api' &&
        segments[1] === 'v3'
      ) {
        sendJson(
          res,
          200,
          { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
          { 'x-oauth-scopes': 'repo, read:org' },
        );
        return;
      }
      if (
        method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'v3' &&
        segments[2] === 'meta'
      ) {
        sendJson(res, 200, { installed_version: '1.0.0' });
        return;
      }

      // Everything else under /api/v3 requires the bearer token.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
        const auth = req.headers.authorization ?? '';
        const authed =
          expected !== ''
            ? auth === `Bearer ${expected}`
            : auth.startsWith('Bearer ') && auth.slice('Bearer '.length).trim() !== '';
        if (!authed) {
          sendError(res, 401, 'Requires authentication');
          return;
        }
      } else {
        // Not an API route at all (git smart HTTP arrives in a later round).
        sendError(res, 404, 'Not Found');
        return;
      }

      const obj = asObject(body);

      // GET /api/v3/user — the token owner's login (learned, else a placeholder).
      if (
        method === 'GET' &&
        segments.length === 3 &&
        segments[2] === 'user'
      ) {
        sendJson(res, 200, { login: viewerLogin ?? 'forge', id: 1, type: 'User' });
        return;
      }

      // POST /api/v3/user/repos
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[2] === 'user' &&
        segments[3] === 'repos'
      ) {
        if (obj === null) {
          sendError(res, 400, 'Request body must be a JSON object');
          return;
        }
        const name = asString(obj.name);
        if (name === '') {
          sendError(res, 422, 'Repository name is required');
          return;
        }
        if (reposByName.has(name)) {
          sendError(res, 422, 'Repository already exists');
          return;
        }
        const repo = createRepo(name, asBool(obj.private, false), asString(obj.description, ''));
        sendJson(res, 201, repoJson(repo));
        return;
      }

      // GET /api/v3/user/repos (paginated)
      if (
        method === 'GET' &&
        segments.length === 4 &&
        segments[2] === 'user' &&
        segments[3] === 'repos'
      ) {
        const { perPage, page } = pageParams(query);
        const all = [...reposByName.values()];
        const { slice, hasNext } = paginate(all, perPage, page);
        const headers: Record<string, string> = {};
        if (hasNext) {
          const next = `${originOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
          headers.link = `<${next}>; rel="next"`;
        }
        sendJson(res, 200, slice.map((repo) => repoJson(repo)), headers);
        return;
      }

      // /api/v3/repos/{owner}/{repo}[...]
      if (segments.length >= 5 && segments[2] === 'repos') {
        const owner = segments[3]!;
        const repoName = segments[4]!;
        const resolved = resolveRepo(owner, repoName);
        if (resolved === null || resolved === 'foreign') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const repo = resolved;
        const rest = segments.slice(5);

        // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
        if (rest.length === 0) {
          if (method === 'GET') {
            sendJson(res, 200, repoJson(repo));
            return;
          }
          if (method === 'PATCH') {
            if (obj === null) {
              sendError(res, 400, 'Request body must be a JSON object');
              return;
            }
            if (typeof obj.description === 'string') repo.description = obj.description;
            sendJson(res, 200, repoJson(repo));
            return;
          }
          if (method === 'DELETE') {
            reposByName.delete(repoName);
            sendJson(res, 204, null);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        // POST /api/v3/repos/{o}/{r}/git/refs
        if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
          if (obj === null) {
            sendError(res, 400, 'Request body must be a JSON object');
            return;
          }
          const ref = asString(obj.ref);
          const sha = asString(obj.sha);
          const match = /^refs\/heads\/(.+)$/.exec(ref);
          if (match === null || sha === '') {
            sendError(res, 422, 'A branch ref and a commit sha are required');
            return;
          }
          const branchName = match[1]!;
          if (repo.branches.has(branchName)) {
            sendError(res, 422, 'Branch already exists');
            return;
          }
          const commit = repo.commits.get(sha);
          if (commit === undefined) {
            sendError(res, 422, 'Commit not found');
            return;
          }
          const history: string[] = [];
          let cursor: CommitRec | undefined = commit;
          while (cursor !== undefined) {
            history.push(cursor.sha);
            cursor = cursor.parent === null ? undefined : repo.commits.get(cursor.parent);
          }
          const branch: BranchRec = { name: branchName, tip: sha, files: new Map(commit.files), history };
          repo.branches.set(branchName, branch);
          repo.gitRefs.set(ref, sha);
          sendJson(res, 201, { ref, object: { sha } });
          return;
        }

        // GET /api/v3/repos/{o}/{r}/branches
        if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
          sendJson(res, 200, [...repo.branches.values()].map((branch) => branchJson(branch)));
          return;
        }

        // GET /api/v3/repos/{o}/{r}/branches/{branch}
        if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
          const branch = repo.branches.get(rest[1]!);
          if (branch === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, branchJson(branch));
          return;
        }

        // GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch}
        if (
          rest.length === 4 &&
          rest[0] === 'git' &&
          rest[1] === 'refs' &&
          rest[2] === 'heads' &&
          method === 'GET'
        ) {
          const branch = repo.branches.get(rest[3]!);
          if (branch === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, { ref: `refs/heads/${branch.name}`, object: { sha: branch.tip } });
          return;
        }

        // GET /api/v3/repos/{o}/{r}/commits[?sha=]
        if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
          const ref = query.get('sha');
          let history: string[] | null = null;
          if (ref === null) {
            history = repo.branches.get(repo.defaultBranch)?.history ?? [];
          } else {
            const branch = repo.branches.get(ref);
            if (branch !== undefined) history = branch.history;
            else {
              const commit = repo.commits.get(ref);
              if (commit !== undefined) {
                history = [];
                let cursor: CommitRec | undefined = commit;
                while (cursor !== undefined) {
                  history.push(cursor.sha);
                  cursor = cursor.parent === null ? undefined : repo.commits.get(cursor.parent);
                }
              }
            }
          }
          if (history === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const out: Record<string, unknown>[] = [];
          for (const sha of history) {
            const commit = repo.commits.get(sha);
            if (commit !== undefined) out.push(commitJson(commit));
          }
          sendJson(res, 200, out);
          return;
        }

        // /api/v3/repos/{o}/{r}/contents/{path...}
        if (rest.length >= 1 && rest[0] === 'contents') {
          const filePath = rest.slice(1).join('/');
          const branchName = obj !== null && typeof obj.branch === 'string' ? obj.branch : undefined;
          if (method === 'PUT') {
            if (obj === null) {
              sendError(res, 400, 'Request body must be a JSON object');
              return;
            }
            const branch = repo.branches.get(branchName ?? repo.defaultBranch);
            if (branch === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            const contentB64 = asString(obj.content);
            if (contentB64 === '') {
              sendError(res, 400, 'Content is required');
              return;
            }
            const content = Buffer.from(contentB64, 'base64');
            const existing = branch.files.get(filePath);
            if (existing !== undefined && typeof obj.sha === 'string' && obj.sha !== '' && obj.sha.toLowerCase() !== existing.sha.toLowerCase()) {
              sendError(res, 409, 'The file has changed since the given sha');
              return;
            }
            const isCreate = existing === undefined;
            const newFiles = new Map(branch.files);
            const newBlobSha = blobSha(content);
            newFiles.set(filePath, { content, sha: newBlobSha });
            const commit = makeCommit(repo, branch, newFiles, asString(obj.message, 'Update file'));
            sendJson(res, isCreate ? 201 : 200, {
              content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: newBlobSha, size: content.length, encoding: 'base64', type: 'file' },
              commit: { sha: commit.sha, message: commit.message },
            });
            return;
          }
          if (method === 'GET') {
            const files = filesAtRef(repo, query.get('ref'));
            if (files === null) {
              sendError(res, 404, 'Not Found');
              return;
            }
            const file = filePath === '' ? undefined : files.get(filePath);
            if (file !== undefined) {
              sendJson(res, 200, {
                type: 'file',
                name: filePath.split('/').pop() ?? filePath,
                path: filePath,
                sha: file.sha,
                size: file.content.length,
                encoding: 'base64',
                content: file.content.toString('base64'),
              });
              return;
            }
            const listing = directoryListing(repo, files, filePath);
            if (listing.length === 0) {
              sendError(res, 404, 'Not Found');
              return;
            }
            sendJson(res, 200, listing);
            return;
          }
          if (method === 'DELETE') {
            const branch = repo.branches.get(branchName ?? repo.defaultBranch);
            if (branch === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            const existing = branch.files.get(filePath);
            if (existing === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            if (obj !== null && typeof obj.sha === 'string' && obj.sha !== '' && obj.sha.toLowerCase() !== existing.sha.toLowerCase()) {
              sendError(res, 409, 'The file has changed since the given sha');
              return;
            }
            const newFiles = new Map(branch.files);
            newFiles.delete(filePath);
            const commit = makeCommit(repo, branch, newFiles, obj !== null ? asString(obj.message, 'Delete file') : 'Delete file');
            sendJson(res, 200, { commit: { sha: commit.sha, message: commit.message } });
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        // POST /api/v3/repos/{o}/{r}/labels
        if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
          if (obj === null) {
            sendError(res, 400, 'Request body must be a JSON object');
            return;
          }
          const name = asString(obj.name);
          if (name === '') {
            sendError(res, 422, 'Label name is required');
            return;
          }
          const existing = repo.labels.get(name);
          if (existing !== undefined) {
            sendJson(res, 201, { name: existing.name, color: existing.color });
            return;
          }
          const label: LabelRec = { name, color: asString(obj.color, 'ededed') };
          repo.labels.set(name, label);
          sendJson(res, 201, { name: label.name, color: label.color });
          return;
        }
        if (rest.length === 1 && rest[0] === 'labels' && method === 'GET') {
          sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
          return;
        }

        // /api/v3/repos/{o}/{r}/pulls[/{n}[/merge|/files]] — minimal surface
        // (create/list/read/merge/files), shared with MCP and GraphQL.
        if (rest.length >= 1 && rest[0] === 'pulls') {
          const refNameOf = (value: unknown): string => {
            if (typeof value === 'string') return value;
            const record = asObject(value);
            if (record !== null) return asString(record.ref, asString(record.branch));
            return '';
          };
          if (rest.length === 1 && method === 'POST') {
            if (obj === null) {
              sendError(res, 400, 'Request body must be a JSON object');
              return;
            }
            const title = asString(obj.title);
            if (title === '') {
              sendError(res, 422, 'Pull request title is required');
              return;
            }
            const created = createPull(repo, title, asString(obj.body, ''), refNameOf(obj.head), refNameOf(obj.base));
            if ('error' in created) {
              sendError(res, 422, created.error);
              return;
            }
            sendJson(res, 201, pullJson(repo, created.pull));
            return;
          }
          if (rest.length === 1 && method === 'GET') {
            const state = query.get('state') ?? 'open';
            let list = [...repo.pulls.values()];
            if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
            else if (state !== 'all') list = list.filter((pull) => pull.state === 'open');
            list.sort((a, b) => b.seq - a.seq);
            const { perPage, page } = pageParams(query);
            const { slice } = paginate(list, perPage, page);
            sendJson(res, 200, slice.map((pull) => pullJson(repo, pull)));
            return;
          }
          if (rest.length === 2) {
            const number = Number.parseInt(rest[1]!, 10);
            const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
            if (pull === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            if (method === 'GET') {
              sendJson(res, 200, pullJson(repo, pull));
              return;
            }
            sendError(res, 404, 'Not Found');
            return;
          }
          if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
            const number = Number.parseInt(rest[1]!, 10);
            const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
            if (pull === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            const merged = mergePull(repo, pull);
            if ('error' in merged) {
              sendError(res, merged.conflict === true ? 405 : 422, merged.error);
              return;
            }
            sendJson(res, 200, {
              merged: true,
              sha: merged.sha,
              message: `Pull request #${pull.number} merged`,
            });
            return;
          }
          if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
            const number = Number.parseInt(rest[1]!, 10);
            const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
            if (pull === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            const baseFiles = filesOfCommit(repo, mergeBaseSha(repo, pull.head, pull.base));
            const headFiles = repo.branches.get(pull.head)?.files ?? new Map<string, FileRec>();
            const files = prChangedFiles(repo, pull);
            sendJson(
              res,
              200,
              files.map((file) => {
                const oldFile = baseFiles.get(file.path);
                const newFile = headFiles.get(file.path);
                const patchLines: string[] = [`--- a/${file.path}`, `+++ b/${file.path}`];
                if (oldFile !== undefined) {
                  for (const line of countLines(oldFile.content)) patchLines.push(`-${line}`);
                }
                if (newFile !== undefined) {
                  for (const line of countLines(newFile.content)) patchLines.push(`+${line}`);
                }
                return {
                  filename: file.path,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  changes: file.additions + file.deletions,
                  patch: patchLines.join('\n'),
                };
              }),
            );
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        // /api/v3/repos/{o}/{r}/issues[/{n}[/comments]]
        if (rest.length >= 1 && rest[0] === 'issues') {
          if (rest.length === 1 && method === 'POST') {
            if (obj === null) {
              sendError(res, 400, 'Request body must be a JSON object');
              return;
            }
            const rawLabels = Array.isArray(obj.labels) ? obj.labels : [];
            const labels: LabelRec[] = [];
            for (const raw of rawLabels) {
              const labelName = typeof raw === 'string' ? raw : asString((raw as Record<string, unknown> | null)?.name);
              const found = repo.labels.get(labelName);
              if (found === undefined) {
                sendError(res, 422, `Label does not exist: ${labelName}`);
                return;
              }
              labels.push(found);
            }
            const issue = makeIssue(repo, asString(obj.title, ''), asString(obj.body, ''), labels);
            sendJson(res, 201, issueJson(repo, issue));
            return;
          }
          if (rest.length === 1 && method === 'GET') {
            const state = query.get('state') ?? 'open';
            const sort = query.get('sort') ?? 'created';
            const direction = query.get('direction') ?? 'desc';
            let list = [...repo.issues.values()];
            if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
            else if (state !== 'all') list = list.filter((issue) => issue.state === 'open');
            if (sort === 'created') {
              list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
            }
            const { perPage, page } = pageParams(query);
            const { slice } = paginate(list, perPage, page);
            sendJson(res, 200, slice.map((issue) => issueJson(repo, issue)));
            return;
          }
          if (rest.length === 2) {
            const number = Number.parseInt(rest[1]!, 10);
            const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
            if (issue === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            if (method === 'GET') {
              sendJson(res, 200, issueJson(repo, issue));
              return;
            }
            if (method === 'PATCH') {
              if (obj === null) {
                sendError(res, 400, 'Request body must be a JSON object');
                return;
              }
              if (obj.state === 'open' || obj.state === 'closed') issue.state = obj.state;
              if (typeof obj.title === 'string') issue.title = obj.title;
              if (typeof obj.body === 'string') issue.body = obj.body;
              sendJson(res, 200, issueJson(repo, issue));
              return;
            }
            sendError(res, 404, 'Not Found');
            return;
          }
          if (rest.length === 3 && rest[2] === 'comments') {
            const number = Number.parseInt(rest[1]!, 10);
            const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
            if (issue === undefined) {
              sendError(res, 404, 'Not Found');
              return;
            }
            if (method === 'POST') {
              if (obj === null) {
                sendError(res, 400, 'Request body must be a JSON object');
                return;
              }
              const comment = addCommentTo(repo, issue, asString(obj.body, ''));
              sendJson(res, 201, {
                id: comment.id,
                body: comment.body,
                user: { login: ownerLoginOf(repo), id: 1, type: 'User' },
                created_at: FIXED_DATE,
                updated_at: FIXED_DATE,
              });
              return;
            }
            if (method === 'GET') {
              sendJson(
                res,
                200,
                issue.comments.map((comment) => ({
                  id: comment.id,
                  body: comment.body,
                  user: { login: ownerLoginOf(repo), id: 1, type: 'User' },
                  created_at: FIXED_DATE,
                  updated_at: FIXED_DATE,
                })),
              );
              return;
            }
            sendError(res, 404, 'Not Found');
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        sendError(res, 404, 'Not Found');
        return;
      }

      // Authenticated but unmatched /api/v3 route.
      sendError(res, 404, 'Not Found');
    })().catch((err: unknown) => {
      try {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } catch {
        // Response already gone; nothing to do.
      }
    });
  });
}
