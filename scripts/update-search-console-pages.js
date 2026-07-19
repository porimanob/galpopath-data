import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';

const SERVICE_ACCOUNT_JSON = process.env.GA_SERVICE_ACCOUNT_JSON || process.env.SEARCH_CONSOLE_SERVICE_ACCOUNT_JSON;
const CLIENT_EMAIL = process.env.GA_CLIENT_EMAIL || process.env.SEARCH_CONSOLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GA_PRIVATE_KEY || process.env.SEARCH_CONSOLE_PRIVATE_KEY;
const SITE_URL = process.env.SEARCH_CONSOLE_SITE_URL || 'https://www.galpopath.com/';
const SITE_ORIGIN = SITE_URL.replace(/\/$/, '');
const POST_INDEX_PATH = process.env.POST_INDEX_PATH || 'data/post-index.json';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'data/search-console-pages.json';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const ROW_LIMIT = 25000;

function getCredentials() {
  if (SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(SERVICE_ACCOUNT_JSON);
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key
    };
  }

  return {
    clientEmail: CLIENT_EMAIL,
    privateKey: PRIVATE_KEY ? PRIVATE_KEY.replace(/\\n/g, '\n') : ''
  };
}

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken() {
  const { clientEmail, privateKey } = getCredentials();

  if (!clientEmail || !privateKey) {
    throw new Error('Missing service account credentials.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };
  const claim = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  };

  const unsignedToken = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = createSign('RSA-SHA256').update(unsignedToken).sign(privateKey);
  const jwt = `${unsignedToken}.${base64url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OAuth token error ${response.status}: ${detail.slice(0, 500)}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function readPostIndex() {
  try {
    const raw = await readFile(POST_INDEX_PATH, 'utf8');
    const data = JSON.parse(raw);
    const posts = Array.isArray(data.posts) ? data.posts : [];
    const byUrl = new Map();

    posts.forEach((post) => {
      if (!post.url) return;
      byUrl.set(normalizeUrl(post.url), post);
    });

    return byUrl;
  } catch {
    return new Map();
  }
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return toIsoDate(date);
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''), SITE_ORIGIN);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase();
    url.protocol = 'https:';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '').trim().replace(/\/$/, '');
  }
}

function isUsefulPage(url) {
  const normalized = normalizeUrl(url);
  if (!normalized.startsWith(SITE_ORIGIN)) return false;

  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === '/' || parsed.pathname === '') return false;
    if (parsed.pathname.startsWith('/search')) return false;
    if (parsed.pathname.startsWith('/p/')) return false;
    return true;
  } catch {
    return false;
  }
}

async function querySearchConsole(accessToken, range) {
  const response = await fetch(`${API_BASE}/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions: ['page'],
      searchType: 'web',
      rowLimit: ROW_LIMIT,
      startRow: 0,
      aggregationType: 'byPage'
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Search Console API error ${response.status}: ${detail.slice(0, 500)}`);
  }

  const data = await response.json();
  return Array.isArray(data.rows) ? data.rows : [];
}

function rowToPage(row, postIndex) {
  const url = normalizeUrl(row.keys?.[0] || '');
  const post = postIndex.get(url);

  return {
    url,
    title: post?.title || '',
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
    ctr: Number(row.ctr || 0),
    position: Number(row.position || 0),
    postId: post?.id || '',
    published: post?.published || '',
    labels: Array.isArray(post?.labels) ? post.labels : []
  };
}

async function main() {
  const accessToken = await getAccessToken();
  const postIndex = await readPostIndex();
  const ranges = [
    { key: '7days', label: '৭ দিনে', startDate: daysAgo(8), endDate: daysAgo(1) },
    { key: '28days', label: '২৮ দিনে', startDate: daysAgo(29), endDate: daysAgo(1) },
    { key: '3months', label: '৩ মাসে', startDate: daysAgo(91), endDate: daysAgo(1) }
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    siteUrl: SITE_URL,
    ranges: {}
  };

  for (const range of ranges) {
    const rows = await querySearchConsole(accessToken, range);
    const pages = rows
      .map((row) => rowToPage(row, postIndex))
      .filter((page) => page.impressions > 0 && isUsefulPage(page.url))
      .sort((first, second) => {
        return second.clicks - first.clicks ||
          second.impressions - first.impressions ||
          first.url.localeCompare(second.url);
      });

    payload.ranges[range.key] = {
      label: range.label,
      startDate: range.startDate,
      endDate: range.endDate,
      total: pages.length,
      pages
    };

    console.log(`Fetched ${pages.length} pages for ${range.key}.`);
  }

  await mkdir('data', { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
