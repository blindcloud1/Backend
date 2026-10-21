import multer from 'multer';

/**
 * AI pricing-table extraction (OpenAI GPT-4o vision).
 *
 * Used by the product page ("Use AI to extract prices") to turn a photo or
 * screenshot of a supplier price list into a pricing-table matrix.
 *
 * The endpoint is intentionally split out of server.ts so the pricing service
 * stays readable.
 *
 * Env:
 *   OPENAI_API_KEY             required
 *   OPENAI_VISION_MODEL        default gpt-4o
 *   OPENAI_VISION_DETAIL       default high  (low | high)
 *   OPENAI_VISION_TIMEOUT_MS   default 60000
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
const OPENAI_VISION_DETAIL = (process.env.OPENAI_VISION_DETAIL || 'high').toLowerCase();
const OPENAI_VISION_TIMEOUT_MS = Number(process.env.OPENAI_VISION_TIMEOUT_MS || 60000);
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export const isVisionConfigured = (): boolean => OPENAI_API_KEY.length > 0;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// 8 MB. OpenAI accepts up to 20 MB but bigger uploads are almost certainly a
// mistake and cost real money to process.
export const visionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

// ---------------------------------------------------------------------------
// Simple per-user rate limit (this endpoint costs money per call)
// ---------------------------------------------------------------------------
type RateEntry = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateEntry>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

export const checkVisionRateLimit = (key: string): { ok: boolean; retryAfterSeconds: number } => {
  const now = Date.now();
  const entry = rateBuckets.get(key);

  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfterSeconds: 0 };
  }

  if (entry.count >= RATE_MAX) {
    return { ok: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
};

// keep the map from growing forever
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets.entries()) {
    if (entry.resetAt <= now) rateBuckets.delete(key);
  }
}, RATE_WINDOW_MS).unref?.();

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a precise data-extraction engine for blinds and curtains price lists.

The image contains a pricing table with:
- WIDTHS  = the horizontal size of the blind
- DROPS   = the vertical size of the blind

Extract every numeric cell into a structured matrix.

Output rules:
- Reply with a single JSON object and NOTHING else. No markdown fences, no explanation.
- Strip currency symbols (GBP, USD, EUR), thousands separators, "VAT", "inc", "from", and any other text. Numbers only.
- Keep the numbers exactly as printed. Do not round, convert or infer.
- If a cell is blank, missing, or unreadable, use null for that price.
- If the image is NOT a pricing table, return:
  {"tableName":"","unitSystem":"centimeters","widthValues":[],"dropValues":[],"rows":[]}

Schema:
{
  "tableName": "string - a short descriptive name for the table, or the title printed on the image",
  "unitSystem": "centimeters" | "inches",
  "widthValues": [number],
  "dropValues": [number],
  "rows": [ { "width": number, "prices": [number|null] } ]
}

Ordering rules (these are critical):
- widthValues: every width found, in ascending order.
- dropValues: every drop found, in ascending order.
- rows: exactly one entry per width, in the SAME ORDER as widthValues.
- prices: exactly one entry per drop, in the SAME ORDER as dropValues.

The source table may be laid out with widths down the side and drops across the top, or the other way around. Work out which is which from the labels and always return the normalised form above (widths down, prices across the drops).`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type AiRow = { width: number; prices: (number | null)[] };

type AiExtraction = {
  tableName: string;
  unitSystem: 'centimeters' | 'inches';
  widthValues: number[];
  dropValues: number[];
  rows: AiRow[];
};

export type ExtractedPricingTable = {
  name: string;
  unitSystem: 'centimeters' | 'inches';
  widthValues: number[];
  dropValues: number[];
  /** priceMatrix[dropIndex][widthIndex] — matches the app's existing shape */
  priceMatrix: (number | null)[][];
  /** tab separated, one line per width, values across the drops — pastes straight into the grid */
  csv: string;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.\-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const stripJsonFences = (raw: string): string => {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
};

