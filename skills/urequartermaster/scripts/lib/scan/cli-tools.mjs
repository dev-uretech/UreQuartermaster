// Command-line tools found on PATH: a curated list plus `clis` from config.json.
// Only file existence (and the execute bit on POSIX) is checked: nothing is ever run.
import { makeResolver, SAFE_COMMAND_NAME } from '../core/which.mjs';

// name -> one-line description; `commands` are tried in order (default: [name]).
export const CURATED_CLIS = [
  { name: 'gh', description: 'GitHub CLI: repositories, issues, pull requests, releases, Actions and the GitHub API' },
  { name: 'git', description: 'Git version control: commits, branches, diffs, history, remotes' },
  { name: 'gcloud', description: 'Google Cloud CLI: projects, Compute Engine, Cloud Run, IAM and other Google Cloud services' },
  { name: 'bq', description: 'BigQuery CLI: run SQL queries, manage datasets and tables' },
  { name: 'gsutil', description: 'Google Cloud Storage CLI: copy, list and sync bucket objects' },
  { name: 'aws', description: 'AWS CLI: manage Amazon Web Services resources (S3, EC2, Lambda, IAM, ...)' },
  { name: 'az', description: 'Azure CLI: manage Microsoft Azure resources' },
  { name: 'kubectl', description: 'Kubernetes CLI: inspect and manage clusters, pods, deployments and logs' },
  { name: 'helm', description: 'Helm: install and manage Kubernetes charts and releases' },
  { name: 'terraform', description: 'Terraform: plan and apply infrastructure as code' },
  { name: 'docker', description: 'Docker: build, run and manage containers and images' },
  { name: 'podman', description: 'Podman: daemonless containers and images, Docker-compatible' },
  { name: 'wp', description: 'WP-CLI: manage WordPress sites, plugins, users, options and the database' },
  { name: 'composer', description: 'Composer: PHP dependency manager' },
  { name: 'php', description: 'PHP interpreter: run scripts and lint files (php -l)' },
  { name: 'npm', description: 'npm: Node.js package manager and script runner' },
  { name: 'pnpm', description: 'pnpm: fast, disk-efficient Node.js package manager' },
  { name: 'yarn', description: 'Yarn: Node.js package manager' },
  { name: 'bun', description: 'Bun: JavaScript runtime, bundler, test runner and package manager' },
  { name: 'deno', description: 'Deno: secure JavaScript and TypeScript runtime' },
  { name: 'python', commands: ['python3', 'python'], description: 'Python interpreter: run scripts and modules' },
  { name: 'uv', description: 'uv: fast Python package and project manager (uv run, uvx)' },
  { name: 'pipx', description: 'pipx: install and run Python command-line applications in isolation' },
  { name: 'ffmpeg', description: 'FFmpeg: convert, cut, encode and inspect audio and video' },
  { name: 'imagemagick', commands: ['magick', 'convert'], description: 'ImageMagick: convert, resize and edit images' },
  { name: 'pandoc', description: 'Pandoc: convert documents between Markdown, HTML, DOCX, PDF and more' },
  { name: 'sqlite3', description: 'SQLite shell: query and edit SQLite database files' },
  { name: 'psql', description: 'PostgreSQL interactive client' },
  { name: 'mysql', description: 'MySQL/MariaDB command-line client' },
  { name: 'redis-cli', description: 'Redis command-line client' },
  { name: 'stripe', description: 'Stripe CLI: test webhooks, inspect events, call the Stripe API' },
  { name: 'vercel', description: 'Vercel CLI: deploy and manage Vercel projects' },
  { name: 'netlify', description: 'Netlify CLI: deploy sites and manage Netlify projects' },
  { name: 'firebase', description: 'Firebase CLI: deploy hosting, functions and rules, run emulators' },
  { name: 'supabase', description: 'Supabase CLI: local development, migrations and project management' },
  { name: 'flyctl', description: 'Fly.io CLI: deploy and manage Fly apps' },
  { name: 'railway', description: 'Railway CLI: deploy and manage Railway projects' },
  { name: 'heroku', description: 'Heroku CLI: deploy and manage Heroku apps' },
  { name: 'wrangler', description: 'Cloudflare Wrangler: Workers, Pages, KV, R2 and D1' },
  { name: 'rclone', description: 'rclone: sync files with cloud storage (S3, Drive, Dropbox, SFTP, ...)' },
  { name: 'jq', description: 'jq: query and transform JSON' },
  { name: 'yq', description: 'yq: query and transform YAML (and JSON, XML, TOML)' },
  { name: 'rg', description: 'ripgrep: fast recursive text search' },
  { name: 'curl', description: 'curl: HTTP requests and file transfers' },
];

export function scanCli(config, env = process.env, { platform = process.platform } = {}) {
  const resolve = makeResolver(env, platform);
  const out = [];
  const seen = new Set();
  const add = (name, commands, description, source) => {
    if (seen.has(name)) return;
    for (const c of commands) {
      const file = resolve(c);
      if (!file) continue;
      seen.add(name);
      out.push({ id: `cli:${name}`, kind: 'cli', name, description, headings: [], path: file, source, state: 'available', usage: `${c} --help` });
      return;
    }
  };

  const extra = config && Array.isArray(config.clis) ? config.clis : [];
  const configured = new Map();
  for (const c of extra) {
    if (c && typeof c.name === 'string' && SAFE_COMMAND_NAME.test(c.name) && !configured.has(c.name)) configured.set(c.name, typeof c.description === 'string' ? c.description.trim() : '');
  }

  for (const c of CURATED_CLIS) {
    const own = configured.get(c.name);
    add(c.name, c.commands || [c.name], own || c.description, 'path');
  }
  for (const [name, description] of configured) add(name, [name], description || `${name} command-line tool`, 'config');
  return out;
}
