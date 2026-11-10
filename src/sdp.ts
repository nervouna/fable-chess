// Signalling codes: a WebRTC offer or answer squeezed into a short URL-safe string, and back.
// A data-channel-only session needs very little of its SDP: the ICE credentials, the DTLS fingerprint
// and role, the mid, and the candidates. Everything else is rebuilt from a fixed template.
//   packed  `1` flags ulen ufrag plen pwd [mlen mid] base64url(fingerprint, candidates)
//           ufrag and pwd are ice-chars (A-Z a-z 0-9 + /), written as base64url digits; one character
//           each for flags and lengths. Each candidate is one byte (type, address form), the address
//           (IPv4 4 bytes, IPv6 16, an mDNS `<uuid>.local` name 16, other names length + ASCII) and
//           the port (2 bytes). Only UDP candidates of component 1 are kept.
//   deflate `Z` base64url(deflate-raw(sdp)), for anything the packed form cannot express.
// A typical Chrome offer (one mDNS host candidate and one server-reflexive one) packs to ~110 chars.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SETUPS = ['actpass', 'active', 'passive'] as const;
const TYPES = ['host', 'srflx', 'prflx', 'relay'] as const;
const TYPE_PREF = { host: 126, prflx: 110, srflx: 100, relay: 0 };
/** Longest code accepted for expansion (a deflated SDP with many candidates stays well under). */
export const MAX_CODE = 4000;

export type SdpType = 'offer' | 'answer';
export interface Desc { type: SdpType; sdp: string }
export interface Candidate { type: (typeof TYPES)[number]; address: string; port: number }
/** The fields of an SDP that a data channel needs. */
export interface SdpFields { ufrag: string; pwd: string; fingerprint: string; setup: string; mid: string; port: number; candidates: Candidate[] }
export class SdpError extends Error {}

/** Read the fields that matter (only UDP candidates of component 1 are kept). */
export function fields(sdp: string): SdpFields {
  const one = (re: RegExp) => re.exec(sdp)?.[1]?.trim() ?? '';
  const candidates: Candidate[] = [];
  for (const m of sdp.matchAll(/^a=candidate:\S+ (\d+) (\S+) \d+ (\S+) (\d+) typ (\w+)/gim))
    if (m[1] === '1' && m[2].toLowerCase() === 'udp' && (TYPES as readonly string[]).includes(m[5])) candidates.push({ type: m[5] as Candidate['type'], address: m[3], port: +m[4] });
  return {
    ufrag: one(/^a=ice-ufrag:(.+)$/m), pwd: one(/^a=ice-pwd:(.+)$/m), fingerprint: one(/^a=fingerprint:(.+)$/m),
    setup: one(/^a=setup:(.+)$/m), mid: one(/^a=mid:(.+)$/m), port: +(one(/^a=sctp-port:(\d+)/m) || 5000), candidates,
  };
}

/** A minimal SDP for a data channel, from its fields. */
export function build(type: SdpType, f: SdpFields): string {
  const lines = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', `a=group:BUNDLE ${f.mid}`, 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0'];
  // Priorities follow RFC 8445: type preference, then the original order.
  f.candidates.forEach((c, i) => lines.push(`a=candidate:${i + 1} 1 udp ${TYPE_PREF[c.type] * 2 ** 24 + (65535 - i) * 256 + 255} ${c.address} ${c.port} typ ${c.type}${c.type === 'host' ? '' : ' raddr 0.0.0.0 rport 0'}`));
  lines.push('a=end-of-candidates', // gathering finished before the code was made: nothing trickles
`a=ice-ufrag:${f.ufrag}`, `a=ice-pwd:${f.pwd}`, `a=fingerprint:${f.fingerprint}`, `a=setup:${f.setup}`, `a=mid:${f.mid}`, `a=sctp-port:${f.port}`, '');
  return lines.join('\r\n');
}

