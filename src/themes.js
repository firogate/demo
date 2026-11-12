export const SAFE_FONTS = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'Courier New', Courier, monospace",
  inter: "Inter, 'Helvetica Neue', Arial, sans-serif",
  roboto: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  ubuntu: 'Ubuntu, Cantarell, sans-serif',
  cairo: "'Cairo', 'Noto Sans Arabic', -apple-system, sans-serif",
  tajawal: "'Tajawal', 'Noto Sans Arabic', -apple-system, sans-serif",
  notoarabic: "'Noto Sans Arabic', 'Cairo', -apple-system, sans-serif",
  notocyrillic: "'Noto Sans Cyrillic', 'Roboto', -apple-system, sans-serif",
  notosc: "'Noto Sans SC', -apple-system, sans-serif",
  spacegrotesk: "'Space Grotesk', 'Helvetica Neue', Arial, sans-serif",
  jost: "'Jost', 'Helvetica Neue', Arial, sans-serif",
  outfit: "'Outfit', 'Helvetica Neue', Arial, sans-serif",
  orbitron: "'Orbitron', 'Helvetica Neue', Arial, sans-serif",
  archivoblack: "'Archivo Black', 'Helvetica Neue', Arial, sans-serif",
  baloo2: "'Baloo 2', cursive, sans-serif",
  cormorant: "'Cormorant Garamond', Georgia, serif",
  jetbrains: "'JetBrains Mono', 'Courier New', monospace",
  pressstart: "'Press Start 2P', 'Courier New', monospace",
  poiret: "'Poiret One', cursive, sans-serif",
  bangers: "'Bangers', cursive, sans-serif",
  monoton: "'Monoton', cursive, sans-serif",
  pacifico: "'Pacifico', cursive, sans-serif",
  caveat: "'Caveat', cursive, sans-serif",
};

export const SAFE_BUTTON_STYLES = ['rounded', 'sharp', 'pill'];
export const DEFAULT_THEME_ID = 'firogate';

const P = (label, description, accent, bg, surface, text, text_muted, border, success, error, radius, font, button_style) =>
  ({ label, description, accent, bg, surface, text, text_muted, border, success, error, radius, font, button_style });

export const PRESETS = {
  firogate: P('FiroGate', 'Dark with FiroGate teal', '#00A2A7', '#0B0D0E', '#141719', '#E8EEEE', '#7C8689', '#22272A', '#22C55E', '#F2604F', '12', 'inter', 'rounded'),
  dark_gold: P('Dark Gold', 'Premium dark with gold accents', '#F5C542', '#0A0806', '#161210', '#EBE4D7', '#8C7E6A', '#2A221A', '#22C55E', '#EF4444', '12', 'system', 'rounded'),
  midnight: P('Midnight', 'Deep blue-black, minimal', '#6366F1', '#0F0F14', '#18181F', '#E2E2F0', '#6B6B80', '#2A2A35', '#22C55E', '#EF4444', '10', 'inter', 'rounded'),
  minimal_white: P('Minimal White', 'Clean light theme, maximum clarity', '#111111', '#FAFAFA', '#FFFFFF', '#111111', '#6B7280', '#E5E7EB', '#16A34A', '#DC2626', '8', 'inter', 'rounded'),
  corporate_blue: P('Corporate Blue', 'Professional corporate look', '#2563EB', '#F8FAFF', '#FFFFFF', '#1E293B', '#64748B', '#CBD5E1', '#059669', '#DC2626', '6', 'roboto', 'rounded'),
  terminal_dark: P('Terminal Dark', 'Developer-friendly monospace terminal', '#00FF41', '#0D0D0D', '#141414', '#00FF41', '#00AA2B', '#1A2A1A', '#00FF41', '#FF4444', '4', 'mono', 'sharp'),
  soft_gray: P('Soft Gray', 'Neutral, understated, universal', '#374151', '#F3F4F6', '#FFFFFF', '#111827', '#6B7280', '#D1D5DB', '#059669', '#DC2626', '10', 'system', 'rounded'),
  clean_modern: P('Clean Modern', 'Warm dark with subtle gradients', '#F97316', '#111827', '#1F2937', '#F9FAFB', '#9CA3AF', '#374151', '#22C55E', '#EF4444', '14', 'inter', 'pill'),
};

export const VALID_LAYOUTS = new Set([
  'stripe', 'receipt', 'glass', 'brutalist', 'luxury', 'playful',
  'newspaper', 'cyberpunk', 'swiss', 'pixel', 'boarding_pass', 'zen',
  'aurora', 'blueprint', 'botanical', 'eink', 'fintech', 'artdeco', 'comic', 'vaporwave',
  'delivery', 'candy', 'beauty', 'princess', 'boutique', 'chalkboard', 'gym', 'vinyl',
]);