/**
 * Normalise whatever the model returned into the shape the app expects.
 * Deliberately defensive: the model output is untrusted input.
 */
export const normaliseExtraction = (raw: unknown): ExtractedPricingTable | null => {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<AiExtraction>;

  const unitSystem: 'centimeters' | 'inches' =
    String(data.unitSystem || '').toLowerCase().startsWith('inch') ? 'inches' : 'centimeters';

  const rawRows = Array.isArray(data.rows) ? data.rows : [];

  // Rebuild the width list from the rows when possible - the rows are the
  // authoritative pairing of width -> prices.
  const rows: AiRow[] = [];
  for (const candidate of rawRows) {
    if (!candidate || typeof candidate !== 'object') continue;
    const width = toFiniteNumber((candidate as AiRow).width);
    if (width === null) continue;
    const prices = Array.isArray((candidate as AiRow).prices)
      ? (candidate as AiRow).prices.map((p) => toFiniteNumber(p))
      : [];
    rows.push({ width, prices });
  }

  if (rows.length === 0) return null;

  // widths, de-duplicated and ascending
  const widthSet = new Set<number>(rows.map((r) => r.width));
  const declaredWidths = Array.isArray(data.widthValues)
    ? data.widthValues.map((w) => toFiniteNumber(w)).filter((w): w is number => w !== null)
    : [];
  const widthSource = declaredWidths.length === widthSet.size ? declaredWidths : Array.from(widthSet);
  const widthValues = Array.from(new Set(widthSource)).sort((a, b) => a - b);

  // drops
  const declaredDrops = Array.isArray(data.dropValues)
    ? data.dropValues.map((d) => toFiniteNumber(d)).filter((d): d is number => d !== null)
    : [];
  const maxPriceCount = rows.reduce((max, r) => Math.max(max, r.prices.length), 0);
  const dropValues = (
    declaredDrops.length === maxPriceCount ? declaredDrops : Array.from({ length: maxPriceCount }, (_, i) => i)
  ).sort((a, b) => a - b);

  // order the rows to match widthValues
  const rowsByWidth = new Map(rows.map((r) => [r.width, r]));
  const orderedRows = widthValues.map((w) => rowsByWidth.get(w) || { width: w, prices: [] });

  // priceMatrix[dropIndex][widthIndex]
  const priceMatrix: (number | null)[][] = dropValues.map((_drop, dropIdx) =>
    widthValues.map((_width, widthIdx) => {
      const value = orderedRows[widthIdx].prices[dropIdx];
      return value === undefined ? null : value;
    })
  );

  // CSV in the exact orientation the grid paste handler expects:
  // one line per width, values across the drops, tab separated, no header.
  const csv = orderedRows
    .map((row) => row.prices.map((p) => (p === null || p === undefined ? '' : String(p))).join('\t'))
    .join('\n');

  const name = String(data.tableName || '').trim().slice(0, 120);

  return { name, unitSystem, widthValues, dropValues, priceMatrix, csv };
};

// ---------------------------------------------------------------------------
// Shared OpenAI call (used by every vision extractor below)
// ---------------------------------------------------------------------------
type VisionJsonOutcome =
  | { ok: true; content: string }
  | { ok: false; status: number; error: string };