// ---------- bytes ----------
function b64(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0), k = Math.min(3, bytes.length - i);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (k > 1 ? B64[(n >> 6) & 63] : '') + (k > 2 ? B64[n & 63] : '');
  }
  return s;
}
function unb64(s: string): number[] {
  if (s.length % 4 === 1) throw new SdpError('Truncated code');
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const d = [...s.slice(i, i + 4)].map((c) => { const v = B64.indexOf(c); if (v < 0) throw new SdpError(`Bad character "${c}"`); return v; });
    const n = (d[0] << 18) | (d[1] << 12) | ((d[2] ?? 0) << 6) | (d[3] ?? 0);
    out.push((n >> 16) & 255); if (d.length > 2) out.push((n >> 8) & 255); if (d.length > 3) out.push(n & 255);
  }
  return out;
}
const ICE = /^[A-Za-z0-9+/]{1,63}$/, MID = /^[A-Za-z0-9]{1,63}$/;
const iceIn = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_'), iceOut = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/');
const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/;

function ip4(s: string): number[] | null {
  const p = s.split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && +x < 256) ? p.map(Number) : null;
}
function ip6(s: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(s) || s.split('::').length > 2) return null;
  const [a, b] = s.split('::'), head = a ? a.split(':') : [], tail = b !== undefined && b ? b.split(':') : [];
  const fill = b === undefined ? 0 : 8 - head.length - tail.length;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (groups.length !== 8 || (b !== undefined && fill < 1) || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.flatMap((g) => { const v = parseInt(g, 16); return [v >> 8, v & 255]; });
}
function ip6Text(b: number[]): string {
  const g = Array.from({ length: 8 }, (_, i) => ((b[2 * i] << 8) | b[2 * i + 1]).toString(16));
  // Compress the longest run of zero groups (at least two), as browsers print it.
  let best = -1, len = 0;
  for (let i = 0; i < 8; i++) { let j = i; while (j < 8 && g[j] === '0') j++; if (j - i > len && j - i > 1) { best = i; len = j - i; } }
  return best < 0 ? g.join(':') : g.slice(0, best).join(':') + '::' + g.slice(best + len).join(':');
}

/** Pack a description, or return null when the packed form cannot express it. */
function pack(d: Desc): string | null {
  const f = fields(d.sdp), setup = SETUPS.indexOf(f.setup as (typeof SETUPS)[number]);
  const fp = /^sha-256 ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})$/i.exec(f.fingerprint);
  if (!ICE.test(f.ufrag) || !ICE.test(f.pwd) || !MID.test(f.mid) || setup < 0 || !fp || f.port !== 5000 || f.candidates.length > 255) return null;
  const bytes = fp[1].split(':').map((h) => parseInt(h, 16));
  bytes.push(f.candidates.length);
  for (const c of f.candidates) {
    const t = TYPES.indexOf(c.type) << 2, v4 = ip4(c.address), v6 = v4 ? null : ip6(c.address), u = UUID.exec(c.address.toLowerCase());
    if (v4) bytes.push(t | 0, ...v4);
    else if (v6) bytes.push(t | 1, ...v6);
    else if (u) bytes.push(t | 2, ...u.slice(1).join('').match(/../g)!.map((h) => parseInt(h, 16)));
    else if (/^[\x21-\x7e]{1,255}$/.test(c.address)) bytes.push(t | 3, c.address.length, ...[...c.address].map((ch) => ch.charCodeAt(0)));
    else return null;
    bytes.push(c.port >> 8, c.port & 255);
  }
  const flags = (d.type === 'answer' ? 1 : 0) | (setup << 1) | (f.mid !== '0' ? 8 : 0);
  return '1' + B64[flags] + B64[f.ufrag.length] + iceIn(f.ufrag) + B64[f.pwd.length] + iceIn(f.pwd) + (f.mid !== '0' ? B64[f.mid.length] + f.mid : '') + b64(bytes);
}

