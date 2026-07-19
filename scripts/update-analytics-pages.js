import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SERVICE_ACCOUNT_JSON = process.env.GA_SERVICE_ACCOUNT_JSON;
const CLIENT_EMAIL = process.env.GA_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GA_PRIVATE_KEY;
const SITE_URL = (process.env.GA_SITE_URL || 'https://www.galpopath.com').replace(/\/$/, '');
const POST_INDEX_PATH = process.env.POST_INDEX_PATH || 'data/post-index.json';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'data/analytics-pages.json';
const API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const LIMIT = 250;

if (!PROPERTY_ID) {
  throw new Error('Missing GA4_PROPERTY_ID environment variable.');
}

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
    throw new Error('Missing GA service account credentials.');
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

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''), SITE_URL);
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
  if (!normalized.startsWith(SITE_URL)) return false;

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

async function runReport(accessToken, range) {
  const response = await fetch(`${API_BASE}/properties/${encodeURIComponent(PROPERTY_ID)}:runReport`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: 'pageLocation' }, { name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: String(LIMIT)
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GA Data API error ${response.status}: ${detail.slice(0, 500)}`);
  }

  const data = await response.json();
  return Array.isArray(data.rows) ? data.rows : [];
}

function rowToPage(row, postIndex) {
  const url = normalizeUrl(row.dimensionValues?.[0]?.value || '');
  const title = row.dimensionValues?.[1]?.value || '';
  const views = Number(row.metricValues?.[0]?.value || 0);
  const activeUsers = Number(row.metricValues?.[1]?.value || 0);
  const post = postIndex.get(url);

  return {
    url,
    title: post?.title || title,
    views,
    activeUsers,
    postId: post?.id || '',
    published: post?.published || '',
    labels: Array.isArray(post?.labels) ? post.labels : []
  };
}

async function main() {
  const accessToken = await getAccessToken();
  const postIndex = await readPostIndex();
  const ranges = [
    { key: '7days', label: '৭ দিনে', startDate: '7daysAgo', endDate: 'today' },
    { key: '30days', label: '৩০ দিনে', startDate: '30daysAgo', endDate: 'today' },
    { key: 'all', label: 'সামগ্রিক', startDate: '2020-01-01', endDate: 'today' }
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    propertyId: PROPERTY_ID,
    siteUrl: SITE_URL,
    ranges: {}
  };

  for (const range of ranges) {
    const rows = await runReport(accessToken, range);
    const pages = rows
      .map((row) => rowToPage(row, postIndex))
      .filter((page) => page.views > 0 && isUsefulPage(page.url))
      .sort((first, second) => second.views - first.views || first.title.localeCompare(second.title, 'bn'));

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