const requestVisionJson = async (
  systemPrompt: string,
  userText: string,
  dataUrl: string
): Promise<VisionJsonOutcome> => {
  if (!OPENAI_API_KEY) {
    return { ok: false, status: 501, error: 'AI extraction is not configured on this server' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_VISION_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        temperature: 0.1,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              {
                type: 'image_url',
                image_url: { url: dataUrl, detail: OPENAI_VISION_DETAIL === 'low' ? 'low' : 'high' }
              }
            ]
          }
        ]
      })
    });

    const rawText = await response.text();

    if (!response.ok) {
      let message = `AI extraction failed (HTTP ${response.status})`;
      let errorCode = '';
      try {
        const parsed = JSON.parse(rawText);
        if (parsed?.error?.message) message = parsed.error.message;
        if (parsed?.error?.code) errorCode = String(parsed.error.code);
      } catch {
        if (rawText && rawText.length < 300) message = rawText;
      }

      if (response.status === 401) {
        message = 'The AI service rejected the API key.';
      } else if (response.status === 429) {
        // OpenAI returns 429 for BOTH a short-term rate limit and an empty
        // credit balance. The balance case is by far the more common one.
        if (errorCode === 'credit_balance_exhausted' || errorCode === 'insufficient_quota') {
          message =
            'The AI service has no credits remaining. Add credits at ' +
            'https://platform.openai.com/settings/organization/billing/';
        } else {
          message = 'The AI service is rate limited. Please try again shortly.';
        }
      } else if (response.status === 400 && /image|vision/i.test(message)) {
        message = `The AI service rejected the image: ${message}`;
      }

      return { ok: false, status: 502, error: message };
    }

    let payload: any;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return { ok: false, status: 502, error: 'The AI service returned an unreadable response.' };
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, status: 502, error: 'The AI service returned no content.' };
    }

    return { ok: true, content };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, status: 504, error: 'The AI extraction timed out. Try a smaller image.' };
    }
    return {
      ok: false,
      status: 502,
      error: err?.message || 'Failed to reach the AI service.'
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseModelJson = (content: string): { ok: unknown } | { error: string } => {
  try {
    return { ok: JSON.parse(stripJsonFences(content)) };
  } catch {
    return { error: 'The AI service returned malformed JSON. Try a clearer image.' };
  }
};

export type VisionResult =
  | { ok: true; table: ExtractedPricingTable; raw: string }
  | { ok: false; status: number; error: string };

export const extractPricingFromImage = async (
  buffer: Buffer,
  mimeType: string
): Promise<VisionResult> => {
  if (!OPENAI_API_KEY) {
    return { ok: false, status: 501, error: 'AI extraction is not configured on this server' };
  }

  if (!ALLOWED_MIME.has(mimeType)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported image type "${mimeType}". Use JPG, PNG, WEBP or GIF.`
    };
  }

  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const outcome = await requestVisionJson(
    SYSTEM_PROMPT,
    'Extract the pricing table from this image. Reply with JSON only.',
    dataUrl
  );
  if (!outcome.ok) {
    return { ok: false, status: outcome.status, error: outcome.error };
  }

  const parsed = parseModelJson(outcome.content);
  if ('error' in parsed) {
    return { ok: false, status: 502, error: parsed.error };
  }

  const table = normaliseExtraction(parsed.ok);
  if (!table) {
    return {
      ok: false,
      status: 422,
      error: 'No pricing table could be found in that image. Make sure the whole table is visible.'
    };
  }

  return { ok: true, table, raw: outcome.content };
};

// ---------------------------------------------------------------------------
// Product & specification extraction (product page "Use AI")
//
// The model returns structured JSON (unambiguous); the CSV the frontend shows
// is generated server-side here with deterministic RFC-4180 quoting, so the
// comma/newline/quote edge cases are always handled correctly.
// ---------------------------------------------------------------------------

/** Mirrors the category list in frontend src/components/Products/ProductManagement.tsx */
export const PRODUCT_CATEGORIES = [
  'Vertical Blinds',
  'Rollers Blinds',
  'Wood Venetian Blinds',
  'Metal Venetian Blinds',
  'Perfect Fit Rollers Blinds',
  'Perfect Fit Venetian Blinds',
  'Vision Day/Night Blinds',
  'Pleated Blinds',
  'Roman Blinds',
  'Velux (Sky light) Blinds',
  'Shutters'
];

const PRODUCTS_SYSTEM_PROMPT = `You are a precise product-data extraction engine for a blinds retail CRM.

The image may contain one or more products: a catalog page, a supplier flyer, a product sheet or a screenshot.

Return a single JSON object and NOTHING else. No markdown fences, no explanation.
Schema:
{"products":[{"name":"","category":"","price":null,"vatPercentage":null,"description":"","specifications":["..."]}]}

Rules:
- One entry per product actually visible in the image.
- name: the product name exactly as printed, short (max 120 chars). If only a model/reference number is printed, use it.
- category: exactly one of these values when it clearly applies, otherwise ""
  ${PRODUCT_CATEGORIES.join(' | ')}
  Do not invent categories outside this list.
- price: the product's price as a number. Strip currency symbols (GBP, USD, EUR), thousands separators, "VAT", "inc", "from". Keep the number exactly as printed; do not round or convert. If no price is printed, null.
- vatPercentage: the VAT percentage number (e.g. 20, 4.5) if clearly printed, otherwise null.
- description: at most one short sentence taken from the image. Never write marketing text yourself.
- specifications: the product's technical details or key spec lines exactly as printed, each as a separate short string (max 20 entries, max 240 chars each).
- NEVER invent or guess a value. If a value is not visible, use "" / null / [].
- If the image does not contain product listings, return {"products":[]}`;

const SPECIFICATIONS_SYSTEM_PROMPT = `You are a precise specification-lines extraction engine for a blinds retail CRM.

The image contains a product specification list: bullet points, a spec table or lines of technical details.

Return a single JSON object and NOTHING else. No markdown fences, no explanation.
Schema:
{"specifications":["..."]}

Rules:
- One entry per bullet/line/row exactly as printed, in the order shown.
- Keep the wording faithful to the image; only shorten a line if it is extremely long.
- Never invent specifications. Use plain data: numbers, units, materials.
- If the image contains no specification list, return {"specifications":[]}`;

export type ExtractedProduct = {
  name: string;
  category: string;
  price: number | null;
  vatPercentage: number | null;
  description: string;
  specifications: string[];
};

const MAX_PRODUCTS = 30;
const MAX_SPECS_PER_PRODUCT = 20;
const MAX_SPEC_LINES = 40;
const MAX_SPEC_LENGTH = 240;

const clampText = (value: unknown, max: number): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const matchCategory = (raw: unknown): string => {
  const candidate = clampText(raw, 60).toLowerCase();
  if (!candidate) return '';
  const exact = PRODUCT_CATEGORIES.find(c => c.toLowerCase() === candidate);
  if (exact) return exact;
  if (candidate.length >= 4) {
    const partial = PRODUCT_CATEGORIES.find(
      c => c.toLowerCase().includes(candidate) || candidate.includes(c.toLowerCase())
    );
    if (partial) return partial;
  }
  return '';
};

/**
 * Normalise whatever the model returned into safe product rows.
 * Deliberately defensive: the model output is untrusted input.
 */
export const normaliseProductsExtraction = (raw: unknown): ExtractedProduct[] => {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray((raw as any).products) ? (raw as any).products : [];

  const seen = new Set<string>();
  const products: ExtractedProduct[] = [];

  for (const candidate of list.slice(0, MAX_PRODUCTS * 2)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as any;

    const name = clampText(item.name, 120);
    const price = toFiniteNumber(item.price);
    if (!name) continue;

    const specifications: string[] = [];
    if (Array.isArray(item.specifications)) {
      for (const spec of item.specifications.slice(0, MAX_SPECS_PER_PRODUCT * 2)) {
        const text = clampText(spec, MAX_SPEC_LENGTH);
        if (text && !specifications.some(s => s.toLowerCase() === text.toLowerCase())) {
          specifications.push(text);
        }
        if (specifications.length >= MAX_SPECS_PER_PRODUCT) break;
      }
    }

    const key = `${name.toLowerCase()}|${price ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      name,
      category: matchCategory(item.category),
      price,
      vatPercentage: toFiniteNumber(item.vatPercentage),
      description: clampText(item.description, 500),
      specifications
    });
    if (products.length >= MAX_PRODUCTS) break;
  }

  return products;
};