function unpack(s: string): Desc {
  let p = 1;
  const digit = () => { const v = B64.indexOf(s[p++] ?? '?'); if (v < 0) throw new SdpError('Bad code'); return v; };
  const text = () => { const n = digit(), t = s.slice(p, p + n); if (t.length !== n) throw new SdpError('Truncated code'); p += n; return t; };
  const flags = digit();
  if (flags > 15 || (flags >> 1 & 3) > 2) throw new SdpError('Bad code flags');
  const ufrag = iceOut(text()), pwd = iceOut(text()), mid = flags & 8 ? text() : '0';
  if (!ICE.test(ufrag) || !ICE.test(pwd) || !MID.test(mid)) throw new SdpError('Bad ICE credentials');
  const b = unb64(s.slice(p));
  let q = 0;
  const take = (n: number) => { if (q + n > b.length) throw new SdpError('Truncated code'); q += n; return b.slice(q - n, q); };
  const fingerprint = 'sha-256 ' + take(32).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const candidates: Candidate[] = [];
  for (let n = take(1)[0]; n > 0; n--) {
    const [h] = take(1), type = TYPES[(h >> 2) & 3], form = h & 3;
    if (h > 15) throw new SdpError('Bad candidate');
    let address: string;
    if (form === 0) address = take(4).join('.');
    else if (form === 1) address = ip6Text(take(16));
    else if (form === 2) { const x = take(16).map((v) => v.toString(16).padStart(2, '0')).join(''); address = `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}.local`; }
    else { address = String.fromCharCode(...take(take(1)[0])); if (!/^[\x21-\x7e]+$/.test(address)) throw new SdpError('Bad candidate address'); }
    const [hi, lo] = take(2);
    candidates.push({ type, address, port: (hi << 8) | lo });
  }
  if (q !== b.length) throw new SdpError('Trailing bytes in code');
  const type: SdpType = flags & 1 ? 'answer' : 'offer';
  return { type, sdp: build(type, { ufrag, pwd, fingerprint, setup: SETUPS[(flags >> 1) & 3], mid, port: 5000, candidates }) };
}

// ---------- deflate fallback ----------
async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t));
  return new Uint8Array(await out.arrayBuffer());
}

/** Compress a description to a code. */
export async function compress(d: Desc): Promise<string> {
  const p = pack(d);
  if (p) return p;
  const z = await pipe(new TextEncoder().encode((d.type === 'answer' ? 'a' : 'o') + d.sdp), new CompressionStream('deflate-raw'));
  return 'Z' + b64([...z]);
}

/** Expand a code (or any text containing one after `#join=` / `#reply=`) back to a description. */
export async function expand(text: string): Promise<Desc> {
  const s = codeOf(text);
  if (!s) throw new SdpError('Empty code');
  if (s.length > MAX_CODE) throw new SdpError('Code too long');
  if (s[0] === '1') return unpack(s);
  if (s[0] === 'Z') {
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(await pipe(new Uint8Array(unb64(s.slice(1))), new DecompressionStream('deflate-raw'))); }
    catch (e) { throw e instanceof SdpError ? e : new SdpError('Bad compressed code'); }
    const type = raw[0] === 'a' ? 'answer' : raw[0] === 'o' ? 'offer' : null, sdp = raw.slice(1);
    if (!type || !sdp.startsWith('v=0') || sdp.length > 20000) throw new SdpError('Bad compressed code');
    return { type, sdp };
  }
  throw new SdpError('Unknown code format');
}

/** The code inside a pasted text: after `#join=` or `#reply=` if present, whitespace removed. */
export function codeOf(text: string): string {
  let t = text.trim();
  const h = /#(?:join|reply)=([^\s#&]*)/.exec(t);
  if (h) t = h[1];
  try { t = decodeURIComponent(t); } catch { /* not URI-encoded */ }
  return t.replace(/\s+/g, '');
}