const HEX = /^#[0-9A-Fa-f]{6}$/;
const safeHex = v => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toUpperCase() : null);
function safeText(v, max = 120) {
  if (!v || typeof v !== 'string') return null;
  let s = v.replace(/<[^>]+>/g, '').replace(/[<>&"'\\]/g, '').replace(/(javascript|data|vbscript):/gi, '').trim().slice(0, max);
  return s || null;
}
function safeRadius(v) {
  if (v == null) return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? String(Math.max(0, Math.min(24, n))) : null;
}
const safeFont = v => (typeof v === 'string' && SAFE_FONTS[v.trim().toLowerCase()] ? v.trim().toLowerCase() : null);
const safeButton = v => (typeof v === 'string' && SAFE_BUTTON_STYLES.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);
const safeThemeId = v => (typeof v === 'string' && (PRESETS[v.trim().toLowerCase()] || v.trim().toLowerCase() === 'custom') ? v.trim().toLowerCase() : null);
const safePosition = v => (v === 'top' || v === 'bottom' ? v : null);
function safeOverlay(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9]/g, '');
  return s ? String(Math.max(0, Math.min(95, parseInt(s, 10)))) : null;
}
const BG_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
function safeBgImage(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return '';
  const m = BG_RE.exec(s);
  if (!m || m[2].length > 400000) return null;
  let head;
  try { head = atob(m[2].slice(0, 24)); } catch { return null; }
  const b = i => head.charCodeAt(i);
  const ok = (b(0) === 0x89 && head.slice(1, 4) === 'PNG') || (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff)
    || head.startsWith('GIF87a') || head.startsWith('GIF89a') || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP');
  return ok ? s : null;
}
function safeV2Colors(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const clean = {};
  for (const [id, c] of Object.entries(v)) {
    if (!VALID_LAYOUTS.has(id) || id === 'stripe' || !c || typeof c !== 'object') continue;
    const e = {};
    const a = safeHex(c.accent), bg = safeHex(c.bg), f = safeFont(c.font);
    if (a) e.accent = a;
    if (bg) e.bg = bg;
    if (f) e.font = f;
    if (Object.keys(e).length) clean[id] = e;
  }
  return Object.keys(clean).length ? clean : null;
}

export function validateThemeInput(d) {
  return {
    theme_id: safeThemeId(d.theme_id),
    theme_accent: safeHex(d.theme_accent),
    theme_bg: safeHex(d.theme_bg),
    theme_surface: safeHex(d.theme_surface),
    theme_text: safeHex(d.theme_text),
    theme_radius: safeRadius(d.theme_radius),
    theme_font: safeFont(d.theme_font),
    theme_button_style: safeButton(d.theme_button_style),
    theme_checkout_title: safeText(d.theme_checkout_title, 80),
    theme_checkout_subtitle: safeText(d.theme_checkout_subtitle, 120),
    theme_success_msg: safeText(d.theme_success_msg, 200),
    theme_cancel_msg: safeText(d.theme_cancel_msg, 200),
    theme_qr_position: safePosition(d.theme_qr_position),
    theme_cancel_position: safePosition(d.theme_cancel_position),
    theme_bg_image: safeBgImage(d.theme_bg_image),
    theme_bg_overlay: safeOverlay(d.theme_bg_overlay),
    checkout_layout: VALID_LAYOUTS.has(d.checkout_layout) ? d.checkout_layout : null,
    theme_v2_colors_json: safeV2Colors(d.theme_v2_colors_json),
  };
}

export function resolveTheme(themeId, o) {
  const base = { ...(PRESETS[themeId || DEFAULT_THEME_ID] || PRESETS[DEFAULT_THEME_ID]) };
  if (safeHex(o.accent)) base.accent = safeHex(o.accent);
  if (safeHex(o.bg)) base.bg = safeHex(o.bg);
  if (safeHex(o.surface)) base.surface = safeHex(o.surface);
  if (safeHex(o.text)) base.text = safeHex(o.text);
  if (safeRadius(o.radius)) base.radius = safeRadius(o.radius);
  if (safeFont(o.font)) base.font = safeFont(o.font);
  if (safeButton(o.button_style)) base.button_style = safeButton(o.button_style);
  base.font_stack = SAFE_FONTS[base.font] || SAFE_FONTS.system;
  const r = parseInt(base.radius || '12', 10);
  base.radius_sm = String(Math.max(0, r - 4));
  base.radius_lg = String(Math.min(24, r + 4));
  base.radius_btn = { rounded: String(r), sharp: '2', pill: '999' }[base.button_style || 'rounded'] || String(r);
  return base;
}

export function themeSettings(sb) {
  let t = {};
  try { t = sb.theme_json ? JSON.parse(sb.theme_json) : {}; } catch { t = {}; }
  return t;
}

export function themeFromSandbox(sb) {
  const t = themeSettings(sb);
  const theme = resolveTheme(t.theme_id || DEFAULT_THEME_ID, {
    accent: t.theme_accent, bg: t.theme_bg, surface: t.theme_surface, text: t.theme_text,
    radius: t.theme_radius, font: t.theme_font, button_style: t.theme_button_style,
  });
  theme.checkout_title = safeText(t.theme_checkout_title, 80) || '';
  theme.checkout_subtitle = safeText(t.theme_checkout_subtitle, 120) || '';
  theme.success_msg = safeText(t.theme_success_msg, 200) || '';
  theme.cancel_msg = safeText(t.theme_cancel_msg, 200) || '';
  theme.qr_position = safePosition(t.theme_qr_position) || 'bottom';
  theme.cancel_position = safePosition(t.theme_cancel_position) || 'bottom';
  theme.bg_image = t.theme_bg_image || '';
  theme.bg_overlay = safeOverlay(t.theme_bg_overlay) || '70';
  theme.theme_id = t.theme_id || DEFAULT_THEME_ID;
  theme.checkout_layout = VALID_LAYOUTS.has(t.checkout_layout) ? t.checkout_layout : 'stripe';
  theme.v2_colors = t.theme_v2_colors_json || {};
  return theme;
}