export const normaliseSpecificationsExtraction = (raw: unknown): string[] => {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray((raw as any).specifications) ? (raw as any).specifications : [];

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of list.slice(0, MAX_SPEC_LINES * 2)) {
    const text = clampText(typeof item === 'string' ? item : (item as any)?.text, MAX_SPEC_LENGTH);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(text);
    if (lines.length >= MAX_SPEC_LINES) break;
  }
  return lines;
};

/** RFC-4180-safe single CSV field. */
const csvField = (value: unknown): string => {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Header row + one line per product, so the block pastes into spreadsheets too. */
export const productsToCsv = (products: ExtractedProduct[]): string =>
  [
    'name,category,price,vat_percentage,description,specifications',
    ...products.map(product =>
      [
        product.name,
        product.category,
        product.price === null ? '' : String(product.price),
        product.vatPercentage === null ? '' : String(product.vatPercentage),
        product.description,
        product.specifications.join(' | ')
      ]
        .map(csvField)
        .join(',')
    )
  ].join('\r\n');

export const specificationsToCsv = (lines: string[]): string =>
  lines.map(csvField).join('\r\n');

export type ProductVisionResult =
  | { ok: true; products: ExtractedProduct[]; csv: string; raw: string }
  | { ok: false; status: number; error: string };

export type SpecificationVisionResult =
  | { ok: true; specifications: string[]; csv: string; raw: string }
  | { ok: false; status: number; error: string };

const dataUrlFromBuffer = (buffer: Buffer, mimeType: string): string | { error: string } => {
  if (!ALLOWED_MIME.has(mimeType)) {
    return { error: `Unsupported image type "${mimeType}". Use JPG, PNG, WEBP or GIF.` };
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
};

export const extractProductsFromImage = async (
  buffer: Buffer,
  mimeType: string
): Promise<ProductVisionResult> => {
  const dataUrl = dataUrlFromBuffer(buffer, mimeType);
  if (typeof dataUrl !== 'string') {
    return { ok: false, status: 400, error: dataUrl.error };
  }

  const outcome = await requestVisionJson(
    PRODUCTS_SYSTEM_PROMPT,
    'Extract the product listings from this image. Reply with JSON only.',
    dataUrl
  );
  if (!outcome.ok) {
    return { ok: false, status: outcome.status, error: outcome.error };
  }

  const parsed = parseModelJson(outcome.content);
  if ('error' in parsed) {
    return { ok: false, status: 502, error: parsed.error };
  }

  const products = normaliseProductsExtraction(parsed.ok);
  if (products.length === 0) {
    return {
      ok: false,
      status: 422,
      error: 'No product listings could be found in that image. Try a clearer photo of the catalog page.'
    };
  }

  return { ok: true, products, csv: productsToCsv(products), raw: outcome.content };
};

export const extractSpecificationsFromImage = async (
  buffer: Buffer,
  mimeType: string
): Promise<SpecificationVisionResult> => {
  const dataUrl = dataUrlFromBuffer(buffer, mimeType);
  if (typeof dataUrl !== 'string') {
    return { ok: false, status: 400, error: dataUrl.error };
  }

  const outcome = await requestVisionJson(
    SPECIFICATIONS_SYSTEM_PROMPT,
    'Extract the specification lines from this image. Reply with JSON only.',
    dataUrl
  );
  if (!outcome.ok) {
    return { ok: false, status: outcome.status, error: outcome.error };
  }

  const parsed = parseModelJson(outcome.content);
  if ('error' in parsed) {
    return { ok: false, status: 502, error: parsed.error };
  }

  const specifications = normaliseSpecificationsExtraction(parsed.ok);
  if (specifications.length === 0) {
    return {
      ok: false,
      status: 422,
      error: 'No specification lines could be found in that image. Try a clearer photo.'
    };
  }

  return { ok: true, specifications, csv: specificationsToCsv(specifications), raw: outcome.content };
};
