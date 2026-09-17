/**
 * The agent fetches URLs supplied by whoever is chatting with it, so every URL
 * is treated as hostile input before it reaches `fetch`.
 *
 * Known limitation, stated plainly: this validates the host in the URL. It does
 * not defeat DNS rebinding, because Workers resolve the name inside `fetch` and
 * the resolved address is never exposed to user code. A deployment that needs
 * that guarantee should egress through a proxy with an allowlist.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data"
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * DNS treats a trailing dot as the root-anchored form of the same name, so
 * `localhost.` resolves exactly like `localhost` and must not survive as a
 * distinct string past the denylist.
 */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) =>
    /^\d{1,3}$/.test(p) ? Number(p) : Number.NaN
  );
  if (octets.some((o) => Number.isNaN(o) || o > 255)) return false;

  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups.
 *
 * Prefix matching on the textual form is not good enough: `URL` normalizes
 * IPv4-mapped addresses to hex groups, `fe80::/10` spans `fe80`–`febf`, and
 * several distinct embedding formats (mapped, translated, compatible, NAT64)
 * all smuggle an IPv4 address through. Parsing once and range-checking
 * numerically covers every spelling.
 */
function parseIpv6(host: string): number[] | null {
  let text = host;

  // A trailing dotted-quad (`::ffff:127.0.0.1`) becomes two hex groups.
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const dotted = text.slice(lastColon + 1);
    const octets = dotted.split(".");
    if (octets.length !== 4) return null;
    const values = octets.map((o) =>
      /^\d{1,3}$/.test(o) ? Number(o) : Number.NaN
    );
    if (values.some((v) => Number.isNaN(v) || v > 255)) return null;
    const high = ((values[0] << 8) | values[1]).toString(16);
    const low = ((values[2] << 8) | values[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }

  const values = groups.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN
  );
  return values.some(Number.isNaN) ? null : values;
}

function isBlockedIpv6(host: string): boolean {
  const groups = parseIpv6(host.replace(/^\[|\]$/g, "").toLowerCase());
  if (!groups) return false;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // Every way an IPv4 address can be embedded in an IPv6 one.
  const zeroLead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  const embedsIpv4 =
    (zeroLead && g4 === 0 && g5 === 0xffff) || // ::ffff:0:0/96  mapped
    (zeroLead && g4 === 0xffff && g5 === 0) || // ::ffff:0:0:0/96 translated
    (zeroLead && g4 === 0 && g5 === 0) || //       ::/96          compatible
    (g0 === 0x64 && g1 === 0xff9b); //             64:ff9b::/96   NAT64

  if (embedsIpv4) {
    const ipv4 = [g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff].join(".");
    return isBlockedIpv4(ipv4);
  }

  return false;
}

export interface UrlCheck {
  ok: boolean;
  url?: URL;
  reason?: string;
}

export function checkSourceUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are rejected" };
  }

  const host = normalizeHost(url.hostname);
  if (!host) {
    return { ok: false, reason: "missing host" };
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `blocked host ${host}` };
  }
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: `blocked internal domain ${host}` };
  }
  if (isBlockedIpv4(host) || isBlockedIpv6(host)) {
    return { ok: false, reason: "private or reserved IP address" };
  }

  return { ok: true, url };
}

/** Validate a batch, keeping the caller's ordering and de-duplicating. */
export function partitionUrls(raw: string[]): {
  allowed: string[];
  rejected: { url: string; reason: string }[];
} {
  const allowed: string[] = [];
  const rejected: { url: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const candidate of raw) {
    const check = checkSourceUrl(candidate);
    if (!check.ok || !check.url) {
      rejected.push({ url: candidate, reason: check.reason ?? "rejected" });
      continue;
    }
    const normalized = check.url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    allowed.push(normalized);
  }

  return { allowed, rejected };
}
